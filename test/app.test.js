import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMockPanel } from './mock-easypanel.js';
import { normalizeTree, normalizeUrl, PanelClient } from '../src/easypanel.js';
import { decrypt, encrypt } from '../src/crypto.js';
import crypto from 'node:crypto';

let panelA, panelB, urlA, urlB, app, base, cookie = '';

async function api(method, path, body, { anon = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(cookie && !anon ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json() };
}

before(async () => {
  panelA = createMockPanel({ token: 'AAA', seed: { web: [{ name: 'site' }, { name: 'db', type: 'postgres' }], empty: [] } });
  panelB = createMockPanel({ token: 'BBB', seed: { api: [{ name: 'svc', enabled: false }] } });
  urlA = await panelA.listen(); urlB = await panelB.listen();
  const config = { ...loadConfig({}), dataDir: ':memory:', cacheTtlMs: 1, requestTimeoutMs: 3000 };
  const db = openDb(':memory:');
  app = createApp({ config, db, key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { app.manager.stop(); app.server.closeAllConnections(); app.server.close(); await panelA.close(); await panelB.close(); });

describe('unit', () => {
  test('шифрование токенов', () => {
    const k = crypto.randomBytes(32);
    assert.equal(decrypt(k, encrypt(k, 'секрет')), 'секрет');
    assert.throws(() => decrypt(crypto.randomBytes(32), encrypt(k, 'x')));
  });
  test('normalizeUrl', () => {
    assert.equal(normalizeUrl('https://p.example.com/api/trpc/'), 'https://p.example.com');
    assert.equal(normalizeUrl('http://1.2.3.4:3000/'), 'http://1.2.3.4:3000');
    assert.throws(() => normalizeUrl('ftp://x'));
  });
  test('normalizeTree принимает разные формы', () => {
    const a = normalizeTree({ projects: [{ name: 'p' }], services: [{ projectName: 'p', name: 's', type: 'redis' }] });
    assert.equal(a.projects[0].services[0].type, 'redis');
    const b = normalizeTree({ projects: [{ name: 'p', services: [{ name: 'x' }] }] });
    assert.equal(b.projects[0].services[0].type, 'app');
    assert.deepEqual(normalizeTree(null), { projects: [] });
  });
  test('клиент отвергает недопустимые процедуры', async () => {
    await assert.rejects(new PanelClient({ url: urlA, token: 'AAA' }).query('../etc/passwd'));
  });
});

describe('авторизация', () => {
  test('без входа — 401, setup доступен один раз', async () => {
    assert.equal((await api('GET', '/api/overview', null, { anon: true })).status, 401);
    assert.equal((await api('GET', '/api/session', null, { anon: true })).data.setupRequired, true);
    assert.equal((await api('POST', '/api/setup', { username: 'admin', password: 'short' })).status, 400);
    assert.equal((await api('POST', '/api/setup', { username: 'admin', password: 'longenough1' })).status, 200);
    assert.equal((await api('POST', '/api/setup', { username: 'x', password: 'longenough1' })).status, 403);
    assert.equal((await api('GET', '/api/session')).data.user.username, 'admin');
  });
  test('CSRF-заголовок обязателен', async () => {
    const res = await fetch(base + '/api/panels', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    assert.equal(res.status, 403);
  });
  test('неверный пароль', async () => {
    assert.equal((await api('POST', '/api/login', { username: 'admin', password: 'wrong' }, { anon: true })).status, 401);
  });
});

let idA, idB;
describe('панели', () => {
  test('проверка соединения: успех и неверный токен', async () => {
    assert.equal((await api('POST', '/api/panels/test', { url: urlA, token: 'AAA' })).data.ok, true);
    const bad = (await api('POST', '/api/panels/test', { url: urlA, token: 'nope' })).data;
    assert.equal(bad.ok, false); assert.equal(bad.kind, 'auth');
  });
  test('добавление, токен не возвращается', async () => {
    const a = await api('POST', '/api/panels', { name: 'A', url: urlA, token: 'AAA', tags: 'prod, eu' });
    const b = await api('POST', '/api/panels', { name: 'B', url: urlB, token: 'BBB' });
    idA = a.data.id; idB = b.data.id;
    assert.equal(a.status, 200);
    assert.ok(!JSON.stringify(a.data).includes('AAA'));
    assert.deepEqual(a.data.tags, ['prod', 'eu']);
  });
  test('токен зашифрован в БД', () => {
    const row = app.manager.getRow(idA);
    assert.ok(!row.token_enc.includes('AAA'));
  });
  test('overview агрегирует все панели', async () => {
    const { data } = await api('GET', '/api/overview?force=1');
    assert.equal(data.length, 2);
    assert.equal(data[0].status, 'online');
    assert.equal(data[0].tree.projects.find((p) => p.name === 'web').services.length, 2);
    assert.equal(data[1].tree.projects[0].services[0].enabled, false);
    assert.ok(data[0].stats.cpu > 0);
    assert.ok(!JSON.stringify(data).includes('AAA'));
  });
  test('недоступная панель не ломает остальные', async () => {
    const dead = await api('POST', '/api/panels', { name: 'Dead', url: 'http://127.0.0.1:1', token: 'x' });
    const { data } = await api('GET', '/api/overview?force=1');
    assert.equal(data.find((p) => p.name === 'Dead').status, 'offline');
    assert.equal(data.find((p) => p.name === 'A').status, 'online');
    await api('DELETE', `/api/panels/${dead.data.id}`);
  });
  test('неверный токен → auth_error', async () => {
    const p = await api('POST', '/api/panels', { name: 'Bad', url: urlA, token: 'wrong' });
    const { data } = await api('GET', '/api/overview?force=1');
    assert.equal(data.find((x) => x.name === 'Bad').status, 'auth_error');
    await api('DELETE', `/api/panels/${p.data.id}`);
  });
});

describe('управление сервисами', () => {
  const ref = { type: 'app', project: 'web', name: 'site' };
  test('stop → start → restart меняют состояние', async () => {
    await api('POST', `/api/panels/${idA}/service/action`, { ...ref, action: 'stop' });
    assert.equal(panelA.projects.get('web')[0].enabled, false);
    await api('POST', `/api/panels/${idA}/service/action`, { ...ref, action: 'start' });
    assert.equal(panelA.projects.get('web')[0].enabled, true);
    assert.equal((await api('POST', `/api/panels/${idA}/service/action`, { ...ref, action: 'restart' })).status, 200);
  });
  test('БД: stop/start транслируются в disable/enable, deploy запрещён', async () => {
    const db = { type: 'postgres', project: 'web', name: 'db' };
    await api('POST', `/api/panels/${idA}/service/action`, { ...db, action: 'stop' });
    assert.equal(panelA.projects.get('web')[1].enabled, false);
    assert.equal((await api('POST', `/api/panels/${idA}/service/action`, { ...db, action: 'deploy' })).status, 502);
  });
  test('inspect отдаёт service/domains/ports/mounts', async () => {
    const { data } = await api('GET', `/api/panels/${idA}/service?type=app&project=web&name=site`);
    assert.equal(data.service.name, 'site');
    assert.deepEqual(data.domains, []);
  });
  test('env, домен, порт, том', async () => {
    const op = (o, params) => api('POST', `/api/panels/${idA}/service/op`, { ...ref, op: o, params });
    assert.equal((await op('env', { env: 'A=1\nB=2' })).status, 200);
    assert.equal(panelA.projects.get('web')[0].env, 'A=1\nB=2');
    await op('domainAdd', { host: 'x.example.com' });
    const d = panelA.projects.get('web')[0].domains;
    assert.equal(d[0].host, 'x.example.com');
    await op('domainDelete', { id: d[0].id });
    assert.equal(panelA.projects.get('web')[0].domains.length, 0);
    await op('portAdd', { published: 8080, target: 80 });
    assert.equal(panelA.projects.get('web')[0].ports[0].published, 8080);
    await op('mountAdd', { type: 'volume', name: 'data', mountPath: '/data' });
    assert.equal(panelA.projects.get('web')[0].mounts.length, 1);
    assert.equal((await op('nope', {})).status, 502);
  });
  test('редактирование домена, порта и монтирования: правки применяются к существующей записи', async () => {
    const op = (o, params) => api('POST', `/api/panels/${idA}/service/op`, { ...ref, op: o, params });
    await op('domainAdd', { host: 'old.example.com', port: 80 });
    const d = panelA.projects.get('web')[0].domains.at(-1);
    assert.equal((await op('domainUpdate', { id: d.id, original: d, host: 'new.example.com', port: 8080, path: '/x', https: false })).status, 200);
    assert.deepEqual([d.host, d.port, d.path, d.https], ['new.example.com', 8080, '/x', false]);
    await op('portAdd', { published: 8081, target: 80 });
    const p = panelA.projects.get('web')[0].ports.at(-1);
    assert.equal((await op('portUpdate', { id: p.id, original: p, published: 9090, target: 90, protocol: 'udp' })).status, 200);
    assert.deepEqual([p.published, p.target, p.protocol], [9090, 90, 'udp']);
    await op('mountAdd', { type: 'volume', name: 'v1', mountPath: '/one' });
    const m = panelA.projects.get('web')[0].mounts.at(-1);
    assert.equal((await op('mountUpdate', { id: m.id, original: m, type: 'bind', hostPath: '/srv/x', mountPath: '/two' })).status, 200);
    assert.deepEqual([m.type, m.hostPath, m.mountPath], ['bind', '/srv/x', '/two']);
    assert.equal((await op('domainUpdate', { id: 'nope', host: 'a.b' })).status, 502, 'несуществующая запись — ошибка панели, а не 200');
  });
  test('монтирование: панель со вложенным форматом (type = тип сервиса, свойства в mount) тоже работает', async () => {
    const N = createMockPanel({ token: 'N', mountStyle: 'nested', seed: { p: [{ name: 's' }] } });
    const url = await N.listen();
    const nid = (await api('POST', '/api/panels', { name: 'Nested', url, token: 'N' })).data.id;
    const r = await api('POST', `/api/panels/${nid}/service/op`, { type: 'app', project: 'p', name: 's', op: 'mountAdd', params: { type: 'file', mountPath: '/etc/x.conf', content: 'hello' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const m = N.projects.get('p')[0].mounts[0];
    assert.deepEqual([m.type, m.mountPath, m.content], ['file', '/etc/x.conf', 'hello']);
    const u = await api('POST', `/api/panels/${nid}/service/op`, { type: 'app', project: 'p', name: 's', op: 'mountUpdate', params: { id: m.id, original: m, type: 'file', mountPath: '/etc/y.conf', content: 'bye' } });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.deepEqual([m.mountPath, m.content], ['/etc/y.conf', 'bye']);
    await api('DELETE', `/api/panels/${nid}`); await N.close();
  });
  test('валидация имён защищает от инъекций', async () => {
    const r = await api('POST', `/api/panels/${idA}/service/action`, { type: 'app', project: '../x', name: 'site', action: 'stop' });
    assert.equal(r.status, 400);
    const r2 = await api('POST', `/api/panels/${idA}/service/action`, { type: 'evil.type', project: 'web', name: 'site', action: 'stop' });
    assert.equal(r2.status, 502);
  });
  test('создание проекта и сервисов, удаление', async () => {
    assert.equal((await api('POST', `/api/panels/${idA}/projects`, { name: 'newp' })).status, 200);
    assert.equal((await api('POST', `/api/panels/${idA}/services`, { type: 'redis', project: 'newp', name: 'cache' })).status, 200);
    assert.equal(panelA.projects.get('newp')[0].type, 'redis');
    assert.equal((await api('POST', `/api/panels/${idA}/service/action`, { type: 'redis', project: 'newp', name: 'cache', action: 'destroy' })).status, 200);
    assert.equal((await api('DELETE', `/api/panels/${idA}/projects/newp`)).status, 200);
    assert.equal(panelA.projects.has('newp'), false);
  });
  test('создание приложения с разными источниками и способом сборки', async () => {
    const svc = (n) => panelA.projects.get('srcp').find((x) => x.name === n);
    await api('POST', `/api/panels/${idA}/projects`, { name: 'srcp' });
    const mk = (name, source) => api('POST', `/api/panels/${idA}/services`, { type: 'app', project: 'srcp', name, source });
    assert.equal((await mk('a-git', { type: 'git', repo: 'git@github.com:o/r.git', ref: 'dev', build: { type: 'dockerfile', file: 'docker/Dockerfile' } })).status, 200);
    assert.deepEqual(svc('a-git').source, { type: 'git', repo: 'git@github.com:o/r.git', ref: 'dev', path: '/' });
    assert.deepEqual(svc('a-git').build, { type: 'dockerfile', file: 'docker/Dockerfile' });
    assert.equal((await mk('a-gh', { type: 'github', owner: 'o', repo: 'r', build: { type: 'nixpacks' } })).status, 200);
    assert.equal(svc('a-gh').source.owner, 'o'); assert.equal(svc('a-gh').build.type, 'nixpacks');
    assert.equal((await mk('a-df', { type: 'dockerfile', dockerfile: 'FROM alpine' })).status, 200);
    assert.equal(svc('a-df').source.dockerfile, 'FROM alpine');
    assert.equal((await mk('a-img', { type: 'image', image: 'ghcr.io/o/i:1', username: 'u', password: 'p' })).status, 200);
    assert.equal(svc('a-img').source.image, 'ghcr.io/o/i:1');
    assert.equal((await mk('a-bad', { type: 'ftp' })).status, 400);
    assert.equal((await mk('a-bad2', { type: 'git' })).status, 400);
    assert.equal((await mk('a-bad3', { type: 'git', repo: 'x', build: { type: 'evil' } })).status, 400);
    await api('DELETE', `/api/panels/${idA}/projects/srcp`);
  });
  test('массовая операция на нескольких панелях с частичной ошибкой', async () => {
    const { data } = await api('POST', '/api/bulk', {
      action: 'restart',
      targets: [
        { panelId: idA, type: 'app', project: 'web', name: 'site' },
        { panelId: idB, type: 'app', project: 'api', name: 'svc' },
        { panelId: idB, type: 'app', project: 'api', name: 'ghost' },
      ],
    });
    assert.equal(data.okCount, 2); assert.equal(data.failCount, 1);
    assert.equal(panelB.projects.get('api')[0].enabled, true);
  });
});

describe('аудит и роли', () => {
  test('действия попадают в аудит, включая ошибки', async () => {
    const { data } = await api('GET', '/api/audit');
    assert.ok(data.some((a) => a.action === 'service.stop' && a.ok === 1));
    assert.ok(data.some((a) => a.action === 'bulk.restart' && a.ok === 0));
  });
  test('viewer может читать, но не менять', async () => {
    await api('POST', '/api/users', { username: 'v', password: 'viewerpass1', role: 'viewer' });
    const admin = cookie;
    await api('POST', '/api/login', { username: 'v', password: 'viewerpass1' }, { anon: true });
    assert.equal((await api('GET', '/api/overview')).status, 200);
    assert.equal((await api('POST', `/api/panels/${idA}/service/action`, { type: 'app', project: 'web', name: 'site', action: 'stop' })).status, 403);
    assert.equal((await api('GET', '/api/users')).status, 403);
    cookie = admin;
  });
  test('удаление панели', async () => {
    assert.equal((await api('DELETE', `/api/panels/${idB}`)).status, 200);
    assert.equal((await api('GET', '/api/overview')).data.length, 1);
  });
  test('статика и защитные заголовки', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });
});
