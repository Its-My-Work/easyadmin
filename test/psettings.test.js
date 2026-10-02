import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { SETTINGS, cleanValue, diffText } from '../src/panel-settings.js';
import { createMockPanel } from './mock-easypanel.js';

let app, base, tmp; const jars = {}; const panels = [];
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const addPanel = async (name, opts = {}) => {
  const m = createMockPanel({ token: 'T', seed: { web: [{ name: 'site' }] }, ...opts });
  panels.push(m); const url = await m.listen();
  const r = await api('admin', 'POST', '/api/panels', { name, url, token: 'T' });
  return { id: r.data.id, m };
};
const auditOf = async (q) => (await api('admin', 'GET', `/api/audit?q=${encodeURIComponent(q)}&limit=200`)).data;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-ps-'));
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db: openDb(tmp), key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await Promise.all(panels.map((p) => p.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('настройки панели: реестр и проверка значений', () => {
  test('проверка полей: домен, e-mail, цвет, числа, выбор; лишние поля отбрасываются', () => {
    const def = (k) => SETTINGS.find((s) => s.key === k);
    assert.deepEqual(cleanValue(def('panelDomain'), { customPanelDomain: ' Panel.Example.com ', serveOnIp: 1, evil: 'x' }), { customPanelDomain: 'Panel.Example.com', serveOnIp: true });
    assert.throws(() => cleanValue(def('panelDomain'), { customPanelDomain: 'not a domain', serveOnIp: true }), /домен/);
    assert.throws(() => cleanValue(def('panelDomain'), { customPanelDomain: '*.example.com', serveOnIp: true }), /домен/);
    assert.throws(() => cleanValue(def('letsEncryptEmail'), { email: 'nope' }), /e-mail/);
    assert.throws(() => cleanValue(def('letsEncryptEmail'), { email: '' }), /обязательное/);
    assert.throws(() => cleanValue(def('brandingBasic'), { serverName: 'x', serverColor: 'red' }), /#RRGGBB/);
    assert.equal(cleanValue(def('brandingBasic'), { serverName: 'x', serverColor: '#AABBCC' }).serverColor, '#AABBCC');
    assert.throws(() => cleanValue(def('metrics'), { enabled: true, retentionType: 'days', retentionValue: 0, scrapeInterval: 15 }), /от 1/);
    assert.throws(() => cleanValue(def('metrics'), { enabled: true, retentionType: 'weeks', retentionValue: 3, scrapeInterval: 15 }), /недопустимое/);
    assert.throws(() => cleanValue(def('metrics'), { enabled: true, retentionType: 'days', retentionValue: 2.5, scrapeInterval: 15 }), /число/);
    assert.throws(() => cleanValue(def('customCode'), { customCode: 'a\u0000b' }), /символы/);
    assert.throws(() => cleanValue(def('customCode'), null), /объект/);
  });
  test('в журнале секреты маскируются, длинные тексты сокращаются, без изменений — так и пишем', () => {
    const d = SETTINGS.find((s) => s.key === 'githubToken');
    assert.equal(diffText(d, { token: '' }, { token: 'ghp_verysecret' }), 'token: — → ••••');
    const c = SETTINGS.find((s) => s.key === 'customCode');
    assert.match(diffText(c, { customCode: '' }, { customCode: 'x'.repeat(100) }), /… *$/);
    assert.equal(diffText(c, { customCode: 'a' }, { customCode: 'a' }), 'без изменений');
  });
});

describe('настройки панели: значения, запись, журнал, права', () => {
  test('схема и значения: только админ; значения приходят в форме полей, секреты не отдаются', async () => {
    const { id, m } = await addPanel('P1'); m.ps.github = 'ghp_TOPSECRET';
    assert.equal((await api('op', 'GET', '/api/psettings/schema')).status, 403);
    assert.equal((await api('op', 'GET', `/api/panels/${id}/psettings`)).status, 403);
    const schema = (await api('admin', 'GET', '/api/psettings/schema')).data;
    assert.ok(schema.sections.length >= 9 && schema.settings.find((s) => s.key === 'panelDomain').danger);
    const r = await api('admin', 'GET', `/api/panels/${id}/psettings`);
    assert.equal(r.status, 200); assert.deepEqual(r.data.errors, {});
    assert.deepEqual(r.data.values.panelDomain, { customPanelDomain: '', serveOnIp: true, _info: { defaultPanelDomain: 'mock.easypanel.host' } });
    assert.equal(r.data.values.letsEncryptEmail.email, 'ops@example.com');
    assert.equal(r.data.values.telemetry.disabled, false); assert.equal(r.data.values.dailyCleanup.enabled, true);
    assert.equal(r.data.values.metrics.retentionType, 'days', 'не настроено — значения по умолчанию');
    assert.equal(r.data.values.githubToken._info.hasToken, true);
    assert.ok(!JSON.stringify(r.data).includes('ghp_TOPSECRET'), 'токен GitHub не уходит в браузер');
    const one = await api('admin', 'GET', `/api/panels/${id}/psettings?section=address`);
    assert.deepEqual(Object.keys(one.data.values).sort(), ['letsEncryptEmail', 'panelDomain', 'serviceDomain']);
  });

  test('запись: проверка до обращения к панели, значения доходят в нужном виде, в журнале разница без секретов', async () => {
    const { id, m } = await addPanel('P2');
    const put = (key, value) => api('admin', 'PUT', `/api/panels/${id}/psettings/${key}`, { value });
    m.ps.changed.length = 0;
    assert.equal((await put('letsEncryptEmail', { email: 'bad' })).status, 400);
    assert.equal((await put('nope', {})).status, 400);
    assert.equal((await put('panelDomain', { customPanelDomain: 'has space.com', serveOnIp: true })).status, 400);
    assert.deepEqual(m.ps.changed, [], 'неверные значения не дошли до панели');
    assert.equal((await api('op', 'PUT', `/api/panels/${id}/psettings/telemetry`, { value: { disabled: true } })).status, 403);

    const ok = await put('panelDomain', { customPanelDomain: 'panel.example.com', serveOnIp: false });
    assert.equal(ok.status, 200); assert.equal(ok.data.value.customPanelDomain, 'panel.example.com'); assert.equal(ok.data.value.serveOnIp, false);
    assert.equal(m.ps.panelDomain.customPanelDomain, 'panel.example.com');
    await put('telemetry', { disabled: true }); assert.equal(m.ps.telemetry, true);
    await put('metrics', { enabled: true, retentionType: 'gb', retentionValue: 5, scrapeInterval: 30 });
    assert.deepEqual(m.ps.metrics, { enabled: true, retentionType: 'gb', retentionValue: 5, scrapeInterval: 30 });
    await put('githubToken', { token: 'ghp_NEWSECRET' }); assert.equal(m.ps.github, 'ghp_NEWSECRET');
    await put('brandingBasic', { serverName: 'Prod', serverColor: '#112233', hideIp: true, hideNotes: false });
    assert.deepEqual(m.ps.basic, { serverName: 'Prod', serverColor: '#112233', hideIp: true, hideNotes: false });

    const log = await auditOf('psettings');
    const dom = log.find((a) => a.action === 'psettings.panelDomain' && a.ok === 1);
    assert.match(dom.detail, /customPanelDomain: — → panel\.example\.com/); assert.match(dom.detail, /serveOnIp: true → false/);
    assert.ok(JSON.stringify(log).includes('token: — → ••••') && !JSON.stringify(log).includes('ghp_NEWSECRET'), 'секрет в журнал не попал');
    const bad = await api('admin', 'PUT', `/api/panels/${id}/psettings/metrics`, { value: { enabled: true, retentionType: 'gb', retentionValue: 5, scrapeInterval: 30 } });
    assert.equal(bad.status, 200);
  });

  test('ошибка панели при записи: понятный ответ и запись о неудаче в журнале', async () => {
    const { id } = await addPanel('P3', { psettings: { reject: ['settings.setTelemetryDisabled'] } });
    const r = await api('admin', 'PUT', `/api/panels/${id}/psettings/telemetry`, { value: { disabled: true } });
    assert.equal(r.status, 502); assert.match(r.data.error, /rejected/);
    assert.ok((await auditOf('psettings.telemetry')).some((a) => a.ok === 0));
  });

  test('обзор: версии, адрес, счётчики; недоступные процедуры дают null, а не ошибку', async () => {
    const { id } = await addPanel('P4');
    const r = await api('admin', 'GET', `/api/panels/${id}/pstatus`);
    assert.equal(r.status, 200);
    assert.equal(r.data.version, '2.36.0'); assert.equal(r.data.updateAvailable, false); assert.equal(r.data.dockerVersion, '29.7.0');
    assert.deepEqual(r.data.dockerUpdate, { available: true, latest: '29.8.2' }); assert.equal(r.data.serverIp, '203.0.113.7');
    assert.equal(r.data.users, 2); assert.equal(r.data.builders, 1); assert.equal(r.data.nodes, 2);
  });

  test('системные действия: очистка кэша сборки, обновление IP, перезапуск Traefik, обновление панели', async () => {
    const { id, m } = await addPanel('P5');
    for (const op of ['cleanupBuilder', 'refreshServerIp', 'restartTraefik', 'updatePanel']) assert.equal((await api('admin', 'POST', `/api/panels/${id}/system`, { op })).status, 200, op);
    assert.deepEqual(m.ps.changed.slice(-4), ['settings.cleanupDockerBuilder', 'settings.refreshServerIp', 'traefik.restart', 'update.update']);
  });
});

describe('настройки панели: билдеры, пользователи, Traefik, кластер', () => {
  test('билдеры: создание с проверкой имени и лимитов, выбор, остановка, удаление', async () => {
    const { id, m } = await addPanel('B1');
    const op = (b) => api('admin', 'POST', `/api/panels/${id}/pbuilders`, b);
    assert.equal((await op({ op: 'create', name: 'bad name' })).status, 400);
    assert.equal((await op({ op: 'create', name: 'big', memory: 100 })).status, 400);
    assert.equal((await op({ op: 'create', name: 'big', memory: 4096, memorySwap: 1024 })).status, 400);
    assert.equal((await op({ op: 'create', name: 'big', cpus: 4, memory: 4096, memorySwap: 8192 })).status, 200);
    assert.equal((await op({ op: 'use', name: 'big' })).status, 200);
    const list = (await api('admin', 'GET', `/api/panels/${id}/pbuilders`)).data.builders;
    assert.deepEqual(list.map((b) => [b.name, b.current]), [['default', false], ['big', true]]);
    assert.equal((await op({ op: 'nuke', name: 'big' })).status, 400);
    assert.equal((await op({ op: 'remove', name: 'big' })).status, 200); assert.equal(m.ps.builders.length, 1);
  });

  test('пользователи: список без токенов, защита «своего» пользователя, токен показывается один раз', async () => {
    const { id, m } = await addPanel('U1');
    const list = await api('admin', 'GET', `/api/panels/${id}/pusers`);
    assert.equal(list.data.users.length, 2); assert.ok(!JSON.stringify(list.data).includes('owner-token'), 'токен не в ответе');
    const [owner, dev] = list.data.users;
    assert.deepEqual([owner.self, owner.hasToken, owner.admin], [true, true, true]); assert.deepEqual([dev.self, dev.hasToken, dev.twoFactor], [false, false, true]);
    // пользователь, от имени которого работает EasyAdmin, не удаляется и токен ему не меняется — иначе доступ к панели пропадёт
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pusers/${owner.id}`)).status, 400);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pusers/${owner.id}/token`)).status, 400);
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pusers/${owner.id}/token`)).status, 400);
    assert.ok(!m.ps.changed.includes('users.destroyUser') && !m.ps.changed.includes('users.generateApiToken'));
    const tok = await api('admin', 'POST', `/api/panels/${id}/pusers/${dev.id}/token?email=dev@example.com`);
    assert.equal(tok.status, 200); assert.equal(tok.data.token, 'tok-u2-new');
    assert.ok(!JSON.stringify(await auditOf('panel.user.token')).includes('tok-u2-new'), 'токен не попал в журнал');
    assert.equal((await api('admin', 'GET', `/api/panels/${id}/pusers`)).data.users[1].hasToken, true);
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pusers/${dev.id}/token`)).status, 200);
    // создание и правка
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pusers`, { email: 'nope', password: 'longenough' })).status, 400);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pusers`, { email: 'new@example.com', password: 'short' })).status, 400);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pusers`, { email: 'new@example.com', password: 'longenough1', admin: true })).status, 200);
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/pusers/${dev.id}`, { admin: true, password: 'newpassword1' })).status, 200);
    assert.equal(m.ps.users.find((u) => u.id === 'u2').admin, true); assert.equal(m.ps.users.find((u) => u.id === 'u2').passwordChanged, true);
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/pusers/${dev.id}`, { password: 'newpassword1' })).status, 400, 'нужно указать роль');
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/pusers/${dev.id}`, { admin: true, password: 'short' })).status, 400);
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pusers/u2`)).status, 200);
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pusers/..%2Fx`)).status, 400, 'идентификатор проверяется');
    assert.ok(!JSON.stringify(await auditOf('panel.user')).includes('newpassword1'), 'пароли в журнал не попадают');
  });

  test('аккаунт: смена пароля и двухфакторка', async () => {
    const { id, m } = await addPanel('A1');
    const cred = (b) => api('admin', 'POST', `/api/panels/${id}/paccount/credentials`, b);
    assert.equal((await cred({ email: 'x', oldPassword: 'password1', newPassword: 'password2' })).status, 400);
    assert.equal((await cred({ email: 'a@b.co', oldPassword: 'short', newPassword: 'password2' })).status, 400);
    assert.equal((await cred({ email: 'a@b.co', oldPassword: 'wrongpass', newPassword: 'password2' })).status, 502);
    assert.equal((await cred({ email: 'a@b.co', oldPassword: 'password1', newPassword: 'password2' })).status, 200);
    assert.ok(!JSON.stringify(await auditOf('panel.account')).includes('password2'));
    const fa = (b) => api('admin', 'POST', `/api/panels/${id}/paccount/2fa`, b);
    const conf = await fa({ op: 'configure' }); assert.equal(conf.data.secret, 'JBSWY3DPEHPK3PXP'); assert.match(conf.data.qr, /^data:image/);
    assert.equal((await fa({ op: 'enable', code: 'abc' })).status, 400);
    assert.equal((await fa({ op: 'enable', code: '000000' })).status, 502);
    assert.equal((await fa({ op: 'enable', code: '123456' })).status, 200); assert.equal(m.ps.twoFactor, true);
    assert.equal((await fa({ op: 'disable' })).status, 200); assert.equal((await fa({ op: 'x' })).status, 400);
  });

  test('Traefik: env только по запросу, перед каждой записью сохраняется прежняя версия (зашифрованной), её можно прочитать и вернуть', async () => {
    const { id, m } = await addPanel('T1');
    const plain = (await api('admin', 'GET', `/api/panels/${id}/ptraefik`)).data;
    assert.equal(plain.env, undefined, 'env по умолчанию не читается'); assert.equal(plain.config, '');
    const full = (await api('admin', 'GET', `/api/panels/${id}/ptraefik?env=1`)).data; assert.match(full.env, /CF_TOKEN/);
    const put = (kind, content) => api('admin', 'PUT', `/api/panels/${id}/ptraefik/${kind}`, { content });
    assert.equal((await put('bogus', 'x')).status, 400); assert.equal((await put('config', 5)).status, 400); assert.equal((await put('config', 'a\u0000b')).status, 400);
    assert.equal((await put('config', 'http:\n  routers: {}\n')).status, 200);
    const second = await put('config', 'http:\n  routers:\n    a: {}\n'); assert.equal(second.data.history.length, 2);
    assert.equal(m.ps.config, 'http:\n  routers:\n    a: {}\n');
    const h = (await api('admin', 'GET', `/api/panels/${id}/ptraefik`)).data.history.config;
    const oldest = await api('admin', 'GET', `/api/panels/${id}/ptraefik/config/history/${h.at(-1).id}`); assert.equal(oldest.data.content, '');
    const prev = await api('admin', 'GET', `/api/panels/${id}/ptraefik/config/history/${h[0].id}`); assert.equal(prev.data.content, 'http:\n  routers: {}\n');
    assert.equal((await put('config', prev.data.content)).status, 200, 'возврат старой версии — обычная запись');
    assert.equal((await api('admin', 'GET', `/api/panels/${id}/ptraefik/config/history/99999`)).status, 404);
    assert.equal((await put('env', 'A=1\n')).status, 200);
    const raw = new DatabaseSync(path.join(tmp, 'easyadmin.db')).prepare('SELECT content_enc FROM panel_config_history').all();
    assert.ok(raw.length >= 3 && raw.every((r) => !/CF_TOKEN|routers/.test(r.content_enc)), 'в базе версии не лежат открытым текстом');
    assert.ok(!JSON.stringify(await auditOf('traefik')).includes('CF_TOKEN'));
    assert.equal((await api('op', 'GET', `/api/panels/${id}/ptraefik`)).status, 403);
  });

  test('кластер, хранилища бэкапов и каналы панели: списки без секретов, удаление с проверкой', async () => {
    const { id, m } = await addPanel('C1');
    const cl = (await api('admin', 'GET', `/api/panels/${id}/pcluster`)).data;
    assert.deepEqual(cl.nodes.map((n) => [n.id, n.host, n.role, n.manager]), [['n1', 'main', 'manager', true], ['n2', 'w1', 'worker', false]]);
    assert.match(cl.workerCommand, /docker swarm join/);
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pcluster/n2`)).status, 200); assert.equal(m.ps.nodes.length, 1);
    const nf = await api('admin', 'GET', `/api/panels/${id}/pnotify`); assert.deepEqual([nf.data.channels[0].id, nf.data.channels[0].name, nf.data.channels[0].type, nf.data.channels[0].hasSecret], ['c1', 'Ops', 'slack', { url: true }]);
    assert.ok(!JSON.stringify(nf.data).includes('hooks.example'));
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pnotify/c1`)).status, 200);
  });

  test('журнал действий панели: список, подробности, отмена', async () => {
    const { id } = await addPanel('L1');
    assert.equal((await api('admin', 'GET', `/api/panels/${id}/pactions?limit=5`)).status, 200);
    assert.equal((await api('admin', 'GET', `/api/panels/${id}/pactions/a1`)).data.log, 'step 1\nstep 2');
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pactions/a1/kill`)).status, 200);
    assert.equal((await api('admin', 'GET', `/api/panels/${id}/pactions/..%2F..`)).status, 400);
  });
});

describe('обновление Docker из EasyAdmin', () => {
  const mk = async (name, { hostExec, ...opts } = {}) => {
    const m = createMockPanel({ token: 'T', seed: { web: [{ name: 'site' }] }, realPanel: true, hostExec, ...opts });
    panels.push(m); const url = await m.listen();
    return { id: (await api('admin', 'POST', '/api/panels', { name, url, token: 'T' })).data.id, m };
  };
  const marker = (cmd, kind) => { const x = /\$\(\((\d+)\+(\d+)\)\)/.exec(cmd); return `__EA${kind}${Number(x[1]) + Number(x[2])}__`; };
  test('запуск: только админ, подтверждение названием, только если есть новая версия; команда уходит отдельным юнитом systemd', async () => {
    const cmds = [];
    const { id } = await mk('DK1', { hostExec: (cmd) => { cmds.push(cmd); return `Running as unit: docker-upgrade-ea.service\n${marker(cmd, 'OK')}`; } });
    const go = (who, body) => api(who, 'POST', `/api/panels/${id}/pdocker/update`, body);
    assert.equal((await go('op', { confirm: 'DK1' })).status, 403);
    assert.equal((await go('admin', {})).status, 400); assert.equal((await go('admin', { confirm: 'other' })).status, 400); assert.equal(cmds.length, 0, 'без подтверждения команда не выполняется');
    const r = await go('admin', { confirm: 'DK1' });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual([r.data.started, r.data.from, r.data.to], [true, '29.7.0', '29.8.2']);
    assert.equal(cmds.length, 1); assert.match(cmds[0], /systemd-run --unit=docker-upgrade-ea/); assert.match(cmds[0], /docker-ce docker-ce-cli containerd\.io/); assert.match(cmds[0], /--only-upgrade\$PK/); assert.match(cmds[0], /"\$OS" != ubuntu.*"\$OS" != debian/, 'только Ubuntu и Debian'); assert.match(cmds[0], /is-active --quiet docker-upgrade-ea/, 'повторный запуск защищён');
    assert.ok(!cmds[0].includes('DK1') && !cmds[0].includes('confirm'), 'команда фиксированная и не зависит от ввода пользователя');
    const log = await auditOf('docker.update'); assert.ok(log.some((a) => a.ok === 1 && /29\.7\.0 → 29\.8\.2/.test(a.detail)));
  });
  test('нет новой версии, ошибка на хосте (не apt) и таймаут консоли — понятные ответы', async () => {
    const { id, m } = await mk('DK2', { hostExec: (cmd) => `EA_NO_OS\n${marker(cmd, 'FAIL')}` });
    const r = await api('admin', 'POST', `/api/panels/${id}/pdocker/update`, { confirm: 'DK2' });
    assert.equal(r.status, 502); assert.match(r.data.error, /только для Ubuntu и Debian/);
    assert.ok((await auditOf('docker.update')).some((a) => a.ok === 1), 'запуск записан');
    // консоль не отвечает на команду
    const quiet = await mk('DK3', { hostExec: () => '' });
    const t = await api('admin', 'POST', `/api/panels/${quiet.id}/pdocker/update`, { confirm: 'DK3' });
    assert.ok([502, 504].includes(t.status));
  });
  test('ход обновления: состояние юнита и хвост журнала', async () => {
    const { id } = await mk('DK4', { hostExec: (cmd) => (/journalctl/.test(cmd) ? `state: active\nGet:1 repo docker-ce 29.8.2\n${marker(cmd, 'OK')}` : null) });
    const r = await api('admin', 'GET', `/api/panels/${id}/pdocker/log`);
    assert.equal(r.status, 200); assert.equal(r.data.state, 'active'); assert.match(r.data.log, /docker-ce 29\.8\.2/); assert.ok(!r.data.log.includes('state:'));
    assert.equal((await api('op', 'GET', `/api/panels/${id}/pdocker/log`)).status, 403);
  });
  test('проверка системы перед обновлением: apt и dnf/yum поддерживаются; другие системы, отсутствие systemd и Docker не из репозитория Docker — с понятной причиной', async () => {
    const info = (line) => ({ hostExec: (cmd) => (/EA_INFO/.test(cmd) ? `${line}\n${marker(cmd, 'OK')}` : null) });
    const chk = async (name, line) => { const { id } = await mk(name, info(line)); return (await api('admin', 'GET', `/api/panels/${id}/pdocker/check`)).data; };
    const ubuntu = await chk('CK1', 'EA_INFO os=ubuntu pm=apt systemd=yes docker_ce=yes'); assert.deepEqual([ubuntu.supported, ubuntu.reason, ubuntu.os, ubuntu.packageManager], [true, null, 'ubuntu', 'apt']);
    assert.equal((await chk('CK2', 'EA_INFO os=debian pm=apt systemd=yes docker_ce=yes')).supported, true);
    const rocky = await chk('CK3', 'EA_INFO os=rocky pm=dnf systemd=yes docker_ce=yes'); assert.equal(rocky.supported, false); assert.match(rocky.reason, /только для Ubuntu и Debian \(система «rocky»\)/);
    const alp = await chk('CK4', 'EA_INFO os=alpine pm=none systemd=no docker_ce=no'); assert.equal(alp.supported, false); assert.match(alp.reason, /«alpine»/);
    const mint = await chk('CK5', 'EA_INFO os=linuxmint pm=apt systemd=yes docker_ce=yes'); assert.equal(mint.supported, false, 'производные дистрибутивы не поддерживаются: как и у самой установки Easypanel');
    const snap = await chk('CK6', 'EA_INFO os=ubuntu pm=apt systemd=yes docker_ce=no'); assert.equal(snap.supported, false); assert.match(snap.reason, /docker-ce не найден/);
    const { id } = await mk('CK7', info('EA_INFO os=ubuntu pm=apt systemd=yes docker_ce=yes'));
    assert.equal((await api('op', 'GET', `/api/panels/${id}/pdocker/check`)).status, 403);
    const bad = await mk('CK8', { hostExec: () => 'nothing useful' }); assert.ok([502, 504, 400].includes((await api('admin', 'GET', `/api/panels/${bad.id}/pdocker/check`)).status));
  });
  test('обновление на системе без docker-ce отклоняется с причиной, а не «запущено»', async () => {
    const { id } = await mk('DK5', { hostExec: (cmd) => `EA_NO_CE\n${marker(cmd, 'FAIL')}` });
    const r = await api('admin', 'POST', `/api/panels/${id}/pdocker/update`, { confirm: 'DK5' });
    assert.equal(r.status, 502); assert.match(r.data.error, /не из репозитория Docker/);
  });
});
