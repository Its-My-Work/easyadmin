import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, RawResponse, SECURITY_HEADERS, sendRaw } from './http.js';

/**
 * Public Status Page: публичная страница /status, JSON-снимок, SVG-бейджи и инциденты.
 * Публикуется только белый список сервисов (настройки), реальные хосты, проекты и id панелей наружу не попадают.
 * История аптайма — дневные счётчики `status_daily` (их пишет сэмплер раз в минуту) с подстраховкой из `svc_metrics`.
 */

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DAY = 86_400_000;
export const DAYS = 90;
export const SNAPSHOT_TTL_MS = 15_000;
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];
export const INCIDENT_SEVERITIES = ['maintenance', 'minor', 'major'];
const SETTINGS_KEY = 'status.config';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,63}$/;
const STATUS_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'";

/* ---------------- кэш и ограничитель частоты ---------------- */

/** Кэш одного значения с временем жизни. */
export function createTtlCache(ttlMs, now = Date.now) {
  let entry = null;
  return {
    get() { return entry && now() - entry.at < ttlMs ? entry.value : undefined; },
    set(value) { entry = { value, at: now() }; return value; },
    clear() { entry = null; },
    /** Значение из кэша или результат `make()`. */
    async wrap(make) { const hit = this.get(); return hit !== undefined ? hit : this.set(await make()); },
  };
}

/** Фиксированное окно: не больше `limit` запросов за `windowMs` на ключ (IP). */
export function createRateLimiter({ limit = 60, windowMs = 60_000, now = Date.now, maxKeys = 10_000 } = {}) {
  const hits = new Map(); // ключ → {n, reset}
  return {
    take(key) {
      const t = now();
      if (hits.size > maxKeys) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
      if (hits.size > maxKeys) hits.clear();
      let e = hits.get(key);
      if (!e || e.reset <= t) { e = { n: 0, reset: t + windowMs }; hits.set(key, e); }
      e.n++;
      return { ok: e.n <= limit, remaining: Math.max(0, limit - e.n), retryAfter: Math.max(1, Math.ceil((e.reset - t) / 1000)) };
    },
  };
}

/* ---------------- настройки ---------------- */

const DEFAULTS = { enabled: false, title: 'Статус сервисов', description: '', logoUrl: '', services: [] };

export function slugify(name) {
  const s = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'service';
}

/** Проверяет и нормализует настройки из запроса; у сервисов без slug он создаётся из имени (уникальный). */
export function cleanSettings(b, old = DEFAULTS) {
  const bad = (m) => { throw new HttpError(400, m); };
  const out = { ...DEFAULTS, ...old };
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  if (b.title !== undefined) { const t = String(b.title).trim(); if (!t || t.length > 80) bad('Заголовок: от 1 до 80 символов'); out.title = t; }
  if (b.description !== undefined) { const t = String(b.description).trim(); if (t.length > 500) bad('Описание слишком длинное'); out.description = t; }
  if (b.logoUrl !== undefined) {
    const u = String(b.logoUrl).trim();
    if (u && (u.length > 500 || !/^(https:\/\/[^\s"'<>]+|\/[^\s"'<>/][^\s"'<>]*)$/.test(u))) bad('Логотип: адрес https:// или путь на этом сервере');
    out.logoUrl = u;
  }
  if (b.services !== undefined) {
    if (!Array.isArray(b.services) || b.services.length > 50) bad('Список сервисов: не более 50');
    const used = new Set(); const list = [];
    for (const s of b.services) {
      if (!s || typeof s !== 'object') bad('Некорректный сервис');
      const panelId = Number(s.panelId);
      if (!Number.isInteger(panelId) || panelId <= 0) bad('Некорректная панель');
      if (!NAME_RE.test(String(s.project)) || !NAME_RE.test(String(s.service))) bad('Некорректный сервис');
      const name = String(s.name ?? '').trim();
      if (!name || name.length > 60) bad('Публичное имя: от 1 до 60 символов');
      let slug = s.slug ? String(s.slug) : slugify(name);
      if (!SLUG_RE.test(slug)) bad('Некорректный slug');
      if (!s.slug) { const base = slug; for (let i = 2; used.has(slug); i++) slug = `${base.slice(0, 36)}-${i}`; }
      else if (used.has(slug)) bad('Повторяющийся slug');
      used.add(slug);
      list.push({ slug, name, panelId, project: s.project, service: s.service });
    }
    out.services = list;
  }
  return out;
}

export function loadSettings(db) {
  try { return { ...DEFAULTS, ...JSON.parse(db.prepare('SELECT v FROM settings WHERE k = ?').get(SETTINGS_KEY)?.v ?? '{}') }; } catch { return { ...DEFAULTS }; }
}
const saveSettings = (db, s) => db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?,?)').run(SETTINGS_KEY, JSON.stringify(s));

/* ---------------- состояние и аптайм ---------------- */

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Состояние сервиса по снимку панели: operational | degraded | outage | unknown. */
export function serviceState(snap, project, service) {
  if (!snap) return 'unknown';
  if (snap.status === 'offline' || snap.status === 'auth_error') return 'outage';
  const svc = snap.tree?.projects?.find((p) => p.name === project)?.services.find((s) => s.name === service);
  if (!svc) return snap.status === 'online' || snap.status === 'degraded' ? 'outage' : 'unknown';
  if (!svc.enabled || svc.health === 'missing') return 'outage';
  if (svc.health === 'failing' || snap.status === 'degraded') return 'degraded';
  return 'operational';
}

/** Общий статус: operational | maintenance | partial_outage | major_outage. */
export function overallStatus(states, incidents = []) {
  const known = states.filter((s) => s !== 'unknown');
  const outages = known.filter((s) => s === 'outage').length;
  let level = 0; // 0 в норме, 1 обслуживание, 2 частичный сбой, 3 крупный сбой
  if (known.length && outages === known.length) level = 3;
  else if (outages || known.includes('degraded')) level = 2;
  for (const i of incidents) {
    if (i.severity === 'major') level = Math.max(level, 3);
    else if (i.severity === 'minor') level = Math.max(level, 2);
    else if (i.severity === 'maintenance') level = Math.max(level, 1);
  }
  return ['operational', 'maintenance', 'partial_outage', 'major_outage'][level];
}

const pct = (up, total) => (total ? Math.round((up / total) * 10_000) / 100 : null);

/** История за DAYS суток (от старых к новым): дневные счётчики, а при их отсутствии — агрегаты svc_metrics. */
export function serviceHistory(db, svc, nowMs = Date.now()) {
  const fromMs = nowMs - (DAYS - 1) * DAY;
  const days = new Map();
  for (const r of db.prepare('SELECT ts, containers FROM svc_metrics WHERE panel_id = ? AND project = ? AND service = ? AND ts >= ?')
    .all(svc.panelId, svc.project, svc.service, fromMs)) {
    const k = dayKey(r.ts);
    let cur = days.get(k);
    if (!cur) { cur = { up: 0, total: 0 }; days.set(k, cur); }
    cur.total++;
    if (r.containers > 0) cur.up++;
  }
  for (const r of db.prepare('SELECT day, up, total FROM status_daily WHERE slug = ? AND day >= ?').all(svc.slug, dayKey(fromMs))) {
    days.set(r.day, { up: r.up, total: r.total });
  }
  let up = 0; let total = 0; const out = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const k = dayKey(nowMs - i * DAY);
    const v = days.get(k);
    if (v) { up += v.up; total += v.total; }
    out.push({ d: k, up: v ? pct(v.up, v.total) : null });
  }
  return { days: out, uptime: pct(up, total) };
}

/* ---------------- SVG-бейдж ---------------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const BADGE_COLORS = { good: '#3fb950', warn: '#d29922', bad: '#f85149', none: '#8b949e' };

/** Плоский бейдж в стиле shields.io: левая серая часть и цветная правая. */
export function badgeSvg(label, value, color = 'none') {
  const w = (s) => Math.round(s.length * 6.4 + 12);
  const lw = w(label); const vw = w(value); const total = lw + vw;
  const fill = BADGE_COLORS[color] ?? BADGE_COLORS.none;
  const text = `${esc(label)}: ${esc(value)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${text}"><title>${text}</title>`
    + `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`
    + `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>`
    + `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${fill}"/><rect width="${total}" height="20" fill="url(#s)"/></g>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`
    + `<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

/** Содержимое бейджа: uptime — «99.9% uptime»; status — «healthy» / «degraded» / «down». */
export function badgeFor({ kind, uptime, state }) {
  if (kind === 'status') {
    if (state === 'operational') return ['status', 'healthy', 'good'];
    if (state === 'degraded' || state === 'partial_outage' || state === 'maintenance') return ['status', 'degraded', 'warn'];
    if (state === 'outage' || state === 'major_outage') return ['status', 'down', 'bad'];
    return ['status', 'unknown', 'none'];
  }
  if (uptime == null) return ['uptime', 'n/a', 'none'];
  return ['uptime', `${uptime}%`, uptime >= 99.9 ? 'good' : uptime >= 99 ? 'warn' : 'bad'];
}

/* ---------------- инциденты ---------------- */

const incidentRow = (r) => r && ({ id: r.id, title: r.title, status: r.status, severity: r.severity, message: r.message, components: JSON.parse(r.components || '[]'), createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at });

export function cleanIncident(b, old, validSlugs) {
  const bad = (m) => { throw new HttpError(400, m); };
  const out = old ? { ...old } : { title: '', status: 'investigating', severity: 'minor', message: '', components: [] };
  if (b.title !== undefined || !old) { const t = String(b.title ?? '').trim(); if (!t || t.length > 120) bad('Название инцидента: от 1 до 120 символов'); out.title = t; }
  if (b.status !== undefined) { if (!INCIDENT_STATUSES.includes(b.status)) bad('Неизвестный статус инцидента'); out.status = b.status; }
  if (b.severity !== undefined) { if (!INCIDENT_SEVERITIES.includes(b.severity)) bad('Неизвестная важность инцидента'); out.severity = b.severity; }
  if (b.message !== undefined) { const m = String(b.message).trim(); if (m.length > 2000) bad('Сообщение слишком длинное'); out.message = m; }
  if (b.components !== undefined) {
    if (!Array.isArray(b.components) || b.components.some((c) => typeof c !== 'string' || (validSlugs && !validSlugs.has(c)))) bad('Неизвестный компонент');
    out.components = [...new Set(b.components)];
  }
  return out;
}

/* ---------------- ядро ---------------- */

export function createStatusPage({ db, manager, config = {}, now = Date.now, rateLimit = { limit: 60, windowMs: 60_000 }, snapshotTtlMs = SNAPSHOT_TTL_MS, audit = () => {} }) {
  const cache = createTtlCache(snapshotTtlMs, now);
  const limiter = createRateLimiter({ ...rateLimit, now });
  const activeIncidents = () => db.prepare("SELECT * FROM status_incidents WHERE status <> 'resolved' ORDER BY created_at DESC").all().map(incidentRow);

  const states = (s) => Object.fromEntries(s.services.map((x) => [x.slug, serviceState(manager.cache.get(x.panelId), x.project, x.service)]));

  /** Публичный снимок: только имена и slug из белого списка. */
  function buildSnapshot() {
    const s = loadSettings(db);
    const st = states(s);
    const incidents = activeIncidents();
    const names = new Map(s.services.map((x) => [x.slug, x.name]));
    const services = s.services.map((x) => ({ slug: x.slug, name: x.name, state: st[x.slug], ...serviceHistory(db, x, now()) }));
    return {
      title: s.title, description: s.description, logoUrl: s.logoUrl, updatedAt: now(),
      status: overallStatus(Object.values(st), incidents), services,
      incidents: incidents.map((i) => ({ id: i.id, title: i.title, status: i.status, severity: i.severity, message: i.message, components: i.components.filter((c) => names.has(c)).map((c) => ({ slug: c, name: names.get(c) })), createdAt: i.createdAt, updatedAt: i.updatedAt })),
    };
  }

  function snapshot() {
    return cache.wrap(() => {
      const body = JSON.stringify(buildSnapshot());
      return { body, etag: `"${crypto.createHash('sha1').update(body.replace(/"updatedAt":\d+,/, '')).digest('base64url')}"` };
    });
  }

  const clientIp = (req) => {
    const fwd = config.trustProxy ? String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return fwd || req.socket?.remoteAddress || 'unknown';
  };
  /** Возвращает RawResponse 429, если лимит исчерпан; иначе null. */
  const limited = (req) => {
    const r = limiter.take(clientIp(req));
    return r.ok ? null : new RawResponse(JSON.stringify({ error: 'Слишком много запросов' }), 'application/json; charset=utf-8', { 'Retry-After': String(r.retryAfter) }, 429);
  };
  const enabled = () => loadSettings(db).enabled;

  async function snapshotResponse(req) {
    const lim = limited(req); if (lim) return lim;
    if (!enabled()) throw new HttpError(404, 'Страница статуса отключена');
    const { body, etag } = await snapshot();
    const headers = { ETag: etag, 'Cache-Control': `public, max-age=${Math.round(snapshotTtlMs / 1000)}`, 'Access-Control-Allow-Origin': '*' };
    if (req.headers?.['if-none-match'] === etag) return new RawResponse('', 'application/json; charset=utf-8', headers, 304);
    return new RawResponse(body, 'application/json; charset=utf-8', headers);
  }

  function badgeResponse(req, slug, kind) {
    const lim = limited(req); if (lim) return lim;
    const svgHeaders = { 'Cache-Control': 'public, max-age=60' };
    const svg = (parts) => new RawResponse(badgeSvg(...parts), 'image/svg+xml; charset=utf-8', svgHeaders);
    if (!enabled()) return svg(['status', 'disabled', 'none']);
    const s = loadSettings(db);
    if (slug === 'all' || slug === 'overall') {
      const st = Object.values(states(s));
      if (kind === 'status') return svg(badgeFor({ kind, state: overallStatus(st, activeIncidents()) }));
      const ups = s.services.map((x) => serviceHistory(db, x, now()).uptime).filter((u) => u != null);
      return svg(badgeFor({ kind, uptime: ups.length ? Math.round((ups.reduce((a, b) => a + b, 0) / ups.length) * 100) / 100 : null }));
    }
    const svc = s.services.find((x) => x.slug === slug);
    if (!svc) return svg(['status', 'not found', 'none']);
    return svg(badgeFor({ kind, uptime: serviceHistory(db, svc, now()).uptime, state: states(s)[svc.slug] }));
  }

  function pageResponse(req) {
    const lim = limited(req); if (lim) return lim;
    if (!enabled()) throw new HttpError(404, 'Страница статуса отключена');
    return new RawResponse(fs.readFileSync(path.join(PUBLIC_DIR, 'status.html')), 'text/html; charset=utf-8', { 'Content-Security-Policy': STATUS_CSP, 'Cache-Control': 'no-cache' });
  }

  /** Публичные пути вне /api: /status и /status/badge/:slug.svg. Возвращает true, если запрос обработан. */
  async function handlePublic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const badge = /^\/status\/badge\/([a-z0-9-]{1,40})\.svg$/.exec(p);
    if (p !== '/status' && !badge) return false;
    try {
      sendRaw(res, badge ? badgeResponse(req, badge[1], url.searchParams.get('type') === 'status' ? 'status' : 'uptime') : pageResponse(req));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end(status === 404 ? 'Not found' : 'Error');
    }
    return true;
  }

  /** Раз в минуту записывает состояние каждого публичного сервиса в дневные счётчики. */
  function sample() {
    const s = loadSettings(db);
    if (!s.enabled || !s.services.length) return;
    const st = states(s); const day = dayKey(now());
    const upsert = db.prepare('INSERT INTO status_daily (slug, day, up, total) VALUES (?,?,?,1) ON CONFLICT(slug, day) DO UPDATE SET up = up + excluded.up, total = total + 1');
    for (const x of s.services) if (st[x.slug] !== 'unknown') upsert.run(x.slug, day, st[x.slug] === 'outage' ? 0 : 1);
  }
  const prune = () => db.prepare('DELETE FROM status_daily WHERE day < ?').run(dayKey(now() - 400 * DAY));

  let timer;
  const start = () => { sample(); prune(); timer = setInterval(sample, 60_000); timer.unref(); };
  const stop = () => clearInterval(timer);

  /* ----- админские маршруты ----- */
  const slugs = () => new Set(loadSettings(db).services.map((x) => x.slug));
  const incidentOr404 = (id) => { const r = db.prepare('SELECT * FROM status_incidents WHERE id = ?').get(Number(id)); if (!r) throw new HttpError(404, 'Инцидент не найден'); return r; };
  const available = () => db.prepare('SELECT id, name FROM panels ORDER BY position, id').all().map((p) => ({
    panelId: p.id, panel: p.name,
    services: (manager.cache.get(p.id)?.tree?.projects ?? []).flatMap((pr) => pr.services.map((s) => ({ project: pr.name, service: s.name }))),
  }));
  const withTimes = (i, old) => {
    const t = now();
    const resolvedAt = i.status === 'resolved' ? (old?.resolved_at ?? t) : null;
    return { updatedAt: t, resolvedAt };
  };

  const routes = [
    ['GET', '/api/status/snapshot', (ctx) => snapshotResponse(ctx.req), { public: true }],
    ['GET', '/api/status/settings', () => ({ ...loadSettings(db), available: available() }), { admin: true }],
    ['POST', '/api/status/settings', (ctx) => {
      const b = ctx.body ?? {};
      const old = loadSettings(db);
      const next = cleanSettings(b, old);
      for (const x of next.services) if (!db.prepare('SELECT 1 FROM panels WHERE id = ?').get(x.panelId)) throw new HttpError(400, 'Панель не найдена');
      saveSettings(db, next);
      cache.clear();
      audit(ctx, { action: 'status.settings', target: 'Status Page', detail: `${next.enabled ? 'on' : 'off'}, ${next.services.length}` });
      return { ...next, available: available() };
    }, { admin: true }],
    ['GET', '/api/status/incidents', () => db.prepare('SELECT * FROM status_incidents ORDER BY created_at DESC LIMIT 200').all().map(incidentRow), { admin: true }],
    ['POST', '/api/status/incidents', (ctx) => {
      const i = cleanIncident(ctx.body ?? {}, null, slugs());
      const t = withTimes(i);
      const id = db.prepare('INSERT INTO status_incidents (title, status, severity, message, components, created_at, updated_at, resolved_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(i.title, i.status, i.severity, i.message, JSON.stringify(i.components), now(), t.updatedAt, t.resolvedAt).lastInsertRowid;
      cache.clear();
      audit(ctx, { action: 'status.incident.create', target: i.title });
      return incidentRow(incidentOr404(id));
    }, { admin: true }],
    ['PUT', '/api/status/incidents/:id', (ctx) => {
      const old = incidentOr404(ctx.params.id);
      const i = cleanIncident(ctx.body ?? {}, incidentRow(old), slugs());
      const t = withTimes(i, old);
      db.prepare('UPDATE status_incidents SET title = ?, status = ?, severity = ?, message = ?, components = ?, updated_at = ?, resolved_at = ? WHERE id = ?')
        .run(i.title, i.status, i.severity, i.message, JSON.stringify(i.components), t.updatedAt, t.resolvedAt, old.id);
      cache.clear();
      audit(ctx, { action: 'status.incident.update', target: i.title, detail: i.status });
      return incidentRow(incidentOr404(old.id));
    }, { admin: true }],
    ['DELETE', '/api/status/incidents/:id', (ctx) => {
      const old = incidentOr404(ctx.params.id);
      db.prepare('DELETE FROM status_incidents WHERE id = ?').run(old.id);
      cache.clear();
      audit(ctx, { action: 'status.incident.delete', target: old.title });
      return { ok: true };
    }, { admin: true }],
  ];

  return { routes, handlePublic, snapshot, snapshotResponse, badgeResponse, sample, start, stop, invalidate: () => cache.clear() };
}
