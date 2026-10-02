import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { actionState, combine } from '../src/backup-overview.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMockPanel } from './mock-easypanel.js';

/* Раздел «Бэкапы» → «Обзор»: что и чем копируется, по сервисам всех панелей. */
let app, base, tmp, db, M, pid, deadId; const jars = {};
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const ov = async (force = true) => (await api('admin', 'GET', `/api/backups/overview${force ? '?force=1' : ''}`)).data;
const row = (o, name) => o.panels.flatMap((p) => p.rows).find((r) => r.name === name);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-bov-'));
  db = openDb(tmp);
  // web/pg и web/site уже имеют расписания в имитации настроек панели (pg — ещё и успешный запуск)
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

describe('итоговый статус сервиса', () => {
  const ep = (o = {}) => ({ supported: true, schedules: [], last: null, ...o });
  const ea = (o = {}) => ({ covered: false, possible: true, last: null, ...o });
  const NOW = Date.UTC(2026, 9, 1);
  test('нигде не копируется → «не настроено»; нет такой возможности вообще → скрыто', () => {
    assert.equal(combine({ easypanel: ep(), easyadmin: ea() }, NOW), 'none');
    assert.equal(combine({ easypanel: ep({ supported: false }), easyadmin: ea({ possible: false }) }, NOW), 'na');
    assert.equal(combine({ easypanel: ep({ schedules: [{ enabled: false }] }), easyadmin: ea() }, NOW), 'none', 'выключенное расписание — не защита');
  });
  test('ошибка любого источника важнее остального; запуска не было → pending; давно → stale; свежая копия → ok', () => {
    const sched = [{ enabled: true }];
    assert.equal(combine({ easypanel: ep({ schedules: sched, last: { state: 'ok', ts: NOW } }), easyadmin: ea({ covered: true, last: { state: 'error', ts: NOW } }) }, NOW), 'error');
    assert.equal(combine({ easypanel: ep({ schedules: sched, last: { state: 'running', ts: NOW } }), easyadmin: ea() }, NOW), 'running');
    assert.equal(combine({ easypanel: ep({ schedules: sched }), easyadmin: ea() }, NOW), 'pending');
    assert.equal(combine({ easypanel: ep({ schedules: sched, last: { state: 'ok', ts: NOW - 9 * 86_400_000 } }), easyadmin: ea() }, NOW), 'stale');
    assert.equal(combine({ easypanel: ep({ schedules: sched, last: { state: 'ok', ts: NOW - 3_600_000 } }), easyadmin: ea() }, NOW), 'ok');
    assert.equal(combine({ easypanel: ep(), easyadmin: ea({ covered: true, last: { state: 'ok', ts: NOW } }) }, NOW), 'ok', 'достаточно копий EasyAdmin');
  });
  test('статусы действий панели', () => {
    assert.deepEqual(['done', 'success', 'error', 'failed', 'running', 'pending'].map(actionState), ['ok', 'ok', 'error', 'error', 'running', 'running']);
  });
});

describe('обзор по панелям', () => {
  test('сервисы со статусами: расписание Easypanel и успешный запуск, расписание без запусков, без копий', async () => {
    const o = await ov();
    const pg = row(o, 'pg'); assert.equal(pg.status, 'ok'); assert.equal(pg.easypanel.schedules.length, 1); assert.equal(pg.easypanel.last.state, 'ok'); assert.equal(pg.easyadmin.covered, false);
    assert.equal(row(o, 'site').status, 'pending', 'расписание есть, запусков ещё не было');
    assert.equal(row(o, 'cache').status, 'none', 'redis: у Easypanel нет расписаний, EasyAdmin не включён');
    assert.equal(row(o, 'worker').status, 'none');
    assert.equal(o.summary.total, 4); assert.equal(o.summary.none, 2); assert.equal(o.summary.ok, 1); assert.equal(o.summary.pending, 1);
  });
  test('недоступная панель показана с причиной, без сервисов', async () => {
    const o = await ov(); const dead = o.panels.find((p) => p.panelId === deadId);
    assert.ok(dead.error); assert.deepEqual(dead.rows, []);
  });
  test('копии данных EasyAdmin: «выбранные» покрывают сервис; ошибка последнего запуска — «error»', async () => {
    await api('admin', 'PUT', '/api/backups/settings', { password: 'password123' });
    const put = await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'selected', keys: [`${pid}|web|cache`] } }); assert.equal(put.status, 200, JSON.stringify(put.data));
    let c = row(await ov(), 'cache'); assert.equal(c.easyadmin.covered, true); assert.equal(c.easyadmin.auto, false, 'расписание EasyAdmin выключено — вручную'); assert.equal(c.status, 'pending');
    db.prepare("INSERT INTO settings (k, v) VALUES ('backup_data_last', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify({ ts: Date.now(), ok: false, files: 0, failed: 1, dest: 'host', reason: 'manual', panels: [{ name: 'P', status: 'partial', error: null, failed: ['web/cache · redis: нет места'] }] }));
    c = row(await ov(), 'cache'); assert.equal(c.status, 'error'); assert.match(c.easyadmin.last.error, /нет места/);
    assert.equal(row(await ov(), 'pg').easyadmin.covered, false, 'остальные сервисы не затронуты');
    await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'all' } });
    assert.equal(row(await ov(), 'worker').easyadmin.covered, true);
    await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'none' } });
  });
  test('доступ только администратору; кэш: повторный запрос без force не ходит заново', async () => {
    assert.equal((await api('op', 'GET', '/api/backups/overview')).status, 403);
    const o1 = await ov(true); const o2 = await ov(false);
    assert.equal(o1.at <= o2.at, true); assert.equal(o2.panels.find((p) => p.panelId === pid).rows.length, 4);
  });
});

describe('compose-стеки', () => {
  test('виден в обзоре при любом охвате (его копируют копии данных EasyAdmin), а при выбранных сервисах не пропадает', async () => {
    const C = createMockPanel({ token: 'T', seed: { stk: [{ name: 'stack', type: 'compose' }, { name: 'plain' }] } });
    const id = (await api('admin', 'POST', '/api/panels', { name: 'Stacks', url: await C.listen(), token: 'T' })).data.id;
    try {
      await api('admin', 'GET', '/api/overview?force=1'); // панель попадает в обзор после первого опроса
      await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'none' } });
      let s = row(await ov(), 'stack'); assert.ok(s, 'стек показан даже без охвата'); assert.deepEqual([s.status, s.easyadmin.possible, s.easypanel.supported], ['none', true, false]);
      await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'selected', keys: [`${id}|stk|plain`] } });
      s = row(await ov(), 'stack'); assert.ok(s, 'не пропадает и при режиме «Выбранные»'); assert.equal(s.easyadmin.possible, true);
      await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'selected', keys: [`${id}|stk|stack`] } });
      assert.equal(row(await ov(), 'stack').easyadmin.covered, true, 'стек можно выбрать для копий данных');
    } finally { await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'none' } }); await api('admin', 'DELETE', `/api/panels/${id}`); await C.close(); }
  });
});
