import crypto from 'node:crypto';
import { DB_ENGINES, DISCOVER_CMD, cleanupJob, parseDiscovery, parseName, resolveTargets, shq, slugOf, stampOf } from './data-backup.js';
import { MODES, buildInspectScript, buildRestoreScript, parseMember, planMembers, readRestoreStatus, segments, startRestoreJob } from './data-restore.js';
import { createService, inspectService, runServiceOp } from './easypanel.js';
import { applyConfig, configFromService } from './templates.js';

/**
 * Ход восстановления данных: просмотр архива, сопоставление частей с целью (тот же сервис, другой или только что созданный),
 * запуск скрипта на сервере панели и слежение за ним. Задания восстановления хранятся в настройках EasyAdmin (последние 20)
 * и дослеживаются после перезапуска EasyAdmin: скрипт на сервере от него не зависит.
 */
const NAME_OK = /^[a-z0-9_-]+$/;
const JOBS_KEY = 'restore_data_jobs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { throw new Error(m); };

export function createRestorer({ load, getRaw, setRaw, manager, hostFn, s3Of, now = () => Date.now(), audit, pollMs = 3000, busy = () => false, selfId = process.env.HOSTNAME }) {
  const inspects = new Map(); // просмотры архивов (в памяти, живут недолго)
  const sizes = new Map(); // `${панель}|${файл}` → размеры частей из последнего просмотра
  const saved = () => { try { return JSON.parse(getRaw(JOBS_KEY) ?? '[]'); } catch { return []; } };
  const persist = (job) => { const all = saved().filter((x) => x.id !== job.id); setRaw(JOBS_KEY, JSON.stringify([job, ...all].slice(0, 20))); };

  function sourceOf(c, row, name, ttl) {
    if (c.data.dest === 's3') return { url: s3Of(c).presign('GET', `${c.s3.prefix}data/${slugOf(row)}/${name}`, ttl) };
    return { file: `${c.data.dir}/${slugOf(row)}/${name}` };
  }
  function archiveOf(panelId, name, password) {
    const row = manager.getRow(Number(panelId)); if (!row) fail('Панель не найдена');
    const p = parseName(String(name ?? ''));
    if (!p?.archive) fail('Восстановление из интерфейса работает с архивами сервисов (.tar). Для более старых копий используйте «Как восстановить»');
    const c = load(); const pw = password || c.password;
    if (p.encrypted && !pw) fail('Задайте пароль копий (Бэкапы → Настройки) или введите пароль этой копии');
    if (c.data.dest === 's3' && !(c.s3.endpoint && c.s3.bucket && c.s3.accessKey && c.s3.secretKey)) fail('Заполните данные хранилища S3');
    return { row, p, c, pw: p.encrypted ? pw : '' };
  }
  const idOf = (prefix, row) => `${prefix}${stampOf(now())}-${row.id}-${crypto.randomBytes(2).toString('hex')}`;

  /* ---------------- просмотр архива ---------------- */
  async function inspect({ panelId, name, password }) {
    const { row, p, c, pw } = archiveOf(panelId, name, password);
    if (busy()) fail('Сейчас идёт копирование данных: дождитесь его окончания');
    const runId = idOf('i', row); const client = manager.clientFor(row);
    const script = buildInspectScript({ runId, baseDir: c.data.dir, source: sourceOf(c, row, name, 3600), encrypted: p.encrypted, password: pw, selfId });
    await startRestoreJob(client, row, { baseDir: c.data.dir, runId, script }, hostFn);
    const job = { id: runId, kind: 'inspect', panelId: row.id, name, status: 'running', startedAt: now(), members: [] };
    inspects.set(runId, job);
    for (const [k, v] of inspects) if (now() - v.startedAt > 3600e3) inspects.delete(k);
    (async () => {
      let st = null;
      for (let i = 0; i < 1800 && !(st?.done); i++) { await sleep(pollMs); try { st = await readRestoreStatus(client, row, c.data.dir, runId, hostFn); } catch { /* консоль хоста отвечает с задержкой */ } if (!st?.started && now() - job.startedAt > 180_000) break; }
      cleanupJob(client, row, c.data.dir, runId, hostFn);
      if (!st?.done) { job.status = 'error'; job.error = 'Скрипт на сервере не завершился вовремя'; return; }
      if (st.general) { job.status = 'error'; job.error = st.general; return; }
      job.members = st.members.filter((m) => parseMember(m.member)); job.status = 'done';
      sizes.set(`${row.id}|${name}`, new Map(job.members.map((m) => [m.member, m.size])));
    })().catch((e) => { job.status = 'error'; job.error = e.message; });
    return { id: runId };
  }

  /* ---------------- цель ---------------- */
  async function projectsOf(row, force = true) { return (await manager.snapshot(row.id, { force }))?.tree?.projects ?? []; }
  const findSvc = (projects, ref) => projects.find((p) => p.name === ref.project)?.services.find((s) => s.name === ref.service);

  async function targetParts(row, ref) {
    const client = manager.clientFor(row); const projects = await projectsOf(row);
    const svc = findSvc(projects, ref); if (!svc) fail(`Сервиса ${ref.project}/${ref.service} нет на панели «${row.name}»`);
    const compose = svc.type === 'compose' ? parseDiscovery((await hostFn(client, row, DISCOVER_CMD, { timeoutMs: 60_000 }).catch(() => ({ output: '' }))).output) : [];
    const jobs = await resolveTargets(client, row, projects, { mode: 'selected', keys: [`${row.id}|${ref.project}|${ref.service}`], consistency: 'stop' }, stampOf(now()), { compose });
    return { type: svc.type, parts: jobs[0]?.parts ?? [] };
  }

  /** Части копии → части цели. Возвращает позиции для показа и (для запуска) готовые к скрипту части. */
  async function plan({ panelId, name, members, target }) {
    if (!Array.isArray(members) || !members.length || members.some((m) => !parseMember(m))) fail('Некорректный список частей');
    const { p } = archiveOf(panelId, name, 'x'); const srcRef = { project: p.project, service: p.service };
    const row = manager.getRow(Number(target?.panelId ?? panelId)); if (!row) fail('Панель цели не найдена');
    const ref = { project: String(target?.project ?? srcRef.project), service: String(target?.service ?? srcRef.service) };
    const { type, parts } = await targetParts(row, ref);
    const list = planMembers(members, srcRef, ref, parts).map((it) => {
      if (it.status === 'ok' && it.bind && segments(it.part.hostPath) < 2) return { ...it, status: 'unsafe' };
      return it;
    });
    return { row, ref, type, srcRef, items: list };
  }
  const brief = (it) => ({ member: it.member, tag: it.tag, kind: it.kind, bind: !!it.bind, compose: !!it.compose, status: it.status, target: it.part?.label ?? null, hostPath: it.part?.hostPath ?? null });

  /* ---------------- новый сервис ---------------- */
  async function waitContainer(row, ref, ms = 120_000) {
    const client = manager.clientFor(row); const t0 = now();
    while (now() - t0 < ms) {
      const r = await hostFn(client, row, `docker ps -q --filter ${shq(`name=^${ref.project}_${ref.service}\\.`)} | head -n1`, { timeoutMs: 20_000 }).catch(() => null);
      if (r?.output.trim()) return true;
      await sleep(3000);
    }
    return false;
  }
  async function provision({ row, srcRow, srcRef, members, create }) {
    const project = String(create.project ?? ''); const name = String(create.service ?? create.name ?? '');
    if (!NAME_OK.test(project) || !NAME_OK.test(name)) fail('Имя проекта и сервиса: латиница нижнего регистра, цифры, - и _');
    const client = manager.clientFor(row); const projects = await projectsOf(row);
    if (findSvc(projects, { project, service: name })) fail(`В проекте ${project} уже есть сервис ${name}: выберите «В другой сервис»`);
    const parsed = members.map(parseMember).filter(Boolean);
    const dbKinds = [...new Set(parsed.filter((x) => x.kind !== 'volume' && !x.compose).map((x) => x.kind))];
    const vols = parsed.filter((x) => x.kind === 'volume' && !x.compose && !x.bind);
    let type;
    if (parsed.some((x) => x.compose)) fail('Для копии compose-стека новый сервис автоматически не создаётся: создайте стек вручную и выберите «В другой сервис»');
    else if (dbKinds.length === 1 && !vols.length) type = dbKinds[0];
    else if (!dbKinds.length && vols.length) type = 'app';
    else fail('По этой копии нельзя однозначно определить тип нового сервиса: создайте сервис вручную и выберите «В другой сервис»');
    let mounts = [];
    let srcSvc = null;
    if (type === 'app') {
      const sp = await projectsOf(srcRow, false).catch(() => []); const s = findSvc(sp, srcRef);
      if (s?.type === 'app') { srcSvc = await inspectService(manager.clientFor(srcRow), { type: 'app', project: srcRef.project, name: srcRef.service }).catch(() => null); }
      const have = (srcSvc?.mounts ?? []).filter((m) => (m.type ?? m.mountType) === 'volume');
      mounts = vols.map((v) => { const n = v.tag.slice(4); const m = have.find((x) => x.name === n); if (!m?.mountPath) fail(`Не знаю, куда монтировать том «${n}»: исходный сервис ${srcRef.project}/${srcRef.service} не найден. Создайте сервис с этим томом вручную и выберите «В другой сервис»`); return { name: n, mountPath: m.mountPath }; });
    }
    if (type === 'app' && srcSvc?.service) {
      const steps = await applyConfig(client, { project, name }, configFromService('app', srcSvc.service), { existingProjects: projects.map((p) => p.name) });
      const bad = steps.find((x) => !x.ok); if (bad) fail(`Не удалось создать сервис: ${bad.step}: ${bad.error}`);
    } else {
      if (!projects.some((p) => p.name === project)) await client.mutate('projects.createProject', { name: project });
      await createService(client, { type, project, name, ...(type === 'app' ? {} : { password: crypto.randomBytes(12).toString('hex') }) });
    }
    for (const m of mounts) await runServiceOp(client, 'mountAdd', { type: 'app', project, name }, { type: 'volume', name: m.name, mountPath: m.mountPath });
    manager.invalidate(row.id);
    if (DB_ENGINES.includes(type) && !await waitContainer(row, { project, service: name })) fail('Новая база создана, но её контейнер не запустился за 2 минуты: запустите сервис и выберите «В другой сервис»');
    return { project, service: name, type };
  }

  /* ---------------- запуск ---------------- */
  async function start({ panelId, name, password, target, members, mode = 'clean', snapshot = true, by = null }) {
    if (busy()) fail('Сейчас идёт копирование данных: дождитесь его окончания');
    if (!MODES.includes(mode)) fail('Режим: clean или merge');
    if (!Array.isArray(members) || !members.length) fail('Выберите, что восстановить');
    if (members.some((m) => !parseMember(m))) fail('Некорректное имя части');
    if (saved().some((j) => j.status === 'running')) fail('Восстановление уже идёт: дождитесь его окончания');
    const { row: srow, p, c, pw } = archiveOf(panelId, name, password);
    const trow = manager.getRow(Number(target?.panelId ?? srow.id)); if (!trow) fail('Панель цели не найдена');
    if (c.data.dest !== 's3' && trow.id !== srow.id) fail('Копии лежат на сервере своей панели: в сервис другой панели их можно восстановить только из S3');
    const srcRef = { project: p.project, service: p.service };
    let tgt = target?.create ? await provision({ row: trow, srcRow: srow, srcRef, members, create: target.create }) : { project: String(target?.project ?? srcRef.project), service: String(target?.service ?? srcRef.service) };
    const pl = await plan({ panelId, name, members, target: { panelId: trow.id, ...tgt } });
    const ok = pl.items.filter((x) => x.status === 'ok');
    if (!ok.length) fail(`Ни одна из выбранных частей не подходит к сервису ${tgt.project}/${tgt.service}${pl.items[0] ? ` (${pl.items.map((x) => `${x.member}: ${x.status === 'nomatch' ? 'нет такого тома или базы' : x.status}`).join('; ')})` : ''}`);
    const svcName = `${pl.ref.project}_${pl.ref.service}`;
    const parts = ok.map((it) => ({ member: it.member, kind: it.kind === 'volume' ? 'volume' : it.kind, bind: !!it.part.bind, hostPath: it.part.hostPath, filter: it.part.filter, svc: svcName,
      hold: it.kind === 'redis' ? `swarm:${svcName}` : it.kind === 'volume' ? it.part.hold : null }));
    const known = sizes.get(`${srow.id}|${name}`); const needBytes = known ? parts.reduce((n, x) => n + (known.get(x.member) ?? 0), 0) : 0;
    const runId = idOf('x', trow); const client = manager.clientFor(trow);
    const script = buildRestoreScript({ runId, baseDir: c.data.dir, source: sourceOf(c, srow, name, 12 * 3600), encrypted: p.encrypted, password: pw, parts, mode, snapshot: snapshot !== false, minFreeKb: c.data.minFreeMb * 1024, needBytes, selfId });
    await startRestoreJob(client, trow, { baseDir: c.data.dir, runId, script }, hostFn);
    const job = { id: runId, kind: 'restore', panelId: srow.id, targetPanelId: trow.id, targetPanel: trow.name, file: name, target: `${pl.ref.project}/${pl.ref.service}`, created: !!target?.create, mode, snapshot: snapshot !== false, by, status: 'running', startedAt: now(), baseDir: c.data.dir,
      parts: pl.items.map((it) => ({ ...brief(it), result: it.status === 'ok' ? 'wait' : 'skip' })) };
    persist(job); follow(job).catch(() => {});
    return { id: runId, target: job.target, parts: job.parts.length, restoring: ok.length, skipped: pl.items.length - ok.length };
  }

  /** Следит за запущенным скриптом, обновляет задание, в конце убирает за собой и пишет в журнал действий. */
  async function follow(job) {
    const trow = manager.getRow(job.targetPanelId); const client = trow ? manager.clientFor(trow) : null; let st = null;
    try {
      if (!trow) fail('Панель удалена');
      for (let polls = 0; !st?.done; polls++) {
        await sleep(pollMs);
        try { st = await readRestoreStatus(client, trow, job.baseDir, job.id, hostFn); } catch { /* консоль может отвечать с задержкой */ }
        if (st) {
          job.current = st.current ?? null; job.snapDir = st.snapDir ?? job.snapDir;
          for (const pt of job.parts) if (pt.result !== 'skip') { const r = st.parts[pt.member]; pt.result = r ? (r.ok ? 'ok' : 'fail') : st.current === pt.member ? 'run' : 'wait'; pt.error = r?.error; pt.warn = st.warns[pt.member]; }
          persist(job);
          if (!st.started && now() - job.startedAt > 180_000) fail('Скрипт на сервере не стартовал');
        }
        if (now() - job.startedAt > 12 * 3600e3) fail('Восстановление идёт слишком долго (больше 12 часов)');
      }
      if (st.general) fail(st.general);
      job.status = job.parts.some((x) => x.result === 'fail') ? 'partial' : 'done';
    } catch (e) { job.status = 'error'; job.error = e.message; }
    job.endedAt = now(); job.current = null; persist(job);
    cleanupJob(client, trow, job.baseDir, job.id, hostFn);
    manager.invalidate?.(job.targetPanelId);
    const okN = job.parts.filter((x) => x.result === 'ok').length; const failN = job.parts.filter((x) => x.result === 'fail').length;
    try { audit?.({ user: { username: job.by ?? 'EasyAdmin' } }, { action: 'backup.restore_data_done', panel: { id: job.targetPanelId, name: job.targetPanel }, target: job.target, ok: job.status === 'done',
      detail: job.error ?? [`Восстановлено частей: ${okN}`, failN ? `ошибок: ${failN}` : null, job.snapDir ? `страховочная копия: ${job.snapDir}` : null].filter(Boolean).join(' · ') }); } catch { /* журнал не должен ломать завершение */ }
  }
  /** После перезапуска EasyAdmin: незавершённые восстановления дослеживаются. */
  function resume() { const run = saved().filter((j) => j.kind === 'restore' && j.status === 'running'); for (const j of run) follow(j).catch(() => {}); return run.length; }

  const get = (id) => inspects.get(id) ?? saved().find((j) => j.id === id) ?? null;
  const history = () => saved();
  return { inspect, plan: async (o) => { const r = await plan(o); return { type: r.type, target: `${r.ref.project}/${r.ref.service}`, items: r.items.map(brief) }; }, start, get, history, resume };
}
