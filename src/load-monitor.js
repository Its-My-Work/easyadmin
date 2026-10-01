import { HttpError } from './http.js';
import { takeSnapshot, topLines } from './host-snapshot.js';

/**
 * Мониторинг нагрузки EasyAdmin: собственная история по бесплатным данным панелей.
 *  - раз в минуту: monitorOld.getMonitorTableData (CPU/память/сеть каждого контейнера; контейнеры compose-сервиса суммируются);
 *  - хост целиком берётся из снимков панели (manager.onSnapshot) — «остаток» = хост минус сумма сервисов (система, dockerd, ядро и т. д.);
 *  - хранение с уплотнением: минутные точки сутки → 5 минут → час (сроки по пресету), счётчики сети переводятся в скорость;
 *  - перегрузка хоста (CPU/память дольше N минут) → уведомление, к которому прикладывается снимок «что грузит сервер».
 * CPU контейнера — в процентах одного ядра (как docker stats); в ответах он приводится к доле всего сервера.
 */
const MIN = 60_000;
export const RETENTION = { short: { m5Days: 3, h1Days: 0 }, standard: { m5Days: 7, h1Days: 30 }, long: { m5Days: 7, h1Days: 90 } };
export const ALERT_PRESETS = { off: null, normal: { cpu: 85, mem: 90, minutes: 10 }, sensitive: { cpu: 70, mem: 80, minutes: 5 } };
export const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const POINTS = 240;
const SNAPSHOT_COOLDOWN = 10 * MIN;

export function createLoadMonitor({ db, manager, alerts, config, now = () => Date.now(), snapshotFn = takeSnapshot }) {
  const setting = (k, def) => db.prepare('SELECT v FROM settings WHERE k = ?').get(`load_${k}`)?.v ?? def;
  const setSetting = (k, v) => db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(`load_${k}`, String(v));
  const getSettings = () => ({ enabled: setting('enabled', '1') === '1', retention: setting('retention', 'standard'), alerts: setting('alerts', 'normal'), snapshot: setting('snapshot', '1') === '1' });
  const lastNet = new Map(); const lastList = new Map(); const unsupported = new Map(); const alertState = new Map();
  let timer = null; let janitor = null;

  // существующим каналам, которые получают «диск заполнен», добавляем и «перегрузку сервера» — один раз
  if (setting('migrated', '0') !== '1') {
    for (const c of db.prepare('SELECT id, events FROM channels').all()) {
      const ev = String(c.events ?? '').split(',').filter(Boolean);
      if (ev.includes('disk_high') && !ev.includes('overload')) db.prepare('UPDATE channels SET events = ? WHERE id = ?').run([...ev, 'overload'].join(','), c.id);
    }
    setSetting('migrated', '1');
  }

  const insert = db.prepare('INSERT INTO svc_metrics (panel_id, ts, res, project, service, containers, cpu, cpu_max, mem, mem_max, rx, tx, cores) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const remove = db.prepare('DELETE FROM svc_metrics WHERE panel_id = ? AND ts = ? AND res = 60 AND project = ? AND service = ?');

  /** Сервисы панели: один запрос на всю панель. */
  async function collectPanel(row, ts = now()) {
    if (!getSettings().enabled) return { skipped: 'off' };
    if ((unsupported.get(row.id) ?? 0) > ts) return { skipped: 'unsupported' };
    const c = manager.clientFor(row);
    let list;
    try { list = await c.query('monitorOld.getMonitorTableData'); }
    catch (e) { if (e.status === 404 || /not found|No procedure/i.test(e.message)) unsupported.set(row.id, ts + 3600_000); return { error: e.message }; }
    if (!Array.isArray(list)) return { error: 'ответ без списка контейнеров' };
    lastList.set(row.id, list);
    const minute = Math.floor(ts / MIN) * MIN; const by = new Map(); const seen = new Set();
    for (const x of list) {
      if (!x?.serviceName) continue;
      const k = `${x.projectName ?? ''}\u0000${x.serviceName}`;
      const a = by.get(k) ?? { project: x.projectName ?? '', service: x.serviceName, containers: 0, cpu: 0, mem: 0, rx: 0, tx: 0 };
      a.containers++; a.cpu += Number(x.stats?.cpu?.percent) || 0; a.mem += Number(x.stats?.memory?.usage) || 0;
      const nk = `${row.id}|${x.id}`; seen.add(nk);
      const inn = Number(x.stats?.network?.in); const out = Number(x.stats?.network?.out); const prev = lastNet.get(nk);
      if (prev && Number.isFinite(inn) && inn >= prev.in && ts > prev.ts) a.rx += (inn - prev.in) / ((ts - prev.ts) / 1000);
      if (prev && Number.isFinite(out) && out >= prev.out && ts > prev.ts) a.tx += (out - prev.out) / ((ts - prev.ts) / 1000);
      if (Number.isFinite(inn) && Number.isFinite(out)) lastNet.set(nk, { in: inn, out, ts });
      by.set(k, a);
    }
    for (const k of lastNet.keys()) if (k.startsWith(`${row.id}|`) && !seen.has(k)) lastNet.delete(k); // контейнер исчез
    db.exec('BEGIN');
    try { for (const a of by.values()) { remove.run(row.id, minute, a.project, a.service); insert.run(row.id, minute, 60, a.project, a.service, a.containers, a.cpu, a.cpu, a.mem, a.mem, a.rx, a.tx, null); } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { services: by.size };
  }

  /** Хост целиком из снимка панели + проверка перегрузки. */
  function onHost(row, snap, ts = now()) {
    const st = snap?.stats; if (!st || !getSettings().enabled) return;
    const minute = Math.floor(ts / MIN) * MIN;
    if (!db.prepare("SELECT 1 FROM svc_metrics WHERE panel_id = ? AND ts = ? AND res = 60 AND project = '' AND service = ''").get(row.id, minute)) {
      insert.run(row.id, minute, 60, '', '', 0, Number(st.cpu) || 0, Number(st.cpu) || 0, (Number(st.memUsedMb) || 0) * 1048576, (Number(st.memTotalMb) || 0) * 1048576, null, null, Number(st.cpus) || 1);
    }
    evaluate(row, st, ts);
  }

  async function evaluate(row, st, ts) {
    const preset = ALERT_PRESETS[getSettings().alerts]; if (!preset) return;
    const s = alertState.get(row.id) ?? { cpu: { since: null, fired: false }, mem: { since: null, fired: false }, lastSnap: 0 };
    alertState.set(row.id, s);
    const fire = [];
    for (const [kind, value, thr] of [['cpu', Number(st.cpu), preset.cpu], ['mem', Number(st.memPct), preset.mem]]) {
      const a = s[kind]; if (!Number.isFinite(value)) continue;
      if (value >= thr) { a.since ??= ts; if (!a.fired && ts - a.since >= preset.minutes * MIN) { a.fired = true; fire.push([kind, value, Math.round((ts - a.since) / MIN)]); } }
      else if (value < thr - 10) { a.since = null; a.fired = false; } // сброс только после заметного спада — без дребезга
    }
    for (const [kind, value, minutes] of fire) {
      let text = `Панель «${row.name}»: ${kind === 'cpu' ? 'CPU сервера' : 'память сервера'} ${Math.round(value)}% уже ${minutes} мин`;
      if (getSettings().snapshot && ts - s.lastSnap >= SNAPSHOT_COOLDOWN) {
        s.lastSnap = ts;
        try { text += `\nТоп: ${topLines(await snapshotFn(manager.clientFor(row), row, lastList.get(row.id) ?? [])).join(', ')}`; } catch { /* без снимка — просто уведомление */ }
      }
      alerts.emit({ type: 'overload', icon: '🔥', text, panel: row.name }).catch?.(() => {});
    }
  }

  /** Уплотнение: минуты старше суток → 5 минут; 5 минут старше срока → час; хвост удаляется. Границы бакетов кратны шагу. */
  function downsample(ts = now()) {
    const cfg = RETENTION[getSettings().retention] ?? RETENTION.standard;
    const roll = (fromRes, toRes, toMs, cutoff) => {
      const cut = Math.floor(cutoff / toMs) * toMs;
      db.exec('BEGIN');
      try {
        db.prepare(`INSERT INTO svc_metrics (panel_id, ts, res, project, service, containers, cpu, cpu_max, mem, mem_max, rx, tx, cores)
          SELECT panel_id, (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER), ?, project, service, MAX(containers), AVG(cpu), MAX(COALESCE(cpu_max, cpu)), AVG(mem), MAX(COALESCE(mem_max, mem)), AVG(rx), AVG(tx), MAX(cores)
          FROM svc_metrics WHERE res = ? AND ts < ? GROUP BY panel_id, project, service, ts / CAST(? AS INTEGER)`).run(toMs, toMs, toRes, fromRes, cut, toMs);
        db.prepare('DELETE FROM svc_metrics WHERE res = ? AND ts < ?').run(fromRes, cut);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    };
    roll(60, 300, 300_000, ts - 24 * 3600e3);
    if (cfg.h1Days > 0) roll(300, 3600, 3600_000, ts - cfg.m5Days * 86400e3);
    else db.prepare('DELETE FROM svc_metrics WHERE res = 300 AND ts < ?').run(ts - cfg.m5Days * 86400e3);
    db.prepare('DELETE FROM svc_metrics WHERE res = 3600 AND ts < ?').run(ts - Math.max(cfg.h1Days, 1) * 86400e3);
  }

  const bucketFor = (span) => Math.max(MIN, Math.ceil(span / POINTS / MIN) * MIN);
  const num = (v) => (v == null ? null : Math.round(v * 100) / 100);

  /** Хост и сервисы за период: ряды для графиков, «остаток» и таблица сервисов. */
  function overview(panelId, range = '24h', ts = now()) {
    const span = RANGES[range] ?? RANGES['24h']; const from = ts - span; const b = bucketFor(span);
    const host = db.prepare("SELECT (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER) t, AVG(cpu) cpu, AVG(mem) mem, MAX(mem_max) total, MAX(cores) cores FROM svc_metrics WHERE panel_id = ? AND project = '' AND service = '' AND ts >= ? GROUP BY ts / CAST(? AS INTEGER) ORDER BY t").all(b, b, panelId, from, b);
    const sums = new Map(db.prepare("SELECT t, SUM(cpu) cpu, SUM(mem) mem FROM (SELECT (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER) t, project, service, AVG(cpu) cpu, AVG(mem) mem FROM svc_metrics WHERE panel_id = ? AND service <> '' AND ts >= ? GROUP BY ts / CAST(? AS INTEGER), project, service) GROUP BY t").all(b, b, panelId, from, b).map((r) => [r.t, r]));
    const cores = host.at(-1)?.cores || 1; const total = host.at(-1)?.total || null;
    const points = host.map((h) => { const sm = sums.get(h.t); const svcCpu = ((sm?.cpu ?? 0) / (h.cores || cores)); const svcMem = sm?.mem ?? 0;
      return { t: h.t, cpu: num(h.cpu), svcCpu: num(Math.min(svcCpu, h.cpu ?? svcCpu)), otherCpu: num(Math.max(0, (h.cpu ?? 0) - svcCpu)), mem: Math.round(h.mem), svcMem: Math.round(Math.min(svcMem, h.mem ?? svcMem)), otherMem: Math.round(Math.max(0, (h.mem ?? 0) - svcMem)) }; });
    const agg = db.prepare("SELECT project, service, AVG(cpu) cpuAvg, MAX(COALESCE(cpu_max, cpu)) cpuMax, AVG(mem) memAvg, MAX(COALESCE(mem_max, mem)) memMax, AVG(rx) rxAvg, AVG(tx) txAvg FROM svc_metrics WHERE panel_id = ? AND service <> '' AND ts >= ? GROUP BY project, service").all(panelId, from);
    const latest = new Map(db.prepare("SELECT m.project, m.service, m.cpu, m.mem, m.rx, m.tx, m.containers, m.ts FROM svc_metrics m JOIN (SELECT project, service, MAX(ts) mts FROM svc_metrics WHERE panel_id = ? AND service <> '' GROUP BY project, service) x ON m.project = x.project AND m.service = x.service AND m.ts = x.mts WHERE m.panel_id = ?").all(panelId, panelId).map((r) => [`${r.project}\u0000${r.service}`, r]));
    const services = agg.map((a) => { const l = latest.get(`${a.project}\u0000${a.service}`); const live = l && ts - l.ts <= 5 * MIN;
      return { project: a.project, service: a.service, running: !!live, containers: live ? l.containers : 0, cpu: live ? num(l.cpu / cores) : null, cpuAvg: num(a.cpuAvg / cores), cpuMax: num(a.cpuMax / cores), mem: live ? Math.round(l.mem) : null, memAvg: Math.round(a.memAvg), memMax: Math.round(a.memMax), rx: live ? Math.round(l.rx ?? 0) : null, tx: live ? Math.round(l.tx ?? 0) : null,
        memPct: live && total ? num((l.mem / total) * 100) : null }; })
      .sort((x, y) => (y.cpuAvg ?? 0) - (x.cpuAvg ?? 0) || (y.memAvg ?? 0) - (x.memAvg ?? 0));
    return { range, bucketMs: b, cores, memTotal: total, points, services };
  }

  /** Ряд одного сервиса: CPU (доля сервера), память, сеть. */
  function serviceSeries(panelId, project, service, range = '24h', ts = now()) {
    const span = RANGES[range] ?? RANGES['24h']; const from = ts - span; const b = bucketFor(span);
    const cores = db.prepare("SELECT MAX(cores) c FROM svc_metrics WHERE panel_id = ? AND project = '' AND service = '' AND ts >= ?").get(panelId, from)?.c || 1;
    const rows = db.prepare('SELECT (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER) t, AVG(cpu) cpu, MAX(COALESCE(cpu_max, cpu)) cpuMax, AVG(mem) mem, MAX(COALESCE(mem_max, mem)) memMax, AVG(rx) rx, AVG(tx) tx FROM svc_metrics WHERE panel_id = ? AND project = ? AND service = ? AND ts >= ? GROUP BY ts / CAST(? AS INTEGER) ORDER BY t').all(b, b, panelId, project, service, from, b);
    return { range, bucketMs: b, cores, points: rows.map((r) => ({ t: r.t, cpu: num(r.cpu / cores), cpuMax: num(r.cpuMax / cores), mem: Math.round(r.mem), memMax: Math.round(r.memMax), rx: Math.round(r.rx ?? 0), tx: Math.round(r.tx ?? 0) })) };
  }

  const info = () => { const r = db.prepare('SELECT COUNT(*) n, MIN(ts) oldest FROM svc_metrics').get(); return { rows: r.n, approxMb: Math.round((r.n * 90) / 1048576 * 10) / 10, oldest: r.oldest ?? null }; };
  const clear = () => db.prepare('DELETE FROM svc_metrics').run().changes;
  const forget = (panelId) => { db.prepare('DELETE FROM svc_metrics WHERE panel_id = ?').run(panelId); };

  async function tick(ts = now()) {
    if (!getSettings().enabled) return;
    const rows = db.prepare("SELECT * FROM panels WHERE status IN ('online','degraded')").all();
    await Promise.allSettled(rows.map((row) => collectPanel(row, ts)));
  }
  const start = () => {
    timer = setInterval(() => { tick().catch(() => {}); }, MIN); timer.unref();
    janitor = setInterval(() => { try { downsample(); } catch { /* повторим через 10 минут */ } }, 10 * MIN); janitor.unref();
  };
  const stop = () => { clearInterval(timer); clearInterval(janitor); };

  return { getSettings, setSetting, collectPanel, onHost, downsample, overview, serviceSeries, info, clear, forget, tick, start, stop, lastContainers: (id) => lastList.get(id) ?? [] };
}

export function loadRoutes(d) {
  const { db, manager, audit, need, asHttp, panelOr404, canPanel, loadmon } = d;
  const lastSnap = new Map();
  const view = () => ({ ...loadmon.getSettings(), ...loadmon.info(), presets: { alerts: ALERT_PRESETS, retention: RETENTION } });
  return [
    ['GET', '/api/load/settings', () => view(), { admin: true }],
    ['PUT', '/api/load/settings', (ctx) => {
      const b = ctx.body ?? {}; const before = loadmon.getSettings();
      if (b.enabled !== undefined) { need(typeof b.enabled === 'boolean', 'Включено — да или нет'); loadmon.setSetting('enabled', b.enabled ? '1' : '0'); }
      if (b.retention !== undefined) { need(Object.keys(RETENTION).includes(b.retention), 'Неизвестный срок хранения'); loadmon.setSetting('retention', b.retention); }
      if (b.alerts !== undefined) { need(Object.keys(ALERT_PRESETS).includes(b.alerts), 'Неизвестный уровень уведомлений'); loadmon.setSetting('alerts', b.alerts); }
      if (b.snapshot !== undefined) { need(typeof b.snapshot === 'boolean', 'Снимок — да или нет'); loadmon.setSetting('snapshot', b.snapshot ? '1' : '0'); }
      audit(ctx, { action: 'load.settings', target: 'нагрузка', detail: JSON.stringify({ before, after: loadmon.getSettings() }).slice(0, 300) });
      return view();
    }, { admin: true }],
    ['DELETE', '/api/load/data', (ctx) => { const n = loadmon.clear(); audit(ctx, { action: 'load.clear', target: 'нагрузка', detail: `${n} записей` }); return { removed: n, ...loadmon.info() }; }, { admin: true }],
    ['GET', '/api/panels/:id/load', (ctx) => {
      const row = panelOr404(ctx.params.id); need(canPanel(ctx.user, row.id), 'Нет доступа к этой панели');
      const q = ctx.url.searchParams; const range = q.get('range') ?? '24h'; need(RANGES[range], 'Период: 1h, 6h, 24h, 7d или 30d');
      const project = q.get('project'); const service = q.get('service');
      if (project != null || service != null) { need(project && service, 'Укажите проект и сервис'); return { enabled: loadmon.getSettings().enabled, ...loadmon.serviceSeries(row.id, project, service, range) }; }
      return { enabled: loadmon.getSettings().enabled, ...loadmon.overview(row.id, range) };
    }],
    ['POST', '/api/panels/:id/snapshot', async (ctx) => {
      const row = panelOr404(ctx.params.id); need(canPanel(ctx.user, row.id), 'Нет доступа к этой панели');
      need(Date.now() - (lastSnap.get(row.id) ?? 0) > 15_000, 'Снимок уже делается — подождите несколько секунд');
      lastSnap.set(row.id, Date.now());
      const c = manager.clientFor(row);
      try {
        const containers = await c.query('monitorOld.getMonitorTableData').catch(() => loadmon.lastContainers(row.id));
        const snap = await takeSnapshot(c, row, Array.isArray(containers) ? containers : []);
        audit(ctx, { action: 'host.snapshot', panel: row, target: row.name, detail: 'что грузит сервер' });
        return snap;
      } catch (e) { audit(ctx, { action: 'host.snapshot', panel: row, target: row.name, ok: false, detail: e.message }); throw asHttp(e); }
    }, { admin: true }],
  ];
}
