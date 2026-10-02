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

/* Переименование и перенос сервиса: остановить → переименовать → запустить; ссылки в EasyAdmin следуют за сервисом. */
let app, base, tmp, db, M, pid; const jars = {};
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const move = (who, b) => api(who, 'POST', `/api/panels/${pid}/service/move`, { type: 'app', project: 'web', name: 'site', confirm: `${b.project ?? 'web'}/${b.name ?? 'site'}`, ...b });
const svc = (project, name) => M.projects.get(project)?.find((s) => s.name === name);
const callsOf = (proc) => M.calls.filter((c) => c.proc === proc);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-mv-'));
  db = openDb(tmp);
  M = createMockPanel({ token: 'T', seed: { web: [{ name: 'site' }, { name: 'idle', enabled: false }, { name: 'pg', type: 'postgres' }, { name: 'stack', type: 'compose' }, { name: 'other' }], infra: [] } });
  const url = await M.listen();
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
  pid = (await api('admin', 'POST', '/api/panels', { name: 'P', url, token: 'T' })).data.id;
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await M.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('проверки до обращения к панели', () => {
  test('только администратор; нужно подтверждение; имена и конфликты проверяются; compose нельзя', async () => {
    assert.equal((await move('op', { newName: 'x' })).status, 403);
    assert.equal((await move('admin', { newName: 'x', confirm: 'wrong' })).status, 400, 'нужно ввести project/service');
    for (const bad of [{ newName: 'Bad Name' }, { newName: '../x' }, { newProject: 'A B', createProject: true }]) assert.equal((await move('admin', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await move('admin', { newName: 'site' })).status, 400, 'ничего не изменилось');
    assert.equal((await move('admin', { newName: 'other' })).data.error, 'В проекте web уже есть сервис other');
    assert.equal((await move('admin', { newProject: 'nowhere', newName: 'site' })).status, 400, 'нет проекта без «создать проект»');
    const c = await move('admin', { type: 'compose', name: 'stack', newName: 'stack2' }); assert.equal(c.status, 400); assert.match(c.data.error, /Compose/);
    assert.equal(callsOf('services.common.renameService').length, 0, 'до панели дело не дошло');
  });
});

describe('переименование и перенос', () => {
  test('работающий сервис: останавливается, переименовывается и запускается снова', async () => {
    M.calls.length = 0;
    const r = await move('admin', { newName: 'site2' }); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.project, r.data.name, r.data.started, r.data.wasRunning], ['web', 'site2', true, true]);
    assert.ok(!svc('web', 'site') && svc('web', 'site2')?.enabled === true);
    const order = M.calls.map((c) => c.proc).filter((p) => /stopService|renameService|startService/.test(p));
    assert.deepEqual(order, ['services.app.stopService', 'services.common.renameService', 'services.app.startService']);
    assert.deepEqual(callsOf('services.common.renameService')[0].input, { oldProjectName: 'web', oldServiceName: 'site', newProjectName: 'web', newServiceName: 'site2' });
  });
  test('остановленный сервис остаётся остановленным', async () => {
    M.calls.length = 0;
    const r = await move('admin', { name: 'idle', newName: 'idle2' }); assert.equal(r.status, 200); assert.equal(r.data.wasRunning, false);
    assert.equal(svc('web', 'idle2').enabled, false); assert.equal(callsOf('services.app.startService').length, 0); assert.equal(callsOf('services.app.stopService').length, 0);
  });
  test('перенос в другой существующий проект вместе с переименованием; база данных тоже', async () => {
    const r = await move('admin', { name: 'site2', newProject: 'infra', newName: 'site' }); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(svc('infra', 'site')?.enabled && !svc('web', 'site2'));
    const d = await move('admin', { type: 'postgres', name: 'pg', newProject: 'infra', newName: 'pg' }); assert.equal(d.status, 200, JSON.stringify(d.data)); assert.ok(svc('infra', 'pg'));
  });
  test('новый проект создаётся только по явной отметке', async () => {
    const r = await move('admin', { name: 'other', newProject: 'fresh', createProject: true, newName: 'other' }); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.createdProject, true); assert.ok(M.projects.has('fresh') && svc('fresh', 'other'));
  });
  test('панель отказала: прежний сервис запускается обратно, имя не меняется, ошибка видна', async () => {
    M.calls.length = 0;
    const r = await move('admin', { name: 'idle2', newName: 'boom' }); assert.ok(r.status >= 400, JSON.stringify(r.data)); assert.match(JSON.stringify(r.data), /docker error/);
    assert.ok(svc('web', 'idle2') && !svc('web', 'boom')); assert.equal(callsOf('services.app.startService').length, 0, 'он и был остановлен — не запускаем');
    await api('admin', 'POST', `/api/panels/${pid}/service/action`, { type: 'app', project: 'infra', name: 'site', action: 'start' });
    const f = await move('admin', { project: 'infra', name: 'site', newName: 'boom' }); assert.ok(f.status >= 400);
    assert.equal(svc('infra', 'site').enabled, true, 'работавший сервис снова запущен после отказа');
  });
});

describe('ссылки в EasyAdmin следуют за сервисом', () => {
  test('расписания, вебхуки, метрики, охват копий и журнал', async () => {
    await api('admin', 'POST', `/api/panels/${pid}/service/action`, { type: 'app', project: 'infra', name: 'site', action: 'start' });
    const sch = await api('admin', 'POST', '/api/schedules', { name: 'ночной рестарт', action: 'restart', mode: 'daily', time: '03:00', target: { kind: 'services', items: [{ panelId: pid, type: 'app', project: 'infra', name: 'site' }, { panelId: pid, type: 'app', project: 'web', name: 'other2' }] } });
    assert.equal(sch.status, 200, JSON.stringify(sch.data));
    const hook = await api('admin', 'POST', '/api/hooks', { panelId: pid, type: 'app', project: 'infra', name: 'site', label: 'CI' }); assert.equal(hook.status, 200, JSON.stringify(hook.data));
    db.prepare('INSERT INTO svc_metrics (panel_id, ts, res, project, service, containers) VALUES (?,?,?,?,?,?)').run(pid, Date.now(), 60, 'infra', 'site', 1);
    await api('admin', 'PUT', '/api/backups/settings', { password: 'correct horse battery' }); // без пароля копий охват не включить
    assert.equal((await api('admin', 'PUT', '/api/backups/settings', { data: { mode: 'selected', keys: [`${pid}|infra|site`, `${pid}|infra|pg`] } })).status, 200);
    const r = await move('admin', { project: 'infra', name: 'site', newProject: 'web', newName: 'site-new' }); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.updated, { metrics: 1, hooks: 1, schedules: 1 });
    const s = (await api('admin', 'GET', '/api/schedules')).data.find((x) => x.name === 'ночной рестарт');
    assert.deepEqual(s.target.items.map((i) => `${i.project}/${i.name}`), ['web/site-new', 'web/other2'], 'чужие цели не тронуты');
    assert.deepEqual((await api('admin', 'GET', '/api/hooks')).data.map((h) => `${h.project}/${h.name}`), ['web/site-new']);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM svc_metrics WHERE project = 'web' AND service = 'site-new'").get().n, 1);
    const keys = (await api('admin', 'GET', '/api/backups')).data.settings.data.keys; assert.deepEqual(keys.sort(), [`${pid}|infra|pg`, `${pid}|web|site-new`].sort());
    const log = db.prepare("SELECT target, ok FROM audit WHERE action = 'service.move' ORDER BY id DESC LIMIT 1").get(); assert.deepEqual([log.target, log.ok], ['infra/site → web/site-new', 1]);
  });
});
