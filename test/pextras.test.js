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
