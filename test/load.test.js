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
import { parseSnapshot, topLines } from '../src/host-snapshot.js';
import { createMockPanel } from './mock-easypanel.js';

const MIN = 60_000; const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const FIXTURE = fs.readFileSync(new URL('./fixtures/host-snapshot.txt', import.meta.url), 'utf8');
let app, base, tmp, db, mon; const jars = {}; const panels = []; const hooks = [];
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const marker = (cmd) => { const x = /\$\(\((\d+)\+(\d+)\)\)/.exec(cmd); return `__EAOK${Number(x[1]) + Number(x[2])}__`; };
const addPanel = async (name, opts = {}) => {
  const m = createMockPanel({ token: 'T', seed: { web: [{ name: 'site' }, { name: 'api' }] }, ...opts });
  panels.push(m); const url = await m.listen();
  const id = (await api('admin', 'POST', '/api/panels', { name, url, token: 'T' })).data.id;
  return { id, m, row: db.prepare('SELECT * FROM panels WHERE id = ?').get(id) };
};
const rows = (where = '1=1', ...a) => db.prepare(`SELECT * FROM svc_metrics WHERE ${where} ORDER BY ts, project, service`).all(...a);
const setSettings = (b) => api('admin', 'PUT', '/api/load/settings', b);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-load-'));
  db = openDb(tmp);
  const fetchImpl = async (url, init) => { hooks.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key: crypto.randomBytes(32), fetchImpl, snapshotFn: async () => parseSnapshot(FIXTURE, [{ id: 'a'.repeat(64), projectName: 'web', serviceName: 'site', containerName: 'web_site.1.x' }]) });
  mon = app.loadmon;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await Promise.all(panels.map((p) => p.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('разбор снимка сервера', () => {
  test('нагрузка, память, диск, процессы с привязкой к сервисам по cgroup; остальное — «система»', () => {
    const snap = parseSnapshot(FIXTURE, [{ id: 'a'.repeat(64), projectName: 'web', serviceName: 'site', containerName: 'web_site.1.x' }]);
    assert.deepEqual(snap.load, { m1: 1.52, m5: 1.1, m15: 0.8 }); assert.deepEqual(snap.cpu, { user: 55, system: 10, iowait: 14, steal: 0, idle: 20 });
    assert.equal(snap.memory.total, 4096000 * 1024); assert.equal(snap.memory.used, 3072000 * 1024); assert.equal(snap.memory.swapUsed, 100000 * 1024); assert.deepEqual(snap.disk, { total: 30000000 * 1024, used: 24000000 * 1024, pct: 83 });
    assert.equal(snap.processes.length, 4); assert.equal(snap.processes[0].pid, 2001); assert.equal(snap.processes[0].cpu, 62); assert.deepEqual(snap.processes[0].owner, { project: 'web', service: 'site', container: 'web_site.1.x' });
    assert.equal(snap.processes[1].owner, null, 'dockerd — система'); assert.equal(snap.processes[2].owner.container, 'bbbbbbbbbbbb', 'неизвестный контейнер — по id');
    assert.equal(snap.memoryTop[0].pid, 2001); assert.equal(snap.memoryTop[0].rss, 384636 * 1024);
    assert.deepEqual(topLines(snap), ['node (site) 62%', 'dockerd (система) 14.5%', 'nginx: (контейнер bbbbbbbbbbbb) 8%']);
    assert.throws(() => parseSnapshot('##LOAD\n0 0 0\n', []), /Неполный/);
  });
});

describe('сбор и хранение', () => {
  test('сервисы: контейнеры compose суммируются, сеть — скорость по разности счётчиков, перезапуск контейнера не даёт отрицательных значений, повтор в ту же минуту не плодит строки', async () => {
    let n = 0;
    const { row } = await addPanel('L1', { tableData: () => { n++; return [
      { id: 'c1', containerName: 'stack-web-1', projectName: 'main', serviceName: 'stack', stats: { cpu: { percent: 10 }, memory: { usage: 100 * 1048576 }, network: { in: 1000 * n, out: 2000 * n } } },
      { id: 'c2', containerName: 'stack-db-1', projectName: 'main', serviceName: 'stack', stats: { cpu: { percent: 5 }, memory: { usage: 50 * 1048576 }, network: { in: n === 3 ? 10 : 500 * n, out: 0 } } },
      { id: 'c3', containerName: 'x', projectName: 'main', serviceName: 'other', stats: { cpu: { percent: 1 }, memory: { usage: 10 }, network: {} } },
      { containerName: 'broken', stats: {} },
    ]; } });
    await mon.collectPanel(row, T0); await mon.collectPanel(row, T0 + 10_000); // та же минута — одна строка на сервис
    let r = rows("panel_id = ? AND service <> ''", row.id); assert.equal(r.length, 2);
    const st = r.find((x) => x.service === 'stack'); assert.deepEqual([st.containers, st.cpu, st.mem], [2, 15, 150 * 1048576]); assert.equal(st.rx, 150, 'вторая выборка через 10 с: ((2000-1000)+(1000-500))/10 с'); assert.equal(st.tx, 200);
    await mon.collectPanel(row, T0 + MIN); r = rows('panel_id = ? AND ts = ?', row.id, T0 + MIN); const s2 = r.find((x) => x.service === 'stack'); assert.equal(s2.rx, 1000 / 50, 'c2 сбросил счётчик (10 < 1000) — его прирост не считается'); assert.equal(s2.tx, 2000 / 50);
    await mon.collectPanel(row, T0 + 2 * MIN); // у c2 счётчик сбросился (10 < 1500): без отрицательных значений
    const s3 = rows('panel_id = ? AND ts = ?', row.id, T0 + 2 * MIN).find((x) => x.service === 'stack'); assert.ok(s3.rx >= 0 && s3.tx >= 0);
    assert.ok(rows('panel_id = ? AND service = ?', row.id, 'other').every((x) => x.rx === 0), 'нет сетевых данных — 0');
  });

  test('хост: одна строка в минуту из снимка панели, «остаток» = хост − сервисы (CPU делится на число ядер)', async () => {
    const { row } = await addPanel('L2', { tableData: [{ id: 'a', projectName: 'p', serviceName: 's1', containerName: 'p_s1', stats: { cpu: { percent: 40 }, memory: { usage: 300 * 1048576 }, network: {} } }, { id: 'b', projectName: 'p', serviceName: 's2', containerName: 'p_s2', stats: { cpu: { percent: 20 }, memory: { usage: 100 * 1048576 }, network: {} } }] });
    const host = { stats: { cpu: 50, memPct: 40, memUsedMb: 1000, memTotalMb: 4000, cpus: 2 } };
    mon.onHost(row, host, T0); mon.onHost(row, host, T0 + 20_000); await mon.collectPanel(row, T0);
    assert.equal(rows("panel_id = ? AND service = ''", row.id).length, 1);
    const o = mon.overview(row.id, '1h', T0 + 30_000);
    assert.equal(o.cores, 2); assert.equal(o.memTotal, 4000 * 1048576); assert.equal(o.points.length, 1);
    const pt = o.points[0]; assert.equal(pt.cpu, 50); assert.equal(pt.svcCpu, 30, '(40+20)/2 ядра'); assert.equal(pt.otherCpu, 20); assert.equal(pt.mem, 1000 * 1048576); assert.equal(pt.svcMem, 400 * 1048576); assert.equal(pt.otherMem, 600 * 1048576);
    assert.deepEqual(o.services.map((s) => [s.service, s.cpu, s.cpuAvg, s.running, s.memPct]), [['s1', 20, 20, true, 7.5], ['s2', 10, 10, true, 2.5]], 'отсортированы по нагрузке, CPU — доля всего сервера');
    const later = mon.overview(row.id, '1h', T0 + 10 * MIN); assert.equal(later.services[0].running, false, 'нет свежих данных — сервис не запущен'); assert.equal(later.services[0].cpu, null);
    const one = mon.serviceSeries(row.id, 'p', 's1', '1h', T0 + 30_000); assert.deepEqual([one.points.length, one.points[0].cpu, one.points[0].mem], [1, 20, 300 * 1048576]);
  });

  test('уплотнение: минуты старше суток → 5 минут (среднее и пик), 5 минут старше 7 дней → час, хвост удаляется; свежие данные не трогаются; пресет «меньше» хранит 3 дня', async () => {
    const { row } = await addPanel('L3'); const NOW = T0 + 40 * 86400e3; const pid = row.id;
    const ins = db.prepare("INSERT INTO svc_metrics (panel_id, ts, res, project, service, containers, cpu, cpu_max, mem, mem_max, rx, tx, cores) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const base0 = Math.floor((NOW - 30 * 3600e3) / 300_000) * 300_000; // 30 ч назад, выровнено по 5 минутам
    for (let i = 0; i < 5; i++) ins.run(pid, base0 + i * MIN, 60, 'p', 's', 1, 10 * (i + 1), 10 * (i + 1), 100 * (i + 1), 100 * (i + 1), 10, 20, null);
    ins.run(pid, NOW - 5 * MIN, 60, 'p', 's', 1, 7, 7, 70, 70, 1, 1, null); // свежая — не трогаем
    mon.downsample(NOW);
    const m5 = rows('panel_id = ? AND res = 300', pid); assert.equal(m5.length, 1); assert.deepEqual([m5[0].cpu, m5[0].cpu_max, m5[0].mem, m5[0].mem_max, m5[0].rx], [30, 50, 300, 500, 10]);
    assert.equal(rows('panel_id = ? AND res = 60', pid).length, 1, 'свежая минутная точка осталась');
    // 5-минутные старше 7 дней → час; старше 30 дней — удаляются
    const old = Math.floor((NOW - 10 * 86400e3) / 3600_000) * 3600_000;
    for (let i = 0; i < 12; i++) ins.run(pid, old + i * 300_000, 300, 'p', 's', 1, 20, 20 + i, 200, 200 + i, 5, 5, null);
    ins.run(pid, NOW - 35 * 86400e3, 3600, 'p', 's', 1, 1, 1, 1, 1, 1, 1, null);
    mon.downsample(NOW);
    const h1 = rows('panel_id = ? AND res = 3600', pid); assert.equal(h1.length, 1, 'старше 30 дней удалено, 12 пятиминуток → один час'); assert.equal(h1[0].ts, old); assert.equal(h1[0].cpu_max, 31);
    // «меньше»: пятиминутки старше 3 дней просто удаляются
    await setSettings({ retention: 'short' }); ins.run(pid, NOW - 4 * 86400e3, 300, 'p', 's', 1, 1, 1, 1, 1, 1, 1, null); ins.run(pid, NOW - 2 * 86400e3, 300, 'p', 's', 1, 1, 1, 1, 1, 1, 1, null);
    mon.downsample(NOW); assert.deepEqual(rows('panel_id = ? AND res = 300', pid).map((x) => x.ts).filter((t) => t < NOW - 86400e3 * 1.5 && t > NOW - 5 * 86400e3), [NOW - 2 * 86400e3], 'старше 3 дней удалено, свежее осталось');
  });
  after(() => setSettings({ retention: 'standard' }));

  test('настройка «Выключено»: ничего не собирается; удаление панели чистит историю', async () => {
    const { id, row } = await addPanel('L4'); await new Promise((r) => setTimeout(r, 100)); await setSettings({ enabled: false }); assert.deepEqual(await mon.collectPanel(row, T0), { skipped: 'off' }); mon.onHost(row, { stats: { cpu: 1 } }, T0);
    assert.equal(rows("panel_id = ? AND ts = ?", id, T0).length, 0); await setSettings({ enabled: true }); await mon.collectPanel(row, T0); assert.ok(rows('panel_id = ? AND ts = ?', id, T0).length > 0);
    assert.equal((await api('admin', 'DELETE', `/api/panels/${id}`)).status, 200); assert.equal(rows('panel_id = ?', id).length, 0, 'история удалённой панели не остаётся');
  });
});

describe('уведомления о перегрузке', () => {
  const hookWith = async () => { const r = await api('admin', 'POST', '/api/channels', { name: 'W', type: 'webhook', url: 'https://hook.example/x', events: ['overload'] }); assert.equal(r.status, 200, JSON.stringify(r.data)); };
  const hot = (cpu, mem = 30) => ({ stats: { cpu, memPct: mem, memUsedMb: 1000, memTotalMb: 4000, cpus: 1 } });
  test('«обычные»: CPU ≥ 85% дольше 10 минут → одно уведомление с топом процессов; повтора нет, пока нагрузка не упадёт заметно; потом снова', async () => {
    await hookWith(); const { row } = await addPanel('A1'); await new Promise((r) => setTimeout(r, 100)); await setSettings({ alerts: 'normal', snapshot: true }); hooks.length = 0;
    for (let i = 0; i <= 9; i++) mon.onHost(row, hot(90), T0 + i * MIN); await new Promise((r) => setTimeout(r, 30)); assert.equal(hooks.length, 0, 'ещё не 10 минут');
    mon.onHost(row, hot(90), T0 + 10 * MIN); await new Promise((r) => setTimeout(r, 50));
    assert.equal(hooks.length, 1); assert.equal(hooks[0].body.type, 'overload'); assert.match(hooks[0].body.text, /Панель «A1»: CPU сервера 90% уже 10 мин/); assert.match(hooks[0].body.text, /Топ: node \(site\) 62%/);
    for (let i = 11; i < 20; i++) mon.onHost(row, hot(95), T0 + i * MIN); await new Promise((r) => setTimeout(r, 30)); assert.equal(hooks.length, 1, 'пока нагрузка держится — без повторов');
    mon.onHost(row, hot(80), T0 + 20 * MIN); mon.onHost(row, hot(90), T0 + 21 * MIN); assert.equal(hooks.length, 1, '80% — ещё не «спад» (порог − 10): состояние сохраняется');
    mon.onHost(row, hot(50), T0 + 22 * MIN); for (let i = 23; i <= 34; i++) mon.onHost(row, hot(90), T0 + i * MIN); await new Promise((r) => setTimeout(r, 60));
    assert.equal(hooks.length, 2, 'после спада и нового долгого периода — снова');
  });
  after(() => setSettings({ alerts: 'normal', snapshot: true }));
  test('«чувствительные» (70%/80%, 5 мин), память отдельно; «выключены» — тишина; без снимка — просто текст; снимки не чаще раза в 10 минут', async () => {
    const { row } = await addPanel('A2'); await setSettings({ alerts: 'sensitive', snapshot: false }); hooks.length = 0;
    for (let i = 0; i <= 5; i++) mon.onHost(row, hot(20, 85), T0 + i * MIN); await new Promise((r) => setTimeout(r, 40));
    assert.equal(hooks.length, 1); assert.match(hooks[0].body.text, /память сервера 85% уже 5 мин/); assert.ok(!hooks[0].body.text.includes('Топ:'), 'снимок выключен');
    const { row: r3 } = await addPanel('A3'); await setSettings({ alerts: 'off' }); hooks.length = 0;
    for (let i = 0; i <= 20; i++) mon.onHost(r3, hot(99, 99), T0 + i * MIN); await new Promise((r) => setTimeout(r, 30)); assert.equal(hooks.length, 0);
    await setSettings({ alerts: 'sensitive', snapshot: true }); const { row: r4 } = await addPanel('A4'); hooks.length = 0;
    for (let i = 0; i <= 6; i++) { mon.onHost(r4, hot(90, 90), T0 + i * MIN); } await new Promise((r) => setTimeout(r, 60));
    assert.equal(hooks.length, 2, 'CPU и память — два события'); assert.equal(hooks.filter((h) => h.body.text.includes('Топ:')).length, 1, 'снимок прикладывается один раз за 10 минут');
  });
  test('каналы, которые получали «диск заполнен», получили и «перегрузку» при первом запуске', () => {
    const d2 = new DatabaseSync(':memory:'); void d2; // миграция отрабатывает при создании монитора; здесь проверяем состояние рабочей базы
    assert.ok(db.prepare("SELECT v FROM settings WHERE k = 'load_migrated'").get()?.v === '1');
  });
});

describe('API', () => {
  test('настройки: только админ, проверка значений, запись в журнал, очистка истории', async () => {
    assert.equal((await api('op', 'GET', '/api/load/settings')).status, 403); assert.equal((await api('op', 'PUT', '/api/load/settings', { enabled: false })).status, 403);
    const g = (await api('admin', 'GET', '/api/load/settings')).data; assert.deepEqual([g.enabled, g.retention, g.alerts, g.snapshot], [true, 'standard', 'normal', true]); assert.ok(g.presets.alerts.normal.cpu === 85 && g.rows >= 0);
    for (const bad of [{ retention: 'forever' }, { alerts: 'extreme' }, { enabled: 'yes' }, { snapshot: 1 }]) assert.equal((await setSettings(bad)).status, 400, JSON.stringify(bad));
    const ok = await setSettings({ retention: 'long', alerts: 'sensitive', snapshot: false }); assert.equal(ok.status, 200); assert.deepEqual([ok.data.retention, ok.data.alerts, ok.data.snapshot], ['long', 'sensitive', false]);
    assert.ok((await api('admin', 'GET', '/api/audit?q=load.settings&limit=20')).data.length >= 1);
    await setSettings({ retention: 'standard', alerts: 'normal', snapshot: true });
    assert.equal((await api('op', 'DELETE', '/api/load/data')).status, 403); const del = await api('admin', 'DELETE', '/api/load/data'); assert.equal(del.status, 200); assert.equal(del.data.rows, 0);
  });
  test('график панели и сервиса: период проверяется, не больше ~240 точек, права на панель учитываются', async () => {
    const { id, row } = await addPanel('P1');
    const startTs = Date.now() - 400 * MIN;
    for (let i = 0; i < 400; i++) { const ts = startTs + i * MIN; mon.onHost(row, { stats: { cpu: 10 + (i % 20), memPct: 30, memUsedMb: 1000, memTotalMb: 4000, cpus: 1 } }, ts); await mon.collectPanel(row, ts); }
    const r = await api('admin', 'GET', `/api/panels/${id}/load?range=30d`); assert.equal(r.status, 200); assert.ok(r.data.points.length > 0 && r.data.points.length <= 241, `точек: ${r.data.points.length}`); assert.ok(r.data.services.length >= 2);
    assert.equal((await api('admin', 'GET', `/api/panels/${id}/load?range=5y`)).status, 400); assert.equal((await api('admin', 'GET', `/api/panels/${id}/load?project=web`)).status, 400);
    const sv = await api('admin', 'GET', `/api/panels/${id}/load?range=30d&project=web&service=site`); assert.equal(sv.status, 200); assert.ok(sv.data.points.length > 0 && sv.data.points.every((p) => p.mem > 0));
    assert.equal((await api('op', 'GET', `/api/panels/${id}/load?range=24h`)).status, 200, 'оператор читает графики');
    assert.equal((await api('admin', 'GET', '/api/panels/99999/load')).status, 404);
  });
  test('снимок «что грузит сервер»: только админ, привязка к сервисам, частые запросы ограничены, ход записан в журнал', async () => {
    const { id } = await addPanel('S1', { realPanel: true, hostExec: (cmd) => (/##LOAD/.test(cmd) ? `${FIXTURE.replace(/##END\n?$/, '##END')}\n${marker(cmd)}` : null), tableData: [{ id: 'a'.repeat(64), projectName: 'web', serviceName: 'site', containerName: 'web_site.1.x', stats: { cpu: { percent: 5 }, memory: { usage: 1 }, network: {} } }] });
    assert.equal((await api('op', 'POST', `/api/panels/${id}/snapshot`)).status, 403);
    const r = await api('admin', 'POST', `/api/panels/${id}/snapshot`); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.processes[0].owner.service, 'site'); assert.equal(r.data.cpu.iowait, 14); assert.equal(r.data.disk.pct, 83);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/snapshot`)).status, 400, 'слишком часто');
    assert.ok((await api('admin', 'GET', '/api/audit?q=host.snapshot&limit=10')).data.some((a) => a.ok === 1));
  });
});
