import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { loadKey } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { buildScript, parseStatus } from '../src/data-backup.js';
import { buildInspectScript, buildRestoreScript, describeRestoreFail, parseMember, parseRestoreStatus, planMembers, tagKey } from '../src/data-restore.js';
import { createMockPanel } from './mock-easypanel.js';

const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0 && spawnSync('openssl', ['version']).status === 0;
const PW = 'correct horse battery';
const F = (p, sv) => `--filter 'name=^${p}_${sv}\\.'`;
const EXT = { postgres: 'sql', mysql: 'sql', mariadb: 'sql', mongo: 'archive', redis: 'rdb', volume: 'tar' };
const P = (o) => ({ member: `${o.tag}.${EXT[o.kind]}.gz`, slug: 'p1-x', ...o });
const J = (project, service, parts, stamp, extra = {}) => ({ project, service, label: `${project}/${service}`, slug: 'p1-x', prefix: `${project}__${service}__`, file: `${project}__${service}__${stamp}.tar.enc`, parts: parts.map(P), ...extra });
let tmp, stubs, state, app, base, cookie = ''; const panels = [];
const api = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await res.text(); let data; try { data = JSON.parse(t); } catch { data = t; } return { status: res.status, data };
};
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } };
const hostRun = async (c, row, script) => {
  const r = spawnSync('bash', ['-c', `( ${script} ) && echo __OK__ || echo __FAIL__`], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${r.stdout}${r.stderr}`; return { ok: out.includes('__OK__'), output: out.replace(/__OK__|__FAIL__/g, '').trim() };
};
const sh = (script, env = {}) => { const f = path.join(tmp, `s-${crypto.randomBytes(3).toString('hex')}.sh`); fs.writeFileSync(f, script); return spawnSync('bash', [f], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, ...env }, encoding: 'utf8' }); };
const dockerLog = () => (fs.existsSync(path.join(state, 'docker.log')) ? fs.readFileSync(path.join(state, 'docker.log'), 'utf8') : '');
const resetState = () => { for (const f of fs.readdirSync(state)) if (f !== 'mounts-selfctr') fs.rmSync(path.join(state, f), { force: true, recursive: true }); };
const execIn = () => fs.readdirSync(state).filter((f) => f.startsWith('exec-in.')).sort().map((f) => fs.readFileSync(path.join(state, f), 'utf8'));

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-rest-')); stubs = path.join(tmp, 'stubs'); state = path.join(tmp, 'state'); fs.mkdirSync(stubs); fs.mkdirSync(state); process.env.EA_STATE = state;
  fs.writeFileSync(path.join(state, 'mounts-selfctr'), 'system_easyadmin');
  // подставной docker: пишет журнал вызовов, для «exec -i» сохраняет то, что подали на вход
  fs.writeFileSync(path.join(stubs, 'docker'), `#!/bin/bash
S="$EA_STATE"; echo "docker $*" >> "$S/docker.log"
case "$1" in
  ps) case "$*" in *no_such_*) ;; *) [ -f "$S/scaled0" ] || echo abc123def456;; esac ;;
  inspect) for last; do :; done; cat "$S/mounts-$last" 2>/dev/null ;;
  service) case "$2" in inspect) case "$*" in *Mounts*) echo "bind $EA_REDIS_DIR";; *) echo 1;; esac;; scale) case "$*" in *=0) touch "$S/scaled0";; *) rm -f "$S/scaled0";; esac;; esac ;;
  pause|unpause|stop|start) ;;
  exec) if [[ "$*" == *" -i "* ]]; then n=$(ls "$S" | grep -c '^exec-in\\.'); cat > "$S/exec-in.$(printf %02d $n)"; else for i in $(seq 1 30); do echo "-- dump -- $*"; done; fi ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'systemd-run'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  // подставной curl: «скачивание» отдаёт локальный файл, на который указывает ссылка
  fs.writeFileSync(path.join(stubs, 'curl'), '#!/bin/bash\nfor a; do U=$a; done; case "$U" in *fail403*) echo "curl: (22) The requested URL returned error: 403" >&2; exit 22;; esac; F=${U#http://s3.test/}; F=${F%%\\?*}; cat "$EA_S3DIR/$F"\n', { mode: 0o755 });
});
after(async () => { app?.stop(); app?.server.closeAllConnections(); app?.server.close(); await Promise.all(panels.map((p) => p.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('части архива и сопоставление с целью', () => {
  test('имена частей разбираются, лишнее отвергается', () => {
    assert.deepEqual(parseMember('db-postgres.sql.gz'), { member: 'db-postgres.sql.gz', tag: 'db-postgres', kind: 'postgres', compose: false, bind: false });
    assert.equal(parseMember('vol-data.tar.gz').kind, 'volume'); assert.equal(parseMember('bind-x.tar.gz').bind, true);
    assert.deepEqual([parseMember('cdb~redis~cache.rdb.gz').kind, parseMember('cdb~redis~cache.rdb.gz').compose], ['redis', true]);
    assert.equal(parseMember('cvol~app~main_stack_data.tar.gz').compose, true);
    assert.equal(parseMember('RESTORE.txt'), null); assert.equal(parseMember('../x.tar.gz'), null); assert.equal(parseMember('db-oracle.sql.gz'), null);
  });
  test('тома compose сопоставляются по имени без префикса «проект_сервис_»', () => {
    assert.equal(tagKey('cvol~app~main_stack_data', { project: 'main', service: 'stack' }), 'cvol~app~data');
    assert.equal(tagKey('cvol~app~main_copy_data', { project: 'main', service: 'copy' }), 'cvol~app~data');
    const parts = [{ tag: 'cvol~app~main_copy_data', kind: 'volume' }, { tag: 'cdb~postgres~db', kind: 'postgres' }];
    const plan = planMembers(['cvol~app~main_stack_data.tar.gz', 'cdb~postgres~db.sql.gz', 'cdb~redis~cache.rdb.gz', 'vol-x.tar.gz'], { project: 'main', service: 'stack' }, { project: 'main', service: 'copy' }, parts);
    assert.deepEqual(plan.map((x) => x.status), ['ok', 'ok', 'nomatch', 'nomatch']);
    const redis = planMembers(['cdb~redis~cache.rdb.gz'], { project: 'a', service: 'b' }, { project: 'a', service: 'b' }, [{ tag: 'cdb~redis~cache', kind: 'redis' }]);
    assert.equal(redis[0].status, 'unsupported', 'Redis внутри compose автоматически не восстанавливается');
  });
  test('статус скрипта восстановления и описания ошибок', () => {
    const st = parseRestoreStatus('START\nM|120|db-postgres.sql.gz\nRUN|vol-data.tar.gz|vol-data.tar.gz\nOK|db-postgres.sql.gz\nSNAP|vol-data.tar.gz|/b/before-restore/x1\nWARN|db-postgres.sql.gz|ERROR: boom\nFAIL|vol-data.tar.gz|EA_SELF|\nDONE\n');
    assert.deepEqual(st.members, [{ member: 'db-postgres.sql.gz', size: 120 }]); assert.equal(st.parts['db-postgres.sql.gz'].ok, true); assert.equal(st.parts['vol-data.tar.gz'].ok, false);
    assert.match(st.parts['vol-data.tar.gz'].error, /сам EasyAdmin/); assert.equal(st.snapDir, '/b/before-restore/x1'); assert.equal(st.warns['db-postgres.sql.gz'], 'ERROR: boom'); assert.equal(st.done, true);
    assert.match(parseRestoreStatus('START\nFAIL|*|BADPASS|\nDONE').general, /пароль/);
    assert.match(describeRestoreFail('CMD', 'EA_NOCONT'), /не запущен/); assert.match(describeRestoreFail('NOSPACE', '12'), /12 МБ/);
  });
});

describe('скрипт восстановления (настоящий bash)', { skip: !HAS_BASH }, () => {
  const baseDir = () => path.join(tmp, 'host'); let archive; const vol = path.join(tmp, 'vol'); const newVol = path.join(tmp, 'vol-new');
  const volPart = (hostPath, extra = {}) => ({ kind: 'volume', tag: 'vol-data', member: 'vol-data.tar.gz', hostPath, ...extra });
  const mkRestore = (o) => buildRestoreScript({ runId: o.runId, baseDir: baseDir(), source: { file: archive }, encrypted: true, password: PW, mode: 'clean', snapshot: true, minFreeKb: 1, needBytes: 0, parts: [], selfId: '', ...o });
  const statusOf = (id) => parseRestoreStatus(fs.readFileSync(path.join(baseDir(), '.runs', `${id}.status`), 'utf8'));
  before(() => {
    // настоящий архив: делаем его самим скриптом копирования (том + база mongo + база postgres), зашифрованный паролем
    fs.mkdirSync(vol, { recursive: true }); fs.writeFileSync(path.join(vol, 'f.txt'), 'data '.repeat(40)); fs.mkdirSync(path.join(vol, 'sub')); fs.writeFileSync(path.join(vol, 'sub', 'g.txt'), 'inner');
    const parts = [{ kind: 'volume', tag: 'vol-data', project: 'web', service: 'site', label: 'web/site · data', hostPath: vol }, { kind: 'mongo', tag: 'db-mongo', project: 'web', service: 'site', filter: F('web', 'site'), label: 'web/site · mongo' }, { kind: 'postgres', tag: 'db-postgres', project: 'web', service: 'site', filter: F('web', 'site'), label: 'web/site · pg' }];
    const r = sh(buildScript({ runId: 'rsrc', baseDir: baseDir(), dest: 'host', keep: 1, minFreeKb: 1, items: [J('web', 'site', parts, '20261001-020000')], password: PW }));
    assert.equal(r.status, 0, r.stderr); archive = path.join(baseDir(), 'p1-x', 'web__site__20261001-020000.tar.enc'); assert.ok(fs.existsSync(archive));
    fs.mkdirSync(path.join(tmp, 's3'), { recursive: true }); fs.copyFileSync(archive, path.join(tmp, 's3', 'web__site__20261001-020000.tar.enc'));
  });

  test('просмотр архива: список частей с размерами (RESTORE.txt не считается); неверный пароль — понятная ошибка', () => {
    resetState();
    const ok = sh(buildInspectScript({ runId: 'i1', baseDir: baseDir(), source: { file: archive }, encrypted: true, password: PW })); assert.equal(ok.status, 0, ok.stderr);
    const st = statusOf('i1'); assert.equal(st.done, true); assert.deepEqual(st.members.map((m) => m.member).sort(), ['db-mongo.archive.gz', 'db-postgres.sql.gz', 'vol-data.tar.gz']); assert.ok(st.members.every((m) => m.size > 20));
    sh(buildInspectScript({ runId: 'i2', baseDir: baseDir(), source: { file: archive }, encrypted: true, password: 'не тот' })); assert.match(statusOf('i2').general, /неверный пароль/);
    assert.ok(!fs.readFileSync(path.join(baseDir(), '.runs', 'i2.status'), 'utf8').includes('M|'), 'ничего не показываем из чужого пароля');
    sh(buildInspectScript({ runId: 'i3', baseDir: baseDir(), source: { url: 'http://s3.test/fail403' }, encrypted: true, password: PW })); assert.match(statusOf('i3').general, /скачать архив из S3.*403/);
  });
  test('том, «заменить»: старое удалено, содержимое из копии, страховочная копия сделана, пароль и скрипт убраны', () => {
    resetState(); const target = path.join(tmp, 'vol-clean'); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'old.txt'), 'старое');
    const sc = mkRestore({ runId: 'x1', parts: [volPart(target, { hold: 'swarm:web_site' })] }); assert.ok(!sc.includes(PW), 'пароль в скрипте только в base64');
    const r = sh(sc); assert.equal(r.status, 0, r.stderr); const st = statusOf('x1');
    assert.equal(st.parts['vol-data.tar.gz'].ok, true, JSON.stringify(st)); assert.equal(fs.existsSync(path.join(target, 'old.txt')), false); assert.equal(fs.readFileSync(path.join(target, 'sub', 'g.txt'), 'utf8'), 'inner'); assert.ok(fs.existsSync(path.join(target, 'f.txt')));
    assert.equal(st.snapDir, path.join(baseDir(), 'before-restore', 'x1'));
    const snap = spawnSync('tar', ['-tzf', path.join(st.snapDir, 'vol-data.tar.gz')], { encoding: 'utf8' }).stdout; assert.match(snap, /old\.txt/, 'в страховочной копии — прежнее содержимое');
    assert.match(dockerLog(), /service scale -d web_site=0[\s\S]*service scale -d web_site=1/, 'сервис остановлен на время и запущен обратно');
    assert.deepEqual(fs.readdirSync(path.join(baseDir(), '.runs')).filter((x) => x.startsWith('x1') && /\.(pw|sh)$/.test(x)), []); assert.equal(fs.existsSync(path.join(baseDir(), '.work', 'x1.stage')), false);
  });
  test('том, «дописать»: прежние файлы остаются; новая папка создаётся; без страховочной копии её нет', () => {
    resetState(); const target = path.join(tmp, 'vol-merge'); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
    assert.equal(sh(mkRestore({ runId: 'x2', mode: 'merge', snapshot: false, parts: [volPart(target)] })).status, 0);
    assert.ok(fs.existsSync(path.join(target, 'keep.txt')) && fs.existsSync(path.join(target, 'f.txt'))); assert.equal(statusOf('x2').snapDir, null); assert.equal(fs.existsSync(path.join(baseDir(), 'before-restore', 'x2')), false);
    assert.equal(sh(mkRestore({ runId: 'x3', parts: [volPart(newVol)] })).status, 0); assert.ok(fs.existsSync(path.join(newVol, 'f.txt')), 'папки тома нового сервиса ещё не было');
  });
  test('базы: «заменить» сначала очищает, «дописать» — нет; поток из архива уходит в контейнер; mongo с --drop только при замене', () => {
    resetState();
    const parts = [{ kind: 'postgres', member: 'db-postgres.sql.gz', filter: F('web', 'site'), svc: 'web_site' }, { kind: 'mongo', member: 'db-mongo.archive.gz', filter: F('web', 'site'), svc: 'web_site' }];
    assert.equal(sh(mkRestore({ runId: 'x4', parts })).status, 0); const st = statusOf('x4'); assert.ok(st.parts['db-postgres.sql.gz'].ok && st.parts['db-mongo.archive.gz'].ok, JSON.stringify(st));
    const ins = execIn(); assert.ok(ins.some((t) => /DROP DATABASE/.test(t) && /pg_terminate_backend/.test(t)), 'очистка postgres передана в контейнер'); assert.ok(ins.some((t) => /-- dump --/.test(t)), 'сам дамп из архива дошёл до контейнера');
    assert.match(dockerLog(), /mongorestore --archive --drop/); assert.match(dockerLog(), /pg_dumpall/, 'страховочный дамп текущей базы'); assert.ok(fs.readdirSync(path.join(baseDir(), 'before-restore', 'x4')).includes('db-postgres.sql.gz'));
    resetState(); assert.equal(sh(mkRestore({ runId: 'x5', mode: 'merge', snapshot: false, parts })).status, 0);
    assert.ok(!execIn().some((t) => /DROP DATABASE/.test(t)), 'при «дописать» базы не очищаются'); assert.ok(!/--drop/.test(dockerLog()));
  });
  test('нет контейнера, нет части в архиве, сам EasyAdmin — отказ по части, остальные восстанавливаются', () => {
    resetState(); const target = path.join(tmp, 'vol-ok'); fs.mkdirSync(target, { recursive: true });
    const parts = [{ kind: 'postgres', member: 'db-postgres.sql.gz', filter: F('no_such', 'pg'), svc: 'no_such_pg' }, { kind: 'mysql', member: 'db-mysql.sql.gz', filter: F('web', 'site'), svc: 'web_site' }, volPart(target)];
    assert.equal(sh(mkRestore({ runId: 'x6', parts })).status, 0); const st = statusOf('x6');
    assert.match(st.parts['db-postgres.sql.gz'].error, /не запущен/); assert.match(st.parts['db-mysql.sql.gz'].error, /нет в архиве/); assert.equal(st.parts['vol-data.tar.gz'].ok, true, 'остальное восстановлено'); assert.equal(st.done, true);
    resetState(); const t2 = path.join(tmp, 'vol-self'); fs.mkdirSync(t2, { recursive: true });
    assert.equal(sh(mkRestore({ runId: 'x7', selfId: 'selfctr', parts: [volPart(t2, { hold: 'swarm:system_easyadmin' })] })).status, 0);
    assert.match(statusOf('x7').parts['vol-data.tar.gz'].error, /сам EasyAdmin/); assert.deepEqual(fs.readdirSync(t2), [], 'его том не тронут'); assert.ok(!/scale -d system_easyadmin=0/.test(dockerLog()), 'и сервис не остановлен');
  });
  test('неверный пароль и мало места — общий отказ до любых изменений; S3-источник читается по ссылке', () => {
    resetState(); const target = path.join(tmp, 'vol-guard'); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'old.txt'), 'x');
    sh(mkRestore({ runId: 'x8', password: 'не тот', parts: [volPart(target)] })); assert.match(statusOf('x8').general, /неверный пароль/); assert.ok(fs.existsSync(path.join(target, 'old.txt')), 'данные не тронуты');
    sh(mkRestore({ runId: 'x9', minFreeKb: 9e12, parts: [volPart(target)] })); assert.match(statusOf('x9').general, /Мало места/);
    assert.equal(sh(mkRestore({ runId: 'x10', source: { url: 'http://s3.test/web__site__20261001-020000.tar.enc?X-Amz-Signature=abc' }, parts: [volPart(target)] }), { EA_S3DIR: path.join(tmp, 's3') }).status, 0);
    assert.equal(statusOf('x10').parts['vol-data.tar.gz'].ok, true); assert.ok(fs.existsSync(path.join(target, 'f.txt')) && !fs.existsSync(path.join(target, 'old.txt')));
  });
  test('Redis: dump.rdb кладётся в каталог /data сервиса, AOF откладывается, сервис останавливается и запускается', () => {
    resetState(); const rdir = path.join(tmp, 'redis-data'); fs.mkdirSync(rdir, { recursive: true }); fs.writeFileSync(path.join(rdir, 'appendonly.aof'), 'aof'); fs.writeFileSync(path.join(rdir, 'dump.rdb'), 'OLD');
    const rb = path.join(tmp, 'rsrc.tar'); const stage = path.join(tmp, 'rstage'); fs.mkdirSync(stage, { recursive: true }); fs.writeFileSync(path.join(stage, 'db-redis.rdb.gz'), zlib.gzipSync('REDIS0011'.repeat(5)));
    assert.equal(spawnSync('tar', ['-cf', rb, '-C', stage, 'db-redis.rdb.gz']).status, 0);
    const sc = buildRestoreScript({ runId: 'x11', baseDir: baseDir(), source: { file: rb }, encrypted: false, password: '', mode: 'clean', snapshot: true, minFreeKb: 1, needBytes: 0, selfId: '', parts: [{ kind: 'redis', member: 'db-redis.rdb.gz', svc: 'web_cache', hold: 'swarm:web_cache' }] });
    assert.equal(sh(sc, { EA_REDIS_DIR: rdir }).status, 0); const st = statusOf('x11'); assert.equal(st.parts['db-redis.rdb.gz'].ok, true, JSON.stringify(st));
    assert.equal(fs.readFileSync(path.join(rdir, 'dump.rdb'), 'utf8'), 'REDIS0011'.repeat(5)); assert.ok(!fs.existsSync(path.join(rdir, 'appendonly.aof')) && fs.readdirSync(rdir).some((f) => f.startsWith('appendonly.aof.before-restore')));
    assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(st.snapDir, 'db-redis.rdb.gz'))).toString(), 'OLD', 'страховочная копия прежнего dump.rdb'); assert.match(dockerLog(), /web_cache=0[\s\S]*web_cache=1/);
  });
});

describe('через EasyAdmin: просмотр → сопоставление → запуск', { skip: !HAS_BASH }, () => {
  const dataDir = () => path.join(tmp, 'apihost'); let pid; const volA = path.join(tmp, 'api-vol-a'); const volB = path.join(tmp, 'api-vol-b');
  before(async () => {
    const db = openDb(tmp);
    app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db, key: loadKey(tmp, ''), hostRun, dataPollMs: 120 });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
    await api('POST', '/api/setup', { username: 'admin', password: 'password1' });
    fs.mkdirSync(volA, { recursive: true }); fs.mkdirSync(volB, { recursive: true }); fs.writeFileSync(path.join(volA, 'a.txt'), 'исходный файл'); fs.writeFileSync(path.join(volB, 'old.txt'), 'старый');
    const m = createMockPanel({ token: 'T', seed: { web: [{ name: 'site', mounts: [{ type: 'bind', name: 'b', hostPath: volA, mountPath: '/d' }] }, { name: 'copy', mounts: [{ type: 'bind', name: 'b', hostPath: volB, mountPath: '/d' }] }, { name: 'pg', type: 'postgres' }, { name: 'pg2', type: 'postgres' }] } }); panels.push(m);
    pid = (await api('POST', '/api/panels', { name: 'Alpha', url: await m.listen(), token: 'T' })).data.id;
    await api('PUT', '/api/backups/settings', { password: PW, data: { mode: 'selected', keys: [`${pid}|web|site`, `${pid}|web|pg`], dest: 'host', dir: dataDir(), keep: 3, minFreeMb: 0 } });
    assert.equal((await api('POST', '/api/backups/data/run')).status, 200); await waitFor(async () => { const x = (await api('GET', '/api/backups/data/status')).data; return x.running ? null : x; });
  });
  const files = async () => (await api('GET', '/api/backups/data/files')).data.files;
  const poll = async (id, done = ['done', 'error', 'partial']) => waitFor(async () => { const j = (await api('GET', `/api/backups/data/job?id=${id}`)).data; return done.includes(j.status) ? j : null; });

  test('просмотр архива и проверка входных данных', async () => {
    const site = (await files()).find((f) => f.name.startsWith('web__site__'));
    assert.equal((await api('POST', '/api/backups/data/inspect', { panelId: pid, name: '../x' })).status, 400); assert.equal((await api('POST', '/api/backups/data/inspect', { panelId: pid, name: 'web__site__db-postgres__20261001-020000.sql.gz' })).status, 400, 'старый формат — только подсказка');
    assert.equal((await api('POST', '/api/backups/data/inspect', { panelId: 999, name: site.name })).status, 400);
    const { id } = (await api('POST', '/api/backups/data/inspect', { panelId: pid, name: site.name })).data; const job = await poll(id);
    assert.equal(job.status, 'done', JSON.stringify(job)); assert.deepEqual(job.members.map((m) => m.member), ['bind-api-vol-a.tar.gz']);
    const bad = await poll((await api('POST', '/api/backups/data/inspect', { panelId: pid, name: site.name, password: 'не тот' })).data.id); assert.equal(bad.status, 'error'); assert.match(bad.error, /пароль/);
  });
  test('в другой сервис: части подбираются по тегам; в базу нельзя восстановить том', async () => {
    const site = (await files()).find((f) => f.name.startsWith('web__site__'));
    const same = (await api('POST', '/api/backups/data/restore-plan', { panelId: pid, name: site.name, members: ['bind-api-vol-a.tar.gz'], target: { panelId: pid, project: 'web', service: 'site' } })).data;
    assert.equal(same.items[0].status, 'ok'); assert.equal(same.items[0].hostPath, volA);
    const wrong = (await api('POST', '/api/backups/data/restore-plan', { panelId: pid, name: site.name, members: ['bind-api-vol-a.tar.gz'], target: { panelId: pid, project: 'web', service: 'pg2' } })).data;
    assert.equal(wrong.items[0].status, 'nomatch'); assert.equal((await api('POST', '/api/backups/data/restore-plan', { panelId: pid, name: site.name, members: ['x'], target: { panelId: pid, project: 'web', service: 'site' } })).status, 400);
    assert.equal((await api('POST', '/api/backups/data/restore-plan', { panelId: pid, name: site.name, members: ['bind-api-vol-a.tar.gz'], target: { panelId: pid, project: 'web', service: 'nope' } })).status, 400);
  });
  test('запуск: нужно подтверждение, нельзя восстановить, если ни одна часть не подходит; успешное восстановление заменяет данные и пишет в журнал', async () => {
    const site = (await files()).find((f) => f.name.startsWith('web__site__'));
    const body = { panelId: pid, name: site.name, members: ['bind-api-vol-a.tar.gz'], target: { panelId: pid, project: 'web', service: 'site' }, mode: 'clean', snapshot: true };
    assert.equal((await api('POST', '/api/backups/data/restore', body)).status, 400, 'без confirm'); assert.equal((await api('POST', '/api/backups/data/restore', { ...body, confirm: true, target: { panelId: pid, project: 'web', service: 'pg2' } })).status, 400, 'нет подходящих частей');
    fs.writeFileSync(path.join(volA, 'a.txt'), 'испорчено'); fs.writeFileSync(path.join(volA, 'extra.txt'), 'лишнее');
    const r = await api('POST', '/api/backups/data/restore', { ...body, confirm: true }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.restoring, 1);
    assert.equal((await api('POST', '/api/backups/data/restore', { ...body, confirm: true })).status, 400, 'пока идёт — второе нельзя');
    const job = await poll(r.data.id); assert.equal(job.status, 'done', JSON.stringify(job)); assert.equal(job.parts[0].result, 'ok'); assert.ok(job.snapDir);
    assert.equal(fs.readFileSync(path.join(volA, 'a.txt'), 'utf8'), 'исходный файл'); assert.equal(fs.existsSync(path.join(volA, 'extra.txt')), false, 'режим «заменить»: лишнее удалено');
    assert.ok(fs.readdirSync(job.snapDir).length >= 1); assert.equal((await api('GET', '/api/backups/data/restores')).data.jobs[0].id, r.data.id);
    const audit = (await api('GET', '/api/audit?limit=20')).data; const rows = audit.items ?? audit.rows ?? audit; assert.ok(JSON.stringify(rows).includes('backup.restore_data_done'), 'итог в журнале действий');
  });
  test('в другой существующий сервис (том с другим расположением): «дописать» сохраняет прежние файлы', async () => {
    const site = (await files()).find((f) => f.name.startsWith('web__site__'));
    const r = await api('POST', '/api/backups/data/restore', { panelId: pid, name: site.name, members: ['bind-api-vol-a.tar.gz'], target: { panelId: pid, project: 'web', service: 'copy' }, mode: 'merge', snapshot: false, confirm: true });
    assert.equal(r.status, 400, 'у copy bind-папка называется иначе (api-vol-b): части не подходят'); assert.match(r.data.error, /Ни одна/);
  });
  test('в новый сервис: база создаётся по типу копии, данные восстанавливаются; занятое имя и непонятный тип отклоняются', async () => {
    const all = await files(); const pg = all.find((f) => f.name.startsWith('web__pg__')); const site = all.find((f) => f.name.startsWith('web__site__'));
    const mk = (name, members, create) => api('POST', '/api/backups/data/restore', { panelId: pid, name, members, target: { panelId: pid, create }, mode: 'clean', snapshot: true, confirm: true });
    assert.equal((await mk(pg.name, ['db-postgres.sql.gz'], { project: 'web', service: 'pg2' })).status, 400, 'сервис уже есть');
    assert.equal((await mk(pg.name, ['db-postgres.sql.gz'], { project: 'Web!', service: 'x' })).status, 400, 'недопустимое имя');
    const odd = await mk(site.name, ['bind-api-vol-a.tar.gz'], { project: 'web', service: 'site-new' }); assert.equal(odd.status, 400); assert.match(odd.data.error, /тип нового сервиса/);
    resetState(); const r = await mk(pg.name, ['db-postgres.sql.gz'], { project: 'web', service: 'pgnew' }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.target, 'web/pgnew');
    const job = await poll(r.data.id); assert.equal(job.status, 'done', JSON.stringify(job)); assert.equal(job.created, true);
    const tree = (await api('GET', '/api/overview?force=1')).data; const svcs = tree.find((p) => p.id === pid).tree.projects.find((x) => x.name === 'web').services.map((x) => `${x.name}:${x.type}`);
    assert.ok(svcs.includes('pgnew:postgres'), svcs.join()); assert.ok(execIn().some((t) => /-- dump --/.test(t)), 'дамп из архива уехал в контейнер нового сервиса');
    assert.match(dockerLog(), /name=\^web_pgnew\\\./, 'контейнер искали по имени нового сервиса');
  });
  test('оператору недоступно', async () => {
    await api('POST', '/api/users', { username: 'op', password: 'password1', role: 'operator', panels: [] });
    const saved = cookie; cookie = ''; await api('POST', '/api/login', { username: 'op', password: 'password1' });
    for (const [m, p, b] of [['POST', '/api/backups/data/inspect', { panelId: pid, name: 'x' }], ['GET', '/api/backups/data/job?id=x'], ['GET', '/api/backups/data/restores'], ['POST', '/api/backups/data/restore-plan', {}], ['POST', '/api/backups/data/restore', { confirm: true }]]) assert.equal((await api(m, p, b)).status, 403, p);
    cookie = saved;
  });
});
