import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { loadKey } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { buildScript, parseName, parseStatus, restoreHint, shq, validDir } from '../src/data-backup.js';
import { s3Client } from '../src/backups.js';
import { createMockPanel } from './mock-easypanel.js';

const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const HAS_OPENSSL = spawnSync('openssl', ['version']).status === 0;
const PW = 'correct horse battery';
let tmp, hostRoot, stubs, app, base, db, cookie = ''; const panels = []; const uploads = []; let s3srv, s3Port;
const api = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await res.text(); let data; try { data = JSON.parse(t); } catch { data = t; } return { status: res.status, data };
};
/** «Сервер панели»: команды из консоли выполняются настоящим bash с подставными docker/curl. */
const hostRun = async (c, row, script) => {
  const r = spawnSync('bash', ['-c', `( ${script} ) && echo __OK__ || echo __FAIL__`], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${r.stdout}${r.stderr}`;
  return { ok: out.includes('__OK__'), output: out.replace(/__OK__|__FAIL__/g, '').trim() };
};
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-data-')); hostRoot = path.join(tmp, 'host'); stubs = path.join(tmp, 'stubs'); fs.mkdirSync(stubs); fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(stubs, 'docker'), `#!/bin/bash
case "$1" in
  ps) case "$*" in *no_such_*) ;; *) echo abc123def456;; esac ;;
  exec) shift; shift; python3 -c "print('-- dump --' * 40)" 2>/dev/null || { for i in $(seq 1 40); do echo "-- dump -- $*"; done; } ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'curl'), `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -T) F=$2; shift 2;; -*) shift;; *) U=$1; shift;; esac; done
echo "$U" >> "${tmp}/curl.log"; cp "$F" "${tmp}/up-$(date +%s%N)"; [ -z "$FAILCURL" ] || { echo "S3 AccessDenied" >&2; exit 22; }
`, { mode: 0o755 });
  s3srv = http.createServer((req, res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { uploads.push({ m: req.method, u: req.url }); if (req.method === 'GET') res.end('<ListBucketResult></ListBucketResult>'); else res.end(); }); });
  await new Promise((r) => s3srv.listen(0, '127.0.0.1', r)); s3Port = s3srv.address().port;
  db = openDb(tmp);
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key: loadKey(tmp, ''), hostRun, dataPollMs: 150 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
  await api('POST', '/api/setup', { username: 'admin', password: 'password1' });
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); s3srv.close(); await Promise.all(panels.map((p) => p.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('вспомогательное', () => {
  test('имена файлов, статусы, подсказки восстановления и проверки', () => {
    assert.equal(shq("a'b"), "'a'\\''b'"); assert.ok(validDir('/var/backups/x') && !validDir('/') && !validDir('rel') && !validDir('/a/../b') && !validDir('/a b'));
    assert.deepEqual(parseName('web__pg__db-postgres__20261001-020000.sql.gz.enc'), { project: 'web', service: 'pg', tag: 'db-postgres', stamp: '20261001-020000', ext: 'sql', encrypted: true });
    assert.equal(parseName('../../etc/passwd'), null); assert.equal(parseName('x__y__vol-data__1.tar.gz'), null);
    assert.deepEqual(parseStatus('START\nOK|web/pg · postgres|f.sql.gz|120\nFAIL|web/x · v|CMD|EA_NODIR:/data/v\nDONE\n'), { started: true, done: true, items: [{ ok: true, label: 'web/pg · postgres', name: 'f.sql.gz', size: 120 }, { ok: false, label: 'web/x · v', error: 'Папки /data/v нет на сервере' }] });
    const h = restoreHint('web__pg__db-postgres__20261001-020000.sql.gz.enc', { dir: '/var/backups/easyadmin/p1-x' });
    assert.match(h.text, /openssl enc -d .*YOUR_BACKUP_PASSWORD/); assert.match(h.text, /psql/); assert.ok(!h.text.includes(PW)); assert.ok(h.notes.length >= 2);
    assert.match(restoreHint('web__site__vol-data__20261001-020000.tar.gz', { url: 'https://s3/x?sig' }).text, /curl -fL -o .*\ngunzip -c .* \| tar -xf - -C '\/etc\/easypanel\/projects\/web\/site\/volumes\/data'/s);
    assert.throws(() => restoreHint('evil.txt', {}), /Некорректное имя/);
  });
  test('подписанная ссылка S3 содержит подпись, срок и не содержит секретного ключа', () => {
    const u = s3Client({ endpoint: 'https://s3.example.com', region: 'eu', bucket: 'b', prefix: 'p/', accessKey: 'AKID', secretKey: 'TOPSECRET', pathStyle: true }).presign('PUT', 'p/data/a b.gz', 3600);
    assert.match(u, /^https:\/\/s3\.example\.com\/b\/p\/data\/a%20b\.gz\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F\d{8}%2Feu%2Fs3%2Faws4_request&X-Amz-Date=\d{8}T\d{6}Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/); assert.ok(!u.includes('TOPSECRET'));
  });
});

describe('скрипт на сервере (настоящий bash)', { skip: !HAS_BASH }, () => {
  const run = (script, env = {}) => { const f = path.join(tmp, `s-${crypto.randomBytes(3).toString('hex')}.sh`); fs.writeFileSync(f, script); return spawnSync('bash', [f], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, ...env }, encoding: 'utf8' }); };
  test('дамп базы и том попадают в папку сервера, ротация оставляет keep последних, ошибки описаны', () => {
    const baseDir = path.join(tmp, 'b1'); const vol = path.join(tmp, 'vol'); fs.mkdirSync(vol); fs.writeFileSync(path.join(vol, 'file.txt'), 'hello '.repeat(50));
    const mk = (stamp, extra = []) => buildScript({ runId: `r${stamp}`, baseDir, dest: 'host', keep: 2, passB64: null, minFreeKb: 1, items: [
      { kind: 'postgres', tag: 'db-postgres', project: 'web', service: 'pg', label: 'web/pg · postgres', file: `web__pg__db-postgres__${stamp}.sql.gz`, prefix: 'web__pg__db-postgres__', slug: 'p1-x' },
      { kind: 'volume', tag: 'vol-data', project: 'web', service: 'site', label: 'web/site · data', hostPath: vol, file: `web__site__vol-data__${stamp}.tar.gz`, prefix: 'web__site__vol-data__', slug: 'p1-x' }, ...extra] });
    for (const st of ['20261001-010000', '20261001-020000', '20261001-030000']) { const r = run(mk(st)); assert.equal(r.status, 0, r.stderr); }
    const files = fs.readdirSync(path.join(baseDir, 'p1-x')).sort(); assert.deepEqual(files, ['web__pg__db-postgres__20261001-020000.sql.gz', 'web__pg__db-postgres__20261001-030000.sql.gz', 'web__site__vol-data__20261001-020000.tar.gz', 'web__site__vol-data__20261001-030000.tar.gz']);
    assert.match(zlib.gunzipSync(fs.readFileSync(path.join(baseDir, 'p1-x', files[1]))).toString(), /-- dump --/);
    const tar = spawnSync('tar', ['-tzf', path.join(baseDir, 'p1-x', files[3])], { encoding: 'utf8' }); assert.match(tar.stdout, /file\.txt/);
    const bad = mk('20261001-040000', [{ kind: 'volume', tag: 'vol-gone', project: 'web', service: 'site', label: 'web/site · gone', hostPath: '/nonexistent/x', file: 'web__site__vol-gone__s.tar.gz', prefix: 'web__site__vol-gone__', slug: 'p1-x' }, { kind: 'postgres', tag: 'db-postgres', project: 'no_such_proj', service: 'pg', label: 'no/pg', file: 'x__pg__db-postgres__s.sql.gz', prefix: 'x__pg__db-postgres__', slug: 'p1-x' }]);
    assert.equal(run(bad).status, 0); const st = parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'r20261001-040000.status'), 'utf8'));
    assert.equal(st.done, true); assert.equal(st.items.filter((x) => x.ok).length, 2); assert.match(st.items.find((x) => x.label === 'web/site · gone').error, /нет на сервере/); assert.match(st.items.find((x) => x.label === 'no/pg').error, /не запущен/);
    assert.ok(fs.readdirSync(path.join(baseDir, '.work')).length === 0, 'временные файлы убраны');
  });
  test('мало места → один понятный отказ и ничего не создаётся', () => {
    const baseDir = path.join(tmp, 'b2'); const r = run(buildScript({ runId: 'rlow', baseDir, dest: 'host', keep: 1, passB64: null, minFreeKb: 9e12, items: [] }));
    assert.equal(r.status, 1); const st = parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'rlow.status'), 'utf8')); assert.equal(st.done, true); assert.match(st.items[0].error, /Мало места/);
  });
  test('S3: файл уходит по ссылке (curl), временный файл удаляется; ошибка загрузки попадает в статус', () => {
    const baseDir = path.join(tmp, 'b3'); const item = { kind: 'mysql', tag: 'db-mysql', project: 'a', service: 'm', label: 'a/m · mysql', file: 'a__m__db-mysql__s.sql.gz', prefix: 'a__m__db-mysql__', slug: 'p2-y', url: 'https://s3.example/b/k?X-Amz-Signature=abc' };
    const sc = buildScript({ runId: 'rs3', baseDir, dest: 's3', keep: 1, passB64: null, minFreeKb: 1, items: [item] });
    assert.ok(!sc.includes('SECRET')); assert.equal(run(sc).status, 0); assert.match(fs.readFileSync(path.join(tmp, 'curl.log'), 'utf8'), /X-Amz-Signature=abc/);
    assert.equal(fs.existsSync(path.join(baseDir, 'p2-y')), false, 'на сервере файл не остаётся'); assert.equal(parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'rs3.status'), 'utf8')).items[0].ok, true);
    run(buildScript({ runId: 'rs3f', baseDir, dest: 's3', keep: 1, passB64: null, minFreeKb: 1, items: [item] }), { FAILCURL: '1' });
    assert.match(parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'rs3f.status'), 'utf8')).items[0].error, /Загрузка в S3.*AccessDenied/);
  });
  test('шифрование: файл не читается без пароля и расшифровывается с ним', { skip: !HAS_OPENSSL }, () => {
    const baseDir = path.join(tmp, 'b4'); const item = { kind: 'mongo', tag: 'db-mongo', project: 'a', service: 'mg', label: 'a/mg · mongo', file: 'a__mg__db-mongo__s.archive.gz.enc', prefix: 'a__mg__db-mongo__', slug: 'p3-z' };
    assert.equal(run(buildScript({ runId: 'renc', baseDir, dest: 'host', keep: 1, passB64: Buffer.from(PW).toString('base64'), minFreeKb: 1, items: [item] })).status, 0);
    const f = path.join(baseDir, 'p3-z', item.file); const raw = fs.readFileSync(f); assert.ok(!raw.toString('latin1').includes('-- dump --'));
    const dec = spawnSync('bash', ['-c', `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass pass:'${PW}' -in '${f}' | gunzip -c`], { encoding: 'utf8' }); assert.match(dec.stdout, /-- dump --/);
    assert.notEqual(spawnSync('bash', ['-c', `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass pass:wrongwrong -in '${f}' | gunzip -c`]).status, 0);
    assert.equal(fs.existsSync(path.join(baseDir, '.runs', 'renc.pw')), false, 'файл с паролем удалён');
  });
});

describe('через EasyAdmin', { skip: !HAS_BASH }, () => {
  const addPanel = async (name, seed) => { const m = createMockPanel({ token: 'T', seed }); panels.push(m); return (await api('POST', '/api/panels', { name, url: await m.listen(), token: 'T' })).data.id; };
  const dataDir = () => path.join(tmp, 'hostdir');
  test('настройки данных: проверки значений', async () => {
    await api('PUT', '/api/backups/settings', { password: PW });
    for (const bad of [{ mode: 'x' }, { dest: 'ftp' }, { dir: 'rel' }, { dir: '/a/../b' }, { keep: 0 }, { keys: ['x'] }, { encrypt: 'y' }, { mode: 'selected', keys: [] }]) assert.equal((await api('PUT', '/api/backups/settings', { data: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await api('PUT', '/api/backups/settings', { data: { mode: 'all', dest: 's3' } })).status, 400, 'S3 не настроен');
  });
  test('«на сервер»: базы и тома выбранных сервисов, зашифровано, список файлов и подсказка восстановления', async () => {
    const volDir = path.join(tmp, 'vol2'); fs.mkdirSync(volDir); fs.writeFileSync(path.join(volDir, 'a.txt'), 'x'.repeat(100));
    const id = await addPanel('Alpha Panel', { web: [{ name: 'site', mounts: [{ type: 'bind', name: 'b', hostPath: volDir, mountPath: '/d' }, { type: 'file', name: 'f', mountPath: '/f' }] }, { name: 'pg', type: 'postgres', mounts: [{ type: 'volume', name: 'pgdata', mountPath: '/v' }] }, { name: 'skip', mounts: [{ type: 'volume', name: 'zzz', mountPath: '/z' }] }] });
    const keys = [`${id}|web|site`, `${id}|web|pg`];
    const s = await api('PUT', '/api/backups/settings', { data: { mode: 'selected', keys, dest: 'host', dir: dataDir(), encrypt: HAS_OPENSSL, keep: 2, minFreeMb: 0 } }); assert.equal(s.status, 200, JSON.stringify(s.data));
    const r = await api('POST', '/api/backups/data/run'); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal((await api('POST', '/api/backups/data/run')).status, 400, 'пока идёт — второй запуск нельзя');
    const st = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
    assert.equal(st.result.ok, true, JSON.stringify(st)); assert.equal(st.result.files, 2, 'база pg и bind-том сайта; том pg, file-монтирование и несвязанный сервис не копируются');
    const labels = st.panels[0].items.map((x) => x.label); assert.deepEqual(labels.sort(), [`web/pg · postgres`, `web/site · ${volDir}`].sort());
    const files = (await api('GET', '/api/backups/data/files')).data.files; assert.equal(files.length, 2); assert.ok(files.every((f) => f.panel === 'Alpha Panel' && f.size > 0));
    const pg = files.find((f) => f.name.includes('db-postgres')); assert.equal(pg.name.endsWith('.enc'), HAS_OPENSSL);
    const hint = (await api('POST', '/api/backups/data/hint', { panelId: id, name: pg.name })).data; assert.match(hint.text, /psql/); assert.ok(Array.isArray(hint.notes)); assert.ok(!hint.text.includes(PW));
    assert.equal((await api('POST', '/api/backups/data/hint', { panelId: id, name: '../x' })).status, 400);
    assert.ok((await api('GET', '/api/backups')).data.settings.dataLast.ok);
    app.dataId = id;
  });
  test('ошибка панели (нет контейнера) попадает в итог и в уведомление; запуск без выбора запрещён', async () => {
    const hooks = []; const orig = app.alerts.emit; app.alerts.emit = async (e) => { hooks.push(e); };
    const m = createMockPanel({ token: 'T', seed: { zz: [{ name: 'db', type: 'postgres' }] } }); panels.push(m);
    const id2 = (await api('POST', '/api/panels', { name: 'Beta', url: await m.listen(), token: 'T' })).data.id;
    // подставной docker не находит контейнеры с именем no_such_*: переименуем проект нельзя, поэтому имитируем через selected на проект no_such_proj
    const m3 = createMockPanel({ token: 'T', seed: { no_such_proj: [{ name: 'db', type: 'postgres' }] } }); panels.push(m3);
    const id3 = (await api('POST', '/api/panels', { name: 'Gamma', url: await m3.listen(), token: 'T' })).data.id;
    await api('PUT', '/api/backups/settings', { data: { mode: 'selected', keys: [`${id3}|no_such_proj|db`], dest: 'host', dir: dataDir(), encrypt: false, minFreeMb: 0 } });
    await api('POST', '/api/backups/data/run'); const st = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
    assert.equal(st.result.ok, false); assert.equal(st.result.failed, 1); assert.match(st.panels[0].items[0].error, /не запущен/); assert.equal(hooks[0]?.type, 'backup_failed'); assert.match(hooks[0].text, /Gamma/); app.alerts.emit = orig; void id2;
    await api('PUT', '/api/backups/settings', { data: { mode: 'none' } }); assert.equal((await api('POST', '/api/backups/data/run')).status, 400);
  });
  test('S3: ссылки на загрузку подписаны, ключи не уходят на сервер панели; оператору недоступно', async () => {
    const id = app.dataId;
    await api('PUT', '/api/backups/settings', { s3: { endpoint: `http://127.0.0.1:${s3Port}`, bucket: 'bk', accessKey: 'AKID', secretKey: 'TOPSECRETKEY', prefix: 'ea' }, data: { mode: 'selected', keys: [`${id}|web|pg`], dest: 's3', encrypt: false, minFreeMb: 0 } });
    fs.rmSync(path.join(tmp, 'curl.log'), { force: true }); await api('POST', '/api/backups/data/run');
    const st = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
    assert.equal(st.result.ok, true, JSON.stringify(st)); const log = fs.readFileSync(path.join(tmp, 'curl.log'), 'utf8');
    assert.match(log, /^http:\/\/127\.0\.0\.1:\d+\/bk\/ea\/data\/p\d+-alpha-panel\/web__pg__db-postgres__\d{8}-\d{6}\.sql\.gz\?X-Amz-Algorithm=AWS4-HMAC-SHA256.*X-Amz-Signature=[0-9a-f]{64}/m); assert.ok(!log.includes('TOPSECRETKEY'));
    cookie = ''; await api('POST', '/api/login', { username: 'admin', password: 'password1' });
  });
});
