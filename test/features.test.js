import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { applyHealth } from '../src/easypanel.js';
import { isDue } from '../src/scheduler.js';
import { mergeEnv, parseEnvLines } from '../src/templates.js';
import { base32Decode, base32Encode, hotp, totp } from '../src/totp.js';
import { createMockPanel } from './mock-easypanel.js';

let A, B, urlA, urlB, app, base, hook, hookUrl, hookPosts = [], tmp, cfgRef;
const jars = {};
async function api(who, method, p, body, extraHeaders) {
  const res = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let idA, idB;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-test-'));
  A = createMockPanel({ token: 'A', seed: { web: [{ name: 'site', env: '# c\nFOO=1\nBAR=2', image: 'nginx:1.25', resources: { memoryLimit: 256 } }, { name: 'db', type: 'postgres' }, { name: 'crashy', crash: true }], other: [] }, certs: [{ domain: 'a.example.com', expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() }, { domain: 'b.example.com', expiresAt: new Date(Date.now() + 60 * 86400000).toISOString() }] });
  B = createMockPanel({ token: 'B', seed: { web: [{ name: 'site', image: 'nginx:1.27' }] } });
  urlA = await A.listen(); urlB = await B.listen();
  hook = http.createServer(async (req, res) => { const c = []; for await (const x of req) c.push(x); hookPosts.push({ headers: req.headers, body: JSON.parse(Buffer.concat(c).toString()) }); res.end('ok'); });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r)); hookUrl = `http://127.0.0.1:${hook.address().port}/`;
  const config = { ...loadConfig({ EASYADMIN_DATA: tmp, EASYADMIN_METRICS_TOKEN: 'mtok' }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false };
  cfgRef = config;
  app = createApp({ config, db: openDb(tmp), key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  idA = (await api('admin', 'POST', '/api/panels', { name: 'A', url: urlA, token: 'A' })).data.id;
  idB = (await api('admin', 'POST', '/api/panels', { name: 'B', url: urlB, token: 'B' })).data.id;
  await api('admin', 'GET', '/api/overview?force=1');
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); hook.close(); await A.close(); await B.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('unit', () => {
  test('base32 и TOTP по RFC 6238', () => {
    assert.equal(base32Encode(base32Decode('JBSWY3DPEHPK3PXP')), 'JBSWY3DPEHPK3PXP');
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(hotp(secret, 1), '287082'); // RFC 4226
    assert.equal(totp(secret, 59_000), '287082'); // RFC 6238 (SHA1, последние 6 цифр 94287082)
  });
  test('mergeEnv сохраняет комментарии, обновляет, добавляет и удаляет', () => {
    assert.equal(mergeEnv('# c\nFOO=1\nBAR=2\n', { FOO: 'x', NEW: 'y' }, ['BAR']), '# c\nFOO=x\nNEW=y');
    assert.deepEqual(parseEnvLines('A=1\n# c\n\nB=x=y'), { A: '1', B: 'x=y' });
    assert.throws(() => parseEnvLines('oops'));
  });
  test('isDue: daily и interval', () => {
    const d = new Date(2026, 0, 5, 3, 30, 10); // понедельник
    assert.equal(isDue({ mode: 'daily', time: '03:30', days: '', last_run: 0 }, d), true);
    assert.equal(isDue({ mode: 'daily', time: '03:30', days: '2,3', last_run: 0 }, d), false);
    assert.equal(isDue({ mode: 'daily', time: '03:31', days: '', last_run: 0 }, d), false);
    assert.equal(isDue({ mode: 'daily', time: '03:30', days: '', last_run: d.getTime() - 10_000 }, d), false);
    assert.equal(isDue({ mode: 'interval', interval_min: 10, last_run: d.getTime() - 11 * 60_000 }, d), true);
    assert.equal(isDue({ mode: 'interval', interval_min: 10, last_run: d.getTime() - 5 * 60_000 }, d), false);
  });
  test('applyHealth сопоставляет контейнеры и не выдумывает при чужом формате', () => {
    const tree = () => ({ projects: [{ name: 'p', services: [{ project: 'p', name: 'web', enabled: true }, { project: 'p', name: 'web-api', enabled: true }, { project: 'p', name: 'gone', enabled: true }] }] });
    const t = applyHealth(tree(), [{ name: 'p_web.1.x', state: 'running' }, { name: 'p_web-api.1.y', state: 'exited' }]);
    assert.deepEqual(t.projects[0].services.map((s) => s.health), ['running', 'failing', 'missing']);
    const t2 = applyHealth(tree(), [{ name: 'totally-other', state: 'running' }]);
    assert.ok(t2.projects[0].services.every((s) => s.health === undefined));
  });
});

describe('состояние контейнеров', () => {
  test('упавший контейнер отражается в overview', async () => {
    const { data } = await api('admin', 'GET', '/api/overview?force=1');
    const svcs = data.find((p) => p.id === idA).tree.projects.find((p) => p.name === 'web').services;
    assert.equal(svcs.find((s) => s.name === 'crashy').health, 'failing');
    assert.equal(svcs.find((s) => s.name === 'site').health, 'running');
  });
  test('история нагрузки пишется', async () => {
    const { data } = await api('admin', 'GET', `/api/panels/${idA}/history?hours=1`);
    assert.ok(data.length >= 1 && data[0].cpu > 0);
  });
  test('статистика сервиса', async () => {
    const { data } = await api('admin', 'GET', `/api/panels/${idA}/service-stats?project=web&name=site`);
    assert.equal(data.stats.cpu, 1.5);
  });
});

describe('роли и доступ по панелям', () => {
  test('operator: действия можно, удаление/создание/система — нет', async () => {
    assert.equal((await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator', panels: [idA] })).status, 200);
    await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
    const ref = { type: 'app', project: 'web', name: 'site' };
    assert.equal((await api('op', 'POST', `/api/panels/${idA}/service/action`, { ...ref, action: 'restart' })).status, 200);
    assert.equal((await api('op', 'POST', `/api/panels/${idA}/service/action`, { ...ref, action: 'destroy' })).status, 403);
    assert.equal((await api('op', 'POST', `/api/panels/${idA}/service/op`, { ...ref, op: 'env', params: { env: 'X=1' } })).status, 200);
    assert.equal((await api('op', 'POST', `/api/panels/${idA}/projects`, { name: 'zzz' })).status, 403);
    assert.equal((await api('op', 'POST', `/api/panels/${idA}/system`, { op: 'prune' })).status, 403);
    assert.equal((await api('op', 'POST', `/api/panels/${idA}/trpc`, { kind: 'query', procedure: 'projects.listProjects' })).status, 403);
  });
  test('ограничение по панелям: чужие невидимы и недоступны', async () => {
    const ov = (await api('op', 'GET', '/api/overview')).data;
    assert.deepEqual(ov.map((p) => p.name), ['A']);
    assert.equal((await api('op', 'GET', `/api/panels/${idB}/snapshot`)).status, 403);
    assert.equal((await api('op', 'POST', `/api/panels/${idB}/service/action`, { type: 'app', project: 'web', name: 'site', action: 'restart' })).status, 403);
    const bulk = await api('op', 'POST', '/api/bulk', { action: 'restart', targets: [{ panelId: idB, type: 'app', project: 'web', name: 'site' }] });
    assert.equal(bulk.status, 403);
    assert.equal((await api('op', 'GET', '/api/images')).data.every((i) => i.panelId === idA), true);
  });
  test('viewer не видит env и секреты сервиса', async () => {
    await api('admin', 'POST', '/api/users', { username: 'ro', password: 'password1', role: 'viewer' });
    await api('ro', 'POST', '/api/login', { username: 'ro', password: 'password1' });
    const admin = (await api('admin', 'GET', `/api/panels/${idA}/service?type=app&project=web&name=site`)).data;
    assert.ok(admin.service.env);
    const ro = (await api('ro', 'GET', `/api/panels/${idA}/service?type=app&project=web&name=site`)).data;
    assert.equal(ro.service.env, undefined);
    assert.equal(ro.service.name, 'site');
  });
  test('смена роли и панелей через PUT, нельзя разжаловать себя', async () => {
    const id = (await api('admin', 'GET', '/api/users')).data.find((u) => u.username === 'op').id;
    assert.equal((await api('admin', 'PUT', `/api/users/${id}`, { role: 'viewer', panels: [] })).status, 200);
    assert.equal((await api('op', 'GET', '/api/overview')).data.length, 2);
    assert.equal((await api('op', 'POST', `/api/panels/${idA}/service/action`, { type: 'app', project: 'web', name: 'site', action: 'stop' })).status, 403);
    const me = (await api('admin', 'GET', '/api/session')).data.user.id;
    assert.equal((await api('admin', 'PUT', `/api/users/${me}`, { role: 'viewer' })).status, 400);
  });
});

describe('2FA', () => {
  test('включение, вход с кодом и без', async () => {
    await api('admin', 'POST', '/api/users', { username: 'sec', password: 'password1', role: 'admin' });
    await api('sec', 'POST', '/api/login', { username: 'sec', password: 'password1' });
    const { secret, url } = (await api('sec', 'POST', '/api/me/2fa/setup')).data;
    assert.match(url, /^otpauth:\/\/totp\//);
    assert.equal((await api('sec', 'POST', '/api/me/2fa/enable', { code: '000000' })).status, 400);
    assert.equal((await api('sec', 'POST', '/api/me/2fa/enable', { code: totp(secret) })).status, 200);
    jars.sec2 = undefined;
    const noCode = await api('sec2', 'POST', '/api/login', { username: 'sec', password: 'password1' });
    assert.equal(noCode.status, 401); assert.equal(noCode.data.needTotp, true);
    assert.equal((await api('sec2', 'POST', '/api/login', { username: 'sec', password: 'password1', code: '123456' })).status, 401);
    assert.equal((await api('sec2', 'POST', '/api/login', { username: 'sec', password: 'password1', code: totp(secret) })).status, 200);
    assert.equal((await api('sec2', 'GET', '/api/session')).data.user.totpEnabled, true);
    assert.equal((await api('sec2', 'POST', '/api/me/2fa/disable', { password: 'password1', code: totp(secret) })).status, 200);
  });
});

describe('уведомления', () => {
  let chId;
  test('канал webhook: создание, тест, секреты не утекают', async () => {
    assert.equal((await api('admin', 'POST', '/api/channels', { type: 'webhook', name: 'hook', url: hookUrl, secret: 'sss', events: ['panel_down', 'panel_up', 'service_down'] })).status, 200);
    const list = (await api('admin', 'GET', '/api/channels')).data.channels;
    chId = list[0].id;
    assert.ok(!JSON.stringify(list).includes('sss'));
    assert.equal((await api('admin', 'POST', `/api/channels/${chId}/test`)).status, 200);
    assert.equal(hookPosts.at(-1).headers['x-easyadmin-secret'], 'sss');
    assert.equal((await api('admin', 'POST', '/api/channels', { type: 'webhook', name: 'bad', url: 'ftp://x' })).status, 400);
  });
  test('панель падает → одно уведомление после 2 неудач, потом восстановление', async () => {
    hookPosts.length = 0;
    const dead = createMockPanel({ token: 'D', seed: {} }); const url = await dead.listen();
    const id = (await api('admin', 'POST', '/api/panels', { name: 'Flappy', url, token: 'D' })).data.id;
    await api('admin', 'GET', '/api/overview?force=1');
    await dead.close();
    await api('admin', 'GET', '/api/overview?force=1'); await wait(50);
    assert.equal(hookPosts.filter((p) => p.body.type === 'panel_down').length, 0, 'после первой неудачи алерта ещё нет');
    await api('admin', 'GET', '/api/overview?force=1'); await api('admin', 'GET', '/api/overview?force=1'); await wait(100);
    assert.equal(hookPosts.filter((p) => p.body.type === 'panel_down').length, 1);
    assert.match(hookPosts.find((p) => p.body.type === 'panel_down').body.text, /Flappy/);
    await api('admin', 'DELETE', `/api/panels/${id}`);
  });
  test('остановка сервиса извне → алерт; остановка через EasyAdmin → без алерта', async () => {
    hookPosts.length = 0;
    await api('admin', 'GET', '/api/overview?force=1');
    await api('admin', 'POST', `/api/panels/${idB}/service/action`, { type: 'app', project: 'web', name: 'site', action: 'stop' });
    await api('admin', 'GET', '/api/overview?force=1'); await wait(80);
    assert.equal(hookPosts.filter((p) => p.body.type === 'service_down').length, 0);
    await api('admin', 'POST', `/api/panels/${idB}/service/action`, { type: 'app', project: 'web', name: 'site', action: 'start' });
    await api('admin', 'GET', '/api/overview?force=1');
    A.projects.get('web')[1].enabled = false; // db «упала» сама (не через EasyAdmin)
    await api('admin', 'GET', '/api/overview?force=1'); await wait(100);
    assert.equal(hookPosts.filter((p) => p.body.type === 'service_down').length, 1);
    assert.match(hookPosts.find((p) => p.body.type === 'service_down').body.text, /web\/db/);
    A.projects.get('web')[1].enabled = true;
    await api('admin', 'GET', '/api/overview?force=1');
  });
});

describe('шаблоны и клонирование', () => {
  before(() => { A.projects.get('web')[0].env = '# c\nFOO=1\nBAR=2'; }); // предыдущие тесты меняли env
  test('клон на другую панель переносит env/образ/ресурсы; проект создаётся', async () => {
    const r = await api('admin', 'POST', '/api/clone', { from: { panelId: idA, type: 'app', project: 'web', name: 'site' }, to: { panelId: idB, project: 'copy', name: 'site2' }, deploy: true });
    assert.equal(r.status, 200); assert.equal(r.data.ok, true, JSON.stringify(r.data));
    const s = B.projects.get('copy')[0];
    assert.equal(s.image, 'nginx:1.25');
    assert.match(s.env, /FOO=1/);
    assert.equal(s.resources.memoryLimit, 256);
  });
  test('конфликт имён → 409', async () => {
    const r = await api('admin', 'POST', '/api/clone', { from: { panelId: idA, type: 'app', project: 'web', name: 'site' }, to: { panelId: idB, project: 'copy', name: 'site2' } });
    assert.equal(r.status, 409);
  });
  test('шаблон: сохранить, список без секретов, развернуть, удалить', async () => {
    assert.equal((await api('admin', 'POST', '/api/templates', { panelId: idA, type: 'app', project: 'web', name: 'site', templateName: 'Nginx' })).status, 200);
    const list = (await api('admin', 'GET', '/api/templates')).data;
    assert.equal(list[0].image, 'nginx:1.25'); assert.ok(!JSON.stringify(list).includes('FOO=1'));
    assert.equal((await api('admin', 'POST', `/api/templates/${list[0].id}/deploy`, { panelId: idA, project: 'other', name: 'fromtpl' })).data.ok, true);
    assert.equal(A.projects.get('other')[0].name, 'fromtpl');
    assert.equal((await api('admin', 'DELETE', `/api/templates/${list[0].id}`)).status, 200);
  });
});

describe('массовые изменения', () => {
  test('bulk env: слияние без потери комментариев, на нескольких панелях', async () => {
    const r = await api('admin', 'POST', '/api/bulk/op', { op: 'env', params: { set: 'FOO=new\nADDED=1', remove: 'BAR' }, targets: [{ panelId: idA, type: 'app', project: 'web', name: 'site' }, { panelId: idB, type: 'app', project: 'copy', name: 'site2' }] });
    assert.equal(r.data.okCount, 2, JSON.stringify(r.data));
    assert.equal(A.projects.get('web')[0].env, '# c\nFOO=new\nADDED=1');
    assert.match(B.projects.get('copy')[0].env, /ADDED=1/);
  });
  test('bulk image: только для App, с ошибкой на БД', async () => {
    const r = await api('admin', 'POST', '/api/bulk/op', { op: 'image', params: { image: 'nginx:1.28' }, deploy: true, targets: [{ panelId: idA, type: 'app', project: 'web', name: 'site' }, { panelId: idA, type: 'postgres', project: 'web', name: 'db' }] });
    assert.equal(r.data.okCount, 1); assert.equal(r.data.failCount, 1);
    assert.equal(A.projects.get('web')[0].image, 'nginx:1.28');
  });
  test('bulk system: очистка на нескольких панелях', async () => {
    const r = await api('admin', 'POST', '/api/bulk/system', { op: 'cleanupImages', panelIds: [idA, idB] });
    assert.equal(r.data.okCount, 2);
    assert.equal((await api('admin', 'POST', '/api/bulk/system', { op: 'reboot', panelIds: [idA] })).status, 400);
  });
});

describe('расписания и вебхуки', () => {
  test('расписание: валидация, запуск вручную, статус', async () => {
    assert.equal((await api('admin', 'POST', '/api/schedules', { name: 'x', action: 'restart', mode: 'daily', time: '25:00', target: { items: [{ panelId: idA, type: 'app', project: 'web', name: 'site' }] } })).status, 400);
    assert.equal((await api('admin', 'POST', '/api/schedules', { name: 'Ночной рестарт', action: 'restart', mode: 'daily', time: '03:00', days: [1, 3], target: { items: [{ panelId: idA, type: 'app', project: 'web', name: 'site' }, { panelId: idA, type: 'app', project: 'web', name: 'ghost' }] } })).status, 200);
    const s = (await api('admin', 'GET', '/api/schedules')).data[0];
    assert.deepEqual(s.days, [1, 3]);
    const run = await api('admin', 'POST', `/api/schedules/${s.id}/run`);
    assert.equal(run.data.ok, false); assert.equal(run.data.errors.length, 1);
    const after = (await api('admin', 'GET', '/api/schedules')).data[0];
    assert.match(after.lastStatus, /Ошибок: 1/);
    const audit = (await api('admin', 'GET', '/api/audit')).data;
    assert.ok(audit.some((a) => a.action === 'schedule.restart' && a.username.startsWith('расписание')));
  });
  test('вебхук деплоя: токен один раз, работает без сессии и CSRF, неверный токен → 404', async () => {
    const { token, path: p } = (await api('admin', 'POST', '/api/hooks', { panelId: idA, type: 'app', project: 'web', name: 'site', label: 'ci' })).data;
    const list = (await api('admin', 'GET', '/api/hooks')).data;
    assert.ok(!JSON.stringify(list).includes(token));
    const res = await fetch(base + p, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.ok(A.calls.some((c) => c.proc === 'services.app.deployService'));
    assert.equal((await fetch(base + '/api/hooks/nope', { method: 'POST' })).status, 404);
    const audit = (await api('admin', 'GET', '/api/audit')).data;
    assert.ok(audit.some((a) => a.action === 'hook.deploy' && a.username === 'вебхук: ci'));
  });
});

describe('инвентарь', () => {
  test('образы: одноимённые сервисы на разных панелях с разными тегами', async () => {
    const { data } = await api('admin', 'GET', '/api/images?force=1');
    const sites = data.filter((i) => i.name === 'site' && i.project === 'web');
    assert.equal(new Set(sites.map((s) => s.image)).size, 2);
  });
  test('сертификаты со сроками', async () => {
    const { data } = await api('admin', 'GET', '/api/certs');
    const a = data.find((p) => p.panelId === idA).certs;
    assert.equal(a.length, 2);
    assert.ok(a[0].expiresAt > Date.now());
  });
});

describe('сертификаты в нестандартных форматах', () => {
  test('домен и срок ищутся в глубине, объекты не превращаются в [object Object]', async () => {
    const C = createMockPanel({ token: 'C', certs: [
      { domain: { host: 'deep.example.com' }, validity: { notAfter: '2030-01-01T00:00:00Z' } },
      { name: 'unix.example.com', expiresAt: Math.floor(Date.now() / 1000) + 86400 * 20 },
      { domains: ['a.example.com', 'b.example.com'], info: { expire: 'not a date' } },
      { weird: { x: 1 } },
      { domain: { main: 'main.example.com', sans: ['a.example.com', 'b.example.com'] } },
    ] });
    const url = await C.listen();
    const pid = (await api('admin', 'POST', '/api/panels', { name: 'Cx', url, token: 'C' })).data.id;
    const cx = (await api('admin', 'GET', '/api/certs')).data.find((p) => p.panelId === pid);
    assert.deepEqual(cx.certs.map((c) => c.domain).slice(0, 3), ['deep.example.com', 'unix.example.com', 'a.example.com, b.example.com']);
    assert.ok(cx.certs.every((c) => !c.domain.includes('[object')));
    assert.equal(new Date(cx.certs[0].expiresAt).getUTCFullYear(), 2030);
    const days = (cx.certs[1].expiresAt - Date.now()) / 86400000; assert.ok(days > 19 && days < 21);
    assert.equal(cx.certs[2].expiresAt, null);
    
    assert.match(cx.certs[3].domain, /weird/);
    assert.equal(cx.certs[4].domain, 'main.example.com'); assert.deepEqual(cx.certs[4].sans, ['a.example.com', 'b.example.com']);
    await api('admin', 'DELETE', `/api/panels/${pid}`); await C.close();
  });
});

describe('срок сертификата по TLS-рукопожатию', () => {
  test('если панель не отдаёт срок, он читается у самого домена', { skip: (() => { try { execFileSync('openssl', ['version']); return false; } catch { return 'нет openssl'; } })() }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-probe-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '30', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const srv = tls.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (s) => s.end());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const M = createMockPanel({ token: 'T', certs: [{ domain: { main: 'localhost' } }, { domain: { main: '*.wild.example.com' } }] });
    const url = await M.listen();
    const pid = (await api('admin', 'POST', '/api/panels', { name: 'Tls', url, token: 'T' })).data.id;
    cfgRef.tlsProbe = true; cfgRef.tlsProbePort = srv.address().port;
    try {
      const cx = (await api('admin', 'GET', '/api/certs')).data.find((p) => p.panelId === pid);
      const days = (cx.certs[0].expiresAt - Date.now()) / 86400000;
      assert.ok(days > 28 && days < 31, `дней до конца: ${days}`);
      assert.equal(cx.certs[0].source, 'tls');
      assert.equal(cx.certs[0].domain, 'localhost');
      assert.equal(cx.certs[1].expiresAt, null, 'wildcard не проверяется');
    } finally { cfgRef.tlsProbe = false; srv.close(); await api('admin', 'DELETE', `/api/panels/${pid}`); await M.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('экспорт, бэкап, метрики', () => {
  test('audit CSV с экранированием формул', async () => {
    await api('admin', 'POST', `/api/panels/${idA}/service/action`, { type: 'app', project: 'web', name: 'nope', action: 'stop' });
    const r = await api('admin', 'GET', '/api/audit?format=csv&limit=50');
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.ok(r.data.includes('time,user,panel,action'));
  });
  test('поиск по журналу', async () => {
    const { data } = await api('admin', 'GET', '/api/audit?q=schedule');
    assert.ok(data.length > 0 && data.every((a) => /schedule|расписание/i.test(JSON.stringify(a))));
  });
  test('бэкап содержит БД, ключ — только по запросу', async () => {
    const plain = (await api('admin', 'GET', '/api/backup')).data;
    assert.ok(plain.db.length > 100); assert.equal(plain.key, undefined);
    const withKey = (await api('admin', 'GET', '/api/backup?withKey=1')).data;
    assert.equal(withKey.key.length, 64);
    assert.ok(Buffer.from(withKey.db, 'base64').subarray(0, 15).toString() === 'SQLite format 3');
  });
  test('метрики Prometheus: только с токеном', async () => {
    assert.equal((await fetch(base + '/metrics')).status, 401);
    const r = await fetch(base + '/metrics', { headers: { Authorization: 'Bearer mtok' } });
    const text = await r.text();
    assert.match(text, /easyadmin_panel_up\{panel="A"\} 1/);
    assert.match(text, /easyadmin_services_total\{panel="A"\}/);
  });
});

describe('локализация на сервере', () => {
  test('ошибки API переводятся по заголовку X-Lang', async () => {
    const bad = (lang) => api('anon', 'POST', '/api/login', { username: 'admin', password: 'wrong' }, lang ? { 'X-Lang': lang } : undefined);
    assert.equal((await bad()).data.error, 'Неверный логин или пароль');
    assert.equal((await bad('en')).data.error, 'Wrong username or password');
    assert.match((await api('admin', 'GET', '/api/nothing', undefined, { 'X-Lang': 'en' })).data.error, /Not found/);
  });
  test('язык уведомлений: настройка, права, тексты каналов', async () => {
    assert.equal((await api('admin', 'GET', '/api/settings')).data.notifyLang, 'ru');
    assert.equal((await api('admin', 'PUT', '/api/settings', { notifyLang: 'de' })).status, 400);
    const id = (await api('admin', 'GET', '/api/channels')).data.channels[0].id;
    hookPosts.length = 0;
    await api('admin', 'POST', `/api/channels/${id}/test`);
    assert.match(hookPosts.at(-1).body.text, /тестовое уведомление/);
    assert.equal((await api('admin', 'PUT', '/api/settings', { notifyLang: 'en' })).data.notifyLang, 'en');
    await api('admin', 'POST', `/api/channels/${id}/test`);
    assert.match(hookPosts.at(-1).body.text, /test notification/);
    // реальные события тоже на английском
    const dead = createMockPanel({ token: 'Z', seed: {} }); const url = await dead.listen();
    const pid = (await api('admin', 'POST', '/api/panels', { name: 'Lang', url, token: 'Z' })).data.id;
    await api('admin', 'GET', '/api/overview?force=1'); await dead.close();
    for (let i = 0; i < 3; i++) await api('admin', 'GET', '/api/overview?force=1');
    await wait(100);
    const down = hookPosts.find((p) => p.body.type === 'panel_down');
    assert.match(down.body.text, /Panel “Lang” is unavailable/);
    await api('admin', 'DELETE', `/api/panels/${pid}`);
    await api('admin', 'PUT', '/api/settings', { notifyLang: 'ru' });
    assert.equal((await api('ro', 'GET', '/api/settings')).status, 403);
  });
});
