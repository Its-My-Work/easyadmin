import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMockPanel } from './mock-easypanel.js';
import { PanelClient, normalizeTree, redact, shapeOf, unwrapJson } from '../src/easypanel.js';

// «Чужая» версия панели: без superjson и с другой формой списка проектов
let panel, url, app, base, cookie, id;
const answers = {
  'projects.listProjectsAndServices': { result: { data: { data: { items: [{ id: 'x', name: 'blog', apiToken: 'SECRET123', services: [{ name: 'web', type: 'app' }] }] } } } },
  'monitor.getSystemStats': { error: { message: 'Not implemented', code: -32004, data: { code: 'NOT_FOUND', httpStatus: 404 } } },
};

before(async () => {
  panel = http.createServer((req, res) => {
    const proc = new URL(req.url, 'http://x').pathname.replace('/api/trpc/', '');
    const a = answers[proc];
    if (!a) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'no', data: { code: 'NOT_FOUND' } } })); }
    res.writeHead(a.error ? 404 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(a));
  });
  await new Promise((r) => panel.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${panel.address().port}`;
  app = createApp({ config: { ...loadConfig({}), cacheTtlMs: 1 }, db: openDb(':memory:'), key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
  const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin' };
  cookie = (await fetch(base + '/api/setup', { method: 'POST', headers: h, body: JSON.stringify({ username: 'a', password: 'password1' }) })).headers.get('set-cookie').split(';')[0];
  id = (await (await fetch(base + '/api/panels', { method: 'POST', headers: { ...h, Cookie: cookie }, body: JSON.stringify({ name: 'P', url, token: 't' }) })).json()).id;
});
after(() => { app.stop(); app.server.closeAllConnections(); app.server.close(); panel.close(); });

describe('формат ошибок и тип сервиса (как у реальной панели)', () => {
  test('ошибка вида {json:{message,code}} читается как сообщение, а не сырой JSON', async () => {
    const m = createMockPanel({ token: 'X', flatErrors: true, seed: { p: [{ name: 's' }] } });
    const u = await m.listen();
    await assert.rejects(new PanelClient({ url: u, token: 'X' }).query('nope.nothing'), (e) => e.message.includes('No procedure') && !e.message.includes('{"json"'));
    await assert.rejects(new PanelClient({ url: u, token: 'bad' }).query('projects.listProjects'), (e) => e.kind === 'auth');
    await m.close();
  });
  test('порты и тома запрашиваются с типом сервиса', async () => {
    const m = createMockPanel({ token: 'X', flatErrors: true, requireType: true, seed: { p: [{ name: 'c', type: 'compose' }] } });
    const u = await m.listen();
    const { inspectService } = await import('../src/easypanel.js');
    const r = await inspectService(new PanelClient({ url: u, token: 'X' }), { type: 'compose', project: 'p', name: 'c' });
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.ports, []);
    await m.close();
  });
});

describe('совместимость с другими формами ответов', () => {
  test('клиент понимает ответ без superjson-обёртки', async () => {
    const v = await new PanelClient({ url, token: 't' }).query('projects.listProjectsAndServices');
    assert.equal(v.data.items[0].name, 'blog');
  });
  test('двойная обёртка {json:{json:X}} снимается (как у панели пользователя)', async () => {
    const saved = answers['monitor.getSystemStats'];
    answers['projects.listProjectsAndServices'] = { result: { data: { json: { json: { projects: [{ name: 'main' }, { name: 'hh' }], services: [{ name: 'hh', projectName: 'hh', type: 'app', enabled: true }] } } } } };
    const v = await new PanelClient({ url, token: 't' }).query('projects.listProjectsAndServices');
    assert.equal(v.projects.length, 2);
    assert.deepEqual(unwrapJson({ json: { json: 5, meta: {} }, meta: {} }), 5);
    assert.deepEqual(unwrapJson({ json: 1, other: 2 }), { json: 1, other: 2 }, 'чужие поля не трогаем');
    answers['monitor.getSystemStats'] = saved;
    const t = normalizeTree(v);
    assert.deepEqual(t.projects.map((p) => [p.name, p.services.length]), [['hh', 1], ['main', 0]]);
  });
  test('нераспознанная статистика → «частично» с пояснением', async () => {
    answers['projects.listProjectsAndServices'] = { result: { data: { json: { projects: [{ name: 'p' }], services: [] } } } };
    answers['monitor.getSystemStats'] = { result: { data: { json: { something: 'else' } } } };
    const ov = await (await fetch(base + '/api/overview?force=1', { headers: { Cookie: cookie } })).json();
    assert.equal(ov[0].status, 'degraded'); assert.match(ov[0].error, /Статистика/);
    answers['monitor.getSystemStats'] = { result: { data: { json: { cpuInfo: { usedPercentage: 5 } } } } };
  });
  test('normalizeTree находит проекты и сервисы в нестандартных формах', () => {
    assert.equal(normalizeTree({ data: { items: [{ name: 'a', services: [{ name: 's' }] }] } }).projects[0].services[0].name, 's');
    assert.equal(normalizeTree({ json: [{ name: 'p' }] }).projects[0].name, 'p');
    const t = normalizeTree({ list: { services: [{ name: 'w', type: 'redis', projectName: 'shop' }] } });
    assert.deepEqual(t.projects.map((p) => [p.name, p.services[0].type]), [['shop', 'redis']]);
    assert.deepEqual(normalizeTree(null), { projects: [] });
    assert.deepEqual(normalizeTree({ projects: [], services: [] }), { projects: [] });
  });
  test('панель с непонятным списком помечается «частично» и объясняет причину', async () => {
    answers['projects.listProjectsAndServices'] = { result: { data: { weird: 'format', n: 5 } } };
    const ov = await (await fetch(base + '/api/overview?force=1', { headers: { Cookie: cookie } })).json();
    assert.equal(ov[0].status, 'degraded');
    assert.match(ov[0].error, /не распознан/);
  });
  test('пустая, но корректная панель — онлайн без ошибок; ошибка статистики видна', async () => {
    answers['projects.listProjectsAndServices'] = { result: { data: { json: { projects: [], services: [] } } } };
    answers['monitor.getSystemStats'] = { result: { data: { json: { cpuInfo: { usedPercentage: 5 } } } } };
    const ov = await (await fetch(base + '/api/overview?force=1', { headers: { Cookie: cookie } })).json();
    assert.equal(ov[0].status, 'online'); assert.equal(ov[0].error, null);
  });
  test('диагностика: формы и образцы ответов, секреты скрыты', async () => {
    answers['projects.listProjectsAndServices'] = { result: { data: { data: { items: [{ id: 'x', name: 'blog', apiToken: 'SECRET123', services: [{ name: 'web', type: 'app' }] }] } } } };
    const r = await (await fetch(`${base}/api/panels/${id}/diagnose`, { headers: { Cookie: cookie } })).json();
    const lp = r.results.find((x) => x.proc === 'projects.listProjectsAndServices');
    assert.equal(lp.ok, true); assert.deepEqual(lp.recognized, ['blog (1)']);
    assert.ok(!JSON.stringify(r).includes('SECRET123'));
    assert.ok(r.results.some((x) => !x.ok && /no|Not/.test(x.error)));
    assert.match(lp.shape, /items/);
  });
  test('shapeOf и redact', () => {
    assert.equal(shapeOf({ a: [1, 2], b: null }), '{a: [number]×2, b: null}');
    assert.deepEqual(redact({ password: 'x', name: 'n', nested: { token: 't' } }), { password: '***', name: 'n', nested: { token: '***' } });
  });
});
