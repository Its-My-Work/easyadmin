import crypto from 'node:crypto';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { parseYaml } from './yaml-lite.js';

/**
 * Каталог шаблонов Easypanel (https://github.com/easypanel-io/templates).
 *  - список: templates/list.json;
 *  - карточка и форма: templates/<slug>/meta.yaml;
 *  - схема сервисов: функция generate(input) из templates/<slug>/index.ts.
 * generate — обычный небольшой TypeScript-код, поэтому мы его выполняем сами: типы вырезаются, код запускается в пустом
 * vm-контексте (нет process, require, fetch; eval/Function запрещены, случайность передаётся строкой), с таймаутом.
 * Результат — тот же {services:[{type,data}]}, что принимает templates.createFromSchema в панели.
 */

const SLUG = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const LOGO = /^[\w.-]{1,80}\.(png|svg|jpe?g|gif|webp)$/i;
const MIME = { png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const UTILS = new Set(['Output', 'Services', 'randomString', 'randomPassword']);
const MAX_FILE = 6 * 1024 * 1024;

export class CatalogError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Разбор импортов и подготовка TypeScript к запуску. Бросает CatalogError, если шаблону нужно что-то, чего у нас нет. */
export function prepareTemplateSource(ts) {
  const source = String(ts);
  if (source.length > 300_000) throw new CatalogError('Код шаблона слишком большой', 422);
  const IMPORT = /^[ \t]*import\s+(type\s+)?([\s\S]*?)\s+from\s+(['"])([^'"]+)\3\s*;?[ \t]*$/gm;
  let unsupported = null;
  const code = source.replace(IMPORT, (_all, isType, spec, _q, mod) => {
    if (isType || mod === './meta') return ''; // типы формы
    if (mod === '~templates-utils') {
      const names = spec.replace(/[{}]/g, '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      const bad = names.find((n) => !UTILS.has(n));
      if (bad) unsupported ??= `нужна функция ${bad}, которой нет в нашем окружении`;
      return '';
    }
    if (mod === 'crypto' || mod === 'node:crypto') {
      const names = spec.replace(/[{}]/g, '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      const bad = names.find((n) => n !== 'randomBytes');
      if (bad) unsupported ??= `нужна криптография (${bad}), которой нет в нашем окружении`;
      return '';
    }
    unsupported ??= `подключает внешний модуль «${mod}»`;
    return '';
  });
  if (unsupported) throw new CatalogError(`Шаблон пока не поддерживается: ${unsupported}`, 422);
  if (/^\s*import\s/m.test(code) || /\bimport\s*\(/.test(code)) throw new CatalogError('Шаблон пока не поддерживается: динамические импорты', 422);
  const req = [...code.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
  if (req.some((m) => m !== 'crypto' && m !== 'node:crypto') || (/\brequire\s*\(/.test(code) && !req.length)) throw new CatalogError('Шаблон пока не поддерживается: подключает внешний модуль', 422);
  if (/\b(createECDH|createHash|createHmac|createCipheriv|scryptSync|pbkdf2Sync|generateKeyPair|createSign)\b/.test(code)) throw new CatalogError('Шаблон пока не поддерживается: нужна криптография (ключи, хеши), которой нет в нашем окружении', 422);
  if (/\bprocess\./.test(code)) throw new CatalogError('Шаблон пока не поддерживается: обращается к окружению процесса', 422);
  if (!/export\s+(async\s+)?function\s+generate\b/.test(code)) throw new CatalogError('В шаблоне нет функции generate', 422);
  let js;
  try { js = stripTypeScriptTypes(code.replace(/\bexport\s+(?=(async\s+)?function\b|const\b|let\b)/g, ''), { mode: 'strip' }); } catch (e) { throw new CatalogError(`Шаблон пока не поддерживается: ${String(e.message).split('\n')[0]}`, 422); }
  return js;
}

const HELPERS = `
const __e = __entropy; let __p = 0;
const __byte = () => { if (__p >= __e.length - 1) __p = 0; const v = parseInt(__e.slice(__p, __p + 2), 16); __p += 2; return v; };
const randomString = (length = 10) => { const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'; let r = ''; for (let i = 0; i < length; i++) { let b; do { b = __byte(); } while (b >= 252); r += chars[b % 36]; } return r; };
const randomPassword = () => randomString(20);
const __b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const btoa = (s) => { s = String(s); let out = ''; for (let i = 0; i < s.length; i += 3) { const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2); if (a > 255 || b > 255 || c > 255) throw new Error('Invalid character'); const n = (a << 16) | ((b || 0) << 8) | (c || 0); out += __b64[(n >> 18) & 63] + __b64[(n >> 12) & 63] + (i + 1 < s.length ? __b64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? __b64[n & 63] : '='); } return out; };
const atob = (s) => { s = String(s).replace(/=+$/, ''); let out = '', bits = 0, acc = 0; for (const ch of s) { const v = __b64.indexOf(ch); if (v < 0) throw new Error('Invalid character'); acc = (acc << 6) | v; bits += 6; if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); } } return out; };
const __hex = (bin) => { let h = ''; for (let i = 0; i < bin.length; i++) h += (bin.charCodeAt(i) < 16 ? '0' : '') + bin.charCodeAt(i).toString(16); return h; };
const __wrap = (bin) => ({ length: bin.length, toString: (enc = 'utf8') => (enc === 'base64' ? btoa(bin) : enc === 'hex' ? __hex(bin) : enc === 'base64url' ? btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '') : decodeURIComponent(escape(bin))) });
const Buffer = { from: (s, enc) => __wrap(enc === 'base64' ? atob(s) : enc === 'hex' ? String(s).replace(/../g, (h) => String.fromCharCode(parseInt(h, 16))) : unescape(encodeURIComponent(String(s)))) };
const randomBytes = (n) => { let bin = ''; for (let i = 0; i < n; i++) bin += String.fromCharCode(__byte()); return __wrap(bin); };
const require = (m) => { if (m === 'crypto' || m === 'node:crypto') return { randomBytes }; throw new Error('Cannot find module ' + m); };
`;

/** Запуск generate(input) в изолированном контексте; наружу выходит только JSON-строка. */
export function runGenerate(js, input, { timeoutMs = 2000 } = {}) {
  const ctx = vm.createContext(Object.create(null), { name: 'easypanel-template', codeGeneration: { strings: false, wasm: false } });
  ctx.__entropy = crypto.randomBytes(8192).toString('hex'); // только примитивы: объекты хоста дали бы путь к его Function
  ctx.__input = JSON.stringify(input ?? {});
  let out;
  try {
    out = vm.runInContext(`'use strict';\n${HELPERS}\n${js}\nJSON.stringify(generate(JSON.parse(__input)))`, ctx, { timeout: timeoutMs, filename: 'template.js' });
  } catch (e) {
    const msg = /timed out/i.test(e.message) ? 'Шаблон выполнялся слишком долго' : `Ошибка в коде шаблона: ${String(e.message).split('\n')[0]}`;
    throw new CatalogError(msg, 422);
  }
  if (typeof out !== 'string' || out.length > 2_000_000) throw new CatalogError('Шаблон вернул некорректный результат', 422);
  return JSON.parse(out);
}

const SERVICE_TYPES = ['app', 'compose', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
export function checkSchema(schema) {
  if (!schema || !Array.isArray(schema.services) || !schema.services.length || schema.services.length > 30) throw new CatalogError('Шаблон вернул схему без сервисов', 422);
  for (const s of schema.services) {
    if (!s || !SERVICE_TYPES.includes(s.type) || typeof s.data?.serviceName !== 'string' || !/^[a-z0-9_-]{1,63}$/i.test(s.data.serviceName)) throw new CatalogError('Шаблон вернул сервис с некорректным типом или именем', 422);
  }
  return schema;
}

/** Поля формы из schema.properties метаданных. */
export function formFields(meta) {
  const props = meta?.schema?.properties ?? {};
  const required = new Set(meta?.schema?.required ?? []);
  return Object.entries(props).map(([name, p]) => {
    const options = Array.isArray(p.oneOf) ? p.oneOf.map((o) => ({ value: o.enum?.[0] ?? o.const, label: o.title ?? String(o.enum?.[0] ?? o.const) }))
      : Array.isArray(p.enum) ? p.enum.map((v, i) => ({ value: v, label: p.enumNames?.[i] ?? String(v) })) : null;
    const type = p.type === 'integer' ? 'integer' : p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string';
    return {
      name, title: p.title ?? name, type, default: p.default ?? null, description: p.description ?? null, required: required.has(name),
      options, showIf: p.showIf ?? null, secret: p.format === 'password' || p.secret === true || p.sensitive === true, format: p.format ?? null,
      min: p.minimum ?? null, max: p.maximum ?? null,
    };
  });
}

/** Значения формы → input для generate: типы, значения по умолчанию, обязательные поля, допустимые варианты. */
export function buildInput(fields, values = {}) {
  const input = {};
  for (const f of fields) {
    let v = values[f.name];
    if (v === undefined || v === null || v === '') v = f.default ?? undefined;
    if (v === undefined || v === '') {
      if (f.required && f.type !== 'boolean') throw new CatalogError(`Поле «${f.title}» обязательно`);
      if (f.type === 'boolean') input[f.name] = false; else if (f.type === 'string' && f.default === '') input[f.name] = '';
      continue;
    }
    if (f.type === 'boolean') v = v === true || v === 'true' || v === 1 || v === '1';
    else if (f.type === 'number' || f.type === 'integer') {
      v = Number(v);
      if (!Number.isFinite(v) || (f.type === 'integer' && !Number.isInteger(v))) throw new CatalogError(`Поле «${f.title}» должно быть числом`);
      if (f.min != null && v < f.min) throw new CatalogError(`Поле «${f.title}»: не меньше ${f.min}`);
      if (f.max != null && v > f.max) throw new CatalogError(`Поле «${f.title}»: не больше ${f.max}`);
    } else {
      v = String(v);
      if (v.length > 4000) throw new CatalogError(`Поле «${f.title}» слишком длинное`);
    }
    if (f.options && !f.options.some((o) => o.value === v)) throw new CatalogError(`Поле «${f.title}»: недопустимое значение`);
    input[f.name] = v;
  }
  return input;
}

export function createCatalog({ base, fetchImpl = fetch, ttlMs = 6 * 3600_000, timeoutMs = 20_000 }) {
  const root = String(base).replace(/\/+$/, '');
  let listCache = null;
  const detailCache = new Map();

  async function read(rel) {
    let res;
    try { res = await fetchImpl(`${root}/${rel}`, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'EasyAdmin' } }); } catch (e) { throw new CatalogError(`Не удалось загрузить каталог: ${e.cause?.code ?? e.message}`, 502); }
    if (res.status === 404) throw new CatalogError('Шаблон не найден в каталоге', 404);
    if (!res.ok) throw new CatalogError(`Каталог ответил ${res.status}`, 502);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_FILE) throw new CatalogError('Файл каталога слишком большой', 502);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE) throw new CatalogError('Файл каталога слишком большой', 502);
    return buf;
  }

  async function list({ force = false } = {}) {
    if (!force && listCache && Date.now() - listCache.at < ttlMs) return listCache;
    const raw = JSON.parse((await read('list.json')).toString('utf8'));
    if (!Array.isArray(raw)) throw new CatalogError('Каталог в неожиданном формате', 502);
    const items = raw.filter((x) => x && SLUG.test(String(x.slug))).map((x) => ({
      slug: x.slug, name: String(x.name ?? x.slug), description: String(x.description ?? '').replace(/\s+/g, ' ').slice(0, 260),
      tags: Array.isArray(x.tags) ? x.tags.map(String).slice(0, 12) : [], logo: LOGO.test(String(x.logo)) ? x.logo : null,
    }));
    const tags = new Map();
    for (const it of items) for (const t of it.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    listCache = { at: Date.now(), items, tags: [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })) };
    detailCache.clear();
    return listCache;
  }

  async function entry(slug) {
    if (!SLUG.test(String(slug))) throw new CatalogError('Некорректное название шаблона');
    const it = (await list()).items.find((x) => x.slug === slug);
    if (!it) throw new CatalogError('Шаблон не найден в каталоге', 404);
    return it;
  }

  async function details(slug) {
    const it = await entry(slug);
    const hit = detailCache.get(slug);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const [metaBuf, codeBuf] = await Promise.all([read(`${slug}/meta.yaml`), read(`${slug}/index.ts`)]);
    let meta;
    try { meta = parseYaml(metaBuf.toString('utf8')); } catch (e) { throw new CatalogError(`Не удалось разобрать описание шаблона: ${e.message}`, 502); }
    let supported = true; let reason = null;
    try { prepareTemplateSource(codeBuf.toString('utf8')); } catch (e) { if (!(e instanceof CatalogError)) throw e; supported = false; reason = e.message; }
    const links = Array.isArray(meta.links) ? meta.links.filter((l) => l?.url && /^https?:\/\//i.test(l.url)).map((l) => ({ label: String(l.label ?? l.url), url: l.url })) : [];
    const value = {
      ...it, name: String(meta.name ?? it.name), description: String(meta.description ?? it.description).replace(/\s+/g, ' ').trim(),
      instructions: meta.instructions ? String(meta.instructions).trim() : null, links, tags: it.tags,
      fields: formFields(meta), supported, reason,
      _code: codeBuf.toString('utf8'),
    };
    detailCache.set(slug, { at: Date.now(), value });
    if (detailCache.size > 200) detailCache.delete(detailCache.keys().next().value);
    return value;
  }

  const publicDetails = (d) => { const { _code, ...rest } = d; return rest; };

  /** Схема сервисов для выбранных значений формы. */
  async function schemaFor(slug, values) {
    const d = await details(slug);
    if (!d.supported) throw new CatalogError(d.reason, 422);
    const input = buildInput(d.fields, values);
    return { schema: checkSchema(runGenerate(prepareTemplateSource(d._code), input)), template: publicDetails(d) };
  }

  async function logo(slug) {
    const it = await entry(slug);
    if (!it.logo) throw new CatalogError('У шаблона нет логотипа', 404);
    const ext = it.logo.split('.').pop().toLowerCase();
    return { body: await read(`${slug}/assets/${it.logo}`), type: MIME[ext] ?? 'application/octet-stream' };
  }

  return { list, details: async (slug) => publicDetails(await details(slug)), schemaFor, logo };
}
