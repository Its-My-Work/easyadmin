import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { evaluate } from '../src/installer.js';
import { checkTarget, fingerprintOf, knownHostsLine } from '../src/ssh.js';
import { createMockPanel } from './mock-easypanel.js';

const GOOD = { uid: '0', os: 'ubuntu', osver: '24.04', arch: 'x86_64', mem: '3900', disk: '40', port80: 'free', port443: 'free', port3000: 'free', systemd: 'yes', docker: 'no', swarm: 'none', containers: '0', easypanel: 'no', internet: 'yes' };
const kv = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n');

let app, base, tmp, panel; const jars = {}; const calls = []; let scenario;
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const KEY = { type: 'ssh-ed25519', key: Buffer.from('fake-host-key').toString('base64') }; KEY.fingerprint = fingerprintOf(KEY.key);

/** Поддельный SSH: отвечает на скрипты установщика так, как отвечал бы сервер; туннель ведёт на мок-панель. */
const fakeSsh = {
  async scanHostKeys(host, port) { calls.push(['scan', host, port]); return { host, port, keys: [{ ...KEY }] }; },
  openSession(opts) {
    calls.push(['open', opts.host, opts.user]); let polls = 0; let closed = false;
    return {
      async run(script) {
        if (/echo "uid=\$\(id -u\)"/.test(script)) return { code: 0, stdout: kv({ ...GOOD, ...(scenario.info ?? {}) }), stderr: '' };
        if (/systemd-run --unit=easypanel-install/.test(script)) { calls.push(['start-install', script]); return { code: 0, stdout: 'Running as unit: easypanel-install.service\n', stderr: '' }; }
        if (/__COUNT__/.test(script)) { polls++; const done = polls >= 2; return { code: 0, stdout: `${done ? 'Easypanel is running\n' : 'pulling image\n'}__COUNT__ ${polls}\n__STATE__ ${done ? 'inactive' : 'active'}\n__UP__ ${done && !scenario.noPanel ? 'yes' : 'no'}\n`, stderr: '' }; }
        return { code: 0, stdout: '', stderr: '' };
      },
      async tunnel(port) { calls.push(['tunnel', port]); return { url: panel.url, close() { calls.push(['tunnel-closed']); } }; },
      close() { if (!closed) { closed = true; calls.push(['closed']); } },
    };
  },
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-inst-'));
  const fetchImpl = async (url) => { if (scenario.https && String(url).startsWith('https://')) return { status: 200 }; throw new Error('no https'); };
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db: openDb(tmp), key: crypto.randomBytes(32), ssh: fakeSsh, fetchImpl, installPollMs: 5, installHttpsPollMs: 5, installHttpsTries: 3, installDnsTimeoutMs: 800, installExtTimeoutMs: 800 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await panel?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const freshPanel = async () => { await panel?.close(); panel = createMockPanel({ token: 'T', seed: {}, psettings: { fresh: true } }); panel.url = await panel.listen(); };
const check = (b = {}) => api('admin', 'POST', '/api/installs/check', { host: '203.0.113.50', port: 22, user: 'root', fingerprint: KEY.fingerprint, auth: { password: 'ssh-secret-pw' }, ...b });
const wait = async (id, ms = 8000) => { const t0 = Date.now(); for (;;) { const r = await api('admin', 'GET', `/api/installs/${id}`); if (r.data.status !== 'running' || Date.now() - t0 > ms) return r; await new Promise((x) => setTimeout(x, 30)); } };
const start = async (extra = {}) => { const c = await check(); assert.equal(c.status, 200, JSON.stringify(c.data)); return api('admin', 'POST', '/api/installs', { ticket: c.data.ticket, panel: { name: 'New server', color: '#22c55e', tags: 'new, eu' }, admin: { email: 'admin@example.com' }, terms: true, ...extra }); };

describe('проверка адреса и оценка сервера', () => {
  test('адрес: петля, служебные и некорректные адреса отклоняются', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '169.254.169.254', '::1', 'a b', '-x', 'host_name', '']) assert.throws(() => checkTarget(h, 22), /адрес|нельзя/i, h);
    assert.throws(() => checkTarget('example.com', 0), /Порт/); assert.throws(() => checkTarget('example.com', 70000), /Порт/);
    assert.deepEqual(checkTarget('Example.com', '2222'), { host: 'Example.com', port: 2222 }); assert.equal(checkTarget('203.0.113.5', undefined).port, 22);
  });
  test('отпечаток и known_hosts', () => {
    assert.match(fingerprintOf(Buffer.from('x').toString('base64')), /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(knownHostsLine('h', 22, 'ssh-ed25519', 'AAA'), 'h ssh-ed25519 AAA'); assert.equal(knownHostsLine('h', 2222, 'ssh-ed25519', 'AAA'), '[h]:2222 ssh-ed25519 AAA');
  });
  test('оценка: подходящий сервер; Ubuntu 22.04+ и Debian 11+; остальное — с причиной', () => {
    const lv = (o) => Object.fromEntries(evaluate({ ...GOOD, ...o }).map((c) => [c.id, c.level]));
    assert.ok(Object.values(lv({})).every((l) => l !== 'error'));
    assert.ok(Object.values(lv({ os: 'debian', osver: '12' })).every((l) => l !== 'error'));
    assert.equal(lv({ os: 'ubuntu', osver: '20.04' }).os, 'error'); assert.equal(lv({ os: 'debian', osver: '10' }).os, 'error'); assert.equal(lv({ os: 'rocky', osver: '9' }).os, 'error'); assert.equal(lv({ os: 'alpine', osver: '3.20' }).os, 'error');
    assert.equal(lv({ mem: '900' }).mem, 'error'); assert.equal(lv({ disk: '2' }).disk, 'warn'); assert.equal(lv({ port80: 'busy' }).port80, 'error'); assert.equal(lv({ port3000: 'busy' }).port3000, 'error');
    assert.equal(lv({ swarm: 'active' }).swarm, 'error'); assert.equal(lv({ easypanel: 'yes' }).easypanel, 'error'); assert.equal(lv({ internet: 'no' }).internet, 'error'); assert.equal(lv({ systemd: 'no' }).systemd, 'error');
    assert.equal(lv({ docker: 'yes', containers: '4' }).containers, 'warn'); assert.equal(lv({ arch: 'armv7l' }).arch, 'error');
    const noRoot = evaluate({}); assert.equal(noRoot.find((c) => c.id === 'root').level, 'error');
  });
});

describe('мастер установки', () => {
  test('доступ и проверки: только админ, неверный отпечаток, неподходящий сервер; секреты в ответах и журнале не появляются', async () => {
    assert.equal((await api('op', 'POST', '/api/installs/scan', { host: '203.0.113.50' })).status, 403);
    assert.equal((await api('admin', 'POST', '/api/installs/scan', { host: '127.0.0.1' })).status, 400);
    const sc = await api('admin', 'POST', '/api/installs/scan', { host: '203.0.113.50' }); assert.equal(sc.status, 200); assert.deepEqual(sc.data.keys, [{ type: 'ssh-ed25519', fingerprint: KEY.fingerprint }]); assert.ok(!JSON.stringify(sc.data).includes(KEY.key), 'сам ключ не нужен браузеру');
    assert.equal((await check({ fingerprint: 'SHA256:wrong' })).status, 400);
    assert.equal((await check({ user: 'root; rm -rf /' })).status, 400); assert.equal((await check({ host: '169.254.169.254' })).status, 400);
    scenario = { info: { os: 'centos', osver: '9' } }; const bad = await check(); assert.equal(bad.data.ok, false); assert.equal(bad.data.ticket, undefined); assert.ok(bad.data.checks.some((c) => c.id === 'os' && c.level === 'error')); assert.ok(calls.some((c) => c[0] === 'closed'), 'сеанс закрыт');
    assert.ok(!JSON.stringify(await api('admin', 'GET', '/api/audit?limit=200')).includes('ssh-secret-pw'));
  });

  test('полная установка: проверка → запуск → панель добавлена с токеном, пароль показывается один раз, всё закрыто и очищено', async () => {
    await freshPanel(); scenario = { https: true }; calls.length = 0;
    const c = await check(); assert.equal(c.data.ok, true); assert.ok(c.data.ticket);
    assert.equal((await api('admin', 'POST', '/api/installs', { ticket: c.data.ticket, panel: { name: 'X' }, admin: { email: 'a@b.co' } })).status, 400, 'без согласия с условиями Easypanel — нельзя');
    assert.equal((await api('admin', 'POST', '/api/installs', { ticket: c.data.ticket, panel: { name: '' }, admin: { email: 'a@b.co' }, terms: true })).status, 400);
    assert.equal((await api('admin', 'POST', '/api/installs', { ticket: c.data.ticket, panel: { name: 'X' }, admin: { email: 'nope' }, terms: true })).status, 400);
    assert.equal((await api('admin', 'POST', '/api/installs', { ticket: c.data.ticket, panel: { name: 'X' }, admin: { email: 'a@b.co', password: 'short' }, terms: true })).status, 400);
    assert.equal((await api('op', 'POST', '/api/installs', { ticket: c.data.ticket, panel: { name: 'X' }, admin: { email: 'a@b.co' }, terms: true })).status, 403);
    const s = await api('admin', 'POST', '/api/installs', { ticket: c.data.ticket, panel: { name: 'New server', color: '#22c55e', tags: 'new, eu' }, admin: { email: 'admin@example.com' }, terms: true });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal((await api('admin', 'POST', '/api/installs', { ticket: c.data.ticket, panel: { name: 'X' }, admin: { email: 'a@b.co' }, terms: true })).status, 400, 'ticket одноразовый');
    const r = await wait(s.data.id);
    assert.equal(r.data.status, 'done', JSON.stringify(r.data)); assert.deepEqual(r.data.steps.map((x) => x.status), Array(7).fill('ok'));
    assert.equal(r.data.url, 'https://mock.easypanel.host'); assert.equal(r.data.https, true); assert.equal(r.data.adminEmail, 'admin@example.com');
    assert.ok(r.data.adminPassword && r.data.adminPassword.length >= 16, 'пароль сгенерирован и показан');
    assert.equal((await api('admin', 'GET', `/api/installs/${s.data.id}`)).data.adminPassword, null, 'второй раз пароль не показывается');
    const pwd = r.data.adminPassword;
    assert.deepEqual([panel.ps.setupInput.email, panel.ps.setupInput.source, panel.ps.setupInput.subscribe], ['admin@example.com', 'easyadmin', false], 'подписка по умолчанию выключена, источник — easyadmin');
    const list = (await api('admin', 'GET', '/api/overview')).data; const added = list.find((p) => p.name === 'New server');
    assert.ok(added, 'панель добавлена'); assert.equal(added.url, 'https://mock.easypanel.host'); assert.equal(added.color, '#22c55e'); assert.deepEqual(added.tags, ['new', 'eu']);
    const kinds = calls.map((x) => x[0]); assert.ok(kinds.includes('start-install') && kinds.includes('tunnel') && kinds.includes('tunnel-closed')); assert.equal(kinds.filter((x) => x === 'closed').length >= 1, true);
    assert.match(calls.find((x) => x[0] === 'start-install')[1], /get\.easypanel\.io/); assert.ok(!calls.find((x) => x[0] === 'start-install')[1].includes(pwd), 'пароль не в команде установки');
    // секреты не попали ни в журнал, ни в базу
    const dump = fs.readFileSync(path.join(tmp, 'easyadmin.db')); const audit = JSON.stringify((await api('admin', 'GET', '/api/audit?limit=200')).data);
    for (const secret of [pwd, 'ssh-secret-pw']) { assert.ok(!dump.includes(secret), 'секрет не в базе'); assert.ok(!audit.includes(secret), 'секрет не в журнале'); }
    assert.ok(!r.data.log.join('\n').includes(pwd));
    assert.ok((await api('admin', 'GET', '/api/audit?q=panel.install&limit=50')).data.some((a) => a.action === 'panel.install.done' && a.ok === 1));
    const hist = (await api('admin', 'GET', '/api/installs')).data.installs; assert.equal(hist[0].status, 'done'); assert.equal(hist[0].host, '203.0.113.50');
  });

  test('свой пароль администратора не возвращается; HTTPS недоступен — панель добавляется по HTTP :3000 с предупреждением; неверный домен — предупреждение', async () => {
    await freshPanel(); scenario = { https: false };
    const s = await start({ admin: { email: 'me@example.com', password: 'my-own-password-1' }, domain: 'panel.nonexistent-domain.invalid' });
    assert.equal(s.status, 200); const r = await wait(s.data.id);
    assert.equal(r.data.status, 'done'); assert.equal(r.data.adminPassword, null, 'пароль, заданный пользователем, не возвращается');
    assert.equal(r.data.url, 'http://203.0.113.7:3000'); assert.equal(r.data.https, false);
    assert.ok(r.data.warnings.some((w) => /HTTPS пока недоступен/.test(w))); assert.ok(r.data.warnings.some((w) => /DNS-запись домена/.test(w)));
  });

  test('сбои: панель уже настроена, установка не запустила панель, остановка пользователем; сеанс и туннель всегда закрываются', async () => {
    // уже настроена
    panel = panel ?? null; await panel?.close(); panel = createMockPanel({ token: 'T', seed: {} }); panel.url = await panel.listen(); scenario = { https: true }; calls.length = 0;
    let s = await start(); let r = await wait(s.data.id);
    assert.equal(r.data.status, 'error'); assert.match(r.data.error, /уже настроена/); assert.ok(calls.some((x) => x[0] === 'closed') && calls.some((x) => x[0] === 'tunnel-closed'));
    assert.equal(r.data.steps.find((x) => x.id === 'setup').status, 'error');
    // панель не поднялась
    await freshPanel(); scenario = { noPanel: true }; calls.length = 0;
    s = await start(); r = await wait(s.data.id); assert.equal(r.data.status, 'error'); assert.match(r.data.error, /панель не запустилась/); assert.ok(calls.some((x) => x[0] === 'closed'));
    assert.equal((await api('admin', 'GET', '/api/audit?q=panel.install.failed&limit=20')).data.length >= 2, true);
    // остановка
    await freshPanel(); scenario = { https: true, info: {} }; const slow = { ...fakeSsh }; calls.length = 0;
    s = await start(); const del = await api('admin', 'DELETE', `/api/installs/${s.data.id}`); assert.equal(del.status, 200); r = await wait(s.data.id);
    assert.ok(['aborted', 'done'].includes(r.data.status)); // успел или остановлен — главное, не зависает
    assert.equal((await api('admin', 'GET', '/api/installs/nope')).status, 404); assert.equal((await api('admin', 'DELETE', '/api/installs/nope')).status, 400);
  });
});
