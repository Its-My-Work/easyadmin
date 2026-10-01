import { kindOf, listOf } from './backup-overview.js';
import { makeLicense } from './panel-license.js';

/**
 * Расписания бэкапов Easypanel под управлением EasyAdmin.
 * Администратор один раз задаёт политику (какие сервисы, как часто, сколько копий хранить), а EasyAdmin приводит к ней панели:
 * создаёт расписания в самих панелях, обновляет их при смене политики и удаляет, когда сервис выведен из охвата или способ выключен.
 * Трогаем только то, что создали сами (список запомнен в settings.backup_ep_managed): свои расписания администратора остаются как есть,
 * а если у сервиса уже есть включённое собственное расписание для той же базы или тома, второе не создаётся.
 * Копии делает сама панель в своём хранилище: пароль EasyAdmin на них не распространяется, шифрование — на стороне хранилища.
 */
const MANAGED_KEY = 'backup_ep_managed';
const LAST_KEY = 'backup_ep_last';
const OPS = {
  db: { list: 'databaseBackups.listDatabaseBackups', create: 'databaseBackups.createDatabaseBackup', update: 'databaseBackups.updateDatabaseBackup', del: 'databaseBackups.deleteDatabaseBackup', field: 'databaseName', fields: ['enabled', 'schedule', 'storageProviderId', 'storageProviderPath', 'retention'] },
  volume: { list: 'volumeBackups.listVolumeBackups', create: 'volumeBackups.createVolumeBackup', update: 'volumeBackups.updateVolumeBackup', del: 'volumeBackups.destroyVolumeBackup', field: 'volumeName', fields: ['enabled', 'schedule', 'storageProviderId', 'storageProviderPath'] },
};
const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
const nameOf = (x) => (typeof x === 'string' ? x : x?.name ?? x?.databaseName ?? x?.volumeName ?? '');

/** Расписание политики → cron панели: каждый день или раз в неделю (по понедельникам) в нужный час. */
export const cronOf = (c) => (c.every === 'weekly' ? `0 ${c.hour} * * 1` : `0 ${c.hour} * * *`);
export const wantsEasypanel = (c) => c.data.mode !== 'none' && !!c.data.methods?.easypanel;
export const inScope = (c, panelId, project, service) => c.data.mode === 'all' || (c.data.mode === 'selected' && c.data.keys.includes(`${panelId}|${project}|${service}`));
const panelInScope = (c, panelId) => c.data.mode === 'all' || (c.data.mode === 'selected' && c.data.keys.some((k) => k.startsWith(`${panelId}|`)));

async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export function createEpSync({ db, manager, getRaw, setRaw, load, audit, now = () => Date.now() }) {
  const lic = makeLicense({ manager });
  const read = (k, d) => { try { return JSON.parse(getRaw(k) ?? 'null') ?? d; } catch { return d; } };
  const managed = () => read(MANAGED_KEY, []);
  const last = () => read(LAST_KEY, null);
  let pending = 0; let chain = Promise.resolve();

  async function providersOf(row) {
    const r = await manager.clientFor(row).query('storageProviders.common.listOptions');
    return listOf(r).map((o) => ({ id: String(o.value ?? o.id ?? ''), name: o.label ?? o.name ?? '' })).filter((o) => o.id);
  }
  const pick = (cfg, row, providers) => providers.find((p) => p.id === cfg.data.providers?.[row.id]) ?? (providers.length === 1 ? providers[0] : null);

  /** Для экрана настройки: у каждой панели из охвата — список хранилищ и то, какое будет использовано. */
  async function providers({ panelIds = null } = {}) {
    const cfg = load();
    const rows = db.prepare('SELECT * FROM panels ORDER BY position, id').all().filter((r) => (panelIds ? panelIds.includes(r.id) : panelInScope(cfg, r.id)));
    return Promise.all(rows.map(async (row) => {
      try { const list = await providersOf(row); return { panelId: row.id, name: row.name, providers: list, selected: pick(cfg, row, list)?.id ?? null, chosen: cfg.data.providers?.[row.id] ?? null }; }
      catch (e) { return { panelId: row.id, name: row.name, providers: [], selected: null, chosen: null, error: e.message }; }
    }));
  }

  async function syncPanel(cfg, row, prev) {
    const rep = { id: row.id, name: row.name, created: 0, updated: 0, removed: 0, unchanged: 0, notes: [], error: null };
    const next = []; const client = manager.clientFor(row);
    const snap = await manager.snapshot(row.id);
    if (!snap || !['online', 'degraded'].includes(snap.status)) { rep.error = snap?.error || 'Панель недоступна'; return { rep, next: prev }; }
    const services = wantsEasypanel(cfg)
      ? snap.tree.projects.flatMap((p) => p.services.map((s) => ({ project: p.name, name: s.name, type: s.type }))).filter((s) => kindOf(s.type) && inScope(cfg, row.id, s.project, s.name)) : [];
    const wanted = new Set(services.map((s) => `${s.project}|${s.name}`));

    /** Удаляет расписание, созданное нами. false — не вышло, запись остаётся в списке управляемых. */
    const drop = async (m, label) => {
      try { await client.mutate(OPS[m.kind].del, { id: m.id }); rep.removed++; return true; }
      catch (e) {
        const still = await client.query(OPS[m.kind].list, { projectName: m.project, serviceName: m.service }).then((l) => listOf(l).some((x) => String(x.id) === m.id), () => true);
        if (!still) return true; // расписания уже нет (удалено вручную или вместе с сервисом)
        rep.notes.push(`${label}: не удалось удалить расписание — ${e.message}`); return false;
      }
    };

    for (const m of prev) if (!wanted.has(`${m.project}|${m.service}`) && !(await drop(m, `${m.project}/${m.service}`))) next.push(m);
    if (!services.length) return { rep, next };

    let provs = null;
    try { provs = await providersOf(row); } catch (e) { rep.notes.push(`Хранилища панели недоступны: ${e.message}`); }
    const prov = provs ? pick(cfg, row, provs) : null;
    if (!prov) {
      if (provs) rep.error = provs.length ? 'Выберите хранилище для копий этой панели' : 'В панели нет хранилища бэкапов — добавьте его в настройках панели';
      else rep.error = 'Не удалось получить список хранилищ панели';
      return { rep, next: [...next, ...prev.filter((m) => wanted.has(`${m.project}|${m.service}`))] };
    }
    let dbLicense = null;
    const hasDbLicense = async () => (dbLicense ??= await lic.has(row, client, 'databaseBackups').catch(() => false));

    await mapLimit(services, 4, async (s) => {
      const kind = kindOf(s.type); const op = OPS[kind]; const label = `${s.project}/${s.name}`; const sel = { projectName: s.project, serviceName: s.name };
      const mine = prev.filter((m) => m.project === s.project && m.service === s.name);
      if (kind === 'db' && !(await hasDbLicense())) { next.push(...mine); rep.notes.push(`${label}: без лицензии Easypanel расписания баз не выполняются — для баз включите копии EasyAdmin`); return; }
      let existing; let targets;
      try {
        existing = listOf(await client.query(op.list, sel));
        targets = kind === 'db' ? listOf(await client.query('databaseBackups.getServiceDatabases', sel), 'databases').map(nameOf) : listOf(await client.query('volumeBackups.listVolumeMounts', sel), 'mounts').map(nameOf);
        targets = [...new Set(targets.filter(Boolean))];
      } catch (e) { next.push(...mine); rep.notes.push(`${label}: ${e.message}`); return; }
      if (!targets.length) rep.notes.push(kind === 'db' ? `${label}: в сервисе нет баз данных для копирования` : `${label}: нет томов для копирования — Easypanel копирует только тома (Volume mount), файловые и bind-монтирования не поддерживаются`);
      for (const m of mine) if (!targets.includes(m.target) && !(await drop(m, label))) next.push(m);
      for (const t of targets) {
        const want = { enabled: cfg.enabled, schedule: cronOf(cfg), storageProviderId: prov.id, storageProviderPath: `${safe(s.project)}/${safe(s.name)}/${safe(t)}`, [op.field]: t, ...(kind === 'db' ? { retention: cfg.data.keep } : {}) };
        const m = mine.find((x) => x.target === t); const cur = m ? existing.find((x) => String(x.id) === m.id) : null;
        try {
          if (cur) {
            if (op.fields.some((k) => String(cur[k] ?? '') !== String(want[k] ?? ''))) { await client.mutate(op.update, { id: m.id, ...sel, ...want }); rep.updated++; } else rep.unchanged++;
            next.push(m); continue;
          }
          if (existing.some((x) => x[op.field] === t && x.enabled)) { rep.notes.push(`${label} · ${t}: уже есть своё расписание Easypanel — оставлено как есть`); continue; }
          const before = new Set(existing.map((x) => String(x.id)));
          await client.mutate(op.create, { ...sel, ...want }); rep.created++;
          const fresh = listOf(await client.query(op.list, sel)).find((x) => !before.has(String(x.id)) && x[op.field] === t);
          if (fresh) next.push({ panelId: row.id, project: s.project, service: s.name, kind, target: t, id: String(fresh.id) });
          else rep.notes.push(`${label} · ${t}: расписание создано, но найти его не удалось — им придётся управлять вручную`);
        } catch (e) { if (m && cur) next.push(m); rep.notes.push(`${label} · ${t}: ${e.message}`); }
      }
    });
    return { rep, next };
  }

  async function run({ reason, panelIds, ctx }) {
    const t = now(); const cfg = load(); const prevAll = managed();
    const rows = db.prepare('SELECT * FROM panels ORDER BY id').all();
    const known = new Set(rows.map((r) => r.id)); const has = new Set(prevAll.map((m) => m.panelId));
    const targets = rows.filter((r) => (!panelIds || panelIds.includes(r.id)) && (has.has(r.id) || (wantsEasypanel(cfg) && panelInScope(cfg, r.id))));
    const done = new Set(targets.map((r) => r.id));
    let nextAll = prevAll.filter((m) => known.has(m.panelId) && !done.has(m.panelId)); // удалённые панели из списка убираем, остальные не затронутые — оставляем
    const panels = [];
    await mapLimit(targets, 2, async (row) => {
      const prev = prevAll.filter((m) => m.panelId === row.id); let out;
      try { out = await syncPanel(cfg, row, prev); }
      catch (e) { out = { rep: { id: row.id, name: row.name, created: 0, updated: 0, removed: 0, unchanged: 0, notes: [], error: e.message }, next: prev }; }
      finally { manager.invalidate(row.id); }
      nextAll = nextAll.concat(out.next); panels.push(out.rep);
      const r = out.rep;
      if (r.created || r.updated || r.removed || r.error) audit?.(ctx ?? {}, { action: 'backup.ep_sync', panel: row, target: row.name, ok: !r.error, detail: r.error ?? `создано ${r.created}, обновлено ${r.updated}, удалено ${r.removed}` });
    });
    setRaw(MANAGED_KEY, JSON.stringify(nextAll));
    panels.sort((a, b) => a.id - b.id);
    const before = panelIds ? last()?.panels ?? [] : []; // частичный запуск обновляет только свои панели в общем отчёте
    const merged = [...before.filter((p) => !done.has(p.id) && known.has(p.id)), ...panels].sort((a, b) => a.id - b.id);
    const res = { ts: t, reason, ok: merged.every((p) => !p.error), panels: merged };
    setRaw(LAST_KEY, JSON.stringify(res));
    return res;
  }

  /** Приводит расписания в панелях к политике. Запуски выстраиваются в очередь, чтобы не мешать друг другу. */
  function sync(o = {}) {
    pending++;
    const p = chain.then(() => run(o), () => run(o)).finally(() => { pending--; });
    chain = p.catch(() => {});
    return p;
  }

  return {
    sync, providers, last, managedCount: () => managed().length,
    busy: () => pending > 0,
    /** Ключи «панель:id» расписаний, созданных EasyAdmin (для отметки в обзоре). */
    managedKeys: () => new Set(managed().map((m) => `${m.panelId}:${m.id}`)),
  };
}
