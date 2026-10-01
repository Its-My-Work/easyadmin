import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { applyPendingRestore, openBackup, sealBackup, inspectDb } from '../src/backups.js';
import { loadConfig } from '../src/config.js';
import { loadKey } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { createMockPanel } from './mock-easypanel.js';

let app, base, tmp, db, key, restarted = 0; const panels = []; let cookie = ''; let s3srv, s3Port; const s3Objects = new Map(); const s3Auth = [];
const api = async (method, p, body, raw) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const addPanel = async (name, seed) => {
  const m = createMockPanel({ token: 'T', seed }); panels.push(m);
  const id = (await api('POST', '/api/panels', { name, url: await m.listen(), token: 'T' })).data.id; return id;
};
const PW = 'correct horse battery';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-bak-'));
  db = openDb(tmp); key = loadKey(tmp, '');
  // мини-S3: PUT/GET/DELETE/list, запоминает заголовки подписи
  s3srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); s3Auth.push({ method: req.method, auth: req.headers.authorization, sha: req.headers['x-amz-content-sha256'], path: u.pathname });
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const k = decodeURIComponent(u.pathname);
      if (req.method === 'PUT') { s3Objects.set(k, Buffer.concat(chunks)); res.end(); }
      else if (req.method === 'DELETE') { s3Objects.delete(k); res.writeHead(204); res.end(); }
      else if (u.searchParams.get('list-type')) {
        const pre = `/bucket/${u.searchParams.get('prefix')}`;
        res.end(`<ListBucketResult>${[...s3Objects].filter(([n]) => n.startsWith(pre)).map(([n, b]) => `<Contents><Key>${n.slice('/bucket/'.length)}</Key><Size>${b.length}</Size><LastModified>2026-10-01T00:00:00Z</LastModified></Contents>`).join('')}</ListBucketResult>`);
      } else if (s3Objects.has(k)) res.end(s3Objects.get(k)); else { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); }
    });
  });
  await new Promise((r) => s3srv.listen(0, '127.0.0.1', r)); s3Port = s3srv.address().port;
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key, restart: () => { restarted++; } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
  await api('POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); s3srv.close(); await Promise.all(panels.map((p) => p.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('формат файла копии', () => {
  test('шифруется паролем: неверный пароль и порча файла отвергаются, содержимое восстанавливается', () => {
    const tmpDb = path.join(tmp, 'x.db'); const d = new DatabaseSync(tmpDb); d.exec('CREATE TABLE panels (id INTEGER); CREATE TABLE users (id INTEGER); CREATE TABLE channels (id INTEGER); CREATE TABLE templates (id INTEGER); INSERT INTO panels VALUES (1),(2)'); d.close();
    const bytes = fs.readFileSync(tmpDb); const k = crypto.randomBytes(32);
    const f = sealBackup({ dbBytes: bytes, appKey: k, password: PW, createdAt: 5, panels: [{ id: 1, name: 'p', projects: [], errors: [] }] });
    assert.ok(!f.toString().includes('SQLite format'), 'открытого текста нет'); assert.ok(!f.toString().includes(k.toString('hex')));
    const o = openBackup(f, PW); assert.ok(o.db.equals(bytes)); assert.ok(o.key.equals(k)); assert.equal(o.panels[0].name, 'p'); assert.equal(inspectDb(o.db).panels, 2);
    assert.throws(() => openBackup(f, 'wrong password'), /Неверный пароль/);
    const bad = JSON.parse(f.toString()); bad.data = Buffer.from(bad.data, 'base64').fill(0, 0, 4).toString('base64');
    assert.throws(() => openBackup(Buffer.from(JSON.stringify(bad)), PW), /Неверный пароль или файл повреждён/);
    assert.throws(() => openBackup(Buffer.from('not json'), PW), /Это не файл копии/); assert.throws(() => inspectDb(Buffer.from('garbage')), /нет базы|повреждена/);
    const noSys = openBackup(sealBackup({ dbBytes: null, appKey: k, password: PW, createdAt: 1, panels: [] }), PW); assert.equal(noSys.db, null); assert.equal(noSys.key, null, 'без системы ключ не кладём');
  });
});

describe('настройки и запуск', () => {
  test('права, проверки значений, секреты не отдаются', async () => {
    assert.equal((await api('GET', '/api/backups')).status, 200);
    const { status, data } = await api('PUT', '/api/backups/settings', { enabled: true }); assert.equal(status, 400); assert.match(data.error, /пароль/);
    for (const bad of [{ password: 'short' }, { every: 'hourly' }, { hour: 24 }, { keep: 0 }, { storage: 'ftp' }, { panels: 'some' }, { panelIds: ['a'] }, { s3: { endpoint: 'ftp://x' } }, { s3: { prefix: '../x' } }]) assert.equal((await api('PUT', '/api/backups/settings', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await api('PUT', '/api/backups/settings', { panels: 'selected', panelIds: [] })).status, 400, 'выбранные: нужна хотя бы одна');
    assert.equal((await api('PUT', '/api/backups/settings', { system: false, panels: 'none' })).status, 400, 'нечего копировать');
    const ok = await api('PUT', '/api/backups/settings', { password: PW, keep: 3, panels: 'all', s3: { endpoint: `http://127.0.0.1:${s3Port}`, bucket: 'bucket', accessKey: 'AK', secretKey: 'SECRETSECRET', prefix: 'ea' } });
    assert.equal(ok.status, 200); assert.deepEqual([ok.data.hasPassword, ok.data.s3.hasSecret, ok.data.s3.secretKey, ok.data.s3.prefix], [true, true, '', 'ea/']); assert.ok(!JSON.stringify(ok.data).includes(PW) && !JSON.stringify(ok.data).includes('SECRETSECRET'));
    assert.ok(!fs.readFileSync(path.join(tmp, 'easyadmin.db'), 'latin1').includes('SECRETSECRET'), 'в базе пароль и ключи S3 зашифрованы');
    const op = fs.mkdtempSync(path.join(os.tmpdir(), 'x')); fs.rmSync(op, { recursive: true });
  });

  test('копия содержит систему и выбранные панели; история нагрузки и сессии не попадают; локальная ротация по числу копий', async () => {
    const a = await addPanel('Альфа', { web: [{ name: 'site' }] }); const b = await addPanel('Бета', { api: [{ name: 'svc' }] });
    db.prepare("INSERT INTO svc_metrics (panel_id, ts, res, project, service, containers, cpu, cpu_max, mem, mem_max) VALUES (?,?,?,?,?,?,?,?,?,?)").run(a, 1, 60, 'p', 's', 1, 1, 1, 1, 1);
    await api('PUT', '/api/backups/settings', { panels: 'selected', panelIds: [a], storage: 'local', keep: 2 });
    const r = await api('POST', '/api/backups/run'); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.panels.map((p) => p.name), ['Альфа']);
    const file = await api('GET', `/api/backups/download?name=${r.data.name}`, null, true); const o = openBackup(file.buf, PW);
    assert.ok(o.db && o.key.equals(key)); assert.deepEqual(o.panels.map((p) => p.name), ['Альфа']);
    const svc = o.panels[0].projects.find((p) => p.name === 'web').services[0]; assert.equal(svc.name, 'site'); assert.ok(svc.service, 'полное описание сервиса сохранено');
    const check = path.join(tmp, 'chk.db'); fs.writeFileSync(check, o.db); const c = new DatabaseSync(check);
    assert.equal(c.prepare('SELECT COUNT(*) n FROM svc_metrics').get().n, 0); assert.equal(c.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0); assert.equal(c.prepare('SELECT COUNT(*) n FROM panels').get().n, 2); c.close();
    assert.ok(db.prepare('SELECT COUNT(*) n FROM svc_metrics').get().n > 0, 'рабочая база не тронута');
    // все панели + без системы
    await api('PUT', '/api/backups/settings', { panels: 'all', system: false });
    await new Promise((r2) => setTimeout(r2, 1100)); const r2 = await api('POST', '/api/backups/run'); assert.equal(r2.data.panels.length, 2);
    const o2 = openBackup((await api('GET', `/api/backups/download?name=${r2.data.name}`, null, true)).buf, PW); assert.equal(o2.db, null); assert.equal(o2.panels.length, 2);
    await new Promise((r2) => setTimeout(r2, 1100)); await api('POST', '/api/backups/run'); // третья → самая старая удалена
    const list = (await api('GET', '/api/backups')).data.files; assert.equal(list.length, 2, 'хранится keep=2'); assert.ok(!list.some((f) => f.name === r.data.name));
    assert.equal((await api('GET', '/api/backups/download?name=../../etc/passwd')).status, 400);
    assert.equal((await api('DELETE', `/api/backups?name=${list[1].name}`)).status, 200);
    await api('PUT', '/api/backups/settings', { system: true });
  });

  test('S3: запросы подписаны SigV4, файл попадает в бакет, список и ротация работают', async () => {
    await api('PUT', '/api/backups/settings', { storage: 's3', keep: 2, panels: 'none' }); s3Auth.length = 0;
    const r = await api('POST', '/api/backups/run'); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok([...s3Objects.keys()].some((k) => k.startsWith('/bucket/ea/easyadmin-')));
    const put = s3Auth.find((x) => x.method === 'PUT'); assert.match(put.auth, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(put.sha, crypto.createHash('sha256').update(s3Objects.get(put.path)).digest('hex'), 'хэш тела совпадает');
    for (let i = 0; i < 2; i++) { await new Promise((r2) => setTimeout(r2, 1100)); await api('POST', '/api/backups/run'); }
    const files = (await api('GET', '/api/backups')).data.files; assert.equal(files.length, 2);
    const v = await api('POST', '/api/backups/verify', { name: files[0].name }); assert.equal(v.status, 200, JSON.stringify(v.data)); assert.equal(v.data.hasSystem, true);
    s3Objects.clear(); const bad = await api('PUT', '/api/backups/settings', { s3: { secretKey: 'x' } }); assert.equal(bad.status, 200);
  });

  test('ошибка хранилища: копия не создаётся, ошибка видна в «последней копии» и уходит в уведомление', async () => {
    const hooks = []; const orig = app.alerts.emit; app.alerts.emit = async (e) => { hooks.push(e); };
    await api('PUT', '/api/backups/settings', { s3: { endpoint: 'http://127.0.0.1:1' } });
    const r = await api('POST', '/api/backups/run'); assert.equal(r.status, 400); const last = (await api('GET', '/api/backups')).data.settings.last;
    assert.equal(last.ok, false); assert.equal(hooks[0].type, 'backup_failed'); app.alerts.emit = orig;
    await api('PUT', '/api/backups/settings', { storage: 'local', panels: 'all' });
  });
});

describe('расписание', () => {
  test('ежедневно: после заданного часа один раз в сутки; еженедельно — раз в 6.5 суток; после ошибки — не чаще раза в час', async () => {
    const b = app.backups; await api('PUT', '/api/backups/settings', { enabled: true, every: 'daily', hour: 3, storage: 'local' });
    const day = (h, d = 1, m = 0) => new Date(2030, 0, d, h, m).getTime();
    assert.equal(await b.tick(day(2)), null, 'раньше 03:00 — нет');
    const first = await b.tick(day(3, 1, 5)); assert.ok(first?.ok); assert.equal(first.reason, 'schedule');
    // last.ts = реальное now() — подменяем «последний успех» под тестовые даты
    db.prepare("INSERT INTO settings (k, v) VALUES ('backup_last', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify({ ts: day(3, 1, 5), ok: true }));
    assert.equal(await b.tick(day(15, 1)), null, 'в тот же день — нет'); assert.ok(await b.tick(day(3, 2, 1)), 'на следующий день — есть');
    await api('PUT', '/api/backups/settings', { every: 'weekly' });
    db.prepare("UPDATE settings SET v = ? WHERE k = 'backup_last'").run(JSON.stringify({ ts: day(3, 2), ok: true }));
    assert.equal(await b.tick(day(4, 5)), null); assert.ok(await b.tick(day(4, 9)));
    db.prepare("UPDATE settings SET v = ? WHERE k = 'backup_last'").run(JSON.stringify({ ts: day(5, 20), ok: false, error: 'x' }));
    assert.equal(await b.tick(day(5, 20, 30)), null, 'после ошибки — подождать час'); assert.ok(await b.tick(day(6, 21)), 'через час пробуем снова');
    await api('PUT', '/api/backups/settings', { enabled: false });
  });
});

describe('проверка и восстановление', () => {
  test('проверка показывает состав и совпадение ключа; неверный пароль — ошибка', async () => {
    await api('PUT', '/api/backups/settings', { system: true, panels: 'all' }); const r = await api('POST', '/api/backups/run');
    const v = await api('POST', '/api/backups/verify', { name: r.data.name }); assert.equal(v.status, 200); assert.equal(v.data.users, 2); assert.equal(v.data.panels.length >= 2, true); assert.equal(v.data.keyMatches, true);
    assert.equal((await api('POST', '/api/backups/verify', { name: r.data.name, password: 'wrong wrong' })).status, 400);
    assert.equal((await api('POST', '/api/backups/verify', { name: 'nope.eabak' })).status, 400);
    globalThis.__bak = r.data.name;
  });
  test('восстановление: готовит файлы и перезапускает; при старте база подменяется, прежняя сохраняется; ключ из копии подхватывается', async () => {
    const name = globalThis.__bak; assert.equal((await api('POST', '/api/backups/restore', { name })).status, 400, 'нужно подтверждение');
    restarted = 0; const r = await api('POST', '/api/backups/restore', { name, confirm: true }); assert.equal(r.status, 200); assert.equal(r.data.restarting, true);
    await new Promise((r2) => setTimeout(r2, 900)); assert.equal(restarted, 1);
    assert.ok(fs.existsSync(path.join(tmp, 'restore-pending', 'easyadmin.db')));
    // имитация нового запуска на другом каталоге с другим ключом
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-new-')); const k2 = loadKey(dir2, '');
    const d2 = openDb(dir2); d2.prepare("INSERT INTO settings (k, v) VALUES ('marker', 'old')").run(); d2.close();
    fs.cpSync(path.join(tmp, 'restore-pending'), path.join(dir2, 'restore-pending'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'restore-pending', 'secret.key'), key.toString('hex'));
    const saved = applyPendingRestore(dir2); assert.ok(saved && fs.existsSync(path.join(saved, 'easyadmin.db')) && fs.existsSync(path.join(saved, 'secret.key')));
    const db3 = openDb(dir2); assert.equal(db3.prepare('SELECT COUNT(*) n FROM users').get().n, 2); assert.equal(db3.prepare("SELECT COUNT(*) n FROM settings WHERE k = 'marker'").get().n, 0); db3.close();
    assert.ok(loadKey(dir2, '').equals(key) && !loadKey(dir2, '').equals(k2), 'ключ приложения заменён ключом из копии');
    assert.equal(applyPendingRestore(dir2), null, 'повторно ничего не делает'); fs.rmSync(dir2, { recursive: true, force: true });
    fs.rmSync(path.join(tmp, 'restore-pending'), { recursive: true, force: true });
  });
  test('конфигурация панели из копии: скачивание и возврат одного сервиса на панель', async () => {
    const files = (await api('GET', '/api/backups')).data.files; const name = files[0].name;
    const v = (await api('POST', '/api/backups/verify', { name })).data; const alpha = v.panels.find((p) => p.name === 'Альфа'); assert.ok(alpha.services >= 1);
    const cfg = await api('POST', '/api/backups/panel-config', { name, panel: alpha.id }); assert.equal(cfg.status, 200); assert.equal(cfg.data.projects[0].services[0].name, 'site');
    assert.equal((await api('POST', '/api/backups/panel-config', { name, panel: 9999 })).status, 400);
    const pid = await addPanel('Новая', {}); // пустая панель — сюда возвращаем сервис
    const r = await api('POST', '/api/backups/restore-service', { name, panel: alpha.id, project: 'web', service: 'site', targetPanelId: pid, targetProject: 'restored', targetName: 'site2' });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.ok, true);
    const again = await api('POST', '/api/backups/restore-service', { name, panel: alpha.id, project: 'web', service: 'site', targetPanelId: pid, targetProject: 'restored', targetName: 'site2' }); assert.equal(again.status, 400, 'уже есть — не перезаписываем');
    assert.equal((await api('POST', '/api/backups/restore-service', { name, panel: alpha.id, project: 'web', service: 'nope', targetPanelId: pid })).status, 400);
    assert.equal((await api('POST', '/api/backups/restore-service', { name, panel: alpha.id, project: 'web', service: 'site', targetPanelId: pid, targetName: 'Bad Name' })).status, 400);
  });
  test('оператор не имеет доступа', async () => {
    const saved = cookie; cookie = ''; await api('POST', '/api/login', { username: 'op', password: 'password1' });
    for (const [m, p] of [['GET', '/api/backups'], ['PUT', '/api/backups/settings'], ['POST', '/api/backups/run'], ['GET', '/api/backups/download?name=x'], ['POST', '/api/backups/verify'], ['POST', '/api/backups/restore'], ['POST', '/api/backups/panel-config'], ['POST', '/api/backups/restore-service']]) assert.equal((await api(m, p, m === 'GET' ? undefined : {})).status, 403, `${m} ${p}`);
    cookie = saved;
  });
});
