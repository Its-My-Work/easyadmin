import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { applyTimezone, currentTimezone, validTz } from '../src/timezone.js';
import { createMockPanel } from './mock-easypanel.js';

/* Пакет доработок: история сервиса, часовой пояс сервера, интервал замеров нагрузки, удаление сертификата, инвентарь по всем типам сервисов. */
const MIN = 60_000; const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
let app, base, tmp, db, M, pid; const jars = {}; const origTz = process.env.TZ;
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-batch-'));
  db = openDb(tmp);
  M = createMockPanel({ token: 'T', seed: { web: [{ name: 'site', image: 'nginx:1.25' }, { name: 'db', type: 'postgres' }, { name: 'stack', type: 'compose' }] }, certs: [{ domain: 'a.example.com' }, { domain: 'b.example.com' }] });
  const url = await M.listen();
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'ro', password: 'password1', role: 'viewer' });
  await api('ro', 'POST', '/api/login', { username: 'ro', password: 'password1' });
  pid = (await api('admin', 'POST', '/api/panels', { name: 'P', url, token: 'T' })).data.id;
  await api('admin', 'GET', '/api/overview?force=1');
});
after(async () => {
  if (origTz === undefined) delete process.env.TZ; else process.env.TZ = origTz;
  app.stop(); app.server.closeAllConnections(); app.server.close(); await M.close(); fs.rmSync(tmp, { recursive: true, force: true });
});

describe('история сервиса', () => {
  const q = 'project=web&name=site';
  test('деплой попадает в историю: действие панели с id и запись EasyAdmin; лог открывается отдельным запросом', async () => {
    assert.equal((await api('admin', 'POST', `/api/panels/${pid}/service/action`, { type: 'app', project: 'web', name: 'site', action: 'deploy' })).status, 200);
    const h = (await api('admin', 'GET', `/api/panels/${pid}/service/history?${q}`)).data;
    assert.equal(h.actionsError, null);
    const panel = h.items.find((x) => x.source === 'panel');
    assert.ok(panel && panel.id && /deploy/.test(panel.kind) && panel.hasLog, JSON.stringify(h.items));
    assert.ok(h.items.some((x) => x.source === 'easyadmin' && x.action === 'service.deploy' && x.user === 'admin' && x.ok));
    assert.ok(h.items.every((x, i, a) => i === 0 || (a[i - 1].ts ?? 0) >= (x.ts ?? 0)), 'новые сверху');
    const log = (await api('admin', 'GET', `/api/panels/${pid}/service/history/${panel.id}`)).data;
    assert.match(log.log, /Pulling image/);
    assert.equal(log.action.id, panel.id);
  });
  test('история другого сервиса не смешивается; без прав оператора — 403; плохое имя — 400', async () => {
    const other = (await api('admin', 'GET', `/api/panels/${pid}/service/history?project=web&name=db`)).data;
    assert.equal(other.items.some((x) => x.source === 'panel'), false);
    assert.equal(other.items.some((x) => x.target === 'web/site'), false);
    assert.equal((await api('ro', 'GET', `/api/panels/${pid}/service/history?${q}`)).status, 403);
    assert.equal((await api('admin', 'GET', `/api/panels/${pid}/service/history?project=web&name=bad%20name`)).status, 400);
  });
  test('ошибка в журнале попадает в историю целиком, с текстом ошибки', async () => {
    await api('admin', 'POST', `/api/panels/${pid}/service/action`, { type: 'app', project: 'web', name: 'nothing', action: 'deploy' });
    const h = (await api('admin', 'GET', `/api/panels/${pid}/service/history?project=web&name=nothing`)).data;
    const bad = h.items.find((x) => x.source === 'easyadmin');
    assert.ok(bad && bad.ok === false && /not found/i.test(bad.detail), JSON.stringify(h.items));
  });
});

describe('часовой пояс сервера', () => {
  test('время сервера доступно любому вошедшему; смена пояса — только администратору, с проверкой и записью в журнал', async () => {
    const t = (await api('ro', 'GET', '/api/time')).data;
    assert.ok(Math.abs(t.now - Date.now()) < 5000 && typeof t.tz === 'string' && t.tz);
    assert.equal((await api('ro', 'PUT', '/api/settings', { timezone: 'Asia/Tokyo' })).status, 403);
    assert.equal((await api('admin', 'PUT', '/api/settings', { timezone: 'Mars/Olympus' })).status, 400);
    assert.equal((await api('admin', 'PUT', '/api/settings', { timezone: 'bad zone!' })).status, 400);
    const r = await api('admin', 'PUT', '/api/settings', { timezone: 'Asia/Tokyo' });
    assert.equal(r.status, 200); assert.equal(r.data.timezone, 'Asia/Tokyo'); assert.equal(r.data.timezoneSaved, 'Asia/Tokyo');
    assert.equal((await api('ro', 'GET', '/api/time')).data.tz, 'Asia/Tokyo');
    // локальное время процесса действительно переехало: расписания и копии считают по нему
    assert.equal(new Date(Date.UTC(2026, 0, 1, 0, 0)).getHours(), 9);
    assert.ok((await api('admin', 'GET', '/api/audit?q=settings.timezone')).data.some((a) => a.action === 'settings.timezone' && /Asia\/Tokyo/.test(a.detail)));
    assert.equal((await api('admin', 'PUT', '/api/settings', { timezone: 'UTC' })).data.timezone, 'UTC');
    assert.equal(new Date(Date.UTC(2026, 0, 1, 0, 0)).getHours(), 0);
  });
  test('validTz / applyTimezone: мусор не применяется', () => {
    const before = currentTimezone();
    assert.equal(validTz('Europe/Moscow'), true); assert.equal(validTz('UTC'), true);
    assert.equal(validTz(''), false); assert.equal(validTz(null), false); assert.equal(validTz('../etc/passwd'), false); assert.equal(validTz('No/Such_Zone'), false);
    assert.equal(applyTimezone('No/Such_Zone'), false); assert.equal(currentTimezone(), before);
  });
  test('сохранённый пояс применяется при запуске приложения', () => {
    process.env.TZ = 'UTC';
    const d2 = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'ea-tz-')));
    d2.prepare("INSERT INTO settings (k, v) VALUES ('timezone', 'Europe/Berlin')").run();
    const a2 = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), tlsProbe: false }, db: d2, key: crypto.randomBytes(32) });
    try { assert.equal(currentTimezone(), 'Europe/Berlin'); } finally { a2.stop(); a2.server.close(); process.env.TZ = 'UTC'; }
  });
});

describe('интервал замеров нагрузки', () => {
  test('допустимые значения; по умолчанию — 1 минута', async () => {
    assert.equal((await api('admin', 'GET', '/api/load/settings')).data.interval, 1);
    assert.deepEqual((await api('admin', 'GET', '/api/load/settings')).data.presets.intervals, [1, 2, 5, 10, 15]);
    assert.equal((await api('admin', 'PUT', '/api/load/settings', { interval: 3 })).status, 400);
    assert.equal((await api('admin', 'PUT', '/api/load/settings', { interval: 5 })).data.interval, 5);
    assert.equal((await api('ro', 'PUT', '/api/load/settings', { interval: 1 })).status, 403);
  });
  test('замеры идут раз в выбранный интервал: сервисы и хост', async () => {
    const mon = app.loadmon; const row = db.prepare('SELECT * FROM panels WHERE id = ?').get(pid);
    const count = () => db.prepare("SELECT COUNT(*) c FROM svc_metrics WHERE panel_id = ? AND service <> ''").get(pid).c;
    const host = () => db.prepare("SELECT COUNT(*) c FROM svc_metrics WHERE panel_id = ? AND project = '' AND service = ''").get(pid).c;
    db.prepare('DELETE FROM svc_metrics').run();
    await mon.tick(T0); const first = count(); assert.ok(first > 0);
    await mon.tick(T0 + MIN); assert.equal(count(), first, 'через минуту при интервале 5 — пропуск');
    await mon.tick(T0 + 4 * MIN); assert.equal(count(), first, 'через 4 минуты — пропуск');
    await mon.tick(T0 + 5 * MIN); assert.ok(count() > first, 'через 5 минут — новый замер');
    const snap = { stats: { cpu: 10, memPct: 20, memUsedMb: 100, memTotalMb: 1000, cpus: 2 } };
    mon.onHost(row, snap, T0 + 10 * MIN); mon.onHost(row, snap, T0 + 11 * MIN); mon.onHost(row, snap, T0 + 13 * MIN);
    assert.equal(host(), 1, 'хост: одна запись на интервал');
    mon.onHost(row, snap, T0 + 15 * MIN); assert.equal(host(), 2);
    await api('admin', 'PUT', '/api/load/settings', { interval: 1 });
    mon.onHost(row, snap, T0 + 16 * MIN); assert.equal(host(), 3, 'при интервале 1 — каждую минуту');
  });
});

describe('сертификаты: удаление', () => {
  test('удаляет сертификат без перевыпуска, пишет журнал; проверки домена и прав', async () => {
    const before = (await api('admin', 'GET', '/api/certs')).data[0].certs.map((c) => c.domain);
    assert.deepEqual(before.sort(), ['a.example.com', 'b.example.com']);
    assert.equal((await api('ro', 'POST', `/api/panels/${pid}/certs/delete`, { domain: 'a.example.com' })).status, 403);
    assert.equal((await api('admin', 'POST', `/api/panels/${pid}/certs/delete`, { domain: 'bad domain!' })).status, 400);
    assert.equal((await api('admin', 'POST', `/api/panels/${pid}/certs/delete`, { domain: 'nope.example.com' })).status, 400);
    assert.equal((await api('admin', 'POST', `/api/panels/${pid}/certs/delete`, { domain: 'a.example.com' })).status, 200);
    assert.deepEqual((await api('admin', 'GET', '/api/certs')).data[0].certs.map((c) => c.domain), ['b.example.com']);
    assert.ok((await api('admin', 'GET', '/api/audit?q=cert.delete')).data.some((a) => a.action === 'cert.delete' && a.target === 'a.example.com' && a.ok === 1));
  });
});

describe('инвентарь: все типы сервисов', () => {
  test('кроме приложений есть базы данных и compose-стеки, с типом сервиса', async () => {
    const items = (await api('admin', 'GET', '/api/images?force=1')).data;
    assert.deepEqual(items.map((i) => `${i.name}:${i.kind}`).sort(), ['db:postgres', 'site:app', 'stack:compose']);
    assert.ok(items.every((i) => i.type !== 'error'));
    assert.equal(items.find((i) => i.name === 'site').image, 'nginx:1.25');
  });
});
