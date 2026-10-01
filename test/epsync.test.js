import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { cronOf } from '../src/ep-sync.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMockPanel } from './mock-easypanel.js';

/* Расписания бэкапов Easypanel под управлением EasyAdmin: одна политика → расписания в панелях. */
let app, base, tmp, db; const jars = {}; const mocks = [];
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const put = (data, rest = {}) => api('admin', 'PUT', '/api/backups/settings', { ...rest, data });
const sync = async () => { const r = await api('admin', 'POST', '/api/backups/ep/sync'); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const panelRep = (r, id) => r.panels.find((p) => p.id === id);
const addPanel = async (name, seed, opts = {}) => {
  const m = createMockPanel({ token: 'T', seed, ...opts }); mocks.push(m);
  const id = (await api('admin', 'POST', '/api/panels', { name, url: await m.listen(), token: 'T' })).data.id; return { id, m };
};
const SEED = { web: [{ name: 'pg', type: 'postgres' }, { name: 'site' }, { name: 'cache', type: 'redis' }, { name: 'worker' }] };
let A; // основная панель: у неё уже есть свои расписания pg/app и site/data

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-eps-'));
  db = openDb(tmp);
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
  A = await addPanel('A', SEED);
  await api('admin', 'GET', '/api/overview?force=1');
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await Promise.all(mocks.map((m) => m.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('политика → cron', () => {
  test('каждый день или раз в неделю в заданный час', () => {
    assert.equal(cronOf({ every: 'daily', hour: 3 }), '0 3 * * *'); assert.equal(cronOf({ every: 'weekly', hour: 22 }), '0 22 * * 1');
  });
});

describe('создание, обновление и удаление расписаний', () => {
  test('настройки: способы и хранилища проверяются; по умолчанию Easypanel выключен, EasyAdmin включён', async () => {
    const s = (await api('admin', 'GET', '/api/backups')).data.settings; assert.deepEqual(s.data.methods, { easyadmin: true, easypanel: false }); assert.deepEqual(s.data.providers, {}); assert.equal('encrypt' in s.data, false, 'шифрования паролем у копий данных больше нет');
    for (const bad of [{ methods: { easypanel: 'да' } }, { providers: { x: 'p1' } }, { providers: { 1: 'a b' } }]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  });
  test('«все сервисы»: создаются расписания там, где своих нет; свои расписания не трогаем', async () => {
    assert.equal((await put({ mode: 'all', methods: { easyadmin: false, easypanel: true }, keep: 5 }, { enabled: true, every: 'daily', hour: 3 })).status, 200);
    const r = await sync(); const p = panelRep(r, A.id);
    assert.equal(p.error, null, JSON.stringify(p)); assert.equal(p.created, 2, 'pg/analytics и worker/data; pg/app и site/data уже настроены вручную; redis и compose не поддерживаются');
    assert.ok(p.notes.some((n) => /pg · app.*своё расписание/.test(n)) && p.notes.some((n) => /site · data.*своё расписание/.test(n)), JSON.stringify(p.notes));
    const mk = A.m.ps.dbBackups.find((b) => b.databaseName === 'analytics');
    assert.deepEqual([mk.projectName, mk.serviceName, mk.enabled, mk.schedule, mk.retention, mk.storageProviderId, mk.storageProviderPath], ['web', 'pg', true, '0 3 * * *', 5, 'p1', 'web/pg/analytics']);
    const vw = A.m.ps.volBackups.find((b) => b.serviceName === 'worker'); assert.deepEqual([vw.volumeName, vw.schedule, vw.storageProviderPath], ['data', '0 3 * * *', 'web/worker/data']);
    const manual = A.m.ps.dbBackups.find((b) => b.id === 'b1'); assert.deepEqual([manual.schedule, manual.retention], ['0 2 * * *', 7], 'своё расписание не изменено');
    assert.equal((await api('admin', 'GET', '/api/backups/ep')).data.managed, 2);
  });
  test('повторный запуск ничего не меняет (дубликатов нет)', async () => {
    const before = [A.m.ps.dbBackups.length, A.m.ps.volBackups.length]; const p = panelRep(await sync(), A.id);
    assert.deepEqual([p.created, p.updated, p.removed, p.unchanged], [0, 0, 0, 2]); assert.deepEqual([A.m.ps.dbBackups.length, A.m.ps.volBackups.length], before);
  });
  test('смена расписания и числа копий применяется к созданным нами, но не к чужим', async () => {
    await put({ keep: 9 }, { every: 'weekly', hour: 5 });
    const p = panelRep(await sync(), A.id); assert.equal(p.updated, 2);
    const mk = A.m.ps.dbBackups.find((b) => b.databaseName === 'analytics'); assert.deepEqual([mk.schedule, mk.retention], ['0 5 * * 1', 9]);
    assert.equal(A.m.ps.volBackups.find((b) => b.serviceName === 'worker').schedule, '0 5 * * 1');
    assert.equal(A.m.ps.dbBackups.find((b) => b.id === 'b1').schedule, '0 2 * * *'); assert.equal(A.m.ps.volBackups.find((b) => b.id === 'v1').schedule, '0 3 * * *');
  });
  test('«По расписанию» выключено → созданные расписания приостанавливаются', async () => {
    await api('admin', 'PUT', '/api/backups/settings', { enabled: false }); await sync();
    assert.equal(A.m.ps.volBackups.find((b) => b.serviceName === 'worker').enabled, false);
    await api('admin', 'PUT', '/api/backups/settings', { enabled: true }); await sync();
    assert.equal(A.m.ps.volBackups.find((b) => b.serviceName === 'worker').enabled, true);
  });
  test('удалили расписание в панели руками — при следующей синхронизации оно возвращается', async () => {
    A.m.ps.volBackups = A.m.ps.volBackups.filter((b) => b.serviceName !== 'worker');
    const p = panelRep(await sync(), A.id); assert.equal(p.created, 1); assert.ok(A.m.ps.volBackups.some((b) => b.serviceName === 'worker'));
    assert.equal((await api('admin', 'GET', '/api/backups/ep')).data.managed, 2, 'в списке управляемых нет дублей');
  });
  test('сервис вышел из охвата → его расписание удаляется, остальные остаются', async () => {
    await put({ mode: 'selected', keys: [`${A.id}|web|worker`] });
    const p = panelRep(await sync(), A.id); assert.equal(p.removed, 1);
    assert.equal(A.m.ps.dbBackups.some((b) => b.databaseName === 'analytics'), false); assert.ok(A.m.ps.volBackups.some((b) => b.serviceName === 'worker'));
    assert.ok(A.m.ps.dbBackups.some((b) => b.id === 'b1') && A.m.ps.volBackups.some((b) => b.id === 'v1'), 'чужие остались');
  });
  test('способ Easypanel выключен → созданное нами удаляется, чужое остаётся', async () => {
    await put({ methods: { easypanel: false } });
    const p = panelRep(await sync(), A.id); assert.equal(p.removed, 1); assert.equal(A.m.ps.volBackups.some((b) => b.serviceName === 'worker'), false);
    assert.equal((await api('admin', 'GET', '/api/backups/ep')).data.managed, 0); assert.equal(A.m.ps.volBackups.length, 1);
  });
});

describe('хранилище, лицензия, доступность', () => {
  test('нет хранилища в панели → понятная ошибка, ничего не создаётся и не удаляется', async () => {
    const keep = A.m.ps.providers; A.m.ps.providers = [];
    await put({ mode: 'selected', keys: [`${A.id}|web|worker`], methods: { easypanel: true } });
    const n = A.m.ps.volBackups.length; const p = panelRep(await sync(), A.id);
    assert.match(p.error, /нет хранилища бэкапов/); assert.equal(A.m.ps.volBackups.length, n);
    A.m.ps.providers = keep;
  });
  test('несколько хранилищ: нужен выбор; после выбора расписание создаётся в выбранном', async () => {
    A.m.ps.providers.push({ id: 'p2', name: 'Second', type: 's3', bucket: 'b2', region: 'eu', accessKeyId: 'x', secretAccessKey: 'y' });
    let p = panelRep(await sync(), A.id); assert.match(p.error, /Выберите хранилище/);
    const info = (await api('admin', 'GET', `/api/backups/ep?panel=${A.id}`)).data.panels[0]; assert.deepEqual(info.providers.map((x) => x.id), ['p1', 'p2']); assert.equal(info.selected, null);
    await put({ providers: { [A.id]: 'p2' } }); p = panelRep(await sync(), A.id); assert.equal(p.error, null);
    assert.equal(A.m.ps.volBackups.find((b) => b.serviceName === 'worker').storageProviderId, 'p2');
    await put({ providers: { [A.id]: 'p1' } }); assert.equal(panelRep(await sync(), A.id).updated, 1, 'смена хранилища переносит расписание');
    A.m.ps.providers.pop();
  });
  test('расписания баз без лицензии Easypanel не создаются (панель их не выполняет), тома — создаются', async () => {
    const B = await addPanel('B', { web: [{ name: 'pg', type: 'postgres' }, { name: 'app' }] }, { psettings: { license: 'free' } });
    B.m.ps.dbBackups = []; B.m.ps.volBackups = [];
    await put({ mode: 'selected', keys: [`${B.id}|web|pg`, `${B.id}|web|app`], providers: {} });
    const p = panelRep(await sync(), B.id);
    assert.equal(p.error, null); assert.equal(B.m.ps.dbBackups.length, 0); assert.equal(B.m.ps.volBackups.length, 1);
    assert.ok(p.notes.some((n) => /pg: без лицензии.*EasyAdmin/.test(n)), JSON.stringify(p.notes));
    await put({ mode: 'selected', keys: [] }); // охват пуст — ниже проверим, что сервис больше не нужен
  });
  test('панель недоступна → ошибка по этой панели, расписания в списке управляемых сохраняются', async () => {
    const C = await addPanel('C', { web: [{ name: 'site' }] }); C.m.ps.volBackups = [];
    await put({ mode: 'selected', keys: [`${C.id}|web|site`], methods: { easypanel: true } });
    assert.equal(panelRep(await sync(), C.id).created, 1);
    await C.m.close(); await app.manager.snapshot(C.id, { force: true }).catch(() => {});
    const p = panelRep(await sync(), C.id); assert.ok(p.error, 'панель недоступна'); assert.equal((await api('admin', 'GET', '/api/backups/ep')).data.managed >= 1, true);
  });
});

describe('быстрая настройка сервиса и обзор', () => {
  test('«Настроить»: сервис добавляется в охват, способы включаются, расписание Easypanel создаётся сразу', async () => {
    const D = await addPanel('D', { web: [{ name: 'pg', type: 'postgres' }, { name: 'site' }] }); D.m.ps.dbBackups = []; D.m.ps.volBackups = [];
    await put({ mode: 'none', keys: [], methods: { easyadmin: false, easypanel: false } }, { enabled: false });
    const bad = await api('admin', 'POST', '/api/backups/protect', { panelId: D.id, project: 'web', service: 'site', methods: {} }); assert.equal(bad.status, 400);
    const r = await api('admin', 'POST', '/api/backups/protect', { panelId: D.id, project: 'web', service: 'site', methods: { easyadmin: true, easypanel: true }, enableSchedule: true });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.sync.created, 1); assert.equal(D.m.ps.volBackups.length, 1);
    const s = r.data.settings; assert.deepEqual([s.enabled, s.data.mode, s.data.keys, s.data.methods], [true, 'selected', [`${D.id}|web|site`], { easyadmin: true, easypanel: true }]);
    // второй сервис добавляется к первому, а не заменяет его
    const r2 = await api('admin', 'POST', '/api/backups/protect', { panelId: D.id, project: 'web', service: 'pg', methods: { easypanel: true } });
    assert.equal(r2.status, 200, JSON.stringify(r2.data)); assert.deepEqual(r2.data.settings.data.keys.sort(), [`${D.id}|web|pg`, `${D.id}|web|site`].sort());
    assert.equal((await api('admin', 'POST', '/api/backups/protect', { panelId: 9999, project: 'web', service: 'x', methods: { easypanel: true } })).status, 400);
    D.id2 = D.id; app.D = D;
  });
  test('обзор: созданные EasyAdmin расписания помечены, у запланированных видно «ждёт создания»', async () => {
    const D = app.D;
    const o = (await api('admin', 'GET', '/api/backups/overview?force=1')).data; const rows = o.panels.find((p) => p.panelId === D.id).rows;
    const site = rows.find((r) => r.name === 'site'); assert.equal(site.easypanel.schedules[0].managed, true); assert.equal(site.easypanel.planned, true); assert.equal(site.easyadmin.covered, true);
    D.m.ps.volBackups = []; // расписание пропало — обзор показывает «запланировано, но нет»
    const again = (await api('admin', 'GET', '/api/backups/overview?force=1')).data.panels.find((p) => p.panelId === D.id).rows.find((r) => r.name === 'site');
    assert.equal(again.easypanel.schedules.length, 0); assert.equal(again.easypanel.planned, true);
  });
  test('выключенный способ EasyAdmin не считается защитой в обзоре, охват сохраняется', async () => {
    const D = app.D; await put({ methods: { easyadmin: false } });
    const site = (await api('admin', 'GET', '/api/backups/overview?force=1')).data.panels.find((p) => p.panelId === D.id).rows.find((r) => r.name === 'site');
    assert.equal(site.easyadmin.covered, false);
    const run = await api('admin', 'POST', '/api/backups/data/run'); assert.equal(run.status, 400); assert.match(run.data.error, /EasyAdmin выключены/);
  });
  test('оператору новые маршруты недоступны', async () => {
    for (const [m, p] of [['GET', '/api/backups/ep'], ['POST', '/api/backups/ep/sync'], ['POST', '/api/backups/protect']]) assert.equal((await api('op', m, p, m === 'POST' ? {} : undefined)).status, 403, p);
  });
  test('планировщик: после изменения настроек синхронизация запускается сама, затем не чаще раза в 6 часов', async () => {
    const E = await addPanel('E', { web: [{ name: 'site' }] }); E.m.ps.volBackups = [];
    await put({ mode: 'selected', keys: [`${E.id}|web|site`], methods: { easypanel: true } }, { enabled: true });
    const t0 = Date.now(); const r = await app.backups.tickEp(t0); assert.equal(panelRep(r, E.id).created, 1, JSON.stringify(r)); assert.equal(E.m.ps.volBackups.length, 1);
    assert.equal(r.ok, false, 'панель C недоступна — это видно в общем итоге, но не мешает остальным');
    assert.equal(await app.backups.tickEp(t0 + 60_000), null, 'ничего не менялось — пропуск');
    const n = await app.backups.tickEp(Date.now() + 7 * 3600e3); assert.ok(n, 'через 6 часов — плановая сверка');
  });
});
