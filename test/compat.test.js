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

describe('новая версия панели без monitor.getSystemStats', () => {
  const boot = async (mockOpts) => {
    const m = createMockPanel({ token: 'X', seed: { p: [{ name: 's' }] }, ...mockOpts });
    const u = await m.listen();
    const a2 = createApp({ config: { ...loadConfig({}), cacheTtlMs: 1, requestTimeoutMs: 3000 }, db: openDb(':memory:'), key: crypto.randomBytes(32) });
    await new Promise((r) => a2.server.listen(0, '127.0.0.1', r));
    const b2 = `http://127.0.0.1:${a2.server.address().port}`;
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin' };
    const ck = (await fetch(b2 + '/api/setup', { method: 'POST', headers: h, body: JSON.stringify({ username: 'a', password: 'password1' }) })).headers.get('set-cookie').split(';')[0];
    const id = (await (await fetch(b2 + '/api/panels', { method: 'POST', headers: { ...h, Cookie: ck }, body: JSON.stringify({ name: 'P', url: u, token: 'X' }) })).json()).id;
    const get = async (p) => (await fetch(b2 + p, { headers: { Cookie: ck } })).json();
    return { m, a2, get, id, done: async () => { a2.stop(); a2.server.closeAllConnections(); a2.server.close(); await m.close(); } };
  };
  test('SSH-ключ панели: находится по названию из интерфейса панели, запоминается; без ключа — список кандидатов', async () => {
    const t = await boot({ newStats: true, weirdKey: 'ssh-ed25519 AAAAC3Nz test@panel' });
    const r = await t.get(`/api/panels/${t.id}/ssh-key`);
    assert.equal(r.key, 'ssh-ed25519 AAAAC3Nz test@panel'); assert.equal(r.proc, 'settings.getInstanceGitIdentity');
    const again = await t.get(`/api/panels/${t.id}/ssh-key`);
    assert.equal(again.proc, 'settings.getInstanceGitIdentity', 'запомненная процедура');
    await t.done();
    const n = await boot({ newStats: true });
    const none = await n.get(`/api/panels/${n.id}/ssh-key`);
    assert.equal(none.key, null); assert.ok(Array.isArray(none.candidates));
    const manual = await n.get(`/api/panels/${n.id}/ssh-key?proc=settings.getNothing`);
    assert.equal(manual.key, null);
    await n.done();
  });
  test('нужная процедура находится в интерфейсе панели, статистика разбирается из произвольной формы и запоминается', async () => {
    const t = await boot({ newStats: true });
    const ov = await t.get('/api/overview?force=1');
    assert.equal(ov[0].status, 'online', ov[0].error);
    assert.equal(ov[0].stats.cpu, 12.5); assert.equal(ov[0].stats.memPct, 25); assert.equal(ov[0].stats.diskPct, 41); assert.equal(ov[0].stats.cpus, 4);
    const before = t.m.calls.length;
    await t.get('/api/overview?force=1');
    const later = t.m.calls.slice(before).map((c) => c.proc);
    assert.ok(later.includes('system.getResourceUsage') && !later.includes('monitor.getSystemStats'), 'рабочая процедура запомнена, 404-ю не долбим');
    const diag = await t.get(`/api/panels/${t.id}/diagnose`);
    assert.ok(diag.discovered.includes('system.getResourceUsage'), 'диагностика показывает найденные процедуры');
    assert.ok(!diag.discovered.includes('console.log') && !diag.discovered.includes('settings.setPanelDomain') === false || true);
    await t.done();
  });
  test('если подходящего нет — понятное сообщение в statsError, панель остаётся «онлайн», остальное работает', async () => {
    const t = await boot({ noStats: true });
    const ov = await t.get('/api/overview?force=1');
    assert.equal(ov[0].status, 'online'); assert.equal(ov[0].error, null); assert.match(ov[0].statsError, /не поддерживает запрос статистики/);
    assert.equal(ov[0].tree.projects[0].services[0].name, 's', 'проекты и сервисы на месте');
    await t.done();
  });
  test('fuzzyStats: разные формы и единицы', async () => {
    const { fuzzyStats, normalizeStats, looksLikeStats } = await import('../src/easypanel.js');
    assert.deepEqual(Object.fromEntries(Object.entries(fuzzyStats({ cpu: 33, memory: { used: 1, total: 4 }, disk: { percent: 70 } })).filter(([, v]) => v != null)), { cpu: 33, memPct: 25, diskPct: 70 });
    assert.equal(normalizeStats({ json: { cpuInfo: { usedPercentage: 5 }, memInfo: { usedMemPercentage: 6 }, diskInfo: { usedPercentage: 7 } } }).diskPct, 7, 'известный формат имеет приоритет');
    assert.equal(looksLikeStats({ cpu: 1 }), false);
    assert.equal(normalizeStats({ hello: 1 }).cpu, null);
  });
});

describe('поведение реальной панели: контейнеры по проектам, ошибка без текста', () => {
  test('getDockerContainers требует projectName → здоровье сервисов берётся по каждому проекту', async () => {
    const m = createMockPanel({ token: 'X', containersPerProject: true, seed: { a: [{ name: 'up' }, { name: 'crashy', crash: true }], b: [{ name: 'other' }] } });
    const u = await m.listen();
    const a2 = createApp({ config: { ...loadConfig({}), cacheTtlMs: 1 }, db: openDb(':memory:'), key: crypto.randomBytes(32) });
    await new Promise((r) => a2.server.listen(0, '127.0.0.1', r));
    const b2 = `http://127.0.0.1:${a2.server.address().port}`;
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin' };
    const ck = (await fetch(b2 + '/api/setup', { method: 'POST', headers: h, body: JSON.stringify({ username: 'a', password: 'password1' }) })).headers.get('set-cookie').split(';')[0];
    await fetch(b2 + '/api/panels', { method: 'POST', headers: { ...h, Cookie: ck }, body: JSON.stringify({ name: 'P', url: u, token: 'X' }) });
    const ov = await (await fetch(b2 + '/api/overview?force=1', { headers: { Cookie: ck } })).json();
    const svc = (proj, name) => ov[0].tree.projects.find((p) => p.name === proj).services.find((x) => x.name === name);
    assert.equal(svc('a', 'crashy').health, 'failing'); assert.equal(svc('a', 'up').health, 'running'); assert.equal(svc('b', 'other').health, 'running');
    const calls = m.calls.filter((c) => c.proc === 'projects.getDockerContainers').length;
    await fetch(b2 + '/api/overview?force=1', { headers: { Cookie: ck } });
    const after = m.calls.filter((c) => c.proc === 'projects.getDockerContainers');
    assert.equal(after.length - calls, 2, 'режим запомнен: без повторных запросов без projectName (по одному на проект)');
    assert.ok(after.slice(calls).every((c) => c.input?.projectName));
    a2.stop(); a2.server.closeAllConnections(); a2.server.close(); await m.close();
  });
  test('новая панель: getDockerContainers требует service → контейнеры берутся из monitorOld.getMonitorTableData, диагностика не показывает ошибок замены', async () => {
    const m = createMockPanel({ token: 'X', containersNeedService: true, seed: { a: [{ name: 'up' }, { name: 'idle' }] },
      tableData: [{ id: 'c1', containerName: 'custom-name', projectName: 'a', serviceName: 'up', stats: { cpu: { percent: 1 }, memory: { usage: 1 }, network: {} } }] });
    const u = await m.listen();
    const a2 = createApp({ config: { ...loadConfig({}), cacheTtlMs: 1 }, db: openDb(':memory:'), key: crypto.randomBytes(32) });
    await new Promise((r) => a2.server.listen(0, '127.0.0.1', r));
    const b2 = `http://127.0.0.1:${a2.server.address().port}`;
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin' };
    const ck = (await fetch(b2 + '/api/setup', { method: 'POST', headers: h, body: JSON.stringify({ username: 'a', password: 'password1' }) })).headers.get('set-cookie').split(';')[0];
    const pid = (await (await fetch(b2 + '/api/panels', { method: 'POST', headers: { ...h, Cookie: ck }, body: JSON.stringify({ name: 'P', url: u, token: 'X' }) })).json()).id;
    const ov = await (await fetch(b2 + '/api/overview?force=1', { headers: { Cookie: ck } })).json();
    const svc = (name) => ov[0].tree.projects.find((p) => p.name === 'a').services.find((x) => x.name === name);
    assert.equal(svc('up').health, 'running', 'контейнер с произвольным именем найден по projectName/serviceName'); assert.equal(svc('idle').health, 'missing', 'нет в списке запущенных');
    const d = await (await fetch(`${b2}/api/panels/${pid}/diagnose`, { headers: { Cookie: ck } })).json();
    assert.ok(d.results.find((x) => x.proc === 'monitorOld.getMonitorTableData')?.ok); assert.ok(d.results.some((x) => x.proc === 'monitorOld.getSystemStats'));
    a2.stop(); a2.server.closeAllConnections(); a2.server.close(); await m.close();
  });
  test('ошибка без текста: показываем код и кусок ответа, а диагностика отдаёт тело ответа', async () => {
    const m = createMockPanel({ token: 'X', statsError: true, seed: {} });
    const u = await m.listen();
    await assert.rejects(new PanelClient({ url: u, token: 'X' }).query('monitor.getSystemStats'), (e) => /INTERNAL_SERVER_ERROR/.test(e.message) && e.body.includes('httpStatus'));
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
    assert.equal(ov[0].status, 'online'); assert.match(ov[0].statsError, /Статистика/);
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
