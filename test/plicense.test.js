import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { entitlements } from '../src/panel-license.js';
import { createMockPanel } from './mock-easypanel.js';

let app, base, tmp; const jars = {}; const panels = [];
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const addPanel = async (name, psettings = {}) => {
  const m = createMockPanel({ token: 'T', seed: { web: [{ name: 'site' }, { name: 'pg', type: 'postgres' }] }, psettings });
  panels.push(m); const url = await m.listen();
  return { id: (await api('admin', 'POST', '/api/panels', { name, url, token: 'T' })).data.id, m };
};
const auditOf = async (q) => (await api('admin', 'GET', `/api/audit?q=${encodeURIComponent(q)}&limit=200`)).data;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-lic-'));
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db: openDb(tmp), key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await Promise.all(panels.map((p) => p.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('правила лицензии (как в самой Easypanel)', () => {
  test('бесплатная, Lemon (разные продукты), Portal с флагами', () => {
    const f = (l, p) => entitlements(l, p).features;
    assert.ok(Object.values(f(null, null)).every((v) => v === false), 'без лицензии закрыто всё');
    assert.equal(entitlements(null, null).tier, 'free');
    // Lemon valid: мониторинг, уведомления, бэкапы баз, домен сервисов; брендинг, кластер и пользователи — только нужные продукты
    const lemon = f({ valid: true, meta: { product_id: 108137 } }, null);
    assert.deepEqual(lemon, { advancedMonitoring: true, notifications: true, databaseBackups: true, branding: false, multipleUsers: false, cluster: false, customServiceDomain: true });
    assert.equal(f({ valid: true, meta: { product_id: 108139 } }, null).multipleUsers, true);
    assert.deepEqual([f({ valid: true, meta: { product_id: 108143 } }, null).branding, f({ valid: true, meta: { product_id: 108143 } }, null).cluster], [true, true]);
    assert.equal(f({ valid: false, meta: { product_id: 108143 } }, null).branding, true, 'брендинг/кластер у продукта 108143 проверяются по продукту, как в панели');
    assert.equal(f({ valid: false }, null).notifications, false, 'невалидный ключ ничего не открывает');
    const portal = f(null, { plan: { options: { branding: true, cluster: true } } });
    assert.deepEqual([portal.branding, portal.cluster, portal.notifications, portal.customServiceDomain], [true, true, false, true]);
    assert.equal(entitlements(null, { plan: { name: 'Pro', options: {} } }).tier, 'portal');
    assert.ok(Object.values(entitlements(null, null, false).features).every(Boolean), 'лицензия не определена — ничего не блокируем');
  });
});

describe('бесплатная панель: закрытое отклоняется заранее, бесплатное работает', () => {
  test('состояние лицензии; пользователи, каналы, брендинг, мониторинг, домен сервисов, кластер', async () => {
    const { id, m } = await addPanel('FREE', { license: 'free' });
    const st = (await api('admin', 'GET', `/api/panels/${id}/plicense`)).data;
    assert.equal(st.tier, 'free'); assert.equal(st.known, true); assert.ok(Object.values(st.features).every((v) => v === false)); assert.ok(st.featureLabels.branding);
    assert.equal((await api('op', 'GET', `/api/panels/${id}/plicense`)).status, 403);
    m.ps.changed.length = 0;
    const lic = (r) => { assert.equal(r.status, 403, JSON.stringify(r.data)); assert.match(r.data.error, /нужна лицензия/); assert.equal(r.data.license, true); };
    lic(await api('admin', 'POST', `/api/panels/${id}/pusers`, { email: 'new@example.com', password: 'longenough1' }));
    lic(await api('admin', 'PUT', `/api/panels/${id}/pusers/u2`, { admin: true }));
    lic(await api('admin', 'DELETE', `/api/panels/${id}/pusers/u2`));
    lic(await api('admin', 'POST', `/api/panels/${id}/pnotify`, { type: 'slack', name: 'S', target: { url: 'https://hooks.example/x' }, events: {} }));
    lic(await api('admin', 'DELETE', `/api/panels/${id}/pnotify/c1`));
    lic(await api('admin', 'PUT', `/api/panels/${id}/plogos`, { slot: 'lightLogo', value: 'data:image/png;base64,AAAA' }));
    for (const [key, value] of [['brandingLinks', { hideDocumentationLink: true }], ['errorPages', { hideLogo: true, customCss: '' }], ['customCode', { customCode: '<b>x</b>' }], ['serviceDomain', { customServiceDomain: 'apps.example.com' }],
      ['metrics', { enabled: true, retentionType: 'days', retentionValue: 7, scrapeInterval: 15 }], ['logsAgg', { enabled: true, retentionType: 'days', retentionValue: 3 }]]) lic(await api('admin', 'PUT', `/api/panels/${id}/psettings/${key}`, { value }));
    assert.deepEqual(m.ps.changed, [], 'в панель не ушло ни одного запроса на запись');
    // выключить мониторинг можно, бесплатное работает
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/psettings/metrics`, { value: { enabled: false, retentionType: 'days', retentionValue: 7, scrapeInterval: 15 } })).status, 200);
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/psettings/telemetry`, { value: { disabled: true } })).status, 200);
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/psettings/brandingBasic`, { value: { serverName: 'Free', serverColor: '#112233', hideIp: false, hideNotes: false } })).status, 200);
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/psettings/panelDomain`, { value: { customPanelDomain: 'panel.example.com', serveOnIp: true } })).status, 200);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pbuilders`, { op: 'create', name: 'b2' })).status, 200);
    assert.equal((await api('admin', 'PUT', `/api/panels/${id}/ptraefik/config`, { content: 'x: 1\n' })).status, 200);
    const cl = (await api('admin', 'GET', `/api/panels/${id}/pcluster`)).data; assert.equal(cl.locked, true); assert.deepEqual(cl.nodes, []);
    assert.ok(!(await auditOf('panel.user')).some((a) => a.ok === 1), 'в журнале нет ложных «успехов»');
  });

  test('Lemon-ключ (обычный продукт): мониторинг, уведомления и домен открыты; брендинг, пользователи, кластер — нет', async () => {
    const { id } = await addPanel('LEMON', { license: 'lemon' });
    const put = (k, v) => api('admin', 'PUT', `/api/panels/${id}/psettings/${k}`, { value: v });
    assert.equal((await put('metrics', { enabled: true, retentionType: 'days', retentionValue: 7, scrapeInterval: 15 })).status, 200);
    assert.equal((await put('serviceDomain', { customServiceDomain: 'apps.example.com' })).status, 200);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pnotify`, { type: 'slack', name: 'S', target: { url: 'https://hooks.example/x' }, events: {} })).status, 200);
    assert.equal((await put('customCode', { customCode: 'x' })).status, 403);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pusers`, { email: 'n@example.com', password: 'longenough1' })).status, 403);
    assert.equal((await api('admin', 'GET', `/api/panels/${id}/pcluster`)).data.locked, true);
  });

  test('панель не отдаёт лицензию (старая версия): ничего не блокируем, а тихий отказ панели ловится проверкой результата', async () => {
    const { id } = await addPanel('OLD', { license: 'free', hideLicense: true });
    const st = (await api('admin', 'GET', `/api/panels/${id}/plicense`)).data; assert.equal(st.known, false); assert.ok(Object.values(st.features).every(Boolean));
    const r = await api('admin', 'POST', `/api/panels/${id}/pusers`, { email: 'silent@example.com', password: 'longenough1' });
    assert.equal(r.status, 502); assert.match(r.data.error, /не применила/);
    const n = await api('admin', 'POST', `/api/panels/${id}/pnotify`, { type: 'slack', name: 'S', target: { url: 'https://hooks.example/x' }, events: {} });
    assert.equal(n.status, 502); assert.match(n.data.error, /не применила/);
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}/pnotify/c1`)).status, 502);
    // брендинг без лицензии панель отклоняет сама — ошибка доходит понятной
    const b = await api('admin', 'PUT', `/api/panels/${id}/psettings/customCode`, { value: { customCode: 'x' } });
    assert.equal(b.status, 502); assert.match(b.data.error, /white-labeling/);
  });
});

describe('активация лицензии из EasyAdmin', () => {
  test('ключ Lemon: формат, неверный ключ панель игнорирует — сообщаем; верный — тариф меняется; ключ нигде не сохраняется', async () => {
    const { id } = await addPanel('ACT', { license: 'free' });
    const act = (b) => api('admin', 'POST', `/api/panels/${id}/plicense/lemon`, b);
    assert.equal((await act({ licenseKey: 'short' })).status, 400); assert.equal((await act({ licenseKey: 'has spaces in the key 12345' })).status, 400);
    const bad = await act({ licenseKey: 'BAD0-1111-2222-3333-4444' }); assert.equal(bad.status, 400); assert.match(bad.data.error, /не приняла/);
    assert.equal((await api('op', 'POST', `/api/panels/${id}/plicense/lemon`, { licenseKey: 'GOOD-1111-2222-3333-4444' })).status, 403);
    const ok = await act({ licenseKey: 'GOOD-1111-2222-3333-4444' }); assert.equal(ok.status, 200); assert.equal(ok.data.tier, 'lemon'); assert.equal(ok.data.features.multipleUsers, true); assert.equal(ok.data.features.branding, false);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/pusers`, { email: 'n@example.com', password: 'longenough1' })).status, 200, 'функция открылась сразу, без ожидания кэша');
    assert.ok(!JSON.stringify(await auditOf('license')).includes('GOOD-1111'), 'ключ не попал в журнал');
    const dump = fs.readFileSync(path.join(tmp, 'easyadmin.db')); assert.ok(!dump.includes('GOOD-1111-2222'), 'ключ не сохранён в базе EasyAdmin');
    const off = await api('admin', 'DELETE', `/api/panels/${id}/plicense/lemon`); assert.equal(off.status, 200); assert.equal(off.data.tier, 'free');
  });
  test('по номеру заказа и Portal-лицензия; неверные данные отклоняются', async () => {
    const { id } = await addPanel('ACT2', { license: 'free' }); const { id: id2 } = await addPanel('ACT3', { license: 'free', portalAvailable: true });
    const order = (b) => api('admin', 'POST', `/api/panels/${id}/plicense/order`, b);
    assert.equal((await order({ identifier: '', orderId: '1001' })).status, 400); assert.equal((await order({ identifier: 'me@example.com', orderId: 'bad id!' })).status, 400);
    assert.equal((await order({ identifier: 'me@example.com', orderId: '9999' })).status, 400);
    assert.equal((await order({ identifier: 'me@example.com', orderId: '1001' })).data.tier, 'lemon');
    const portal = await api('admin', 'POST', `/api/panels/${id}/plicense/portal`); assert.equal(portal.status, 502); assert.match(portal.data.error, /not valid/);
    const ok = await api('admin', 'POST', `/api/panels/${id2}/plicense/portal`); assert.equal(ok.data.tier, 'portal'); assert.equal(ok.data.features.cluster, true); assert.equal(ok.data.portal.plan, 'Pro');
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id2}/plicense/portal`)).data.tier, 'free'); assert.equal((await api('admin', 'DELETE', `/api/panels/${id2}/plicense/nope`)).status, 400);
  });
});
