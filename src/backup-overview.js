import { parseTs } from './ts.js';

/**
 * Обзор копирования: по каждому сервису всех панелей — чем он копируется (расписания самой Easypanel и/или копии данных EasyAdmin),
 * когда был последний запуск и чем он закончился. Ничего не меняет, только читает панели и настройки.
 */
const DB_TYPES = ['postgres', 'mysql', 'mariadb', 'mongo']; // у Easypanel расписания баз — только для этих типов
export const listOf = (v, ...keys) => (Array.isArray(v) ? v : keys.map((k) => v?.[k]).find(Array.isArray) ?? []);
export const kindOf = (type) => (DB_TYPES.includes(type) ? 'db' : type === 'app' || type === 'box' ? 'volume' : null);
const STALE_MS = 8 * 86_400_000; // успешной копии давно не было
const CACHE_MS = 60_000;

const tsOf = (a) => parseTs(a?.finishedAt ?? a?.createdAt ?? a?.startedAt ?? a?.date);
/** Статус действия панели → ok | error | running. */
export const actionState = (st) => (/fail|error|cancel|kill|abort/i.test(String(st ?? '')) ? 'error' : /done|succe|complet|finish|\bok\b/i.test(String(st ?? '')) ? 'ok' : 'running');

async function mapLimit(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/** Итоговый статус сервиса по двум источникам. */
export function combine({ easypanel, easyadmin }, now) {
  const scheduledEp = easypanel.schedules.some((x) => x.enabled);
  const covered = scheduledEp || easyadmin.covered;
  if (!covered) return easypanel.supported || easyadmin.possible ? 'none' : 'na';
  const lasts = [easypanel.last, easyadmin.last].filter(Boolean);
  if (lasts.some((x) => x.state === 'error')) return 'error';
  if (easypanel.last?.state === 'running') return 'running';
  const okTs = Math.max(0, ...lasts.filter((x) => x.state === 'ok').map((x) => x.ts ?? now)); // успешный запуск без даты считаем свежим
  if (!okTs) return 'pending';
  return now - okTs > STALE_MS ? 'stale' : 'ok';
}

export function createBackupOverview({ db, manager, backups, treeOf, now = () => Date.now() }) {
  const cache = new Map(); // panelId → { at, rows, error }

  async function serviceEasypanel(c, project, svc) {
    const kind = kindOf(svc.type);
    if (!kind) return { supported: false, kind: null, schedules: [], last: null, noData: false };
    const sel = { projectName: project, serviceName: svc.name };
    const [sch, acts] = await Promise.all([
      c.query(kind === 'db' ? 'databaseBackups.listDatabaseBackups' : 'volumeBackups.listVolumeBackups', sel).then((r) => ({ r }), (e) => ({ e })),
      c.query('actions.listActions', { limit: 30, ...sel }).then((r) => ({ r }), () => ({ r: [] })),
    ]);
    if (sch.e) return { supported: true, kind, schedules: [], last: null, noData: false, error: sch.e.message };
    const schedules = listOf(sch.r).map((x) => ({ id: String(x.id ?? ''), schedule: x.schedule ?? '', enabled: !!x.enabled, target: x.databaseName ?? x.volumeName ?? '' }));
    const bk = listOf(acts.r, 'actions').filter((a) => a?.type === 'backup').sort((a, b) => (tsOf(b) ?? 0) - (tsOf(a) ?? 0))[0];
    let noData = false;
    if (kind === 'volume' && !schedules.length) { // у приложения без томов копировать нечего — не считаем это упущением
      const m = await c.query('volumeBackups.listVolumeMounts', sel).then((r) => listOf(r, 'mounts'), () => null);
      noData = Array.isArray(m) && m.length === 0;
    }
    return { supported: true, kind, schedules, noData, last: bk ? { state: actionState(bk.status), status: String(bk.status ?? ''), ts: tsOf(bk), description: bk.description ?? null } : null };
  }

  async function panelRows(row) {
    const projects = await treeOf(row);
    const c = manager.clientFor(row);
    const items = projects.flatMap((p) => p.services.map((s) => ({ project: p.name, svc: s })));
    return mapLimit(items, 5, async ({ project, svc }) => ({ project, name: svc.name, type: svc.type, easypanel: await serviceEasypanel(c, project, svc).catch((e) => ({ supported: true, kind: kindOf(svc.type), schedules: [], last: null, noData: false, error: e.message })) }));
  }

  /** Часть EasyAdmin: входит ли сервис в копии данных и чем закончился последний запуск. */
  function easyadminOf(row, project, name, type, s) {
    const d = s.data; const key = `${row.id}|${project}|${name}`;
    const inScope = d.mode === 'all' || (d.mode === 'selected' && d.keys.includes(key));
    const covered = inScope && d.methods.easyadmin; // способ можно выключить, не трогая охват
    const dl = s.dataLast; const label = `${project}/${name}`;
    const panel = dl?.panels?.find((p) => p.name === row.name);
    const failed = !!panel?.failed?.some((f) => String(f).startsWith(label));
    const last = covered && dl ? { state: failed || panel?.error ? 'error' : 'ok', ts: dl.ts, error: panel?.failed?.find((f) => String(f).startsWith(label)) ?? panel?.error ?? null } : null;
    return { covered, auto: !!s.enabled && covered, possible: true, last, planned: inScope && d.methods.easypanel };
  }

  async function overview(accessiblePanels, { force = false } = {}) {
    const s = backups.view(); const t = now(); const managed = backups.epManaged?.() ?? new Set();
    const panels = await Promise.all(accessiblePanels.map(async (row) => {
      const up = ['online', 'degraded'].includes(row.status);
      if (!up) return { panelId: row.id, panelName: row.name, color: row.color, error: row.last_error || 'Панель недоступна', rows: [] };
      let hit = cache.get(row.id);
      if (force || !hit || t - hit.at > CACHE_MS) {
        try { hit = { at: t, rows: await panelRows(row) }; } catch (e) { hit = { at: t, rows: [], error: e.message }; }
        cache.set(row.id, hit);
      }
      const rows = hit.rows.map((r) => {
        const { planned, ...easyadmin } = easyadminOf(row, r.project, r.name, r.type, s);
        const easypanel = { ...r.easypanel, planned: planned && r.easypanel.supported, schedules: r.easypanel.schedules.map((x) => ({ ...x, managed: managed.has(`${row.id}:${x.id}`) })) };
        return { ...r, easypanel, easyadmin, status: combine({ easypanel, easyadmin }, t) };
      }).filter((r) => !(r.status === 'na' || (r.status === 'none' && r.easypanel.noData && !r.easyadmin.possible)));
      return { panelId: row.id, panelName: row.name, color: row.color, error: hit.error ?? null, rows };
    }));
    const all = panels.flatMap((p) => p.rows);
    const count = (st) => all.filter((r) => r.status === st).length;
    return { panels, summary: { total: all.length, none: count('none'), error: count('error'), stale: count('stale'), pending: count('pending'), running: count('running'), ok: count('ok') }, at: t };
  }

  return { overview, forget: (id) => cache.delete(id) };
}

export function backupOverviewRoutes(d) {
  const { db, backups, canPanel } = d;
  const ov = createBackupOverview(d);
  return [
    ['GET', '/api/backups/overview', async (ctx) => {
      const panels = db.prepare('SELECT * FROM panels ORDER BY position, id').all().filter((p) => canPanel(ctx.user, p.id));
      return ov.overview(panels, { force: ctx.url.searchParams.get('force') === '1' });
    }, { admin: true }],
  ];
}
