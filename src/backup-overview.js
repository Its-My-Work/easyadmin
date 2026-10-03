/**
 * Обзор копирования EasyAdmin: по каждому сервису всех панелей — входит ли он в копии, когда и чем закончилась последняя копия.
 * Ничего не запрашивает у панелей (кроме списка сервисов из кэша): результаты копирования хранятся в EasyAdmin.
 */
const STALE_MS = 8 * 86_400_000; // успешной копии давно не было

/** Статус сервиса: off — не копируется; queued — ждёт своей очереди в идущем запуске; running — копируется сейчас; error; stale; pending — копии ещё не было; empty — копировать нечего; ok. */
export function statusOf({ included, last, live }, now) {
  if (!included) return 'off';
  if (live === 'running' || live === 'queued') return live;
  if (last?.ok === false) return 'error';
  if (last?.empty) return 'empty';
  if (!last) return 'pending';
  return now - last.ts > STALE_MS ? 'stale' : 'ok';
}

export function createBackupOverview({ db, backups, treeOf, now = () => Date.now() }) {
  async function overview(accessiblePanels) {
    const s = backups.view(); const t = now(); const results = backups.svcResults(); const live = backups.dataStatus();
    // ход идущего запуска: сервис, который копируется сейчас (и какая его часть), и очередь за ним
    const liveOf = new Map(live.running ? live.panels.flatMap((p) => (p.items ?? []).filter((x) => x.status === 'run' || x.status === 'wait').map((x) => [`${p.id}|${x.label.replace('/', '|')}`, { state: x.status === 'run' ? 'running' : 'queued', part: x.part ?? null }])) : []);
    const panels = await Promise.all(accessiblePanels.map(async (row) => {
      const up = ['online', 'degraded'].includes(row.status);
      if (!up) return { panelId: row.id, panelName: row.name, color: row.color, error: row.last_error || 'Панель недоступна', rows: [] };
      let projects = [];
      try { projects = await treeOf(row); } catch (e) { return { panelId: row.id, panelName: row.name, color: row.color, error: e.message, rows: [] }; }
      const rows = projects.flatMap((p) => p.services.map((sv) => {
        const key = `${row.id}|${p.name}|${sv.name}`;
        const included = s.data.mode === 'all' || (s.data.mode === 'selected' && s.data.keys.includes(key));
        const last = results[key] ?? null;
        const lv = liveOf.get(key) ?? null;
        return { project: p.name, name: sv.name, type: sv.type, key, included, last, ...(lv ? { live: lv } : {}), status: statusOf({ included, last, live: lv?.state }, t) };
      }));
      return { panelId: row.id, panelName: row.name, color: row.color, error: null, rows };
    }));
    const all = panels.flatMap((p) => p.rows);
    const count = (st) => all.filter((r) => r.status === st).length;
    const included = all.filter((r) => r.included).length;
    return {
      panels, at: t,
      summary: { total: all.length, included, off: count('off'), error: count('error'), stale: count('stale'), pending: count('pending'), running: count('running'), queued: count('queued'), empty: count('empty'), ok: count('ok') },
      mode: s.data.mode, running: live.running,
      system: { enabled: s.enabled, system: s.system, panels: s.panels, last: s.last, where: s.where, hasPassword: s.hasPassword },
    };
  }
  return { overview };
}

export function backupOverviewRoutes(d) {
  const { db, canPanel } = d;
  const ov = createBackupOverview(d);
  return [
    ['GET', '/api/backups/overview', async (ctx) => ov.overview(db.prepare('SELECT * FROM panels ORDER BY position, id').all().filter((p) => canPanel(ctx.user, p.id))), { admin: true }],
  ];
}
