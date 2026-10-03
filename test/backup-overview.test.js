import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { statusOf } from '../src/backup-overview.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMockPanel } from './mock-easypanel.js';

/* Раздел «Бэкапы»: обзор по сервисам, включение в копии, пароль для всех копий, где хранить. */
let app, base, tmp, db, M, pid, deadId; const jars = {};
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const ov = async () => (await api('admin', 'GET', '/api/backups/overview')).data;
const row = (o, name) => o.panels.flatMap((p) => p.rows).find((r) => r.name === name);
const setSvc = (map) => db.prepare("INSERT INTO settings (k, v) VALUES ('backup_data_svc', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(map));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-bov-'));
  db = openDb(tmp);
  M = createMockPanel({ token: 'T', seed: { web: [{ name: 'pg', type: 'postgres' }, { name: 'site' }, { name: 'cache', type: 'redis' }, { name: 'worker' }] } });
  const url = await M.listen();
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
  pid = (await api('admin', 'POST', '/api/panels', { name: 'P', url, token: 'T' })).data.id;
  deadId = (await api('admin', 'POST', '/api/panels', { name: 'Dead', url: 'http://127.0.0.1:1', token: 'x' })).data.id;
  await api('admin', 'GET', '/api/overview?force=1');
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await M.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('статус сервиса', () => {
  const NOW = Date.UTC(2026, 9, 1);
  test('не выбран → off; идёт → running; ждёт → queued; ошибка → error; нечего копировать → empty; не было копии → pending; давно → stale; свежая → ok', () => {
    assert.equal(statusOf({ included: false, last: { ok: true, ts: NOW } }, NOW), 'off');
    assert.equal(statusOf({ included: true, live: 'running' }, NOW), 'running');
    assert.equal(statusOf({ included: true, live: 'queued', last: { ok: true, ts: NOW } }, NOW), 'queued', 'в очереди важнее прошлого результата');
    assert.equal(statusOf({ included: false, live: 'running' }, NOW), 'off');
    assert.equal(statusOf({ included: true, last: { ok: false, ts: NOW } }, NOW), 'error');
    assert.equal(statusOf({ included: true, last: { ok: true, empty: true, ts: NOW } }, NOW), 'empty');
    assert.equal(statusOf({ included: true, last: null }, NOW), 'pending');
    assert.equal(statusOf({ included: true, last: { ok: true, ts: NOW - 9 * 86_400_000 } }, NOW), 'stale');
    assert.equal(statusOf({ included: true, last: { ok: true, ts: NOW - 3_600_000 } }, NOW), 'ok');
  });
});

describe('обзор по панелям', () => {
  test('по умолчанию ничего не копируется; недоступная панель показана с причиной', async () => {
    const o = await ov();
    assert.equal(o.mode, 'none'); assert.equal(o.summary.total, 4); assert.equal(o.summary.included, 0); assert.equal(o.summary.off, 4);
    assert.ok(o.panels.find((p) => p.panelId === deadId).error); assert.deepEqual(o.panels.find((p) => p.panelId === deadId).rows, []);
    assert.equal(o.system.hasPassword, false);
  });
  test('пароль нужен для любых копий: без него сервис в копии не включить и расписание не включить', async () => {
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'selected', keys: [`${pid}|web|pg`] } })).status, 400);
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { enabled: true })).status, 400);
    assert.equal((await api('admin', 'POST', '/api/backups/data/run', {})).status, 400, 'запуск без пароля');
    assert.equal((await api('admin', 'POST', '/api/backups/run')).status, 400);
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { password: 'short' })).status, 400);
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { password: 'correct horse battery' })).status, 200);
  });
  test('включение сервисов, результаты запусков → статусы; «все» включает и новые', async () => {
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'selected', keys: [`${pid}|web|pg`, `${pid}|web|site`, `${pid}|web|cache`] } })).status, 200);
    const now = Date.now();
    setSvc({ [`${pid}|web|pg`]: { ts: now - 3600e3, ok: true, size: 5 * 1048576 }, [`${pid}|web|site`]: { ts: now - 12 * 86400e3, ok: true, size: 1000 }, [`${pid}|web|cache`]: { ts: now - 3600e3, ok: false, error: 'Мало места' }, [`${pid}|web|worker`]: { ts: now, ok: true, empty: true } });
    const o = await ov();
    assert.equal(row(o, 'pg').status, 'ok'); assert.equal(row(o, 'pg').included, true); assert.equal(row(o, 'pg').last.size, 5 * 1048576);
    assert.equal(row(o, 'site').status, 'stale'); assert.equal(row(o, 'cache').status, 'error'); assert.equal(row(o, 'cache').last.error, 'Мало места');
    assert.equal(row(o, 'worker').status, 'off', 'не выбран — результат прошлых запусков не делает его «копируемым»');
    assert.deepEqual([o.summary.included, o.summary.ok, o.summary.error, o.summary.stale], [3, 1, 1, 1]);
    await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'all' } });
    const all = await ov(); assert.equal(all.summary.included, 4); assert.equal(row(all, 'worker').status, 'empty'); assert.equal(all.mode, 'all');
    await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'none' } });
  });
  test('переименование сервиса переносит выбор и результат', async () => {
    await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'selected', keys: [`${pid}|web|pg`] } });
    app.backups.repoint(pid, { project: 'web', name: 'pg' }, { project: 'data', name: 'postgres' });
    assert.deepEqual(app.backups.view().data.keys, [`${pid}|data|postgres`]); assert.ok(app.backups.svcResults()[`${pid}|data|postgres`]); assert.equal(app.backups.svcResults()[`${pid}|web|pg`], undefined);
    await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'none' } });
  });
  test('доступ только администратору', async () => {
    assert.equal((await api('op', 'GET', '/api/backups/overview')).status, 403);
  });
});

describe('куда сохранять и что копировать', () => {
  test('«на сервере»/«в S3» меняет и копии настроек, и копии данных; S3 без данных хранилища отклоняется', async () => {
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { where: 's3' })).status, 400);
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { where: 'cloud' })).status, 400);
    const r = await api('admin', 'PUT', '/api/backups/settings', { where: 's3', s3: { endpoint: 'https://s3.example.com', bucket: 'b', accessKey: 'AK', secretKey: 'SK' } });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.where, 's3'); assert.equal(r.data.storage, 's3'); assert.equal(r.data.data.dest, 's3');
    const back = (await api('admin', 'PUT', '/api/backups/settings', { where: 'server' })).data; assert.equal(back.where, 'server'); assert.equal(back.storage, 'local'); assert.equal(back.data.dest, 'host');
  });
  test('копия самого EasyAdmin: можно выключить совсем; тогда ручной запуск отказывает понятно', async () => {
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { system: false, panels: 'none' })).status, 200);
    const r = await api('admin', 'POST', '/api/backups/run'); assert.equal(r.status, 400); assert.match(r.data.error, /выключено/);
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { system: true, panels: 'all' })).status, 200);
  });
  test('запуск одного сервиса: имена проверяются', async () => {
    assert.equal((await api('admin', 'POST', '/api/backups/data/run', { panelId: pid, project: 'Bad Name!', service: 'x' })).status, 400);
    assert.equal((await api('admin', 'GET', `/api/backups/data/files?panel=${pid}&project=web&service=pg`)).status, 200);
  });
});
