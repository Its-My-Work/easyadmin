import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMockPanel } from './mock-easypanel.js';

let app, base, tmp; const jars = {}; const panels = [];
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const addPanel = async (name, opts = {}) => {
  const m = createMockPanel({ token: 'T', seed: { web: [{ name: 'site' }, { name: 'pg', type: 'postgres' }] }, ...opts });
  panels.push(m); const url = await m.listen();
  return { id: (await api('admin', 'POST', '/api/panels', { name, url, token: 'T' })).data.id, m };
};
const auditOf = async (q) => (await api('admin', 'GET', `/api/audit?q=${encodeURIComponent(q)}&limit=200`)).data;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-px-'));
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db: openDb(tmp), key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await Promise.all(panels.map((p) => p.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('хранилища бэкапов панели', () => {
  test('список без секретов и с описанием полей; создание по типам с проверкой; только админ', async () => {
    const { id, m } = await addPanel('S1');
    assert.equal((await api('op', 'GET', `/api/panels/${id}/pstorage`)).status, 403);
    const l = (await api('admin', 'GET', `/api/panels/${id}/pstorage`)).data;
    assert.deepEqual(l.providers[0].values, { name: 'Backups', bucket: 'b1', region: 'eu', endpoint: '', storageClass: '' }); assert.deepEqual(l.providers[0].hasSecret, { accessKeyId: true, secretAccessKey: true });
    assert.ok(!JSON.stringify(l).includes('shh') && !JSON.stringify(l).includes('AKIA')); assert.ok(l.specs.s3.fields.some((f) => f.name === 'secretAccessKey' && f.secret));
    const create = (b) => api('admin', 'POST', `/api/panels/${id}/pstorage`, b);
    assert.equal((await create({ type: 'dropbox', values: { name: 'x' } })).status, 400, 'Dropbox/Google подключаются в панели');
    assert.equal((await create({ type: 'nope', values: {} })).status, 400);
    assert.equal((await create({ type: 's3', values: { name: 'A', bucket: 'b', region: 'eu' } })).status, 400, 'нет ключей');
    assert.equal((await create({ type: 'local', values: { name: 'Disk' } })).status, 400, 'нет пути');
    assert.equal((await create({ type: 'local', values: { name: 'Disk', path: '/backups' } })).status, 200);
    assert.equal((await create({ type: 's3', values: { name: 'R2', bucket: 'b', region: 'auto', accessKeyId: 'AKIANEW', secretAccessKey: 'newsecret', subtype: 'cloudflare-r2' } })).status, 200);
    assert.equal((await create({ type: 'sftp', values: { name: 'Box', host: 'h', username: 'u', password: 'p' } })).status, 200);
    const s3 = m.ps.providers.find((p) => p.name === 'R2'); assert.equal(s3.subtype, 'cloudflare-r2'); assert.equal(s3.secretAccessKey, 'newsecret');
    assert.ok(!JSON.stringify(await auditOf('storage.provider')).includes('newsecret'), 'секрет не в журнале');
  });
  test('правка: пустой секрет — прежний, новый — заменяется; чужой id и пустые обязательные поля отклоняются', async () => {
    const { id, m } = await addPanel('S2');
    const put = (type, pid, values) => api('admin', 'PUT', `/api/panels/${id}/pstorage/${type}/${pid}`, { values });
    assert.equal((await put('s3', 'p1', { name: 'Renamed', bucket: 'b1', region: 'eu', accessKeyId: '', secretAccessKey: '' })).status, 200);
    const p = m.ps.providers[0]; assert.equal(p.name, 'Renamed'); assert.equal(p.secretAccessKey, 'shh'); assert.equal(p.accessKeyId, 'AKIA');
    assert.equal((await put('s3', 'p1', { name: 'Renamed', bucket: 'b1', region: 'eu', secretAccessKey: 'rotated' })).status, 200); assert.equal(m.ps.providers[0].secretAccessKey, 'rotated');
    assert.equal((await put('s3', 'p1', { name: '', bucket: 'b1', region: 'eu' })).status, 400);
    assert.equal((await put('s3', 'nope', { name: 'x', bucket: 'b', region: 'r' })).status, 400);
    assert.equal((await put('dropbox', 'p1', { name: 'x' })).status, 400, 'такого хранилища нет');
  });
});

describe('каналы уведомлений панели', () => {
  test('создание по типам, проверка полей, правка без показа секретов, тест и удаление', async () => {
    const { id, m } = await addPanel('N1');
    const ev = { appDeploy: { enabled: true }, diskLoad: { enabled: true, min: 90, schedule: '0 3 * * *' } };
    const create = (b) => api('admin', 'POST', `/api/panels/${id}/pnotify`, b);
    assert.equal((await create({ type: 'slack', name: 'S', target: { url: 'nope' }, events: ev })).status, 400);
    assert.equal((await create({ type: 'slack', name: '', target: { url: 'https://hooks.example/x' }, events: ev })).status, 400);
    assert.equal((await create({ type: 'telegram', name: 'T', target: { access_token: 't', chat_id: 'abc' }, events: ev })).status, 400);
    assert.equal((await create({ type: 'smtp', name: 'M', target: { host: 'h', port: 587, username: 'u', password: 'p', recipients: 'bad' }, events: ev })).status, 400);
    assert.equal((await create({ type: 'slack', name: 'S', target: { url: 'https://hooks.example/x' }, events: { diskLoad: { enabled: true, min: 500 } } })).status, 400);
    assert.equal((await create({ type: 'smtp', name: 'M', target: { host: 'smtp.example.com', port: 587, username: 'u', password: 'pw', recipients: 'a@b.co, c@d.io' }, events: ev })).status, 200);
    const smtp = m.ps.channels.at(-1); assert.deepEqual(smtp.target.recipients, ['a@b.co', 'c@d.io']); assert.equal(smtp.target.port, 587); assert.deepEqual(smtp.events.diskLoad, { enabled: true, min: 90, schedule: '0 3 * * *' }); assert.equal(smtp.events.appDeploy.enabled, true);
    const l = (await api('admin', 'GET', `/api/panels/${id}/pnotify`)).data;
    const mine = l.channels.find((c) => c.name === 'M'); assert.equal(mine.target.recipients, 'a@b.co, c@d.io'); assert.equal(mine.target.password, ''); assert.deepEqual(mine.hasSecret, { password: true });
    assert.ok(!JSON.stringify(l).includes('pw') && !JSON.stringify(l).includes('hooks.example'), 'секреты не отдаются');
    // правка: пустой пароль — прежний
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/pnotify/${mine.id}`, { name: 'M2', target: { host: 'smtp.example.com', port: 465, username: 'u', password: '', recipients: 'a@b.co' }, events: ev })).status, 200);
    const upd = m.ps.channels.find((c) => c.id === mine.id); assert.equal(upd.name, 'M2'); assert.equal(upd.target.password, 'pw'); assert.equal(upd.target.port, 465);
    // тест отправляет введённые (или сохранённые) настройки
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pnotify/test`, { id: mine.id, name: 'M2', target: { host: 'smtp.example.com', port: 465, username: 'u', password: '', recipients: 'a@b.co' }, events: ev })).status, 200);
    assert.equal(m.ps.notified.at(-1).target.password, 'pw');
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/pnotify/nope`, { name: 'x', target: {}, events: ev })).status, 400);
    assert.ok(!JSON.stringify(await auditOf('panel.notify')).includes('pw'));
  });
});

describe('логотипы интерфейса панели', () => {
  test('загрузка одного логотипа не затирает остальные; формат и размер проверяются', async () => {
    const { id, m } = await addPanel('L1'); m.ps.logos.darkLogo = 'data:image/png;base64,AAAA';
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const put = (slot, value) => api('admin', 'PUT', `/api/panels/${id}/plogos`, { slot, value });
    assert.equal((await put('nope', png)).status, 400);
    assert.equal((await put('lightLogo', 'javascript:alert(1)')).status, 400);
    assert.equal((await put('lightLogo', 'data:text/html;base64,PGI+')).status, 400);
    assert.equal((await put('lightLogo', `data:image/png;base64,${'A'.repeat(700_001)}`)).status, 400);
    assert.equal((await put('lightLogo', png)).status, 200);
    assert.deepEqual([m.ps.logos.lightLogo, m.ps.logos.darkLogo], [png, 'data:image/png;base64,AAAA']);
    const l = (await api('admin', 'GET', `/api/panels/${id}/plogos`)).data.logos; assert.equal(l.lightLogo.set, true); assert.equal(l.lightLogo.preview, png); assert.equal(l.darkLogoMark.set, false);
    assert.equal((await put('lightLogo', null)).status, 200); assert.equal(m.ps.logos.lightLogo, ''); assert.equal(m.ps.logos.darkLogo, 'data:image/png;base64,AAAA');
    assert.equal((await put('darkLogoMark', 'https://example.com/logo.svg')).status, 200);
    assert.equal((await api('op', 'GET', `/api/panels/${id}/plogos`)).status, 403);
  });
});

describe('бэкапы баз данных и томов', () => {
  const q = (t, n) => `type=${t}&project=web&name=${n}`;
  test('база: расписания, список баз, хранилища, история копий; создание, правка, запуск, удаление с проверкой', async () => {
    const { id, m } = await addPanel('B1');
    assert.equal((await api('op', 'GET', `/api/panels/${id}/pbackups?${q('postgres', 'pg')}`)).status, 403);
    const l = (await api('admin', 'GET', `/api/panels/${id}/pbackups?${q('postgres', 'pg')}`)).data;
    assert.equal(l.kind, 'db'); assert.deepEqual(l.databases, ['app', 'analytics']); assert.deepEqual(l.providers, [{ id: 'p1', name: 'Backups' }]);
    assert.equal(l.schedules[0].schedule, '0 2 * * *'); assert.equal(l.history.length, 1); assert.equal(l.history[0].restorable, true); assert.equal(l.history[0].path, 'pg/2026-09-30.sql.gz');
    assert.equal((await api('admin', 'GET', `/api/panels/${id}/pbackups?${q('redis', 'cache')}`)).data.kind, null, 'у Redis бэкапов по расписанию нет');
    assert.equal((await api('admin', 'GET', `/api/panels/${id}/pbackups?type=compose&project=web&name=x`)).data.kind, null);
    const create = (schedule) => api('admin', 'POST', `/api/panels/${id}/pbackups`, { type: 'postgres', project: 'web', name: 'pg', schedule });
    const ok = { databaseName: 'analytics', enabled: true, schedule: '30 1 * * *', retention: 14, storageProviderId: 'p1', storageProviderPath: 'pg/analytics' };
    assert.equal((await create({ ...ok, schedule: 'daily' })).status, 400); assert.equal((await create({ ...ok, storageProviderPath: '../etc' })).status, 400);
    assert.equal((await create({ ...ok, retention: 0 })).status, 400); assert.equal((await create({ ...ok, databaseName: 'a b;drop' })).status, 400); assert.equal((await create({ ...ok, storageProviderId: '' })).status, 400);
    assert.equal((await create(ok)).status, 200);
    const made = m.ps.dbBackups.find((b) => b.databaseName === 'analytics'); assert.equal(made.retention, 14); assert.equal(made.serviceName, 'pg');
    const up = await api('admin', 'PUT', `/api/panels/${id}/pbackups/${made.id}`, { type: 'postgres', project: 'web', name: 'pg', schedule: { ...ok, enabled: false } });
    assert.equal(up.status, 200); assert.equal(made.enabled, false);
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/pbackups/zzz`, { type: 'postgres', project: 'web', name: 'pg', schedule: ok })).status, 400, 'чужое/несуществующее расписание');
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pbackups/${made.id}/run`, { type: 'postgres', project: 'web', name: 'pg' })).status, 200);
    assert.ok(m.ps.changed.includes('databaseBackups.runDatabaseBackup'));
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pbackups/b1?${q('postgres', 'other')}`)).status, 400, 'расписание другого сервиса удалить нельзя');
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pbackups/${made.id}?${q('postgres', 'pg')}`)).status, 200);
    assert.ok((await auditOf('backup.db')).length >= 4);
  });
  test('том: расписание с томом и его запуск; восстановление базы — только из копии из журнала, с подтверждением', async () => {
    const { id, m } = await addPanel('B2');
    const l = (await api('admin', 'GET', `/api/panels/${id}/pbackups?${q('app', 'site')}`)).data;
    assert.equal(l.kind, 'volume'); assert.deepEqual(l.mounts, [{ name: 'data', mountPath: '/data' }]); assert.equal(l.schedules[0].volumeName, 'data');
    const c = await api('admin', 'POST', `/api/panels/${id}/pbackups`, { type: 'app', project: 'web', name: 'site', schedule: { volumeName: 'logs', enabled: true, schedule: '0 4 * * *', storageProviderId: 'p1', storageProviderPath: 'site/logs' } });
    assert.equal(c.status, 200); assert.ok(m.ps.volBackups.some((b) => b.volumeName === 'logs'));
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pbackups`, { type: 'app', project: 'web', name: 'site', schedule: { enabled: true, schedule: '0 4 * * *', storageProviderId: 'p1', storageProviderPath: '' } })).status, 400, 'том обязателен');
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pbackups/v1/run`, { type: 'app', project: 'web', name: 'site' })).status, 200);
    const restore = (b) => api('admin', 'POST', `/api/panels/${id}/pbackups/restore`, { type: 'postgres', project: 'web', name: 'pg', databaseName: 'app', path: 'pg/2026-09-30.sql.gz', storageProviderId: 'p1', confirm: 'web/pg', ...b });
    assert.equal((await restore({ confirm: 'web/other' })).status, 400, 'без подтверждения');
    assert.equal((await restore({ path: 'pg/../../etc/passwd' })).status, 400);
    assert.equal((await restore({ path: 'pg/other.sql.gz' })).status, 400, 'такой копии нет в журнале');
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pbackups/restore`, { type: 'app', project: 'web', name: 'site', databaseName: 'app', path: 'x', storageProviderId: 'p1', confirm: 'web/site' })).status, 400, 'у приложения нет восстановления БД');
    assert.equal(m.ps.restored, undefined);
    assert.equal((await restore({})).status, 200); assert.deepEqual(m.ps.restored, { databaseName: 'app', path: 'pg/2026-09-30.sql.gz', projectName: 'web', serviceName: 'pg', storageProviderId: 'p1' });
    assert.match((await auditOf('backup.db.restore')).find((a) => a.ok === 1).detail, /app ← pg\/2026-09-30/);
  });
});
