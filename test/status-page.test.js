import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { openDb } from '../src/db.js';
import { badgeFor, badgeSvg, cleanIncident, cleanSettings, createRateLimiter, createStatusPage, createTtlCache, overallStatus, serviceHistory, serviceState, slugify } from '../src/status-page.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const mem = () => {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'ea-status-')));
  db.prepare("INSERT INTO panels (name, url, token_enc, created_at) VALUES ('Prod','https://secret-host.example','x',1)").run();
  return db;
};
const snap = (status, services) => ({ status, tree: { projects: [{ name: 'shop', services }] } });
const svc = (name, extra = {}) => ({ name, enabled: true, ...extra });

function setup({ clock = { t: NOW }, panel = snap('online', [svc('web'), svc('db')]), rateLimit } = {}) {
  const db = mem();
  const manager = { cache: new Map([[1, panel]]) };
  const page = createStatusPage({ db, manager, now: () => clock.t, rateLimit });
  const save = (b) => page.routes.find((r) => r[0] === 'POST' && r[1] === '/api/status/settings')[2]({ body: b });
  const route = (m, p) => page.routes.find((r) => r[0] === m && r[1] === p)[2];
  save({ enabled: true, title: 'Acme', services: [{ name: 'Web site', panelId: 1, project: 'shop', service: 'web' }, { name: 'Database', panelId: 1, project: 'shop', service: 'db' }] });
  return { db, manager, page, save, route, clock };
}
const req = (headers = {}, ip = '1.2.3.4') => ({ headers, socket: { remoteAddress: ip } });

describe('кэш', () => {
  test('TTL: значение живёт до истечения срока, wrap вызывает make один раз', async () => {
    let t = 0; let calls = 0;
    const c = createTtlCache(15_000, () => t);
    assert.equal(c.get(), undefined);
    assert.equal(await c.wrap(() => ++calls), 1);
    t = 14_999; assert.equal(await c.wrap(() => ++calls), 1);
    t = 15_000; assert.equal(await c.wrap(() => ++calls), 2);
    c.clear(); assert.equal(c.get(), undefined);
  });
  test('снимок кэшируется на 15 с и сбрасывается при смене настроек', async () => {
    const { page, manager, save, clock } = setup();
    const a = await page.snapshot();
    manager.cache.set(1, snap('offline', []));
    assert.equal(await page.snapshot(), a);
    clock.t += 15_001;
    assert.notEqual((await page.snapshot()).body, a.body);
    const b = await page.snapshot();
    save({ title: 'Другой' });
    assert.equal(JSON.parse((await page.snapshot()).body).title, 'Другой');
    assert.notEqual(await page.snapshot(), b);
  });
});

describe('ограничитель частоты', () => {
  test('окно: лимит на ключ, сброс по времени, независимые ключи', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
    assert.deepEqual([1, 2, 3].map(() => rl.take('a').ok), [true, true, true]);
    const r = rl.take('a');
    assert.equal(r.ok, false); assert.equal(r.retryAfter, 1);
    assert.equal(rl.take('b').ok, true);
    t = 1000; assert.equal(rl.take('a').ok, true);
  });
  test('снимок отвечает 429 с Retry-After', async () => {
    const { page } = setup({ rateLimit: { limit: 2, windowMs: 60_000 } });
    assert.equal((await page.snapshotResponse(req())).status, 200);
    assert.equal((await page.snapshotResponse(req())).status, 200);
    const r = await page.snapshotResponse(req());
    assert.equal(r.status, 429); assert.ok(Number(r.headers['Retry-After']) >= 1);
    assert.equal((await page.snapshotResponse(req({}, '9.9.9.9'))).status, 200);
  });
});

describe('снимок', () => {
  test('публикует только белый список и не раскрывает хосты, проекты и id панелей', async () => {
    const { page } = setup();
    const r = await page.snapshotResponse(req());
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.title, 'Acme'); assert.equal(j.status, 'operational');
    assert.deepEqual(j.services.map((s) => [s.slug, s.name, s.state]), [['web-site', 'Web site', 'operational'], ['database', 'Database', 'operational']]);
    assert.equal(j.services[0].days.length, 90);
    assert.ok(!/secret-host|shop|panelId/.test(r.body));
  });
  test('ETag и 304', async () => {
    const { page } = setup();
    const r = await page.snapshotResponse(req());
    assert.match(r.headers.ETag, /^"/);
    const again = await page.snapshotResponse(req({ 'if-none-match': r.headers.ETag }));
    assert.equal(again.status, 304); assert.equal(again.body, '');
  });
  test('выключенная страница даёт 404', async () => {
    const { page, save } = setup();
    save({ enabled: false });
    await assert.rejects(() => page.snapshotResponse(req()), { status: 404 });
  });
  test('состояние сервисов и общий статус', () => {
    assert.equal(serviceState(null, 'a', 'b'), 'unknown');
    assert.equal(serviceState(snap('offline', []), 'shop', 'web'), 'outage');
    assert.equal(serviceState(snap('online', [svc('web', { enabled: false })]), 'shop', 'web'), 'outage');
    assert.equal(serviceState(snap('online', [svc('web', { health: 'failing' })]), 'shop', 'web'), 'degraded');
    assert.equal(serviceState(snap('online', [svc('web')]), 'shop', 'gone'), 'outage');
    assert.equal(overallStatus(['operational', 'operational']), 'operational');
    assert.equal(overallStatus(['operational', 'outage']), 'partial_outage');
    assert.equal(overallStatus(['operational', 'degraded']), 'partial_outage');
    assert.equal(overallStatus(['outage', 'outage']), 'major_outage');
    assert.equal(overallStatus(['unknown']), 'operational');
    assert.equal(overallStatus(['operational'], [{ severity: 'major' }]), 'major_outage');
    assert.equal(overallStatus(['operational'], [{ severity: 'maintenance' }]), 'maintenance');
  });
  test('сэмплер копит дневной аптайм; история из svc_metrics подхватывается, когда счётчиков нет', () => {
    const { db, page, manager, clock } = setup();
    page.sample(); page.sample();
    manager.cache.set(1, snap('online', [svc('web', { enabled: false }), svc('db')]));
    page.sample(); page.sample();
    const web = serviceHistory(db, { slug: 'web-site', panelId: 1, project: 'shop', service: 'web' }, clock.t);
    assert.equal(web.uptime, 50); assert.deepEqual(web.days.at(-1), { d: '2026-06-15', up: 50 });
    assert.equal(web.days[0].up, null);
    const ins = db.prepare("INSERT INTO svc_metrics (panel_id, ts, project, service, containers) VALUES (1,?,'shop','api',?)");
    const day3 = NOW - 3 * DAY;
    for (const [i, c] of [1, 1, 1, 0].entries()) ins.run(day3 + 10_000 * i, c);
    const api = serviceHistory(db, { slug: 'api', panelId: 1, project: 'shop', service: 'api' }, clock.t);
    assert.equal(api.uptime, 75); assert.equal(api.days.at(-4).up, 75);
  });
});

describe('SVG-бейджи', () => {
  test('badgeSvg: валидная разметка и экранирование', () => {
    const svg = badgeSvg('up<time>', '99.9% "x"', 'good');
    assert.match(svg, /^<svg [^>]*xmlns=/); assert.match(svg, /<\/svg>$/);
    assert.ok(svg.includes('up&lt;time&gt;') && svg.includes('&quot;x&quot;') && !svg.includes('<time>'));
    assert.ok(svg.includes('#3fb950'));
  });
  test('badgeFor: аптайм и статусы', () => {
    assert.deepEqual(badgeFor({ kind: 'uptime', uptime: 99.95 }), ['uptime', '99.95%', 'good']);
    assert.deepEqual(badgeFor({ kind: 'uptime', uptime: 98 }), ['uptime', '98%', 'bad']);
    assert.deepEqual(badgeFor({ kind: 'uptime', uptime: null }), ['uptime', 'n/a', 'none']);
    assert.equal(badgeFor({ kind: 'status', state: 'operational' })[1], 'healthy');
    assert.equal(badgeFor({ kind: 'status', state: 'degraded' })[1], 'degraded');
    assert.equal(badgeFor({ kind: 'status', state: 'outage' })[1], 'down');
  });
  test('маршрут /status/badge/:slug.svg: сервис, общий бейдж, неизвестный slug', () => {
    const { page } = setup();
    page.sample();
    const up = page.badgeResponse(req(), 'web-site', 'uptime');
    assert.equal(up.contentType, 'image/svg+xml; charset=utf-8'); assert.ok(up.body.includes('100% uptime') || (up.body.includes('uptime') && up.body.includes('100%')));
    assert.ok(page.badgeResponse(req(), 'web-site', 'status').body.includes('healthy'));
    assert.ok(page.badgeResponse(req(), 'all', 'status').body.includes('healthy'));
    assert.ok(page.badgeResponse(req(), 'nope', 'uptime').body.includes('not found'));
  });
});

describe('публичные пути HTTP', () => {
  test('/status, бейдж и снимок через настоящий сервер; чужие пути не перехватываются', async () => {
    const { page } = setup();
    const server = http.createServer(async (rq, rs) => { const u = new URL(rq.url, 'http://x'); if (!await page.handlePublic(rq, rs, u)) { rs.writeHead(418); rs.end(); } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const html = await fetch(`${base}/status`);
      assert.equal(html.status, 200); assert.match(html.headers.get('content-type'), /text\/html/);
      assert.match(await html.text(), /status-page\.js/);
      const b = await fetch(`${base}/status/badge/web-site.svg?type=status`);
      assert.equal(b.status, 200); assert.match(b.headers.get('content-type'), /image\/svg\+xml/);
      assert.equal((await fetch(`${base}/status/other`)).status, 418);
      assert.equal((await fetch(`${base}/statusx`)).status, 418);
    } finally { server.close(); }
  });
});

describe('настройки', () => {
  test('slug создаётся и сохраняется, дубли получают суффикс', () => {
    const s = cleanSettings({ services: [{ name: 'Web', panelId: 1, project: 'a', service: 'b' }, { name: 'Web', panelId: 1, project: 'a', service: 'c' }, { name: 'Сайт', panelId: 1, project: 'a', service: 'd' }] });
    assert.deepEqual(s.services.map((x) => x.slug), ['web', 'web-2', 'service']);
    assert.equal(slugify('Мой API v2'), 'api-v2');
    const again = cleanSettings({ services: s.services }, s);
    assert.deepEqual(again.services.map((x) => x.slug), ['web', 'web-2', 'service']);
  });
  test('валидация', () => {
    assert.throws(() => cleanSettings({ title: '' }), { status: 400 });
    assert.throws(() => cleanSettings({ logoUrl: 'javascript:alert(1)' }), { status: 400 });
    assert.throws(() => cleanSettings({ logoUrl: '//evil.example/x.png' }), { status: 400 });
    assert.equal(cleanSettings({ logoUrl: 'https://cdn.example/l.png' }).logoUrl, 'https://cdn.example/l.png');
    assert.throws(() => cleanSettings({ services: [{ name: 'x', panelId: 1, project: '../a', service: 'b' }] }), { status: 400 });
    assert.throws(() => cleanSettings({ services: [{ name: '', panelId: 1, project: 'a', service: 'b' }] }), { status: 400 });
  });
  test('все управляющие маршруты — только для admin; публичные — открыты', () => {
    const { page } = setup();
    for (const [m, p, , o] of page.routes) {
      if (p === '/api/status/snapshot') assert.equal(o.public, true);
      else assert.equal(o.admin, true, `${m} ${p}`);
    }
  });
  test('несуществующая панель отклоняется', () => {
    const { save } = setup();
    assert.throws(() => save({ services: [{ name: 'x', panelId: 99, project: 'a', service: 'b' }] }), { status: 400 });
  });
});

describe('инциденты', () => {
  test('создание, обновление, решение, удаление', async () => {
    const { page, route, clock } = setup();
    const created = route('POST', '/api/status/incidents')({ body: { title: 'БД тормозит', severity: 'major', message: 'Разбираемся', components: ['database'] } });
    assert.equal(created.status, 'investigating'); assert.equal(created.resolvedAt, null); assert.deepEqual(created.components, ['database']);
    let j = JSON.parse((await page.snapshot()).body);
    assert.equal(j.incidents.length, 1); assert.equal(j.status, 'major_outage');
    assert.deepEqual(j.incidents[0].components, [{ slug: 'database', name: 'Database' }]);

    clock.t += 1000;
    const upd = route('PUT', '/api/status/incidents/:id')({ params: { id: created.id }, body: { status: 'monitoring', message: 'Наблюдаем' } });
    assert.equal(upd.status, 'monitoring'); assert.equal(upd.title, 'БД тормозит'); assert.equal(upd.updatedAt, clock.t);
    clock.t += 1000;
    const done = route('PUT', '/api/status/incidents/:id')({ params: { id: created.id }, body: { status: 'resolved' } });
    assert.equal(done.resolvedAt, clock.t);
    clock.t += 20_000;
    j = JSON.parse((await page.snapshot()).body);
    assert.equal(j.incidents.length, 0); assert.equal(j.status, 'operational');
    const reopened = route('PUT', '/api/status/incidents/:id')({ params: { id: created.id }, body: { status: 'identified' } });
    assert.equal(reopened.resolvedAt, null);

    assert.equal(route('GET', '/api/status/incidents')({}).length, 1);
    assert.deepEqual(route('DELETE', '/api/status/incidents/:id')({ params: { id: created.id } }), { ok: true });
    assert.throws(() => route('PUT', '/api/status/incidents/:id')({ params: { id: created.id }, body: {} }), { status: 404 });
  });
  test('валидация инцидента', () => {
    const slugs = new Set(['web']);
    assert.throws(() => cleanIncident({}, null, slugs), { status: 400 });
    assert.throws(() => cleanIncident({ title: 'x', status: 'boom' }, null, slugs), { status: 400 });
    assert.throws(() => cleanIncident({ title: 'x', severity: 'boom' }, null, slugs), { status: 400 });
    assert.throws(() => cleanIncident({ title: 'x', components: ['nope'] }, null, slugs), { status: 400 });
    assert.deepEqual(cleanIncident({ title: ' x ', components: ['web', 'web'] }, null, slugs).components, ['web']);
  });
  test('таблица status_incidents имеет нужные колонки', () => {
    const cols = mem().prepare('PRAGMA table_info(status_incidents)').all().map((c) => c.name);
    assert.deepEqual(cols, ['id', 'title', 'status', 'severity', 'message', 'components', 'created_at', 'updated_at', 'resolved_at']);
  });
});
