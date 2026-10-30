import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { HttpError, RawResponse, readJson } from './http.js';
import { runOnHost } from './host-exec.js';
import { shq } from './data-backup.js';

/**
 * Файловый менеджер хоста панели: все операции — короткие фиксированные скрипты через консоль хоста Easypanel (root).
 * Данные идут как base64 (вывод) и порциями в одну строку консоли (ввод, поэтому сжатым и кусками).
 * Доступно только администраторам; каждое изменение пишется в журнал.
 */
export const DEFAULT_PATH = '/etc/easypanel/projects';
export const READ_MAX = 5 * 1024 * 1024;
export const WRITE_MAX = 1024 * 1024;
export const UPLOAD_MAX = 4 * 1024 * 1024;
export const DOWNLOAD_MAX = 16 * 1024 * 1024;
const LIST_MAX = 5000;
const CHUNK = 3000;

/** Каталоги, которые нельзя удалять и переименовывать; плюс всё внутри виртуальных ФС. */
export const PROTECTED = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/home', '/opt', '/srv', '/usr/bin', '/usr/lib', '/usr/sbin', '/etc/easypanel', '/etc/easypanel/projects', '/var/lib', '/var/lib/docker', '/var/lib/docker/volumes'];
const VIRTUAL = ['/proc', '/sys', '/dev'];

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp' };
export const imageMime = (name) => MIME[extOf(name)] ?? null;

export const extOf = (name) => { const i = String(name).lastIndexOf('.'); return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : ''; };

/** Абсолютный нормализованный путь на хосте или 400. */
export function normPath(p, fallback) {
  const raw = p == null || p === '' ? fallback : p;
  if (typeof raw !== 'string' || !raw) throw new HttpError(400, 'Укажите путь');
  if (raw.length > 4096 || /[\u0000\r\n]/.test(raw)) throw new HttpError(400, 'Недопустимый путь');
  if (!raw.startsWith('/')) throw new HttpError(400, 'Путь должен быть абсолютным');
  return path.posix.normalize(raw).replace(/(.)\/+$/, '$1');
}
export const joinName = (dir, name) => {
  if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..' || /[/\u0000\r\n]/.test(name)) throw new HttpError(400, 'Недопустимое имя');
  return path.posix.join(dir, name);
};
export const isProtected = (p) => PROTECTED.includes(p) || VIRTUAL.some((v) => p.startsWith(`${v}/`));
const assertNotProtected = (p) => { if (isProtected(p)) throw new HttpError(403, 'Системный путь защищён от удаления и переименования'); };
export const parentOf = (p) => (p === '/' ? null : path.posix.dirname(p));

/** Разбор вывода list-скрипта: «F|тип|тип цели|размер|права|время|имя». Папки впереди, дальше по имени. */
export function parseList(output) {
  const items = [];
  const m = /^##L$([\s\S]*?)^##E$/m.exec(output);
  for (const line of (m ? m[1] : '').split('\n')) {
    const parts = line.replace(/\r/g, '').split('|');
    if (parts[0] !== 'F' || parts.length < 7) continue;
    const name = parts.slice(6).join('|');
    if (!name) continue;
    items.push({ name, isDir: parts[2] === 'd', isLink: parts[1] === 'l', size: Number(parts[3]) || 0, mode: parts[4], mtime: Math.round(Number(parts[5]) * 1000) || 0, ext: parts[2] === 'd' ? '' : extOf(name) });
  }
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) : a.isDir ? -1 : 1));
  return items;
}

const LIST_SCRIPT = (p) => `d=${shq(p)}; [ -d "$d" ] || { echo EA_NODIR; exit 2; }; printf '\\n##L\\n'; find "$d" -mindepth 1 -maxdepth 1 -printf 'F|%y|%Y|%s|%m|%T@|%f\\n' 2>/dev/null | head -n ${LIST_MAX}; printf '##E\\n'`;
const READ_SCRIPT = (p) => `f=${shq(p)}; [ -f "$f" ] || { echo EA_NOFILE; exit 2; }; s=$(stat -c %s "$f"); [ "$s" -le ${READ_MAX} ] || { echo EA_BIG; exit 3; }; printf '\\n##B64\\n'; base64 -w0 "$f"; printf '\\n##END\\n'`;
const DOWNLOAD_SCRIPT = (p, dir) => {
  const pack = dir
    ? `T=$(mktemp /tmp/.ea-dl.XXXXXX) || exit 1; trap 'rm -f "$T"' EXIT; tar czf "$T" -C "$(dirname "$f")" -- "$(basename "$f")" 2>/dev/null; `
    : 'T="$f"; ';
  return `f=${shq(p)}; ${dir ? '[ -d "$f" ]' : '[ -f "$f" ]'} || { echo EA_NOFILE; exit 2; }; ${pack}s=$(stat -c %s "$T"); [ "$s" -le ${DOWNLOAD_MAX} ] || { echo EA_BIG; exit 3; }; printf '\\n##B64\\n'; base64 -w0 "$T"; printf '\\n##END\\n'`;
};

const b64Of = (output) => { const m = /^##B64$\s*([A-Za-z0-9+/=\s]*?)\s*^##END$/m.exec(output); if (!m) throw new HttpError(502, 'Сервер вернул неполный ответ'); return Buffer.from(m[1].replace(/\s+/g, ''), 'base64'); };

/** Текст как есть, если это валидный UTF-8 без NUL; иначе base64 (для картинок и бинарников). */
export function decodeContent(buf) {
  if (!buf.includes(0)) { try { return { encoding: 'utf8', content: new TextDecoder('utf-8', { fatal: true }).decode(buf), binary: false }; } catch { /* не UTF-8 */ } }
  return { encoding: 'base64', content: buf.toString('base64'), binary: true };
}

const FAIL = { EA_NODIR: [404, 'Папка не найдена'], EA_NOFILE: [404, 'Файл не найден'], EA_NOENT: [404, 'Путь не найден'], EA_BIG: [413, 'Файл слишком большой'], EA_EXISTS: [409, 'Уже существует'], EA_ISDIR: [400, 'Это папка, а не файл'] };
/** Скрипт вернул ошибку: код EA_… из вывода превращается в понятный HTTP-ответ. */
function failure(r) {
  for (const [code, [status, msg]] of Object.entries(FAIL)) if (r.output.includes(code)) return new HttpError(status, msg);
  const tail = r.output.split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(-200);
  return new HttpError(502, tail ? `Ошибка на сервере: ${tail}` : 'Операция не удалась');
}

const MODE = /^[0-7]{3,4}$/;

export function filesRoutes(d) {
  const { manager, audit, panelOr404, assertPanel, hostRun } = d;
  const host = (c, row, script, o) => (hostRun ?? runOnHost)(c, row, script, o);
  const access = (ctx) => { const row = panelOr404(ctx.params.id); assertPanel(ctx, row.id); return { row, c: manager.clientFor(row) }; };
  const run = async (c, row, script, o) => { const r = await host(c, row, script, o); if (!r.ok) throw failure(r); return r; };
  const q = (ctx, name, fallback) => normPath(ctx.url.searchParams.get(name), fallback);
  const done = (ctx, row, action, target, detail) => audit(ctx, { action, panel: row, target, detail });

  /** Атомарная запись: сжатые куски во временный файл, затем распаковка рядом с целью и mv. */
  async function putFile(c, row, dest, buf, { overwrite = true } = {}) {
    const id = crypto.randomBytes(6).toString('hex'); const stage = `/tmp/.ea-up-${id}`; const dir = path.posix.dirname(dest);
    const chunks = zlib.gzipSync(buf).toString('base64').match(/.{1,3000}/g) ?? [];
    try {
      for (const [i, ch] of chunks.entries()) await run(c, row, `umask 077; printf %s ${shq(ch)} ${i ? '>>' : '>'} ${shq(stage)}`, { timeoutMs: 20_000 });
      if (!chunks.length) await run(c, row, `umask 077; : > ${shq(stage)}`, { timeoutMs: 20_000 });
      const guard = `p=${shq(dest)}; [ -d ${shq(dir)} ] || { echo EA_NODIR; exit 2; }; [ ! -d "$p" ] || { echo EA_ISDIR; exit 2; }; ${overwrite ? '' : '[ ! -e "$p" ] || { echo EA_EXISTS; exit 2; }; '}`;
      await run(c, row, `${guard}T=${shq(`${dir === '/' ? '' : dir}/.ea-tmp-${id}`)}; base64 -d ${shq(stage)} | gunzip > "$T" && { [ ! -e "$p" ] || { chmod --reference="$p" "$T"; chown --reference="$p" "$T"; } 2>/dev/null; true; } && mv -f "$T" "$p"; rc=$?; rm -f "$T" ${shq(stage)}; exit $rc`, { timeoutMs: 30_000 });
    } catch (e) { await host(c, row, `rm -f ${shq(stage)}`, { timeoutMs: 10_000 }).catch(() => {}); throw e; }
  }

  const ro = { admin: true };
  return [
    ['GET', '/api/panels/:id/files/list', async (ctx) => {
      const { row, c } = access(ctx); const p = q(ctx, 'path', DEFAULT_PATH);
      const r = await run(c, row, LIST_SCRIPT(p), { timeoutMs: 30_000 });
      const items = parseList(r.output);
      return { path: p, parent: parentOf(p), items, truncated: items.length >= LIST_MAX };
    }, ro],

    ['GET', '/api/panels/:id/files/read', async (ctx) => {
      const { row, c } = access(ctx); const p = q(ctx, 'path');
      const r = await run(c, row, READ_SCRIPT(p), { timeoutMs: 120_000 });
      const buf = b64Of(r.output);
      return { path: p, size: buf.length, mime: imageMime(p), ...decodeContent(buf) };
    }, ro],

    ['POST', '/api/panels/:id/files/write', async (ctx) => {
      const { row, c } = access(ctx); const body = await readJson(ctx.req, WRITE_MAX * 2 + 4096); const p = normPath(body.path);
      if (typeof body.content !== 'string') throw new HttpError(400, 'Нет содержимого');
      const buf = body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8');
      if (buf.length > WRITE_MAX) throw new HttpError(413, 'Файл слишком большой для редактора (максимум 1 МБ)');
      await putFile(c, row, p, buf);
      done(ctx, row, 'file.write', p, `${buf.length} Б`);
      return { ok: true, size: buf.length };
    }, { admin: true, raw: true }],

    ['POST', '/api/panels/:id/files/mkdir', async (ctx) => {
      const { row, c } = access(ctx); const p = joinName(normPath(ctx.body.path), ctx.body.name);
      await run(c, row, `p=${shq(p)}; [ ! -e "$p" ] || { echo EA_EXISTS; exit 2; }; mkdir -p -- "$p"`);
      done(ctx, row, 'file.mkdir', p);
      return { ok: true, path: p };
    }, ro],

    ['POST', '/api/panels/:id/files/touch', async (ctx) => {
      const { row, c } = access(ctx); const p = joinName(normPath(ctx.body.path), ctx.body.name);
      await run(c, row, `p=${shq(p)}; [ ! -e "$p" ] || { echo EA_EXISTS; exit 2; }; touch -- "$p"`);
      done(ctx, row, 'file.touch', p);
      return { ok: true, path: p };
    }, ro],

    ['POST', '/api/panels/:id/files/rename', async (ctx) => {
      const { row, c } = access(ctx); const from = normPath(ctx.body.oldPath); const to = normPath(ctx.body.newPath);
      assertNotProtected(from); assertNotProtected(to);
      if (from === to) throw new HttpError(400, 'Новый путь совпадает с прежним');
      await run(c, row, `a=${shq(from)}; b=${shq(to)}; [ -e "$a" ] || [ -L "$a" ] || { echo EA_NOENT; exit 2; }; [ ! -e "$b" ] || { echo EA_EXISTS; exit 2; }; mv -- "$a" "$b"`);
      done(ctx, row, 'file.rename', from, `→ ${to}`);
      return { ok: true, path: to };
    }, ro],

    ['POST', '/api/panels/:id/files/chmod', async (ctx) => {
      const { row, c } = access(ctx); const p = normPath(ctx.body.path); const mode = String(ctx.body.mode ?? '');
      if (!MODE.test(mode)) throw new HttpError(400, 'Права: 3–4 восьмеричные цифры, например 644');
      await run(c, row, `p=${shq(p)}; [ -e "$p" ] || { echo EA_NOENT; exit 2; }; chmod ${ctx.body.recursive ? '-R ' : ''}${mode} -- "$p"`);
      done(ctx, row, 'file.chmod', p, mode);
      return { ok: true };
    }, ro],

    ['DELETE', '/api/panels/:id/files', async (ctx) => {
      const { row, c } = access(ctx); const p = normPath(ctx.body.path);
      assertNotProtected(p);
      await run(c, row, `p=${shq(p)}; [ -e "$p" ] || [ -L "$p" ] || { echo EA_NOENT; exit 2; }; rm -rf -- "$p"`, { timeoutMs: 120_000 });
      done(ctx, row, 'file.delete', p);
      return { ok: true };
    }, ro],

    ['GET', '/api/panels/:id/files/download', async (ctx) => {
      const { row, c } = access(ctx); const p = q(ctx, 'path'); const dir = ctx.url.searchParams.get('archive') === '1';
      if (dir && p === '/') throw new HttpError(400, 'Корень целиком скачать нельзя');
      const r = await run(c, row, DOWNLOAD_SCRIPT(p, dir), { timeoutMs: 180_000 });
      const buf = b64Of(r.output); const base = path.posix.basename(p) || 'root';
      const name = dir ? `${base}.tar.gz` : base;
      done(ctx, row, 'file.download', p, `${buf.length} Б`);
      return new RawResponse(buf, dir ? 'application/gzip' : 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });
    }, ro],

    ['POST', '/api/panels/:id/files/upload', async (ctx) => {
      const { row, c } = access(ctx); const body = await readJson(ctx.req, Math.ceil(UPLOAD_MAX * 1.4) + 4096);
      const p = joinName(normPath(body.path), body.name);
      if (typeof body.content !== 'string') throw new HttpError(400, 'Нет содержимого');
      const buf = Buffer.from(body.content, 'base64');
      if (buf.length > UPLOAD_MAX) throw new HttpError(413, 'Файл слишком большой для загрузки (максимум 4 МБ)');
      await putFile(c, row, p, buf, { overwrite: !!body.overwrite });
      done(ctx, row, 'file.upload', p, `${buf.length} Б`);
      return { ok: true, path: p, size: buf.length };
    }, { admin: true, raw: true }],
  ];
}
