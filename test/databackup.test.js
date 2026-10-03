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

const F = (p, sv) => `--filter 'name=^${p}_${sv}\\.'`;
// часть (база или том) и задание «один сервис — один архив», как их собирает resolveTargets
const EXT = { postgres: 'sql', mysql: 'sql', mariadb: 'sql', mongo: 'archive', redis: 'rdb', volume: 'tar' };
const P = (o) => ({ member: `${o.tag}.${EXT[o.kind]}.gz`, slug: 'p1-x', ...o });
const J = (project, service, parts, stamp = 's', extra = {}) => ({ project, service, label: `${project}/${service}`, slug: parts[0].slug ?? 'p1-x', prefix: `${project}__${service}__`, file: `${project}__${service}__${stamp}.tar`, parts: parts.map(P), ...extra });
const tarList = (f) => spawnSync('tar', ['-tf', f], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
const tarMember = (f, m) => spawnSync('tar', ['-xOf', f, m], { encoding: 'buffer' }).stdout;
// зашифрованный паролем копий архив (.tar.enc): расшифровка openssl, как в подсказке восстановления
const decrypt = (f, pw = PW) => spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '100000', '-pass', `pass:${pw}`, '-in', f], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const encList = (f, pw) => spawnSync('tar', ['-tf', '-'], { input: decrypt(f, pw).stdout, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
const encMember = (f, m, pw) => spawnSync('tar', ['-xOf', '-', m], { input: decrypt(f, pw).stdout, encoding: 'buffer' }).stdout;
const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const PW = 'correct horse battery';
let tmp, hostRoot, stubs, state, app, base, db, cookie = ''; const panels = []; const uploads = []; let s3srv, s3Port; const s3Objects = new Map(); const aborted = [];
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
  state = path.join(tmp, 'state'); fs.mkdirSync(state); process.env.EA_STATE = state;
  fs.writeFileSync(path.join(stubs, 'docker'), `#!/bin/bash
S="$EA_STATE"; echo "docker $*" >> "$S/docker.log"
case "$1" in
  ps) if [[ "$*" == *"--format"* ]]; then cat "$S/disc.txt" 2>/dev/null; exit 0; fi
      case "$*" in *no_such_*) ;; *) [ -f "$S/scaled0" ] || echo abc123def456;; esac ;;
  inspect) for last; do :; done; cat "$S/mounts-$last" 2>/dev/null ;;
  service) case "$2" in inspect) echo 1;; scale) case "$*" in *=0) touch "$S/scaled0";; *) rm -f "$S/scaled0";; esac;; esac ;;
  pause|unpause|stop|start) ;;
  exec) shift; shift; for i in $(seq 1 40); do echo "-- dump -- $*"; done ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'systemd-run'), '#!/bin/bash\nexit 1\n', { mode: 0o755 }); // как на CI-раннере: systemd-run есть, но не работает
  fs.writeFileSync(path.join(stubs, 'curl'), `#!/bin/bash
[ -z "$EA_REALCURL" ] || exec /usr/bin/curl "$@"
while [ $# -gt 0 ]; do case "$1" in -T) F=$2; shift 2;; -*) shift;; *) U=$1; shift;; esac; done
echo "$U" >> "${tmp}/curl.log"; cp "$F" "${tmp}/up-$(date +%s%N)"; [ -z "$FAILCURL" ] || { echo "S3 AccessDenied" >&2; exit 22; }
`, { mode: 0o755 });
  const mp = new Map(); // uploadId → { key, parts: Map }
  s3srv = http.createServer((req, res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const body = Buffer.concat(ch); uploads.push({ m: req.method, u: req.url });
    const up = u.searchParams.get('uploadId'); const key = decodeURIComponent(u.pathname);
    if (req.method === 'POST' && u.searchParams.has('uploads')) { mp.set('U1', { key, parts: new Map() }); return res.end('<InitiateMultipartUploadResult><UploadId>U1</UploadId></InitiateMultipartUploadResult>'); }
    if (req.method === 'PUT' && up && u.searchParams.get('partNumber')) { const et = `"${crypto.createHash('md5').update(body).digest('hex')}"`; mp.get(up).parts.set(Number(u.searchParams.get('partNumber')), body); res.setHeader('ETag', et); return res.end(); }
    if (req.method === 'POST' && up) { const o = mp.get(up); const nums = [...String(body).matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1])); s3Objects.set(o.key, Buffer.concat(nums.map((n) => o.parts.get(n)))); mp.delete(up); return res.end('<CompleteMultipartUploadResult/>'); }
    if (req.method === 'DELETE' && up) { mp.delete(up); aborted.push(up); res.writeHead(204); return res.end(); }
    if (req.method === 'PUT') { s3Objects.set(key, body); return res.end(); }
    if (req.method === 'GET' && u.searchParams.get('list-type')) { const pre = `/bk/${u.searchParams.get('prefix')}`; return res.end(`<ListBucketResult>${[...s3Objects].filter(([n]) => n.startsWith(pre)).map(([n, b]) => `<Contents><Key>${n.slice('/bk/'.length)}</Key><Size>${b.length}</Size></Contents>`).join('')}</ListBucketResult>`); }
    res.end(); }); });
  await new Promise((r) => s3srv.listen(0, '127.0.0.1', r)); s3Port = s3srv.address().port;
  db = openDb(tmp);
  app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key: loadKey(tmp, ''), hostRun, dataPollMs: 150, mpMin: 1_000_000, partMb: 1 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
  await api('POST', '/api/setup', { username: 'admin', password: 'password1' });
});
after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); s3srv.close(); await Promise.all(panels.map((p) => p.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('вспомогательное', () => {
  test('имена файлов, статусы, подсказки восстановления и проверки', () => {
    assert.equal(shq("a'b"), "'a'\\''b'"); assert.ok(validDir('/var/backups/x') && !validDir('/') && !validDir('rel') && !validDir('/a/../b') && !validDir('/a b'));
    assert.deepEqual(parseName('web__pg__db-postgres__20261001-020000.sql.gz.enc'), { project: 'web', service: 'pg', tag: 'db-postgres', stamp: '20261001-020000', ext: 'sql', encrypted: true });
    assert.deepEqual(parseName('web__pg__20261001-020000.tar'), { project: 'web', service: 'pg', tag: null, stamp: '20261001-020000', ext: 'tar', encrypted: false, archive: true });
    assert.deepEqual(parseName('web__pg__20261001-020000.tar.enc'), { project: 'web', service: 'pg', tag: null, stamp: '20261001-020000', ext: 'tar', encrypted: true, archive: true });
    assert.equal(parseName('../../etc/passwd'), null); assert.equal(parseName('x__y__vol-data__1.tar.gz'), null); assert.equal(parseName('web__pg__2026.tar'), null);
    assert.deepEqual(parseStatus('START\nOK|web/pg · postgres|f.sql.gz|120\nFAIL|web/x · v|CMD|EA_NODIR:/data/v\nWARN|web/pg · postgres|EA_NODIR:/data/old\nDONE\n'), { started: true, done: true, items: [{ ok: true, label: 'web/pg · postgres', name: 'f.sql.gz', size: 120 }, { ok: false, label: 'web/x · v', error: 'Папки или файла /data/v нет на сервере' }], warns: [{ label: 'web/pg · postgres', text: 'Папки или файла /data/old нет на сервере' }] });
    const h = restoreHint('web__pg__db-postgres__20261001-020000.sql.gz.enc', { dir: '/var/backups/easyadmin/p1-x' });
    assert.match(h.text, /openssl enc -d .*YOUR_BACKUP_PASSWORD/); assert.match(h.text, /psql/); assert.ok(!h.text.includes(PW)); assert.ok(h.notes.length >= 2);
    assert.match(restoreHint('web__site__vol-data__20261001-020000.tar.gz', { url: 'https://s3/x?sig' }).text, /curl -fL -o .*\ngunzip -c .* \| tar -xf - -C '\/etc\/easypanel\/projects\/web\/site\/volumes\/data'/s);
    const ah = restoreHint('web__pg__20261001-020000.tar', { dir: '/var/backups/easyadmin/p1-x' });
    assert.match(ah.text, /^cd '\/var\/backups\/easyadmin\/p1-x'\nmkdir -p restore && tar -xf 'web__pg__20261001-020000\.tar' -C restore/); assert.match(ah.text, /cat RESTORE\.txt/); assert.ok(ah.notes.length >= 2);
    const eh = restoreHint('web__pg__20261001-020000.tar.enc', { dir: '/x' }); assert.match(eh.text, /openssl enc -d .*YOUR_BACKUP_PASSWORD.* \| tar -xf - -C restore/); assert.ok(!eh.text.includes(PW));
    assert.throws(() => restoreHint('evil.txt', {}), /Некорректное имя/);
  });
  test('подписанная ссылка S3 содержит подпись, срок и не содержит секретного ключа', () => {
    const u = s3Client({ endpoint: 'https://s3.example.com', region: 'eu', bucket: 'b', prefix: 'p/', accessKey: 'AKID', secretKey: 'TOPSECRET', pathStyle: true }).presign('PUT', 'p/data/a b.gz', 3600);
    assert.match(u, /^https:\/\/s3\.example\.com\/b\/p\/data\/a%20b\.gz\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F\d{8}%2Feu%2Fs3%2Faws4_request&X-Amz-Date=\d{8}T\d{6}Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/); assert.ok(!u.includes('TOPSECRET'));
  });
});

describe('скрипт на сервере (настоящий bash)', { skip: !HAS_BASH }, () => {
  const run = (script, env = {}) => { const f = path.join(tmp, `s-${crypto.randomBytes(3).toString('hex')}.sh`); fs.writeFileSync(f, script); return spawnSync('bash', [f], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, ...env }, encoding: 'utf8' }); };
  const pgPart = { kind: 'postgres', tag: 'db-postgres', project: 'web', service: 'pg', filter: F('web', 'pg'), label: 'web/pg · postgres' };
  test('один сервис — один архив: дамп базы и том лежат каждый в своём файле внутри, ротация оставляет keep последних, ошибки описаны', () => {
    const baseDir = path.join(tmp, 'b1'); const vol = path.join(tmp, 'vol'); fs.mkdirSync(vol); fs.writeFileSync(path.join(vol, 'file.txt'), 'hello '.repeat(50));
    const volPart = { kind: 'volume', tag: 'vol-data', project: 'web', service: 'site', label: 'web/site · data', hostPath: vol };
    const gone = (service) => ({ kind: 'volume', tag: 'vol-gone', project: 'web', service, label: `web/${service} · gone`, hostPath: '/nonexistent/x' });
    const mk = (stamp, extra = []) => buildScript({ runId: `r${stamp}`, baseDir, dest: 'host', keep: 2, minFreeKb: 1, items: [J('web', 'pg', [pgPart], stamp), J('web', 'site', [volPart], stamp), ...extra] });
    for (const st of ['20261001-010000', '20261001-020000', '20261001-030000']) { const r = run(mk(st)); assert.equal(r.status, 0, r.stderr); }
    const dir = path.join(baseDir, 'p1-x'); const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['web__pg__20261001-020000.tar', 'web__pg__20261001-030000.tar', 'web__site__20261001-020000.tar', 'web__site__20261001-030000.tar'], 'по одному архиву на сервис; старые удалены');
    assert.deepEqual(tarList(path.join(dir, files[1])), ['RESTORE.txt', 'db-postgres.sql.gz']);
    assert.match(zlib.gunzipSync(tarMember(path.join(dir, files[1]), 'db-postgres.sql.gz')).toString(), /-- dump --/);
    assert.match(tarMember(path.join(dir, files[1]), 'RESTORE.txt').toString(), /psql/);
    assert.deepEqual(tarList(path.join(dir, files[3])), ['RESTORE.txt', 'vol-data.tar.gz']);
    const inner = spawnSync('tar', ['-tzf', '-'], { input: tarMember(path.join(dir, files[3]), 'vol-data.tar.gz'), encoding: 'utf8' }); assert.match(inner.stdout, /file\.txt/);
    // сервис без источников и сервис без контейнера: отказ с описанием, остальные не страдают
    const bad = mk('20261001-040000', [J('web', 'gone', [gone('gone')], '20261001-040000'), J('no_such_proj', 'pg', [{ ...pgPart, project: 'no_such_proj', filter: F('no_such_proj', 'pg'), label: 'no/pg' }], '20261001-040000')]);
    assert.equal(run(bad).status, 0); const st = parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'r20261001-040000.status'), 'utf8'));
    assert.equal(st.done, true); assert.equal(st.items.filter((x) => x.ok).length, 2); assert.match(st.items.find((x) => x.label === 'web/gone').error, /нет на сервере/); assert.match(st.items.find((x) => x.label === 'no_such_proj/pg').error, /не запущен/);
    assert.ok(fs.readdirSync(path.join(baseDir, '.work')).length === 0, 'временные файлы и каталоги заданий убраны');
    // часть сервиса пропала (том удалён), но остальное на месте: архив сделан, пропуск записан предупреждением
    const part = buildScript({ runId: 'r20261001-050000', baseDir, dest: 'host', keep: 2, minFreeKb: 1, items: [J('web', 'multi', [volPart, gone('multi')], '20261001-050000')] });
    assert.equal(run(part).status, 0); const ps = parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'r20261001-050000.status'), 'utf8'));
    assert.equal(ps.items.length, 1); assert.equal(ps.items[0].ok, true); assert.deepEqual(ps.warns, [{ label: 'web/multi', text: 'Папки или файла /nonexistent/x нет на сервере' }]);
    assert.deepEqual(tarList(path.join(dir, 'web__multi__20261001-050000.tar')), ['RESTORE.txt', 'vol-data.tar.gz'], 'в архиве нет файла пропавшей части');
  });
  test('bind-монтирование: папка и одиночный файл попадают в архив под своим именем', () => {
    const baseDir = path.join(tmp, 'b1f'); const d = path.join(tmp, 'binddir'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'a.txt'), 'a'.repeat(100)); const file = path.join(d, 'claude.json'); fs.writeFileSync(file, '{"k":1}'.repeat(20));
    const parts = [{ kind: 'volume', bind: true, tag: 'bind-binddir', project: 'main', service: 'code', label: 'dir', hostPath: d }, { kind: 'volume', bind: true, tag: 'bind-claude.json', project: 'main', service: 'code', label: 'file', hostPath: file }];
    assert.equal(run(buildScript({ runId: 'rbind', baseDir, dest: 'host', keep: 1, minFreeKb: 1, items: [J('main', 'code', parts, 's')] })).status, 0);
    const f = path.join(baseDir, 'p1-x', 'main__code__s.tar'); assert.deepEqual(tarList(f), ['RESTORE.txt', 'bind-binddir.tar.gz', 'bind-claude.json.tar.gz']);
    const asFile = spawnSync('tar', ['-tzf', '-'], { input: tarMember(f, 'bind-claude.json.tar.gz'), encoding: 'utf8' }); assert.equal(asFile.stdout.trim(), 'claude.json', 'файл лежит под своим именем (а не «папка не найдена»)');
    const asDir = spawnSync('tar', ['-tzf', '-'], { input: tarMember(f, 'bind-binddir.tar.gz'), encoding: 'utf8' }); assert.match(asDir.stdout, /binddir\/a\.txt/);
    const txt = tarMember(f, 'RESTORE.txt').toString(); assert.ok(txt.includes(`-C '${path.dirname(file)}'`), 'RESTORE.txt: распаковать в родительскую папку');
    assert.equal(parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'rbind.status'), 'utf8')).items[0].ok, true);
  });
  test('мало места → один понятный отказ и ничего не создаётся', () => {
    const baseDir = path.join(tmp, 'b2'); const r = run(buildScript({ runId: 'rlow', baseDir, dest: 'host', keep: 1, minFreeKb: 9e12, items: [] }));
    assert.equal(r.status, 1); const st = parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'rlow.status'), 'utf8')); assert.equal(st.done, true); assert.match(st.items[0].error, /Мало места/);
  });
  test('S3: архив уходит по ссылке (curl), временный файл удаляется; ошибка загрузки попадает в статус', () => {
    const baseDir = path.join(tmp, 'b3'); const item = J('a', 'm', [{ kind: 'mysql', tag: 'db-mysql', project: 'a', service: 'm', filter: F('a', 'm'), label: 'a/m · mysql', slug: 'p2-y' }], 's', { url: 'https://s3.example/b/k?X-Amz-Signature=abc', slug: 'p2-y' });
    const sc = buildScript({ runId: 'rs3', baseDir, dest: 's3', keep: 1, minFreeKb: 1, items: [item] });
    assert.ok(!sc.includes('SECRET')); assert.equal(run(sc).status, 0); assert.match(fs.readFileSync(path.join(tmp, 'curl.log'), 'utf8'), /X-Amz-Signature=abc/);
    assert.equal(fs.existsSync(path.join(baseDir, 'p2-y')), false, 'на сервере файл не остаётся'); assert.equal(parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'rs3.status'), 'utf8')).items[0].ok, true);
    run(buildScript({ runId: 'rs3f', baseDir, dest: 's3', keep: 1, minFreeKb: 1, items: [item] }), { FAILCURL: '1' });
    assert.match(parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'rs3f.status'), 'utf8')).items[0].error, /Загрузка в S3.*AccessDenied/);
  });
  test('пароль копий: без пароля архив открытый, с паролем — зашифрован (AES-256), пароль и скрипт не остаются на сервере', () => {
    const baseDir = path.join(tmp, 'b4'); const mk = (file) => J('a', 'mg', [{ kind: 'mongo', tag: 'db-mongo', project: 'a', service: 'mg', filter: F('a', 'mg'), label: 'a/mg · mongo', slug: 'p3-z' }], 's', { slug: 'p3-z', file });
    const plain = buildScript({ runId: 'rplain', baseDir, dest: 'host', keep: 1, minFreeKb: 1, items: [mk('a__mg__s.tar')] });
    assert.ok(!/\.pw"; printf/.test(plain), 'без пароля файла с паролем в скрипте нет'); assert.equal(run(plain).status, 0);
    assert.match(zlib.gunzipSync(tarMember(path.join(baseDir, 'p3-z', 'a__mg__s.tar'), 'db-mongo.archive.gz')).toString(), /-- dump --/);
    const sc = buildScript({ runId: 'rcrypt', baseDir, dest: 'host', keep: 1, minFreeKb: 1, items: [mk('a__mg__s2.tar.enc')], password: 'пароль-копий 123' });
    assert.ok(!sc.includes('пароль-копий'), 'пароль в скрипте только в base64'); assert.equal(run(sc).status, 0);
    const f = path.join(baseDir, 'p3-z', 'a__mg__s2.tar.enc'); assert.ok(fs.readFileSync(f).subarray(0, 8).toString() === 'Salted__', 'формат openssl enc');
    assert.deepEqual(encList(f, 'пароль-копий 123'), ['RESTORE.txt', 'db-mongo.archive.gz']); assert.match(zlib.gunzipSync(encMember(f, 'db-mongo.archive.gz', 'пароль-копий 123')).toString(), /-- dump --/);
    assert.notEqual(decrypt(f, 'неверный пароль').status, 0, 'с чужим паролем не открывается');
    assert.deepEqual(fs.readdirSync(path.join(baseDir, '.runs')).filter((x) => x.startsWith('rcrypt') && !x.endsWith('.status') && !x.endsWith('.err') && !x.endsWith('.perr')), [], 'файл с паролем и сам скрипт удалены');
    assert.equal(parseStatus(fs.readFileSync(path.join(baseDir, '.runs', 'rcrypt.status'), 'utf8')).items[0].ok, true);
  });
  test('compose-сервис с несколькими базами и томами — всё равно один архив с RESTORE.txt для каждой части', () => {
    const baseDir = path.join(tmp, 'b5'); const v = path.join(tmp, 'cvol'); fs.mkdirSync(v, { recursive: true }); fs.writeFileSync(path.join(v, 'x'), 'x'.repeat(80));
    const cf = (cs) => `--filter 'label=com.docker.compose.project=main_stack' --filter 'label=com.docker.compose.service=${cs}'`;
    const parts = [{ kind: 'postgres', tag: 'cdb~postgres~db', project: 'main', service: 'stack', filter: cf('db'), label: 'main/stack · db (postgres)' }, { kind: 'redis', tag: 'cdb~redis~cache', project: 'main', service: 'stack', filter: cf('cache'), label: 'main/stack · cache (redis)' }, { kind: 'volume', tag: 'cvol~app~main_stack_appdata', project: 'main', service: 'stack', hostPath: v, label: 'main/stack · app: main_stack_appdata' }];
    assert.equal(run(buildScript({ runId: 'rcomp', baseDir, dest: 'host', keep: 1, minFreeKb: 1, items: [J('main', 'stack', parts, 's')] })).status, 0);
    const f = path.join(baseDir, 'p1-x', 'main__stack__s.tar'); assert.deepEqual(tarList(f), ['RESTORE.txt', 'cdb~postgres~db.sql.gz', 'cdb~redis~cache.rdb.gz', 'cvol~app~main_stack_appdata.tar.gz']);
    const txt = tarMember(f, 'RESTORE.txt').toString(); assert.match(txt, /label=com\.docker\.compose\.service=db[\s\S]*psql/); assert.match(txt, /dump\.rdb/); assert.match(txt, /tar -xf - -C '\/var\/lib\/docker\/volumes\/main_stack_appdata\/_data'/);
    assert.equal(fs.readdirSync(path.join(baseDir, 'p1-x')).length, 1, 'один файл на весь стек');
  });
});

describe('через EasyAdmin', { skip: !HAS_BASH }, () => {
  const addPanel = async (name, seed) => { const m = createMockPanel({ token: 'T', seed }); panels.push(m); return (await api('POST', '/api/panels', { name, url: await m.listen(), token: 'T' })).data.id; };
  const dataDir = () => path.join(tmp, 'hostdir');
  test('без пароля копии данных не запускаются и не включаются', async () => {
    assert.equal((await api('PUT', '/api/backups/settings', { data: { mode: 'all' } })).status, 400, 'охват без пароля нельзя');
    assert.equal((await api('PUT', '/api/backups/settings', { enabled: true })).status, 400);
    assert.equal((await api('POST', '/api/backups/data/run')).status, 400);
    assert.equal((await api('PUT', '/api/backups/settings', { password: PW })).status, 200);
  });
  test('настройки данных: проверки значений', async () => {
    for (const bad of [{ mode: 'x' }, { dest: 'ftp' }, { dir: 'rel' }, { dir: '/a/../b' }, { keep: 0 }, { keys: ['x'] }, { mode: 'selected', keys: [] }]) assert.equal((await api('PUT', '/api/backups/settings', { data: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await api('PUT', '/api/backups/settings', { data: { mode: 'all', dest: 's3' } })).status, 400, 'S3 не настроен');
  });
  test('«на сервер»: базы и тома выбранных сервисов, без шифрования, список файлов и подсказка восстановления', async () => {
    const volDir = path.join(tmp, 'vol2'); fs.mkdirSync(volDir); fs.writeFileSync(path.join(volDir, 'a.txt'), 'x'.repeat(100));
    const id = await addPanel('Alpha Panel', { web: [{ name: 'site', mounts: [{ type: 'bind', name: 'b', hostPath: volDir, mountPath: '/d' }, { type: 'file', name: 'f', mountPath: '/f' }] }, { name: 'pg', type: 'postgres', mounts: [{ type: 'volume', name: 'pgdata', mountPath: '/v' }] }, { name: 'skip', mounts: [{ type: 'volume', name: 'zzz', mountPath: '/z' }] }] });
    const keys = [`${id}|web|site`, `${id}|web|pg`];
    const s = await api('PUT', '/api/backups/settings', { data: { mode: 'selected', keys, dest: 'host', dir: dataDir(), keep: 2, minFreeMb: 0 } }); assert.equal(s.status, 200, JSON.stringify(s.data));
    const r = await api('POST', '/api/backups/data/run'); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal((await api('POST', '/api/backups/data/run')).status, 400, 'пока идёт — второй запуск нельзя');
    const st = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
    assert.equal(st.result.ok, true, JSON.stringify(st)); assert.equal(st.result.files, 2, 'по одному архиву на сервис: pg и site; том pg, file-монтирование и несвязанный сервис не копируются');
    const labels = st.panels[0].items.map((x) => x.label); assert.deepEqual(labels.sort(), ['web/pg', 'web/site']);
    const files = (await api('GET', '/api/backups/data/files')).data.files; assert.equal(files.length, 2); assert.ok(files.every((f) => f.panel === 'Alpha Panel' && f.size > 0));
    const pg = files.find((f) => f.name.startsWith('web__pg__')); assert.match(pg.name, /^web__pg__\d{8}-\d{6}\.tar\.enc$/, 'архив зашифрован паролем копий');
    const site = files.find((f) => f.name.startsWith('web__site__')); const dir = path.join(dataDir(), `p${id}-alpha-panel`);
    assert.deepEqual(encList(path.join(dir, pg.name)), ['RESTORE.txt', 'db-postgres.sql.gz']); assert.deepEqual(encList(path.join(dir, site.name)), ['RESTORE.txt', 'bind-vol2.tar.gz']);
    assert.notEqual(decrypt(path.join(dir, pg.name), 'не тот пароль').status, 0);
    const hint = (await api('POST', '/api/backups/data/hint', { panelId: id, name: pg.name })).data; assert.match(hint.text, /openssl enc -d .*web__pg__.* \| tar -xf - -C restore/); assert.match(hint.text, /cat RESTORE\.txt/); assert.match(encMember(path.join(dir, pg.name), 'RESTORE.txt').toString(), /psql/); assert.equal(hint.encrypted, true); assert.ok(Array.isArray(hint.notes)); assert.ok(!hint.text.includes(PW));
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
    await api('PUT', '/api/backups/settings', { data: { mode: 'selected', keys: [`${id3}|no_such_proj|db`], dest: 'host', dir: dataDir(), minFreeMb: 0 } });
    await api('POST', '/api/backups/data/run'); const st = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
    assert.equal(st.result.ok, false); assert.equal(st.result.failed, 1); assert.match(st.panels[0].items[0].error, /не запущен/); assert.equal(hooks[0]?.type, 'backup_failed'); assert.match(hooks[0].text, /Gamma/); app.alerts.emit = orig; void id2;
    await api('PUT', '/api/backups/settings', { data: { mode: 'none' } }); assert.equal((await api('POST', '/api/backups/data/run')).status, 400);
  });
  test('S3: ссылки на загрузку подписаны, ключи не уходят на сервер панели; оператору недоступно', async () => {
    const id = app.dataId;
    await api('PUT', '/api/backups/settings', { s3: { endpoint: `http://127.0.0.1:${s3Port}`, bucket: 'bk', accessKey: 'AKID', secretKey: 'TOPSECRETKEY', prefix: 'ea' }, data: { mode: 'selected', keys: [`${id}|web|pg`], dest: 's3', minFreeMb: 0 } });
    fs.rmSync(path.join(tmp, 'curl.log'), { force: true }); await api('POST', '/api/backups/data/run');
    const st = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
    assert.equal(st.result.ok, true, JSON.stringify(st)); const log = fs.readFileSync(path.join(tmp, 'curl.log'), 'utf8');
    assert.match(log, /^http:\/\/127\.0\.0\.1:\d+\/bk\/ea\/data\/p\d+-alpha-panel\/web__pg__\d{8}-\d{6}\.tar\.enc\?X-Amz-Algorithm=AWS4-HMAC-SHA256.*X-Amz-Signature=[0-9a-f]{64}/m); assert.ok(!log.includes('TOPSECRETKEY'));
    cookie = ''; await api('POST', '/api/login', { username: 'admin', password: 'password1' });
  });
});

describe('согласованность томов, compose, Redis, загрузка частями', { skip: !HAS_BASH }, () => {
  const logPath = () => path.join(state, 'docker.log'); const resetLog = () => { fs.rmSync(logPath(), { force: true }); fs.rmSync(path.join(state, 'scaled0'), { force: true }); };
  const run = (script, env = {}) => { const f = path.join(tmp, `c-${crypto.randomBytes(3).toString('hex')}.sh`); fs.writeFileSync(f, script); return spawnSync('bash', [f], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, ...env }, encoding: 'utf8' }); };
  const vol = (hold, extra = {}) => ({ kind: 'volume', tag: 'vol-data', project: 'web', service: 'site', label: 'web/site · data', hostPath: path.join(tmp, 'vol'), hold, ...extra });
  const mk = (consistency, item, id) => buildScript({ runId: id, baseDir: path.join(tmp, `h-${id}`), dest: 'host', keep: 1, minFreeKb: 1, items: [J(item.project, item.service, [item], 's')], consistency });
  before(() => { fs.mkdirSync(path.join(tmp, 'vol'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'vol', 'f.txt'), 'data '.repeat(40)); });

  test('pause: контейнеры сервиса замораживаются на время копирования и размораживаются; none — не трогает', () => {
    resetLog(); assert.equal(run(mk('pause', vol('swarm:web_site'), 'rp')).status, 0);
    const log = fs.readFileSync(logPath(), 'utf8'); assert.match(log, /docker pause abc123def456[\s\S]*docker unpause abc123def456/);
    resetLog(); run(mk('none', vol(null), 'rn')); assert.ok(!/pause|scale|stop/.test(fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8') : ''));
  });
  test('stop: swarm-сервис масштабируется до 0 и возвращается к прежнему числу реплик, даже если копирование не удалось', () => {
    resetLog(); run(mk('stop', vol('swarm:web_site'), 'rs'));
    let log = fs.readFileSync(logPath(), 'utf8'); assert.match(log, /service scale -d web_site=0[\s\S]*service scale -d web_site=1/);
    resetLog(); const r = run(mk('stop', vol('swarm:web_site', { hostPath: '/nonexistent/dir' }), 'rs2')); assert.equal(r.status, 0);
    log = fs.readFileSync(logPath(), 'utf8'); assert.match(log, /web_site=0[\s\S]*web_site=1/, 'после ошибки сервис всё равно запущен');
    assert.match(parseStatus(fs.readFileSync(path.join(tmp, 'h-rs2', '.runs', 'rs2.status'), 'utf8')).items[0].error, /нет на сервере/);
  });
  test('stop для контейнеров compose: docker stop и затем docker start', () => {
    resetLog(); run(mk('stop', vol("ids:--filter 'label=com.docker.compose.project=main_stack' --filter 'label=com.docker.compose.service=app'"), 'rc'));
    assert.match(fs.readFileSync(logPath(), 'utf8'), /docker stop -t 30 abc123def456[\s\S]*docker start abc123def456/);
  });
  test('Redis: дамп берёт пароль из окружения или из аргумента --requirepass', () => {
    const sc = mk('none', { kind: 'redis', tag: 'db-redis', project: 'web', service: 'cache', label: 'web/cache · redis', filter: "--filter 'name=^web_cache\\.'" }, 'rr');
    assert.match(sc, /--requirepass/); assert.match(sc, /redis-cli/); assert.equal(run(sc).status, 0);
    assert.deepEqual(tarList(path.join(tmp, 'h-rr', 'p1-x', 'web__cache__s.tar')), ['RESTORE.txt', 'db-redis.rdb.gz']);
  });
  test('compose-стек: базы по образу, тома по монтированиям контейнеров; тома баз не копируются', async () => {
    resetLog(); const bindDir = path.join(tmp, 'composebind'); fs.mkdirSync(bindDir, { recursive: true }); fs.writeFileSync(path.join(bindDir, 'x.txt'), 'bind '.repeat(40));
    fs.writeFileSync(path.join(state, 'disc.txt'), 'abc111|main_stack|db|postgres:16\nabc222|main_stack|app|n8nio/n8n\nabc333|main_stack|cache|redis:7\nzzz999|other_proj|db|postgres:16\n');
    fs.writeFileSync(path.join(state, 'mounts-abc111'), 'M|volume|main_stack_pgdata|/var/lib/docker/volumes/main_stack_pgdata/_data\n');
    fs.writeFileSync(path.join(state, 'mounts-abc222'), `M|bind||${bindDir}\nM|volume|main_stack_appdata|/var/lib/docker/volumes/main_stack_appdata/_data\nM|bind||/var/run/docker.sock\n`);
    const m = createMockPanel({ token: 'T', seed: { main: [{ name: 'stack', type: 'compose' }] } }); panels.push(m);
    const id = (await api('POST', '/api/panels', { name: 'Compose Panel', url: await m.listen(), token: 'T' })).data.id;
    await api('PUT', '/api/backups/settings', { password: PW, data: { mode: 'selected', keys: [`${id}|main|stack`], dest: 'host', dir: path.join(tmp, 'hostdir2'), keep: 2, minFreeMb: 0, consistency: 'none' } });
    assert.equal((await api('POST', '/api/backups/data/run')).status, 200);
    const st = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
    const items = st.panels[0].items; assert.equal(items.length, 1, 'весь стек — одно задание'); assert.equal(items[0].label, 'main/stack'); assert.equal(items[0].status, 'ok');
    assert.match(items[0].note, /main_stack_appdata\/_data нет на сервере/, 'том, которого нет на сервере, пропущен с предупреждением, остальное скопировано');
    const files = fs.readdirSync(path.join(tmp, 'hostdir2', `p${id}-compose-panel`)); assert.equal(files.length, 1); assert.match(files[0], /^main__stack__\d{8}-\d{6}\.tar\.enc$/);
    const f = path.join(tmp, 'hostdir2', `p${id}-compose-panel`, files[0]);
    assert.deepEqual(encList(f), ['RESTORE.txt', 'cbind~app~composebind.tar.gz', 'cdb~postgres~db.sql.gz', 'cdb~redis~cache.rdb.gz'], 'docker.sock, чужой проект и том postgres исключены');
    const txt = encMember(f, 'RESTORE.txt').toString(); assert.match(txt, /label=com\.docker\.compose\.service=db/); assert.match(txt, /psql/); assert.ok(txt.includes(`-C '${path.dirname(bindDir)}'`));
    const hint = (await api('POST', '/api/backups/data/hint', { panelId: id, name: files[0] })).data; assert.match(hint.text, /cat RESTORE\.txt/);
    assert.match(restoreHint('main__stack__cvol~app~main_stack_appdata__20261001-020000.tar.gz', { dir: '/x' }).text, /\/var\/lib\/docker\/volumes\/main_stack_appdata\/_data/);
  });
  test('том больше порога уходит в S3 частями (multipart), части собираются в один файл', { skip: !fs.existsSync('/usr/bin/curl') }, async () => {
    process.env.EA_REALCURL = '1'; aborted.length = 0; uploads.length = 0; s3Objects.clear();
    const big = path.join(tmp, 'bigvol'); fs.mkdirSync(big, { recursive: true }); fs.writeFileSync(path.join(big, 'big.bin'), crypto.randomBytes(3 * 1024 * 1024 + 12345));
    const m = createMockPanel({ token: 'T', seed: { files: [{ name: 'big', mounts: [{ type: 'bind', name: 'b', hostPath: big, mountPath: '/d' }] }] } }); panels.push(m);
    const id = (await api('POST', '/api/panels', { name: 'Big Panel', url: await m.listen(), token: 'T' })).data.id;
    const r0 = await api('PUT', '/api/backups/settings', { password: PW, s3: { endpoint: `http://127.0.0.1:${s3Port}`, bucket: 'bk', accessKey: 'AKID', secretKey: 'TOPSECRETKEY', prefix: 'ea' }, data: { mode: 'selected', keys: [`${id}|files|big`], dest: 's3', keep: 2, minFreeMb: 0, consistency: 'none' } }); assert.equal(r0.status, 200, JSON.stringify(r0.data));
    assert.equal((await api('POST', '/api/backups/data/run')).status, 200);
    try {
      const st = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; }, 30000);
      assert.equal(st.result.ok, true, JSON.stringify(st));
      const key = [...s3Objects.keys()].find((k) => /files__big__\d{8}-\d{6}\.tar\.enc$/.test(k)); assert.ok(key, [...s3Objects.keys()].join());
      const parts = uploads.filter((u) => u.m === 'PUT' && /partNumber=/.test(u.u)); assert.ok(parts.length >= 3, `частей: ${parts.length}`);
      const dec = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '100000', '-pass', `pass:${PW}`], { input: s3Objects.get(key), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }); assert.equal(dec.status, 0);
      const inner = spawnSync('bash', ['-c', 'tar -xOf - bind-bigvol.tar.gz | tar -tzf -'], { input: dec.stdout, encoding: 'utf8' }); assert.match(inner.stdout, /bigvol\/big\.bin/);
      assert.equal(aborted.length, 0, 'успешная загрузка не отменяется');
    } finally { delete process.env.EA_REALCURL; }
  });
});

describe('ход копирования, защита EasyAdmin, перезапуск, ротация и журнал', { skip: !HAS_BASH }, () => {
  const run = (script, env = {}) => { const f = path.join(tmp, `n-${crypto.randomBytes(3).toString('hex')}.sh`); fs.writeFileSync(f, script); return spawnSync('bash', [f], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, ...env }, encoding: 'utf8' }); };
  const logPath = () => path.join(state, 'docker.log'); const resetLog = () => { fs.rmSync(logPath(), { force: true }); fs.rmSync(path.join(state, 'scaled0'), { force: true }); };
  const volPart = (hold) => ({ kind: 'volume', tag: 'vol-data', project: 'web', service: 'site', label: 'web/site · data', hostPath: path.join(tmp, 'vol'), hold });
  const status = (id) => parseStatus(fs.readFileSync(path.join(tmp, `n-${id}`, '.runs', `${id}.status`), 'utf8'));
  before(() => { fs.mkdirSync(path.join(tmp, 'vol'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'vol', 'f.txt'), 'data '.repeat(40)); });

  test('в статусе видно, какой сервис и какая часть копируются сейчас; после завершения «текущего» нет', () => {
    const sc = buildScript({ runId: 'rrun', baseDir: path.join(tmp, 'n-rrun'), dest: 'host', keep: 1, minFreeKb: 1, items: [J('web', 'site', [volPart(null)], 's')] });
    assert.equal(run(sc).status, 0); const raw = fs.readFileSync(path.join(tmp, 'n-rrun', '.runs', 'rrun.status'), 'utf8');
    assert.match(raw, /START\nRUN\|web\/site\|vol-data\.tar\.gz\nOK\|web\/site\|/);
    assert.deepEqual(parseStatus('START\nOK|a/x|f.tar.enc|5\nRUN|a/y|vol-data.tar.gz\n').current, { label: 'a/y', part: 'vol-data.tar.gz' });
    assert.equal(parseStatus('START\nRUN|a/y|p\nOK|a/y|f|5\n').current, undefined); assert.equal(parseStatus('START\nRUN|a/y|p\nFAIL|a/y|CMD|x\n').current, undefined); assert.equal(parseStatus('START\nRUN|a/y|p\nDONE\n').current, undefined);
  });

  test('сам EasyAdmin не останавливается и не замораживается (иначе он обрывает собственное копирование): сервис, к которому относится его контейнер, пропускается', () => {
    fs.writeFileSync(path.join(state, 'mounts-selfid1'), 'system_easyadmin\n'); // подставной docker inspect «контейнера EasyAdmin» отвечает названием его сервиса
    for (const mode of ['stop', 'pause']) {
      resetLog(); const id = `rself${mode}`;
      const sc = buildScript({ runId: id, baseDir: path.join(tmp, `n-${id}`), dest: 'host', keep: 1, minFreeKb: 1, consistency: mode, selfId: 'selfid1', items: [J('system', 'easyadmin', [{ ...volPart('swarm:system_easyadmin'), project: 'system', service: 'easyadmin', label: 'system/easyadmin · data' }], 's'), J('web', 'site', [volPart('swarm:web_site')], 's')] });
      assert.equal(run(sc).status, 0); const log = fs.readFileSync(logPath(), 'utf8');
      assert.ok(!/service scale -d system_easyadmin|pause abc123def456.*\n.*system_easyadmin/.test(log) && !/system_easyadmin=0/.test(log), 'свой сервис не трогаем');
      assert.match(log, mode === 'stop' ? /service scale -d web_site=0/ : /docker pause abc123def456/, 'чужие сервисы — как настроено');
      const st = status(id); assert.equal(st.items.filter((x) => x.ok).length, 2, 'оба сервиса скопированы'); assert.match(st.warns.find((w) => w.label === 'system/easyadmin').text, /сам EasyAdmin/);
    }
    resetLog(); const sc2 = buildScript({ runId: 'rself2', baseDir: path.join(tmp, 'n-rself2'), dest: 'host', keep: 1, minFreeKb: 1, consistency: 'stop', selfId: 'not-a-container', items: [J('web', 'site', [volPart('swarm:web_site')], 's')] });
    run(sc2); assert.match(fs.readFileSync(logPath(), 'utf8'), /web_site=0/, 'EasyAdmin вне docker этого сервера — защита не мешает');
  });

  test('результаты записываются по готовности, журнал хранит запуски с текстом ошибок, расписание не повторяет недоделанную попытку', async () => {
    const id = await (async () => { const m = createMockPanel({ token: 'T', seed: { zz: [{ name: 'db', type: 'postgres' }, { name: 'ghost', type: 'postgres' }] } }); panels.push(m); return (await api('POST', '/api/panels', { name: 'Journal Panel', url: await m.listen(), token: 'T' })).data.id; })();
    await api('PUT', '/api/backups/settings', { password: PW, data: { mode: 'selected', keys: [`${id}|zz|db`, `${id}|zz|ghost`], dest: 'host', dir: path.join(tmp, 'hostdir-j'), keep: 2, minFreeMb: 0, consistency: 'none' } });
    assert.equal((await api('POST', '/api/backups/data/run')).status, 200);
    const st = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
    assert.equal(st.result.reason, 'manual');
    const log = (await api('GET', '/api/backups/data/log')).data.runs; assert.equal(log[0].panels[0].name, 'Journal Panel'); assert.ok(log[0].panels[0].items.some((x) => x.label === 'zz/db' && x.status === 'ok' && x.size > 0));
    const ov = (await api('GET', '/api/backups/overview')).data; const r = ov.panels.find((p) => p.panelId === id).rows.find((x) => x.name === 'db'); assert.equal(r.status, 'ok'); assert.ok(r.last.size > 0);
    // расписание: попытка записана при запуске — тот же день не «догоняется» новым запуском, даже если итог не записался
    await api('PUT', '/api/backups/settings', { enabled: true, every: 'daily', hour: 0 });
    db.prepare("DELETE FROM settings WHERE k = 'backup_data_last'").run();
    assert.equal(await app.backups.tickData(Date.now() + 1000), null, 'есть попытка за сегодня — не повторяем');
    db.prepare("UPDATE settings SET v = ? WHERE k = 'backup_data_attempt'").run(String(Date.now() - 3 * 86400e3));
    const again = await app.backups.tickData(Date.now()); assert.ok(again?.started, 'прошлая попытка давняя — запуск по расписанию');
    await again.wait; await api('PUT', '/api/backups/settings', { enabled: false });
  });

  test('после перезапуска EasyAdmin идущий на сервере запуск дослеживается: результаты, журнал, уборка, запись о запуске снимается', async () => {
    const m = createMockPanel({ token: 'T', seed: { rs: [{ name: 'a' }] } }); panels.push(m);
    const id = (await api('POST', '/api/panels', { name: 'Resume Panel', url: await m.listen(), token: 'T' })).data.id;
    const dir = path.join(tmp, 'hostdir-r'); fs.mkdirSync(path.join(dir, '.runs'), { recursive: true });
    const runId = `r20261003-010101-${id}`;
    fs.writeFileSync(path.join(dir, '.runs', `${runId}.status`), 'START\nOK|rs/a|rs__a__20261003-010101.tar.enc|777\nFAIL|rs/b|CMD|EA_NOCONT\nDONE\n');
    await api('PUT', '/api/backups/settings', { password: PW, data: { mode: 'selected', keys: [`${id}|rs|a`], dest: 'host', dir, minFreeMb: 0 } });
    db.prepare("INSERT INTO settings (k, v) VALUES ('backup_data_pending', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify({ [runId]: { panelId: id, labels: ['rs/a', 'rs/b'], startedAt: Date.now() - 600_000, reason: 'manual', dest: 'host', dir, keep: 3, empty: [] } }));
    assert.equal(await app.backups.resumeRuns(), 1);
    const done = await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
    assert.equal(done.result.reason, 'resume'); assert.equal(done.result.failed, 1);
    const svc = app.backups.svcResults(); assert.equal(svc[`${id}|rs|a`].ok, true); assert.equal(svc[`${id}|rs|a`].size, 777); assert.equal(svc[`${id}|rs|b`].ok, false); assert.match(svc[`${id}|rs|b`].error, /не запущен/);
    assert.deepEqual(JSON.parse(db.prepare("SELECT v FROM settings WHERE k = 'backup_data_pending'").get().v), {}, 'запись о запуске снята');
    await waitFor(async () => !fs.existsSync(path.join(dir, '.runs', `${runId}.status`))); // файлы запуска на сервере убраны
    assert.equal((await api('GET', '/api/backups/data/log')).data.runs[0].reason, 'resume');
    assert.equal(await app.backups.resumeRuns(), 0, 'нечего подхватывать');
  });

  test('список S3 читается постранично (хранилище отдаёт не больше 1000 за запрос), ротация удаляет лишнее у каждого сервиса', async () => {
    const pages = []; const fetchImpl = async (url) => { pages.push(String(url)); const u = new URL(url); const tok = u.searchParams.get('continuation-token');
      const xml = !tok ? '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>T2</NextContinuationToken><Contents><Key>p/a__x__20261001-000001.tar.enc</Key><Size>1</Size></Contents></ListBucketResult>'
        : '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/a__x__20261001-000002.tar.enc</Key><Size>2</Size></Contents></ListBucketResult>';
      return { ok: true, status: 200, text: async () => xml }; };
    const list = await s3Client({ endpoint: 'https://s3.example.com', region: 'r', bucket: 'b', prefix: 'p/', accessKey: 'A', secretKey: 'S', pathStyle: true }, fetchImpl).list('p/');
    assert.deepEqual(list.map((o) => o.size), [1, 2]); assert.equal(pages.length, 2); assert.match(pages[1], /continuation-token=T2/);
  });
});
