/* Чистые помощники файлового менеджера (без DOM — проверяются в test/files.test.js). */
export const DEFAULT_PATH = '/etc/easypanel/projects';
export const QUICK_JUMPS = [['Тома Easypanel', '/etc/easypanel/projects', 'box'], ['Docker тома', '/var/lib/docker/volumes', 'database'], ['Конфиги /etc', '/etc', 'settings'], ['Логи /var/log', '/var/log', 'fileText'], ['Корень /', '/', 'home']];
export const LIMITS = { edit: 1024 * 1024, upload: 4 * 1024 * 1024 };

const SETS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst'],
  script: ['sh', 'bash', 'zsh', 'py', 'js', 'mjs', 'ts', 'rb', 'pl', 'php', 'go', 'lua'],
  config: ['conf', 'cfg', 'ini', 'yml', 'yaml', 'json', 'toml', 'env', 'xml', 'service', 'timer', 'properties', 'lock'],
};
export const isImage = (name) => SETS.image.includes(String(name).split('.').pop().toLowerCase()) && String(name).includes('.');

/** Вид элемента списка: folder | image | archive | script | config | text | file. */
export function kindOf(it) {
  if (it.isDir) return 'folder';
  const ext = (it.ext ?? '').toLowerCase();
  for (const [kind, list] of Object.entries(SETS)) if (list.includes(ext)) return kind;
  if (['txt', 'md', 'log', 'csv', 'rst', 'list', ''].includes(ext)) return 'text';
  return 'file';
}
export const KIND_ICON = { folder: 'folder', image: 'image', archive: 'archive', script: 'fileCode', config: 'fileCode', text: 'fileText', file: 'file' };

/** [число строкой, единица]: единицу переводит вызывающий код. */
export function fmtSize(n) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = Number(n) || 0; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return [i === 0 || v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10), units[i]];
}

/** Права 755 / 4755 → rwxr-xr-x (спецбиты: s, t). */
export function rwx(mode) {
  const m = String(mode ?? '').padStart(4, '0'); if (!/^[0-7]{4}$/.test(m)) return '';
  const sp = Number(m[0]);
  return [1, 2, 3].map((k) => {
    const d = Number(m[k]); const x = d & 1;
    const last = k === 3 && sp & 1 ? (x ? 't' : 'T') : k === 2 && sp & 2 ? (x ? 's' : 'S') : k === 1 && sp & 4 ? (x ? 's' : 'S') : null;
    return (d & 4 ? 'r' : '-') + (d & 2 ? 'w' : '-') + (last ?? (x ? 'x' : '-'));
  }).join('');
}

export const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
export const baseName = (p) => p.replace(/\/+$/, '').split('/').pop() || '/';
/** «/a/b» → [{name:'/',path:'/'},{name:'a',path:'/a'},{name:'b',path:'/a/b'}] */
export function crumbs(p) {
  const out = [{ name: '/', path: '/' }]; let cur = '';
  for (const seg of p.split('/').filter(Boolean)) { cur += `/${seg}`; out.push({ name: seg, path: cur }); }
  return out;
}

export function bytesToB64(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Поиск в тексте: индексы всех совпадений (без пересечений). Пустой запрос → []. */
export function findAll(text, query, { matchCase = false, limit = 10000 } = {}) {
  if (!query) return [];
  const hay = matchCase ? text : text.toLowerCase(); const needle = matchCase ? query : query.toLowerCase();
  const out = [];
  for (let i = hay.indexOf(needle); i !== -1 && out.length < limit; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}
/** Индекс в списке совпадений, ближайшего к позиции pos в заданную сторону (по кругу); -1 — совпадений нет. */
export function pickMatch(matches, pos, dir = 1) {
  if (!matches.length) return -1;
  if (dir >= 0) { const i = matches.findIndex((m) => m >= pos); return i === -1 ? 0 : i; }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i] < pos) return i;
  return matches.length - 1;
}
/** Заменяет все совпадения; возвращает [новый текст, число замен]. */
export function replaceAllIn(text, query, repl, opts = {}) {
  const m = findAll(text, query, { ...opts, limit: Infinity });
  let out = ''; let last = 0;
  for (const i of m) { out += text.slice(last, i) + repl; last = i + query.length; }
  return [out + text.slice(last), m.length];
}
/** Номер строки (с 1) → индекс её начала в тексте; номер за пределами прижимается к диапазону. */
export function lineStart(text, line) {
  const n = Math.max(1, Math.floor(line) || 1); let idx = 0;
  for (let k = 1; k < n; k++) { const nl = text.indexOf('\n', idx); if (nl === -1) return idx; idx = nl + 1; }
  return idx;
}
export const dirOf = (p) => p.replace(/\/[^/]*\/*$/, '') || '/';
