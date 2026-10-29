import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { encrypt, sha256 } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { STEPS } from '../src/migration.js';
import { createMockPanel } from './mock-easypanel.js';

const EXT_URL = 'https://admin.example.com';
let app, base, tmp, panel, db, key, cookie = ''; let panelId;
const api = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, type: res.headers.get('content-type') };
};
// запросы «с нового сервера»: без входа и без заголовка CSRF
const anon = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, type: res.headers.get('content-type') };
};
/** Задание в состоянии «слепок готов» — так, как его оставляет успешный слепок на сервере-источнике. */
function seedReady(kind = 'oneliner', over = {}) {
  const id = crypto.randomBytes(8).toString('hex'); const token = crypto.randomBytes(24).toString('base64url'); const utoken = crypto.randomBytes(24).toString('base64url');
  const j = { id, kind, status: 'ready', panelId, panelName: 'Source', host: null, username: 'admin', steps: STEPS.map(([sid, label]) => ({ id: sid, label, status: sid === 'connect' ? 'skipped' : 'pending', detail: null })), log: [], warnings: [], error: null, createdAt: Date.now(), finishedAt: null, expiresAt: Date.now() + 3600_000, size: 10, encrypted: false, baseUrl: EXT_URL, newPanelId: null, includeData: true, sha: null, uploaded: false, ...over };
  db.prepare('INSERT INTO migrations (id, ts, status, token_hash, upload_hash, token_enc, data) VALUES (?,?,?,?,?,?,?)').run(id, j.createdAt, j.status, sha256(token), sha256(utoken), encrypt(key, JSON.stringify([token, utoken])), JSON.stringify(j));
  return { id, token, utoken };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-mig-'));
  panel = createMockPanel({ token: 'T', seed: {} }); const url = await panel.listen();
  db = openDb(tmp); key = crypto.randomBytes(32);
  // слепок на «сервере»: консоль возвращает ошибку — задание завершается ошибкой, токены гасятся
  const hostRun = async () => ({ ok: false, output: 'нет доступа к консоли' });
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key, hostRun, dataPollMs: 20 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
  await api('POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  panelId = (await api('POST', '/api/panels', { name: 'Source', url, token: 'T' })).data.id;
  assert.ok(panelId, 'панель-источник добавлена');
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await panel.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('слепок («одной командой»)', () => {
  test('без панели и с localhost-адресом — отказ', async () => {
    assert.equal((await api('POST', '/api/migration/snapshot', { baseUrl: 'https://admin.example.com' })).status, 400);
    const r = await api('POST', '/api/migration/snapshot', { panelId, baseUrl: 'http://localhost:3000' });
    assert.equal(r.status, 400); assert.match(r.data.error, /внешний адрес/i);
    assert.equal((await api('POST', '/api/migration/snapshot', { panelId, baseUrl: 'https://admin.example.com', consistency: 'bogus' })).status, 400);
  });
  test('создаёт задание; при сбое слепка ссылки гасятся, ход виден через GET /api/migration/:id', async () => {
    const r = await api('POST', '/api/migration/snapshot', { panelId, baseUrl: 'https://admin.example.com/' });
    assert.equal(r.status, 200); assert.match(r.data.id, /^[0-9a-f]{16}$/);
    let j; for (let i = 0; i < 100; i++) { j = (await api('GET', `/api/migration/${r.data.id}`)).data; if (j.status !== 'snapshot') break; await new Promise((x) => setTimeout(x, 50)); }
    assert.equal(j.status, 'error'); assert.equal(j.kind, 'oneliner'); assert.equal(j.baseUrl, 'https://admin.example.com');
    assert.equal(j.command, null); assert.deepEqual(j.steps.map((s) => s.id), STEPS.map(([id]) => id));
    assert.equal(j.steps.find((s) => s.id === 'connect').status, 'skipped'); assert.equal(j.steps.find((s) => s.id === 'snapshot').status, 'error');
    assert.ok(!JSON.stringify(j).match(/token/i), 'токены не попадают в ответ');
  });
  test('готовый слепок отдаёт команду curl …/bootstrap.sh?token=… | bash', async () => {
    const s = seedReady();
    const j = (await api('GET', `/api/migration/${s.id}`)).data;
    assert.equal(j.status, 'ready'); assert.equal(j.command, `curl -sSL ${EXT_URL}/api/migration/bootstrap.sh?token=${s.token} | bash`);
    const list = (await api('GET', '/api/migration')).data;
    assert.ok(list.jobs.some((x) => x.id === s.id)); assert.equal(typeof list.defaults.maxGb, 'number');
    assert.equal((await api('DELETE', `/api/migration/${s.id}`)).status, 200);
    assert.equal((await api('GET', `/api/migration/${s.id}`)).data.status, 'aborted');
    assert.equal((await anon('GET', `/api/migration/bootstrap.sh?token=${s.token}`)).status, 404, 'после удаления ссылка не работает');
  });
  test('управление только для администратора', async () => {
    const saved = cookie; cookie = '';
    await api('POST', '/api/login', { username: 'op', password: 'password1' });
    for (const [m, p, b] of [['GET', '/api/migration'], ['POST', '/api/migration/snapshot', { panelId }], ['POST', '/api/migration/ssh/scan', { host: '203.0.113.5' }], ['POST', '/api/migration/ssh', {}]]) assert.equal((await api(m, p, b)).status, 403, `${m} ${p}`);
    cookie = saved;
  });
});

describe('/api/migration/bootstrap.sh', () => {
  test('отдаёт bash-скрипт с адресом и токеном, без входа', async () => {
    const s = seedReady();
    const r = await anon('GET', `/api/migration/bootstrap.sh?token=${s.token}`);
    assert.equal(r.status, 200); assert.match(r.type, /text\/x-shellscript/); assert.match(r.data, /^#!.*(ba)?sh/);
    assert.ok(r.data.includes(EXT_URL)); assert.ok(r.data.includes(s.token));
    assert.ok(!r.data.includes(s.utoken), 'токен загрузки слепка не попадает на новый сервер');
  });
  test('чужой, короткий, пустой токен и токен загрузки — 404', async () => {
    const s = seedReady();
    for (const tk of ['', 'short', 'x'.repeat(32), "a'; rm -rf /; '".padEnd(30, 'a'), s.utoken]) assert.equal((await anon('GET', `/api/migration/bootstrap.sh?token=${encodeURIComponent(tk)}`)).status, 404, tk);
  });
  test('просроченный слепок и слепок в процессе создания — 404', async () => {
    const old = seedReady('oneliner', { expiresAt: Date.now() - 1000 });
    assert.equal((await anon('GET', `/api/migration/bootstrap.sh?token=${old.token}`)).status, 404);
    const busy = seedReady('oneliner', { status: 'snapshot' });
    assert.equal((await anon('GET', `/api/migration/bootstrap.sh?token=${busy.token}`)).status, 404);
  });
});

describe('переезд по SSH: проверка данных', () => {
  const good = { host: '203.0.113.50', port: 22, user: 'root', fingerprint: 'SHA256:x', auth: { password: 'pw' }, panelId: 0, baseUrl: 'https://admin.example.com' };
  test('адрес сервера и порт', async () => {
    for (const b of [{}, { host: '' }, { host: 'bad host!' }, { host: '203.0.113.50', port: 99999 }, { host: '127.0.0.1' }]) assert.equal((await api('POST', '/api/migration/ssh/scan', b)).status, 400, JSON.stringify(b));
  });
  test('пользователь, способ входа, панель, адрес EasyAdmin', async () => {
    const send = (over) => api('POST', '/api/migration/ssh', { ...good, panelId, ...over });
    const bad = { user: "root; reboot" }; assert.equal((await send(bad)).status, 400);
    const noAuth = await send({ auth: {} }); assert.equal(noAuth.status, 400); assert.match(noAuth.data.error, /пароль или приватный ключ/i);
    assert.equal((await send({ host: '' })).status, 400);
    const noPanel = await send({ panelId: 99999 }); assert.equal(noPanel.status, 400); assert.match(noPanel.data.error, /панель/i);
    const local = await send({ baseUrl: 'http://localhost' }); assert.equal(local.status, 400);
    assert.equal((await send({ consistency: 'x' })).status, 400);
  });
  test('GET /api/migration/:id: неизвестный номер — 404', async () => {
    assert.equal((await api('GET', '/api/migration/nope')).status, 404);
    assert.equal((await api('DELETE', '/api/migration/nope')).status, 404);
  });
});

describe('/api/migration/report', () => {
  const report = (s, b) => anon('POST', `/api/migration/report?token=${s.token}`, b);
  test('без токена и с неверным токеном — 404', async () => {
    assert.equal((await anon('POST', '/api/migration/report', { step: 'log', status: 'info', detail: 'x' })).status, 404);
    assert.equal((await anon('POST', `/api/migration/report?token=${'z'.repeat(32)}`, { step: 'log', status: 'info', detail: 'x' })).status, 404);
  });
  test('принимает шаги и журнал; первый отчёт переводит задание в «идёт»', async () => {
    const s = seedReady();
    assert.equal((await report(s, { step: 'transfer', status: 'running', detail: 'Скачиваю' })).status, 200);
    let j = (await api('GET', `/api/migration/${s.id}`)).data;
    assert.equal(j.status, 'running'); assert.equal(j.steps.find((x) => x.id === 'transfer').status, 'running'); assert.equal(j.steps.find((x) => x.id === 'transfer').detail, 'Скачиваю');
    assert.equal((await report(s, { step: 'log', status: 'info', detail: 'строка 1\nстрока 2' })).status, 200);
    assert.equal((await report(s, { step: 'transfer', status: 'ok', detail: '10 МБ' })).status, 200);
    j = (await api('GET', `/api/migration/${s.id}`)).data;
    assert.deepEqual(j.log.slice(0, 2), ['строка 1', 'строка 2']); assert.equal(j.steps.find((x) => x.id === 'unpack_and_start').status, 'running');
    assert.ok(j.command, 'пока идёт — команда ещё видна');
  });
  test('некорректные шаг и статус отклоняются', async () => {
    const s = seedReady();
    assert.equal((await report(s, { step: 'format_disk', status: 'ok' })).status, 400);
    assert.equal((await report(s, { step: 'transfer', status: 'weird' })).status, 400);
  });
  test('ошибка шага завершает задание; повторный отчёт и скрипт недоступны', async () => {
    const s = seedReady();
    assert.equal((await report(s, { step: 'unpack_and_start', status: 'error', detail: 'tar: нет места' })).status, 200);
    const j = (await api('GET', `/api/migration/${s.id}`)).data;
    assert.equal(j.status, 'error'); assert.equal(j.error, 'tar: нет места'); assert.equal(j.command, null);
    assert.equal((await report(s, { step: 'log', status: 'info', detail: 'поздно' })).status, 404);
    assert.equal((await anon('GET', `/api/migration/bootstrap.sh?token=${s.token}`)).status, 404);
  });
  test('«done» завершает слепок «одной командой» и гасит ссылки', async () => {
    const s = seedReady();
    assert.equal((await report(s, { step: 'done', status: 'ok', detail: 'http://203.0.113.9:3000' })).status, 200);
    const j = (await api('GET', `/api/migration/${s.id}`)).data;
    assert.equal(j.status, 'done'); assert.ok(j.steps.every((x) => ['ok', 'skipped'].includes(x.status))); assert.equal(j.command, null);
    assert.equal((await anon('GET', `/api/migration/bootstrap.sh?token=${s.token}`)).status, 404);
  });
});

describe('загрузка и выдача слепка', () => {
  test('без токена загрузки слепок не принимается и не отдаётся', async () => {
    const s = seedReady('oneliner', { status: 'snapshot' });
    assert.equal((await anon('GET', `/api/migration/snapshot?token=${s.token}`)).status, 404, 'файла ещё нет');
    const put = (tk) => fetch(`${base}/api/migration/upload?token=${tk}`, { method: 'PUT', body: 'data' });
    assert.equal((await put(s.token)).status, 404, 'токен скрипта не годится для загрузки');
    assert.equal((await put('y'.repeat(32))).status, 404);
  });
});
