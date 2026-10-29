import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt, encrypt, sha256 } from './crypto.js';
import { DISCOVER_CMD, buildScript, cleanupJob, deployJob, needsDiscovery, parseDiscovery, readStatus, resolveTargets, shq, slugOf, stampOf, validDir } from './data-backup.js';
import { PanelClient, runAction } from './easypanel.js';
import { runOnHost } from './host-exec.js';
import { HttpError, RawResponse, StreamResponse } from './http.js';
import { PRECHECK, evaluate, parseKv } from './installer.js';
import { checkTarget, checkUser, realSsh } from './ssh.js';

/**
 * Переезд на новый сервер: полный слепок системы (/etc/easypanel + тома + дампы баз) → чистый сервер.
 *  1. Слепок делается на сервере-источнике отдельным процессом (как копии данных) и одним файлом `.tar.gz[.enc]`
 *     отправляется в EasyAdmin по одноразовой ссылке (PUT). Файл зашифрован паролем резервных копий, если он задан.
 *  2. Новый сервер забирает слепок командой `curl …/api/migration/bootstrap.sh?token=… | bash`: скрипт ставит Docker,
 *     скачивает слепок, распаковывает /etc/easypanel и тома, запускает Easypanel и восстанавливает базы. Ход он
 *     сообщает EasyAdmin (POST /api/migration/report) — так ход виден и при «одной команде», и при запуске по SSH.
 *  3. «По SSH»: EasyAdmin сам подключается к новому серверу, проверяет его, ставит Docker, запускает тот же скрипт
 *     отдельным юнитом systemd и проверяет итог через SSH-туннель к панели (токены панели переезжают вместе с /etc/easypanel).
 * Секреты (пароль SSH, пароль копий) живут только в памяти задания; в базе — журнал и состояние без секретов.
 */
export const STEPS = [
  ['connect', 'Подключение к серверу'], ['precheck', 'Проверка сервера'], ['install_docker_swarm', 'Docker и Swarm'], ['snapshot', 'Слепок системы'],
  ['transfer', 'Передача слепка'], ['unpack_and_start', 'Распаковка и запуск'], ['verify', 'Проверка'],
];
const STEP_IDS = new Set(STEPS.map(([id]) => id));
const REPORT_STATUS = new Set(['running', 'ok', 'error', 'info']);
const MAX_LOG = 400;
const BASE_URL = /^https?:\/\/(?!localhost|127\.|0\.0\.0\.0)[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Скрипт для нового сервера: подставляются только проверенные значения (адрес, токен из hex, флаг шифрования). */
export function bootstrapScript({ baseUrl, token, encrypted }) {
  if (!BASE_URL.test(baseUrl) || baseUrl.endsWith('/')) throw new HttpError(400, 'Некорректный адрес EasyAdmin');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpError(400, 'Некорректный токен');
  return fs.readFileSync(path.join(DIR, 'migration-bootstrap.sh'), 'utf8')
    .replace('__EA_URL__', baseUrl).replace('__EA_TOKEN__', token).replace('__EA_ENC__', encrypted ? '1' : '0');
}
export const commandOf = (baseUrl, token) => `curl -sSL ${baseUrl}/api/migration/bootstrap.sh?token=${token} | bash`;

/**
 * Скрипт слепка для сервера-источника: копии данных (как у обычного копирования) + /etc/easypanel → один файл → EasyAdmin.
 * Том, лежащий внутри /etc/easypanel и уже попавший в копию данных сервиса, второй раз в архив каталога не кладётся.
 */
export function buildSnapshotScript({ runId, baseDir, items = [], consistency = 'none', minFreeKb, password = '', uploadUrl, name, manifest, includeData = true, selfId = '', mpMin, partMb }) {
  const slug = items[0]?.slug;
  let script = buildScript({ runId, baseDir, dest: 'local', keep: 1, minFreeKb, items, consistency, password: '', selfId, mpMin, partMb });
  script = script.replace(/echo DONE >> "\$ST"\n$/, '');
  const mv = [...new Set(items.map((j) => j.file))].map((f) => `mv ${shq(`${baseDir}/${slug}/${f}`)} "$PK/data/" || snap_fail "Не удалось подготовить $(basename ${shq(f)})"`);
  const covered = [...new Set(items.flatMap((j) => j.parts).filter((p) => p.kind === 'volume' && /^\/etc\/easypanel\/[A-Za-z0-9_./-]+$/.test(p.hostPath ?? '')).map((p) => p.hostPath.slice(1)))];
  const lines = [
    'snap_fail() { fail snapshot CMD "$1"; echo DONE >> "$ST"; exit 1; }',
    `if grep -q '^FAIL|' "$ST"; then snap_fail "Не все сервисы скопированы — переезд остановлен, чтобы не потерять данные"; fi`,
    'printf \'RUN|snapshot|pack\\n\' >> "$ST"',
    'ROOTDIR="${EA_MIGRATION_ROOT:-/}"; PK="$TMPD/$RUN.pack"; FINAL="$TMPD/$RUN.final"; PASSF2=""', // $RUN.* чистит trap
    'mkdir -p "$PK/data" || snap_fail "Не удалось создать рабочую папку"',
    "cat > \"$PK/manifest.json\" <<'EA_MANIFEST'", JSON.stringify(manifest), 'EA_MANIFEST',
    ...mv,
    `TAREX=(--no-wildcards --anchored${covered.map((x) => ` --exclude=${shq(x)}`).join('')})`,
    'tar -czf "$FINAL" "${TAREX[@]}" -C "$ROOTDIR" etc/easypanel -C "$PK" manifest.json data 2>"$LOGD/$RUN.err"; rc=$?', // 1 — «файл изменился при чтении» (живая LMDB), не ошибка
    '[ $rc -le 1 ] || snap_fail "Не удалось упаковать /etc/easypanel: $(tail -c 200 "$LOGD/$RUN.err" | tr \'\\n|\' \'  \')"',
    password ? `PASSF2="$LOGD/$RUN.pw"; printf %s ${shq(Buffer.from(password).toString('base64'))} | base64 -d > "$PASSF2"` : '',
    password ? 'openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass file:"$PASSF2" -in "$FINAL" -out "$FINAL.enc" 2>"$LOGD/$RUN.err" && mv "$FINAL.enc" "$FINAL" || snap_fail "Не удалось зашифровать слепок"' : '',
    'size=$(stat -c %s "$FINAL" 2>/dev/null || echo 0)',
    'printf \'RUN|snapshot|upload\\n\' >> "$ST"',
    `curl -sS -f --retry 3 -T "$FINAL" -o /dev/null ${shq(uploadUrl)} 2>"$LOGD/$RUN.err" || snap_fail "Не удалось отправить слепок в EasyAdmin: $(tail -c 200 "$LOGD/$RUN.err" | tr '\\n|' '  ')"`,
    `printf 'OK|snapshot|%s|%s\\n' ${shq(name)} "$size" >> "$ST"`,
    items.length ? `rmdir ${shq(`${baseDir}/${slug}`)} 2>/dev/null` : '',
    'echo DONE >> "$ST"',
  ];
  return `${script}${lines.filter(Boolean).join('\n')}\n`;
}

export function migrationRoutes(d) {
  const { db, key, config, manager, backups, audit, need, asHttp, addPanelRow, treeOf, hostRun, dataPollMs = 5000 } = d;
  const ssh = d.ssh ?? realSsh;
  const hostFn = (c, row, script, o) => (hostRun ?? runOnHost)(c, row, script, o);
  const now = () => Date.now();
  const dir = () => path.join(config.dataDir, 'migration');
  const jobs = new Map();

  /* ---------- состояние ---------- */
  const PUBLIC_FIELDS = ['id', 'kind', 'status', 'panelId', 'panelName', 'host', 'username', 'steps', 'log', 'warnings', 'error', 'createdAt', 'finishedAt', 'expiresAt', 'size', 'encrypted', 'baseUrl', 'newPanelId', 'includeData', 'sha', 'uploaded'];
  const save = (j) => {
    const data = JSON.stringify(Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, j[k]])));
    db.prepare('INSERT INTO migrations (id, ts, status, token_hash, upload_hash, token_enc, data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, token_hash = excluded.token_hash, upload_hash = excluded.upload_hash, token_enc = excluded.token_enc, data = excluded.data')
      .run(j.id, j.createdAt, j.status, j.token ? sha256(j.token) : null, j.utoken ? sha256(j.utoken) : null, j.token ? encrypt(key, JSON.stringify([j.token, j.utoken])) : null, data);
  };
  const fromRow = (r) => {
    const j = JSON.parse(r.data);
    try { [j.token, j.utoken] = JSON.parse(decrypt(key, r.token_enc)); } catch { /* ссылка уже погашена */ }
    return j;
  };
  const get = (id) => {
    if (jobs.has(id)) return jobs.get(id);
    const r = db.prepare('SELECT * FROM migrations WHERE id = ?').get(String(id)); if (!r) return null;
    const j = fromRow(r); jobs.set(j.id, j); return j;
  };
  const byToken = (token, field = 'token_hash') => {
    const t = String(token ?? ''); if (!/^[A-Za-z0-9_-]{20,100}$/.test(t)) return null;
    const r = db.prepare(`SELECT id FROM migrations WHERE ${field} = ?`).get(sha256(t)); const j = r ? get(r.id) : null;
    if (!j || j.expiresAt < now() || !['snapshot', 'ready', 'running'].includes(j.status)) return null;
    const mine = field === 'token_hash' ? j.token : j.utoken;
    return mine && crypto.timingSafeEqual(Buffer.from(sha256(mine)), Buffer.from(sha256(t))) ? j : null;
  };
  const log = (j, line) => { for (const l of String(line).split('\n')) { const t = l.trimEnd(); if (t) { j.log.push(t.slice(0, 400)); if (j.log.length > MAX_LOG) j.log.shift(); } } };
  const step = (j, id, status, detail) => { const s = j.steps.find((x) => x.id === id); if (!s) return; s.status = status; if (detail !== undefined) s.detail = detail; save(j); };
  const snapFile = (j) => path.join(dir(), `${j.id}.snap`);
  const dropFile = (j) => { for (const f of [snapFile(j), `${snapFile(j)}.part`]) fs.rmSync(f, { force: true }); };
  /** Ссылки гасятся при завершении: слепок после переезда удаляется, повторно по ссылке его не получить. */
  const finish = (j, status, error) => {
    j.status = status; if (error) j.error = error; j.finishedAt = now(); j.secrets = null;
    j.token = null; j.utoken = null; dropFile(j); save(j);
  };
  const view = (j) => ({
    ...Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, j[k]])), log: j.log.slice(-200),
    command: j.kind === 'oneliner' && j.token && ['ready', 'running'].includes(j.status) ? commandOf(j.baseUrl, j.token) : null,
  });
  const active = () => [...jobs.values()].some((j) => ['snapshot', 'running'].includes(j.status) && !j.abort);
  // после перезапуска EasyAdmin незавершённые задания остановлены (скрипт слепка и бутстрап на серверах от него не зависят, но ход не отслеживается)
  for (const r of db.prepare("SELECT * FROM migrations WHERE status IN ('snapshot','running')").all()) { const j = fromRow(r); j.status = 'interrupted'; j.error = 'EasyAdmin был перезапущен во время переезда'; finish(j, 'interrupted', j.error); }
  const sweep = setInterval(() => {
    for (const r of db.prepare("SELECT id FROM migrations WHERE status IN ('ready','snapshot')").all()) { const j = get(r.id); if (j && j.expiresAt < now()) { finish(j, 'expired', 'Срок действия ссылки истёк'); } }
    db.prepare('DELETE FROM migrations WHERE id NOT IN (SELECT id FROM migrations ORDER BY ts DESC LIMIT 50)').run();
    for (const [id, j] of jobs) if (j.finishedAt && now() - j.finishedAt > 3600_000) jobs.delete(id);
  }, 5 * 60_000); sweep.unref();

  function baseUrlOf(ctx, given) {
    let u = String(given || config.publicUrl || '').trim().replace(/\/+$/, '');
    if (!u) { const proto = String(ctx.req.headers['x-forwarded-proto'] ?? '').split(',')[0] || (ctx.req.socket.encrypted ? 'https' : 'http'); u = `${proto}://${ctx.req.headers.host}`; }
    need(BASE_URL.test(u), 'Укажите внешний адрес EasyAdmin, по которому его видят оба сервера (не localhost), например https://admin.example.com');
    return u;
  }

  function newJob(ctx, kind, row, extra = {}) {
    need(!active(), 'Уже идёт переезд — дождитесь его завершения или остановите');
    need([...jobs.values()].filter((j) => j.status === 'ready').length < 3, 'Накопилось несколько неиспользованных слепков — удалите ненужные');
    const c = backups.load();
    const id = crypto.randomBytes(8).toString('hex');
    const j = {
      id, kind, status: 'snapshot', panelId: row.id, panelName: row.name, host: extra.host ?? null, username: ctx.user.username, userId: ctx.user.id,
      steps: STEPS.map(([sid, label]) => ({ id: sid, label, status: kind === 'oneliner' && sid === 'connect' ? 'skipped' : 'pending', detail: null })),
      log: [], warnings: [], error: null, createdAt: now(), finishedAt: null, expiresAt: now() + config.migrationTtlMs, size: null, encrypted: !!c.password,
      baseUrl: extra.baseUrl, newPanelId: null, includeData: extra.includeData !== false, consistency: extra.consistency, sha: null, uploaded: false,
      token: crypto.randomBytes(24).toString('base64url'), utoken: crypto.randomBytes(24).toString('base64url'), abort: false, secrets: extra.secrets ?? null, ssh: extra.ssh ?? null,
    };
    jobs.set(id, j); save(j);
    return j;
  }

  /* ---------- слепок на сервере-источнике ---------- */
  async function makeSnapshot(j) {
    const c = backups.load(); const row = manager.getRow(j.panelId); need(row, 'Панель не найдена');
    const client = manager.clientFor(row);
    const baseDir = `${c.data.dir}/migration`; need(validDir(baseDir), 'Некорректная папка копий');
    step(j, 'snapshot', 'running', 'Готовлю список сервисов');
    const projects = await treeOf(row);
    const stamp = stampOf(now()); const mode = { mode: 'all', keys: [], consistency: j.consistency };
    let items = [];
    if (j.includeData) {
      const compose = needsDiscovery(projects, mode, row.id) ? parseDiscovery((await hostFn(client, row, DISCOVER_CMD, { timeoutMs: 60_000 }).catch(() => ({ output: '' }))).output) : [];
      items = (await resolveTargets(client, row, projects, mode, stamp, { compose, encrypt: false })).map((it) => ({ ...it }));
    }
    const name = `migration__${slugOf(row)}__${stamp}.tar.gz${c.password ? '.enc' : ''}`;
    const services = projects.flatMap((p) => p.services.map((s) => ({ project: p.name, service: s.name, type: s.type })));
    const manifest = { version: 1, kind: 'easyadmin-migration', createdAt: new Date(now()).toISOString(), stamp, source: { id: row.id, name: row.name, url: row.url }, encrypted: !!c.password, includeData: j.includeData, services, archives: items.map((it) => ({ service: it.label, file: it.file, parts: it.parts.map((p) => p.member) })) };
    const runId = `m${stamp}-${row.id}`;
    const script = buildSnapshotScript({ runId, baseDir, items, consistency: j.consistency, minFreeKb: c.data.minFreeMb * 1024, password: c.password, uploadUrl: `${j.baseUrl}/api/migration/upload?token=${j.utoken}`, name, manifest, includeData: j.includeData, selfId: process.env.HOSTNAME, mpMin: d.mpMin, partMb: d.partMb });
    await deployJob(client, row, { baseDir, runId, script }, hostFn);
    log(j, `Слепок запущен на сервере «${row.name}»: сервисов ${services.length}, архивов данных ${items.length}`);
    const labels = items.map((it) => it.label.replace(/\|/g, '/'));
    const t0 = now(); let st = { items: [], done: false, started: false };
    while (!st.done) {
      if (j.abort) throw new HttpError(499, 'Остановлено пользователем');
      await sleep(dataPollMs);
      try { st = await readStatus(client, row, baseDir, runId, hostFn); } catch { /* консоль отвечает с задержкой */ }
      const done = st.items.filter((x) => x.label !== 'snapshot' && x.ok).length;
      step(j, 'snapshot', 'running', st.current ? `${st.current.label === 'snapshot' ? (st.current.part === 'upload' ? 'Отправляю слепок в EasyAdmin' : 'Упаковываю слепок') : `Копирую ${st.current.label}`} (${done}/${labels.length})` : `Копирование: ${done}/${labels.length}`);
      if (!st.started && now() - t0 > 180_000) throw new HttpError(504, 'Скрипт слепка на сервере не стартовал');
      if (now() - t0 > 6 * 3600_000) throw new HttpError(504, 'Слепок делается слишком долго (больше 6 часов)');
    }
    cleanupJob(client, row, baseDir, runId, hostFn);
    const bad = st.items.find((x) => !x.ok);
    if (bad) throw new HttpError(502, `Слепок не сделан: ${bad.label === '*' || bad.label === 'snapshot' ? '' : `${bad.label}: `}${bad.error}`);
    for (const w of st.warns ?? []) j.warnings.push(`${w.label}: ${w.text}`);
    const ok = st.items.find((x) => x.ok && x.label === 'snapshot');
    need(ok && j.uploaded && fs.existsSync(snapFile(j)), 'Слепок не дошёл до EasyAdmin');
    step(j, 'snapshot', 'ok', `${(j.size / 1048576).toFixed(1)} МБ${c.password ? ', зашифрован' : ''}`);
  }

  /* ---------- переезд по SSH ---------- */
  const DOCKER_INSTALL = [
    'set -e', 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update -y', 'apt-get install -y curl ca-certificates openssl tar gzip iproute2',
    'if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi', 'systemctl enable --now docker', 'docker info >/dev/null',
  ].join('; ');

  async function runSsh(j, ctx) {
    const session = j.ssh; let tunnel = null;
    const guard = () => { if (j.abort) throw new HttpError(499, 'Остановлено пользователем'); };
    try {
      step(j, 'connect', 'running'); guard();
      const hello = await session.run('echo EA_HELLO', { timeoutMs: 30_000 });
      need(hello.stdout.includes('EA_HELLO'), 'Сервер не выполнил команду по SSH');
      step(j, 'connect', 'ok', `${j.secrets.user}@${j.host}`);

      step(j, 'precheck', 'running'); guard();
      const info = parseKv((await session.run(PRECHECK, { timeoutMs: 40_000 })).stdout);
      const checks = evaluate(info); const errors = checks.filter((x) => x.level === 'error');
      for (const w of checks.filter((x) => x.level === 'warn')) j.warnings.push(`${w.label}: ${w.detail}`);
      if (errors.length) throw new HttpError(400, `Сервер не подходит для переезда: ${errors.map((x) => `${x.label} — ${x.detail}`).join('; ')}`);
      step(j, 'precheck', 'ok', `${info.os} ${info.osver}, ${info.mem} МБ ОЗУ, ${info.disk} ГБ свободно`);

      step(j, 'install_docker_swarm', 'running'); guard();
      const inst = await session.run(DOCKER_INSTALL, { timeoutMs: 20 * 60_000, onData: (s) => log(j, s) });
      if (inst.code !== 0) throw new HttpError(502, `Не удалось установить Docker: ${(inst.stderr || inst.stdout).trim().slice(-200)}`);
      step(j, 'install_docker_swarm', 'ok', 'Docker готов; Swarm создаст установщик Easypanel');

      await makeSnapshot(j); guard();

      step(j, 'transfer', 'running', 'Запускаю загрузку на сервере');
      const pwFile = '/root/.easyadmin-migrate.pw';
      if (j.encrypted) {
        const pw = backups.load().password;
        const w = await session.run(`umask 077; printf %s ${shq(Buffer.from(pw).toString('base64'))} | base64 -d > ${pwFile}`, { timeoutMs: 20_000 });
        if (w.code !== 0) throw new HttpError(502, 'Не удалось передать пароль слепка на сервер');
      }
      const boot = `curl -fsSL ${j.baseUrl}/api/migration/bootstrap.sh?token=${j.token} | EA_MIGRATION_PASSWORD_FILE=${pwFile} bash`;
      const start = await session.run(`if systemctl is-active --quiet easyadmin-migrate 2>/dev/null; then echo EA_RUNNING; exit 1; fi; `
        + `if command -v systemd-run >/dev/null 2>&1; then systemd-run --unit=easyadmin-migrate --collect --description="EasyAdmin: migration" bash -c ${shq(boot)} >/dev/null 2>&1 && echo EA_STARTED; `
        + `else (nohup bash -c ${shq(boot)} >/var/log/easyadmin-migration.out 2>&1 &); echo EA_STARTED; fi`, { timeoutMs: 40_000 });
      if (!start.stdout.includes('EA_STARTED')) throw new HttpError(502, start.stdout.includes('EA_RUNNING') ? 'На сервере уже идёт переезд' : 'Не удалось запустить загрузку на сервере');
      j.status = 'running'; j.boot = { done: false, error: null, lastAt: now() }; save(j);
      const t0 = now();
      while (!j.boot.done) {
        guard();
        if (j.boot.error) throw new HttpError(502, j.boot.error);
        if (now() - t0 > 3 * 3600_000) throw new HttpError(504, 'Переезд на сервере идёт слишком долго (3 часа)');
        await sleep(j.pollMs ?? 3000);
        if (now() - j.boot.lastAt > (j.silentMs ?? 10 * 60_000)) { // скрипт молчит: жив ли юнит?
          const st = await session.run('systemctl is-active easyadmin-migrate 2>/dev/null; journalctl -u easyadmin-migrate --no-pager -n 15 -o cat 2>/dev/null', { timeoutMs: 30_000 }).catch(() => null);
          if (st && !/^(active|activating)/.test(st.stdout.trim())) throw new HttpError(502, `Скрипт на сервере остановился: ${st.stdout.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
          j.boot.lastAt = now();
        }
      }
      if (j.encrypted) await session.run(`shred -u ${pwFile} 2>/dev/null || rm -f ${pwFile}`, { timeoutMs: 20_000 }).catch(() => {});
      step(j, 'unpack_and_start', 'ok', 'Easypanel запущен на новом сервере');

      /* --- проверка панели через туннель: токены переехали вместе с /etc/easypanel --- */
      step(j, 'verify', 'running'); guard();
      const row = manager.getRow(j.panelId); const srcToken = manager.clientFor(row).token;
      tunnel = await session.tunnel(3000);
      const api = new PanelClient({ url: tunnel.url, token: srcToken, timeoutMs: 25_000 });
      let projects = null;
      for (let i = 0; i < (j.verifyTries ?? 20) && !projects; i++) { try { projects = await api.query('projects.listProjects'); } catch { guard(); await sleep(j.pollMs ?? 3000); } }
      if (!projects) throw new HttpError(502, 'Новая панель не принимает токен старой: проверьте журнал /var/log/easyadmin-migration.log на сервере');
      const src = (await treeOf(row)).flatMap((p) => p.services.map((s) => ({ project: p.name, name: s.name, type: s.type })));
      // сервисы, которых на новом сервере ещё нет в Swarm, разворачиваем; базы поднимаем (deploy к ним неприменим)
      const have = new Set((await session.run("docker service ls --format '{{.Name}}'", { timeoutMs: 30_000 })).stdout.split('\n').map((x) => x.trim()).filter(Boolean));
      const missing = src.filter((s) => !have.has(`${s.project}_${s.name}`));
      let redeployed = 0;
      for (let i = 0; i < missing.length; i += 3) {
        await Promise.all(missing.slice(i, i + 3).map(async (s) => {
          try { await runAction(api, { type: s.type, project: s.project, name: s.name, action: ['app', 'compose'].includes(s.type) ? 'deploy' : 'start' }); redeployed++; }
          catch (e) { j.warnings.push(`${s.project}/${s.name}: не удалось развернуть (${e.message})`); }
        }));
        guard();
      }
      if (missing.length) {
        log(j, `Развёрнуто сервисов: ${redeployed} из ${missing.length}`);
        if (j.includeData) { const r = await session.run('[ -x /root/easyadmin-migration/restore-databases.sh ] && bash /root/easyadmin-migration/restore-databases.sh', { timeoutMs: 30 * 60_000, onData: (s) => log(j, s) }).catch((e) => ({ code: 1, stderr: e.message })); if (r.code !== 0) j.warnings.push('Восстановление баз после развёртывания не завершилось — выполните на новом сервере: bash /root/easyadmin-migration/restore-databases.sh'); }
      }
      step(j, 'verify', 'ok', `Панель отвечает, токен старой панели принят; сервисов в панели: ${src.length}`);

      if (j.addPanel !== false) {
        const url = `http://${j.host}:3000`;
        const nr = addPanelRow({ name: `${row.name} (новый сервер)`, url, token: srcToken, color: row.color, tags: row.tags, notes: `Переезд из EasyAdmin ${new Date().toISOString().slice(0, 10)} с «${row.name}»` });
        j.newPanelId = nr.id; j.warnings.push(`Новая панель добавлена в EasyAdmin по адресу ${url}. Когда перенесёте DNS-записи доменов на новый сервер, поменяйте адрес панели в настройках.`);
      }
      finish(j, 'done'); audit(ctx, { action: 'migration.done', panel: row, target: j.host, detail: `сервисов: ${src.length}` });
    } catch (e) {
      const running = j.steps.find((x) => x.status === 'running'); if (running) step(j, running.id, 'error', e.message);
      finish(j, j.abort ? 'aborted' : 'error', j.abort ? 'Остановлено. Скрипт на новом сервере мог продолжиться (юнит easyadmin-migrate).' : e.message);
      audit(ctx, { action: 'migration.failed', panel: manager.getRow(j.panelId) ?? undefined, target: j.host, ok: false, detail: j.error });
    } finally {
      try { tunnel?.close(); } catch { /* закрыт */ }
      try { session.close(); } catch { /* закрыт */ }
    }
  }

  /* ---------- маршруты ---------- */
  const consistencyOf = (v) => { const x = v ?? 'none'; need(['none', 'pause'].includes(x), 'Согласованность: none или pause'); return x; };
  const panelOf = (ctx, id) => { const row = manager.getRow(Number(id)); need(row, 'Выберите панель — источник переезда'); return row; };
  const fileHeaders = (j) => ({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'X-Snapshot-Sha256': j.sha ?? '', 'X-Content-Type-Options': 'nosniff' });

  return [
    ['GET', '/api/migration', (ctx) => {
      const c = backups.load();
      return {
        jobs: db.prepare('SELECT id FROM migrations ORDER BY ts DESC LIMIT 20').all().map((r) => { const j = get(r.id); return { id: j.id, kind: j.kind, status: j.status, panelName: j.panelName, host: j.host, createdAt: j.createdAt, finishedAt: j.finishedAt, error: j.error }; }),
        defaults: { baseUrl: config.publicUrl || null, encrypted: !!c.password, maxGb: Math.round(config.migrationMaxBytes / 1024 ** 3) },
      };
    }, { admin: true }],

    ['POST', '/api/migration/ssh/scan', async (ctx) => {
      const t = checkTarget(ctx.body?.host, ctx.body?.port);
      try { const r = await ssh.scanHostKeys(t.host, t.port); return { host: r.host, port: r.port, keys: r.keys.map((k) => ({ type: k.type, fingerprint: k.fingerprint })) }; } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    // переезд по SSH: все данные формы проверяются до запуска; пароль SSH и пароль копий остаются в памяти
    ['POST', '/api/migration/ssh', async (ctx) => {
      const b = ctx.body ?? {}; const t = checkTarget(b.host, b.port); const user = checkUser(b.user ?? 'root');
      need(b.auth?.password || b.auth?.privateKey, 'Укажите пароль или приватный ключ SSH');
      const row = panelOf(ctx, b.panelId); const baseUrl = baseUrlOf(ctx, b.baseUrl); const consistency = consistencyOf(b.consistency);
      let scan; try { scan = await ssh.scanHostKeys(t.host, t.port); } catch (e) { throw asHttp(e); }
      const hostKey = scan.keys.find((k) => k.fingerprint === String(b.fingerprint ?? ''));
      need(hostKey, 'Отпечаток ключа сервера не совпадает с подтверждённым — возможна подмена, начните заново');
      let session;
      try { session = ssh.openSession({ host: t.host, port: t.port, user, auth: { password: b.auth.password || undefined, privateKey: b.auth.privateKey || undefined, passphrase: b.auth.passphrase || undefined }, hostKey }); }
      catch (e) { throw asHttp(e); }
      let j;
      try { j = newJob(ctx, 'ssh', row, { host: t.host, baseUrl, consistency, includeData: b.includeData !== false, ssh: session, secrets: { user } }); }
      catch (e) { session.close(); throw e; }
      j.addPanel = b.addPanel !== false; j.pollMs = d.installPollMs; j.silentMs = d.migrationSilentMs; j.verifyTries = d.installHttpsTries;
      audit(ctx, { action: 'migration.start', panel: row, target: t.host, detail: `по SSH, данные: ${j.includeData ? 'да' : 'нет'}` });
      runSsh(j, ctx);
      return { id: j.id };
    }, { admin: true }],

    // «одной командой»: делаем слепок и выдаём команду для нового сервера
    ['POST', '/api/migration/snapshot', async (ctx) => {
      const b = ctx.body ?? {}; const row = panelOf(ctx, b.panelId); const baseUrl = baseUrlOf(ctx, b.baseUrl);
      const j = newJob(ctx, 'oneliner', row, { baseUrl, consistency: consistencyOf(b.consistency), includeData: b.includeData !== false });
      audit(ctx, { action: 'migration.snapshot', panel: row, target: row.name, detail: `данные: ${j.includeData ? 'да' : 'нет'}` });
      (async () => {
        try { await makeSnapshot(j); j.status = 'ready'; step(j, 'transfer', 'pending', 'Ждёт команды на новом сервере'); save(j); }
        catch (e) { const running = j.steps.find((x) => x.status === 'running'); if (running) step(j, running.id, 'error', e.message); finish(j, j.abort ? 'aborted' : 'error', j.abort ? 'Остановлено' : e.message); audit(ctx, { action: 'migration.failed', panel: row, target: row.name, ok: false, detail: j.error }); }
      })();
      return { id: j.id };
    }, { admin: true }],

    /* --- вызовы с нового сервера и с сервера-источника: по одноразовому токену, без входа и CSRF --- */
    ['GET', '/api/migration/bootstrap.sh', (ctx) => {
      const j = byToken(ctx.url.searchParams.get('token'));
      if (!j || j.status === 'snapshot') throw new HttpError(404, 'Не найдено');
      return new RawResponse(bootstrapScript({ baseUrl: j.baseUrl, token: j.token, encrypted: j.encrypted }), 'text/x-shellscript; charset=utf-8');
    }, { public: true }],

    ['PUT', '/api/migration/upload', async (ctx) => {
      const j = byToken(ctx.url.searchParams.get('token'), 'upload_hash');
      if (!j || j.status !== 'snapshot' || j.uploaded) throw new HttpError(404, 'Не найдено');
      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
      const part = `${snapFile(j)}.part`; const hash = crypto.createHash('sha256'); let n = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part, { mode: 0o600 });
        const bail = (e) => { out.destroy(); fs.rmSync(part, { force: true }); reject(e); };
        ctx.req.on('data', (chunk) => { n += chunk.length; if (n > config.migrationMaxBytes) { bail(new HttpError(413, 'Слепок больше допустимого размера')); ctx.req.destroy(); } else hash.update(chunk); });
        ctx.req.on('error', bail); ctx.req.on('aborted', () => bail(new HttpError(400, 'Загрузка прервана')));
        out.on('error', bail); out.on('finish', resolve);
        ctx.req.pipe(out);
      });
      need(n > 0, 'Пустой слепок');
      fs.renameSync(part, snapFile(j));
      j.size = n; j.sha = hash.digest('hex'); j.uploaded = true; save(j);
      return { ok: true, size: n };
    }, { hook: true, raw: true }],

    ['POST', '/api/migration/report', (ctx) => {
      const j = byToken(ctx.url.searchParams.get('token'));
      if (!j || !['ready', 'running'].includes(j.status)) throw new HttpError(404, 'Не найдено');
      const b = ctx.body ?? {}; const stepId = String(b.step ?? ''); const status = String(b.status ?? ''); const detail = String(b.detail ?? '').slice(0, 400);
      need(REPORT_STATUS.has(status), 'Некорректный статус');
      if (j.boot) j.boot.lastAt = now();
      if (j.status === 'ready') { j.status = 'running'; j.boot = { done: false, error: null, lastAt: now() }; }
      if (stepId === 'log') { log(j, detail); save(j); return { ok: true }; }
      if (stepId === 'done') {
        log(j, `Готово: ${detail}`); j.boot ??= { done: false }; j.boot.done = true; j.url = detail;
        if (j.kind === 'oneliner') { j.steps.filter((s) => s.status === 'running' || s.status === 'pending').forEach((s) => { s.status = 'ok'; }); finish(j, 'done'); } else save(j);
        return { ok: true };
      }
      need(STEP_IDS.has(stepId), 'Неизвестный шаг');
      if (j.kind === 'ssh' && stepId === 'verify' && status === 'ok') { log(j, detail); return { ok: true }; } // итог проверки — за EasyAdmin
      const mapped = status === 'info' ? 'running' : status;
      if (stepId !== 'snapshot') step(j, stepId, mapped, detail);
      if (status === 'error') {
        log(j, `Ошибка (${stepId}): ${detail}`);
        if (j.kind === 'oneliner') finish(j, 'error', detail); else { j.boot ??= {}; j.boot.error = detail; save(j); }
      } else if (j.kind === 'oneliner' && stepId === 'transfer' && status === 'ok') step(j, 'unpack_and_start', 'running');
      return { ok: true };
    }, { hook: true }],

    ['HEAD', '/api/migration/snapshot', (ctx) => {
      const j = byToken(ctx.url.searchParams.get('token'));
      if (!j || !j.uploaded || !fs.existsSync(snapFile(j))) throw new HttpError(404, 'Не найдено');
      return new StreamResponse(async (req, res) => { res.writeHead(200, { ...fileHeaders(j), 'Content-Length': fs.statSync(snapFile(j)).size }); res.end(); });
    }, { hook: true, raw: true }],

    ['GET', '/api/migration/snapshot', (ctx) => {
      const j = byToken(ctx.url.searchParams.get('token'));
      if (!j || !j.uploaded || !fs.existsSync(snapFile(j))) throw new HttpError(404, 'Не найдено');
      return new StreamResponse(async (req, res) => {
        const size = fs.statSync(snapFile(j)).size; const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
        const from = m ? Number(m[1]) : 0;
        if (from >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        res.writeHead(m ? 206 : 200, { ...fileHeaders(j), 'Content-Length': size - from, ...(m ? { 'Content-Range': `bytes ${from}-${size - 1}/${size}` } : {}) });
        fs.createReadStream(snapFile(j), { start: from }).on('error', () => res.destroy()).pipe(res);
      });
    }, { public: true }],

    /* --- ход и остановка --- */
    ['GET', '/api/migration/:id', (ctx) => { const j = get(ctx.params.id); if (!j) throw new HttpError(404, 'Переезд не найден'); return view(j); }, { admin: true }],
    ['DELETE', '/api/migration/:id', async (ctx) => {
      const j = get(ctx.params.id); if (!j) throw new HttpError(404, 'Переезд не найден');
      if (['snapshot', 'running'].includes(j.status)) { j.abort = true; if (j.kind === 'oneliner') finish(j, 'aborted', 'Остановлено'); audit(ctx, { action: 'migration.abort', target: j.host ?? j.panelName }); return { ok: true, aborting: true }; }
      if (j.status === 'ready') finish(j, 'aborted', 'Слепок удалён');
      return { ok: true };
    }, { admin: true }],
  ];
}
