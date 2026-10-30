import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decodeContent, extOf, isProtected, joinName, normPath, parentOf, parseList } from '../src/files.js';
import { createMockPanel } from './mock-easypanel.js';

describe('files: чистые функции', () => {
  test('normPath: нормализует, требует абсолютный путь, режет мусор', () => {
    assert.equal(normPath('/a/b/../c//d/'), '/a/c/d');
    assert.equal(normPath('/'), '/');
    assert.equal(normPath(undefined, '/etc/easypanel/projects'), '/etc/easypanel/projects');
    assert.throws(() => normPath('etc/passwd'), /абсолют/);
    assert.throws(() => normPath('/a\nb'), /Недопустимый/);
    assert.throws(() => normPath('/a\0b'), /Недопустимый/);
    assert.throws(() => normPath(''), /Укажите путь/);
  });
  test('joinName и parentOf', () => {
    assert.equal(joinName('/srv/x', 'f.txt'), '/srv/x/f.txt');
    for (const bad of ['', '.', '..', 'a/b', 'a\nb', 'x'.repeat(300), null]) assert.throws(() => joinName('/srv', bad), /Недопустимое имя/);
    assert.equal(parentOf('/'), null);
    assert.equal(parentOf('/a'), '/');
    assert.equal(parentOf('/a/b'), '/a');
  });
  test('isProtected: системные каталоги и виртуальные ФС', () => {
    for (const p of ['/', '/bin', '/boot', '/lib', '/usr', '/etc', '/sys', '/proc', '/proc/1', '/sys/kernel']) assert.ok(isProtected(p), p);
    for (const p of ['/etc/nginx', '/var/log', '/tmp/x', '/etc/easypanel/projects/app']) assert.ok(!isProtected(p), p);
  });
  test('extOf', () => {
    assert.equal(extOf('a.TXT'), 'txt'); assert.equal(extOf('.env'), ''); assert.equal(extOf('Makefile'), ''); assert.equal(extOf('a.tar.gz'), 'gz'); assert.equal(extOf('a.'), '');
  });
  test('parseList: папки первыми, имена с «|», мусор отбрасывается', () => {
    const out = ['$ echo', '##L', 'F|f|f|10|644|1700000000.5|b.txt', 'F|d|d|4096|755|1700000001.0|zdir', 'F|f|f|1|600|1700000002.0|we|ird', 'F|l|d|7|777|1700000003.0|link', 'junk', '##E'].join('\n');
    const items = parseList(out);
    assert.deepEqual(items.map((i) => i.name), ['link', 'zdir', 'b.txt', 'we|ird']);
    assert.equal(items[0].isLink, true); assert.equal(items[0].isDir, true);
    assert.deepEqual(items[2], { name: 'b.txt', isDir: false, isLink: false, size: 10, mode: '644', mtime: 1700000000500, ext: 'txt' });
    assert.deepEqual(parseList('нет маркеров'), []);
  });
  test('decodeContent: utf8 или base64', () => {
    assert.deepEqual(decodeContent(Buffer.from('привет')), { encoding: 'utf8', content: 'привет', binary: false });
    assert.equal(decodeContent(Buffer.from([0x89, 0x50, 0, 1])).encoding, 'base64');
    assert.equal(decodeContent(Buffer.from([0xff, 0xfe, 0x41])).encoding, 'base64');
  });
});

/* ---- API: скрипты выполняются настоящим bash в песочнице вместо консоли хоста ---- */
let app, base, tmp, panel, sandbox, cookie = ''; let pid;
const hostRun = async (c, row, script) => {
  const r = spawnSync('bash', ['-c', `( ${script} )`], { encoding: 'utf8', timeout: 20_000 });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
};
const api = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await res.arrayBuffer()); let data; try { data = JSON.parse(buf.toString()); } catch { data = buf; }
  return { status: res.status, data, headers: res.headers };
};
const F = (s) => `/api/panels/${pid}/files${s}`;

describe('files: API', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-files-')); sandbox = path.join(tmp, 'sb'); fs.mkdirSync(sandbox);
    panel = createMockPanel({ token: 'T', seed: {} }); const url = await panel.listen();
    app = createApp({ config: { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false }, db: openDb(tmp), key: crypto.randomBytes(32), hostRun });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
    await api('POST', '/api/setup', { username: 'admin', password: 'password1' });
    await api('POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
    pid = (await api('POST', '/api/panels', { name: 'P', url, token: 'T' })).data.id;
  });
  after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); await panel.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('mkdir/touch/list: папки впереди, права и размер', async () => {
    assert.equal((await api('POST', F('/mkdir'), { path: sandbox, name: 'conf d' })).status, 200);
    assert.equal((await api('POST', F('/touch'), { path: sandbox, name: 'a.txt' })).status, 200);
    assert.equal((await api('POST', F('/mkdir'), { path: sandbox, name: 'a.txt' })).status, 409);
    assert.equal((await api('POST', F('/mkdir'), { path: sandbox, name: '../x' })).status, 400);
    const r = await api('GET', F(`/list?path=${encodeURIComponent(sandbox)}`));
    assert.equal(r.status, 200);
    assert.equal(r.data.path, sandbox); assert.equal(r.data.parent, tmp);
    assert.deepEqual(r.data.items.map((i) => [i.name, i.isDir]), [['conf d', true], ['a.txt', false]]);
    assert.equal(r.data.items[1].size, 0); assert.match(r.data.items[1].mode, /^[0-7]{3,4}$/); assert.ok(r.data.items[1].mtime > 1e12);
    assert.equal((await api('GET', F(`/list?path=${encodeURIComponent(path.join(sandbox, 'нет'))}`))).status, 404);
    assert.equal((await api('GET', F('/list?path=relative'))).status, 400);
  });

  test('write → read: юникод, атомарная замена, права сохраняются', async () => {
    const f = path.join(sandbox, 'a.txt'); fs.chmodSync(f, 0o640);
    const text = 'строка 1\n# 配置 \'quote\' "dq" $HOME `x`\n'.repeat(300);
    assert.equal((await api('POST', F('/write'), { path: f, content: text })).status, 200);
    assert.equal(fs.readFileSync(f, 'utf8'), text);
    assert.equal(fs.statSync(f).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(sandbox).filter((n) => n.startsWith('.ea-tmp')), []);
    const r = await api('GET', F(`/read?path=${encodeURIComponent(f)}`));
    assert.equal(r.data.encoding, 'utf8'); assert.equal(r.data.content, text); assert.equal(r.data.size, Buffer.byteLength(text));
    assert.equal((await api('POST', F('/write'), { path: sandbox, content: 'x' })).status, 400); // это папка
    assert.equal((await api('POST', F('/write'), { path: path.join(sandbox, 'no/dir/f'), content: 'x' })).status, 404);
    assert.equal((await api('POST', F('/write'), { path: f, content: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
  });

  test('read: бинарные данные приходят в base64, большие и отсутствующие файлы — ошибки', async () => {
    const bin = path.join(sandbox, 'i.png'); const bytes = crypto.randomBytes(500); bytes[0] = 0; fs.writeFileSync(bin, bytes);
    const r = await api('GET', F(`/read?path=${encodeURIComponent(bin)}`));
    assert.equal(r.data.encoding, 'base64'); assert.equal(r.data.mime, 'image/png'); assert.ok(Buffer.from(r.data.content, 'base64').equals(bytes));
    const big = path.join(sandbox, 'big.bin'); fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, 5 * 1024 * 1024 + 1);
    assert.equal((await api('GET', F(`/read?path=${encodeURIComponent(big)}`))).status, 413);
    assert.equal((await api('GET', F(`/read?path=${encodeURIComponent(path.join(sandbox, 'nope'))}`))).status, 404);
  });

  test('rename, chmod', async () => {
    const a = path.join(sandbox, 'a.txt'); const b = path.join(sandbox, 'b.txt');
    assert.equal((await api('POST', F('/rename'), { oldPath: a, newPath: b })).status, 200);
    assert.ok(fs.existsSync(b) && !fs.existsSync(a));
    assert.equal((await api('POST', F('/rename'), { oldPath: a, newPath: b })).status, 404);
    fs.writeFileSync(a, ''); assert.equal((await api('POST', F('/rename'), { oldPath: a, newPath: b })).status, 409);
    assert.equal((await api('POST', F('/rename'), { oldPath: '/etc', newPath: '/etc2' })).status, 403);
    assert.equal((await api('POST', F('/chmod'), { path: b, mode: '600' })).status, 200);
    assert.equal(fs.statSync(b).mode & 0o777, 0o600);
    assert.equal((await api('POST', F('/chmod'), { path: b, mode: '999' })).status, 400);
    assert.equal((await api('POST', F('/chmod'), { path: b, mode: '1; rm -rf /' })).status, 400);
  });

  test('upload: файл в папку, перезапись только по флагу', async () => {
    const bytes = crypto.randomBytes(20_000);
    const up = (extra = {}) => api('POST', F('/upload'), { path: sandbox, name: 'up.bin', content: bytes.toString('base64'), ...extra });
    assert.equal((await up()).status, 200);
    assert.ok(fs.readFileSync(path.join(sandbox, 'up.bin')).equals(bytes));
    assert.equal((await up()).status, 409);
    assert.equal((await up({ overwrite: true })).status, 200);
    assert.equal((await api('POST', F('/upload'), { path: sandbox, name: 'a/b', content: '' })).status, 400);
    assert.equal((await api('POST', F('/upload'), { path: sandbox, name: 'empty', content: '' })).status, 200);
    assert.equal(fs.statSync(path.join(sandbox, 'empty')).size, 0);
  });

  test('download: файл и папка архивом tar.gz', async () => {
    const f = path.join(sandbox, 'up.bin');
    const r = await api('GET', F(`/download?path=${encodeURIComponent(f)}`));
    assert.equal(r.status, 200); assert.ok(r.data.equals(fs.readFileSync(f))); assert.match(r.headers.get('content-disposition'), /attachment; filename="up\.bin"/);
    const z = await api('GET', F(`/download?path=${encodeURIComponent(sandbox)}&archive=1`));
    assert.equal(z.status, 200); assert.match(z.headers.get('content-disposition'), /sb\.tar\.gz/);
    assert.deepEqual([...z.data.subarray(0, 2)], [0x1f, 0x8b]);
    assert.equal((await api('GET', F(`/download?path=${encodeURIComponent(sandbox)}`))).status, 404); // каталог без archive=1
  });

  test('delete: файлы и папки удаляются, системные пути защищены', async () => {
    const d = path.join(sandbox, 'conf d'); fs.writeFileSync(path.join(d, 'x'), '1');
    assert.equal((await api('DELETE', F(''), { path: d })).status, 200);
    assert.ok(!fs.existsSync(d));
    assert.equal((await api('DELETE', F(''), { path: d })).status, 404);
    for (const p of ['/', '/bin', '/boot', '/lib', '/usr', '/etc', '/sys', '/proc', '/etc/', '/etc/../etc', '/proc/self']) assert.equal((await api('DELETE', F(''), { path: p })).status, 403, p);
    assert.equal((await api('DELETE', F(''), {})).status, 400);
  });

  test('доступ: только администратор', async () => {
    const saved = cookie; cookie = '';
    assert.equal((await api('GET', F('/list'))).status, 401);
    await api('POST', '/api/login', { username: 'op', password: 'password1' });
    assert.equal((await api('GET', F('/list'))).status, 403);
    assert.equal((await api('DELETE', F(''), { path: sandbox })).status, 403);
    cookie = saved; assert.ok(fs.existsSync(sandbox));
  });
});

describe('files: помощники интерфейса', () => {
  test('fmtSize, rwx, kindOf, crumbs, joinPath, base64', async () => {
    const u = await import('../public/js/files-util.js');
    assert.deepEqual(u.fmtSize(0), ['0', 'Б']); assert.deepEqual(u.fmtSize(1536), ['1.5', 'КБ']); assert.deepEqual(u.fmtSize(5 * 1024 ** 2), ['5', 'МБ']);
    assert.deepEqual(u.fmtSize(3.5 * 1024 ** 3), ['3.5', 'ГБ']); assert.deepEqual(u.fmtSize(200 * 1024), ['200', 'КБ']);
    assert.equal(u.rwx('755'), 'rwxr-xr-x'); assert.equal(u.rwx('644'), 'rw-r--r--'); assert.equal(u.rwx('4755'), 'rwsr-xr-x'); assert.equal(u.rwx('1777'), 'rwxrwxrwt'); assert.equal(u.rwx('zz'), '');
    const k = (name, isDir = false) => u.kindOf({ name, isDir, ext: isDir ? '' : extOf(name) });
    assert.deepEqual(['d', 'a.png', 'a.tgz', 'run.sh', 'app.yml', 'notes.md', 'Makefile', 'a.bin'].map((n) => k(n, n === 'd')), ['folder', 'image', 'archive', 'script', 'config', 'text', 'text', 'file']);
    assert.ok(u.isImage('x.SVG')); assert.ok(!u.isImage('png')); assert.ok(!u.isImage('a.txt'));
    assert.deepEqual(u.crumbs('/'), [{ name: '/', path: '/' }]);
    assert.deepEqual(u.crumbs('/etc/easypanel'), [{ name: '/', path: '/' }, { name: 'etc', path: '/etc' }, { name: 'easypanel', path: '/etc/easypanel' }]);
    assert.equal(u.joinPath('/', 'a'), '/a'); assert.equal(u.joinPath('/a', 'b'), '/a/b'); assert.equal(u.baseName('/a/b/'), 'b');
    const big = crypto.randomBytes(100_000);
    assert.ok(Buffer.from(u.b64ToBytes(u.bytesToB64(big))).equals(big));
    assert.deepEqual(u.QUICK_JUMPS.map((q) => q[1]), ['/etc/easypanel/projects', '/var/lib/docker/volumes', '/etc', '/var/log', '/']);
  });
});

describe('files: поиск, замена и переход к строке', () => {
  test('findAll, pickMatch, replaceAllIn, lineStart, dirOf', async () => {
    const u = await import('../public/js/files-util.js');
    assert.deepEqual(u.findAll('Foo foo FOO', 'foo'), [0, 4, 8]);
    assert.deepEqual(u.findAll('Foo foo FOO', 'foo', { matchCase: true }), [4]);
    assert.deepEqual(u.findAll('aaaa', 'aa'), [0, 2]); assert.deepEqual(u.findAll('abc', ''), []);
    assert.equal(u.pickMatch([], 0), -1);
    assert.equal(u.pickMatch([2, 10, 20], 5, 1), 1); assert.equal(u.pickMatch([2, 10, 20], 25, 1), 0);
    assert.equal(u.pickMatch([2, 10, 20], 10, -1), 0); assert.equal(u.pickMatch([2, 10, 20], 1, -1), 2);
    assert.deepEqual(u.replaceAllIn('a-b-A', 'a', 'x'), ['x-b-x', 2]); assert.deepEqual(u.replaceAllIn('abc', 'z', 'x'), ['abc', 0]);
    assert.equal(u.lineStart('ab\ncd\nef', 1), 0); assert.equal(u.lineStart('ab\ncd\nef', 3), 6); assert.equal(u.lineStart('ab\ncd', 99), 3);
    assert.equal(u.dirOf('/etc/nginx/nginx.conf'), '/etc/nginx'); assert.equal(u.dirOf('/a'), '/'); assert.equal(u.dirOf('/'), '/');
  });
});
