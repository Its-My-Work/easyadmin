import http from 'node:http';
import https from 'node:https';

const PROC = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_BYTES = 32 * 1024 * 1024;

export class PanelError extends Error {
  constructor(message, { kind = 'error', status, body } = {}) {
    super(message);
    this.body = body;
    this.kind = kind; // 'auth' | 'network' | 'timeout' | 'error'
    this.status = status;
  }
}

/** Нормализует введённый адрес панели: без хвостовых слэшей и /api/trpc. */
export function normalizeUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error('Некорректный URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Разрешены только http и https');
  return (u.origin + u.pathname.replace(/\/api\/trpc\/?$/, '').replace(/\/+$/, ''));
}

/** Тонкий клиент tRPC (superjson-конверт) для Easypanel. Редиректы не следуем — иначе утечёт токен. */
export class PanelClient {
  constructor({ url, token, insecure = false, timeoutMs = 15_000 }) {
    this.base = url.replace(/\/+$/, '');
    this.token = token || null;
    this.timeoutMs = timeoutMs;
    this.agent = insecure && url.startsWith('https:') ? new https.Agent({ rejectUnauthorized: false }) : undefined;
  }

  query(proc, input) { return this.#call('GET', proc, input); }
  mutate(proc, input = {}) { return this.#call('POST', proc, input); }

  #call(method, proc, input) {
    if (!PROC.test(proc)) return Promise.reject(new PanelError(`Недопустимое имя процедуры: ${proc}`));
    let url = `${this.base}/api/trpc/${proc}`;
    let body;
    if (method === 'GET' && input !== undefined) url += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    if (method === 'POST') body = JSON.stringify({ json: input ?? {} });
    return this.#request(method, url, proc, body);
  }

  #request(method, url, proc, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (body) headers['Content-Length'] = Buffer.byteLength(body);
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
      const req = mod.request(u, { method, headers, agent: this.agent }, (res) => {
        res.setEncoding('utf8');
        let data = '', size = 0;
        res.on('data', (c) => {
          size += Buffer.byteLength(c);
          if (size > MAX_BYTES) { req.destroy(); return finish(reject, new PanelError('Ответ панели слишком большой')); }
          data += c;
        });
        res.on('error', (e) => finish(reject, new PanelError(e.message, { kind: 'network' })));
        res.on('end', () => {
          const status = res.statusCode || 0;
          let json; try { json = JSON.parse(data); } catch { /* не JSON */ }
          // ошибка: {error:{json:{message,data:{code}}}} либо (у части версий) сразу {json:{message,code,status,defined}}
          const flat = json?.json && typeof json.json === 'object' && typeof json.json.message === 'string' && ('code' in json.json || 'status' in json.json) ? json.json : null;
          const err = json?.error ?? (flat ? { json: { message: flat.message, data: { code: flat.code } } } : null);
          if (err) {
            const code = err.json?.data?.code ?? err.data?.code ?? err.json?.code ?? err.code;
            // без текста ошибки показываем код и кусок ответа — иначе причину не понять (и диагностика бесполезна)
            const msg = err.json?.message ?? err.message ?? `Ошибка панели (${code ?? status ?? '?'}): ${data.slice(0, 160)}`;
            const auth = code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || status === 401 || status === 403;
            return finish(reject, new PanelError(msg, { kind: auth ? 'auth' : 'error', status, body: data.slice(0, 600) }));
          }
          if (status >= 300 && status < 400) {
            return finish(reject, new PanelError(`Панель перенаправляет на ${res.headers.location || '?'} — укажите итоговый адрес (обычно https://)`, { status }));
          }
          if (status === 401 || status === 403) return finish(reject, new PanelError('Токен отклонён панелью', { kind: 'auth', status }));
          if (status >= 400) return finish(reject, new PanelError(`HTTP ${status} (${proc}): ${data.slice(0, 160)}`, { status }));
          if (json === undefined) return finish(reject, new PanelError('Ответ не похож на API Easypanel (проверьте адрес)', { status }));
          const payload = json?.result?.data;
          // superjson: {result:{data:{json}}}; без superjson: {result:{data}}; void-процедура: {result:{}} → null
          const value = payload && typeof payload === 'object' && !Array.isArray(payload) && 'json' in payload ? payload.json : (json?.result ? (payload ?? null) : json);
          finish(resolve, unwrapJson(value));
        });
      });
      req.on('error', (e) => finish(reject, new PanelError(e.code === 'ECONNREFUSED' ? 'Соединение отклонено' : e.message, { kind: 'network' })));
      const timer = setTimeout(() => { req.destroy(); finish(reject, new PanelError(`Таймаут ${this.timeoutMs} мс (${proc})`, { kind: 'timeout' })); }, this.timeoutMs);
      if (body) req.write(body);
      req.end();
    });
  }
}

/** Некоторые панели оборачивают ответ дважды: {json:{json:X}} — снимаем лишние слои {json, meta?}. */
export function unwrapJson(v) {
  for (let i = 0; i < 4 && v && typeof v === 'object' && !Array.isArray(v) && 'json' in v && Object.keys(v).every((k) => k === 'json' || k === 'meta'); i++) v = v.json;
  return v;
}

/** Вход по email/паролю: возвращает сессионный токен (живёт ~30 дней). */
export async function loginToPanel({ url, email, password, insecure, timeoutMs }) {
  const c = new PanelClient({ url, insecure, timeoutMs });
  const r = await c.mutate('auth.login', { email, password });
  if (!r?.token) throw new PanelError('Панель не вернула токен (включена 2FA?)');
  return r.token;
}

/* ------------------------------------------------------------------ */
/* Нормализация ответов (форма ответа проверяется защитно)             */
/* ------------------------------------------------------------------ */

export const SERVICE_TYPES = ['app', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'compose'];
export const DB_TYPES = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];

/** Приводит ответ projects.listProjectsAndServices к { projects: [{name, services: [...]}] }. */
export function normalizeTree(raw) {
  raw = unwrap(raw);
  const projects = new Map();
  const ensure = (name) => {
    if (!projects.has(name)) projects.set(name, { name, services: [] });
    return projects.get(name);
  };
  const addSvc = (pname, s) => {
    const name = s?.name ?? s?.serviceName;
    if (!name) return;
    const p = ensure(pname);
    if (p.services.some((x) => x.name === name)) return;
    p.services.push({
      project: pname, name: String(name),
      type: String(s.type ?? s.kind ?? s.serviceType ?? 'app'),
      enabled: s.enabled !== false && s.disabled !== true,
      domain: s.domain ?? s.primaryDomain ?? null,
    });
  };
  const fill = (projArr, svcArr) => {
    for (const p of projArr) {
      const name = p?.name ?? p?.projectName;
      if (!name) continue;
      ensure(String(name));
      for (const s of p.services ?? []) addSvc(String(name), s);
    }
    for (const s of svcArr) addSvc(String(s?.projectName ?? s?.project ?? s?.projectId ?? '—'), s);
  };
  fill(Array.isArray(raw) ? raw : Array.isArray(raw?.projects) ? raw.projects : [], Array.isArray(raw?.services) ? raw.services : []);
  if (!projects.size) { // другая форма ответа: ищем массивы проектов/сервисов в глубине
    const { projs, svcs } = scan(raw);
    fill(projs, svcs);
  }
  const list = [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  list.forEach((p) => p.services.sort((a, b) => a.name.localeCompare(b.name)));
  return { projects: list };
}

/** Снимает обёртки вида {json: …} / {data: …} / {result: …}. */
function unwrap(v) {
  for (let i = 0; i < 3 && v && typeof v === 'object' && !Array.isArray(v); i++) {
    const keys = Object.keys(v);
    if (keys.length === 1 && ['json', 'data', 'result'].includes(keys[0])) v = v[keys[0]]; else break;
  }
  return v;
}

/** Поиск массивов объектов с полем name на глубину до 4: с type/projectName — сервисы, иначе — проекты. */
function scan(v, depth = 0, out = { projs: [], svcs: [] }) {
  if (depth > 4 || v == null || typeof v !== 'object') return out;
  if (Array.isArray(v)) {
    const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && (x.name ?? x.serviceName));
    if (objs.length && objs.length === v.length) {
      if (objs.some((x) => x.type || x.projectName || x.project)) out.svcs.push(...objs); else out.projs.push(...objs);
      return out;
    }
    v.forEach((x) => scan(x, depth + 1, out));
    return out;
  }
  Object.values(v).forEach((x) => scan(x, depth + 1, out));
  return out;
}

/** Краткое описание формы значения (без данных) — для диагностики. */
export function shapeOf(v, d = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.length ? shapeOf(v[0], d + 1) : ''}]×${v.length}`;
  if (typeof v === 'object') return d > 2 ? '{…}' : `{${Object.entries(v).slice(0, 14).map(([k, x]) => `${k}: ${shapeOf(x, d + 1)}`).join(', ')}}`;
  return typeof v;
}

const SECRET = /pass|secret|token|key|env|credential|auth|cookie|connection|url|uri/i;
/** Копия значения без секретов — безопасно показывать администратору и отправлять в отчёт. */
export function redact(v, d = 0) {
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => redact(x, d + 1)).concat(v.length > 3 ? [`… +${v.length - 3} more`] : []);
  if (v && typeof v === 'object') return d > 5 ? '{…}' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) && typeof x !== 'object' ? '***' : redact(x, d + 1)]));
  return typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}…` : v;
}

/**
 * Best-effort: сопоставляет контейнеры Docker с сервисами по имени вида `проект_сервис[.N|-N…]`.
 * Признак `health` ставится, только если схема имён подтвердилась хотя бы на одном сервисе —
 * иначе (другая версия панели/формат) ничего не выдумываем.
 */
export function applyHealth(tree, containers) {
  const list = Array.isArray(containers) ? containers : Array.isArray(containers?.containers) ? containers.containers : null;
  if (!list?.length) return tree;
  const items = list.map((c) => ({
    name: String(c?.name ?? c?.Name ?? c?.Names?.[0] ?? c?.serviceName ?? '').replace(/^\//, ''),
    running: /running|up\b/i.test(String(c?.state ?? c?.State ?? c?.status ?? c?.Status ?? '')),
  })).filter((c) => c.name);
  const all = tree.projects.flatMap((p) => p.services);
  const found = new Map(); // service → {seen, running}
  for (const c of items) {
    let best = null;
    for (const s of all) {
      const prefix = `${s.project}_${s.name}`;
      if (c.name === prefix || (c.name.startsWith(prefix) && /^[.\-]/.test(c.name.slice(prefix.length)))) {
        if (!best || prefix.length > `${best.project}_${best.name}`.length) best = s;
      }
    }
    if (best) { const f = found.get(best) ?? { running: false }; f.running ||= c.running; found.set(best, f); }
  }
  if (!found.size) return tree;
  for (const s of all) {
    if (!s.enabled) continue;
    const f = found.get(s);
    s.health = !f ? 'missing' : f.running ? 'running' : 'failing';
  }
  return tree;
}

/** Статистика в известном виде ({cpuInfo, memInfo, diskInfo…}); если поля не нашлись — «нечёткий» разбор произвольной формы. */
export function normalizeStats(s) {
  s = unwrapJson(s);
  if (!s || typeof s !== 'object') return null;
  const std = {
    uptime: s.uptime ?? null,
    cpu: s.cpuInfo?.usedPercentage ?? null,
    cpus: s.cpuInfo?.count ?? null,
    load: s.cpuInfo?.loadavg ?? null,
    memPct: s.memInfo?.usedMemPercentage ?? null,
    memUsedMb: s.memInfo?.usedMemMb ?? null,
    memTotalMb: s.memInfo?.totalMemMb ?? null,
    diskPct: s.diskInfo?.usedPercentage ?? null,
    diskUsedGb: s.diskInfo?.usedGb ?? null,
    diskTotalGb: s.diskInfo?.totalGb ?? null,
    netIn: s.network?.inputMb ?? null,
    netOut: s.network?.outputMb ?? null,
  };
  return looksLikeStats(std) ? std : { ...std, ...Object.fromEntries(Object.entries(fuzzyStats(s)).filter(([, v]) => v != null)) };
}

export const looksLikeStats = (st) => [st?.cpu, st?.memPct, st?.diskPct].filter((x) => x != null).length >= 2;

const asNum = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : null);
function findKey(v, re, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 4) return null;
  for (const [k, x] of Object.entries(v)) if (re.test(k)) return [k, x];
  for (const x of Object.values(v)) if (x && typeof x === 'object') { const r = findKey(x, re, depth + 1); if (r) return r; }
  return null;
}
function percentFrom(node) {
  if (asNum(node) != null) return asNum(node);
  if (!node || typeof node !== 'object') return null;
  for (const [k, x] of Object.entries(node)) if (/percent|pct|usage|load/i.test(k) && !/mb|gb|byte/i.test(k) && asNum(x) != null) return asNum(x);
  const used = asNum(findKey(node, /^used/i)?.[1]), total = asNum(findKey(node, /^total|^limit/i)?.[1]);
  return used != null && total ? (used / total) * 100 : null;
}
const amount = (node, re, unit) => { const r = node && typeof node === 'object' ? findKey(node, re) : null; return r && asNum(r[1]) != null && unit.test(r[0]) ? asNum(r[1]) : null; };

/** Разбор статистики произвольной формы: ищет вложенные cpu / memory / disk по названиям ключей. */
export function fuzzyStats(v) {
  v = unwrapJson(v);
  if (!v || typeof v !== 'object') return {};
  const cpu = findKey(v, /cpu|processor/i)?.[1], mem = findKey(v, /^(mem|memory|ram)|meminfo/i)?.[1], disk = findKey(v, /disk|storage|filesystem|^fs$/i)?.[1];
  const up = asNum(findKey(v, /uptime/i)?.[1]);
  return {
    uptime: up, cpu: percentFrom(cpu), cpus: asNum(findKey(cpu, /^(count|cores?|cpus)$/i)?.[1]), load: null,
    memPct: percentFrom(mem), memUsedMb: amount(mem, /^used/i, /mb$/i), memTotalMb: amount(mem, /^total/i, /mb$/i),
    diskPct: percentFrom(disk), diskUsedGb: amount(disk, /^used/i, /gb$/i), diskTotalGb: amount(disk, /^total/i, /gb$/i),
    netIn: null, netOut: null,
  };
}

/**
 * Имена процедур из интерфейса самой панели: разбираем её JS-бандлы (как делает сам фронтенд).
 * Нужно, когда в новой версии панели процедуры переименованы. Возвращает уникальные имена «роутер.процедура».
 */
export async function discoverProcedures(baseUrl, { insecure = false, timeoutMs = 10_000 } = {}) {
  const agent = insecure && baseUrl.startsWith('https:') ? new https.Agent({ rejectUnauthorized: false }) : undefined;
  const get = (url, max = 8 * 1024 * 1024) => new Promise((resolve) => {
    const u = new URL(url); const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { agent, timeout: timeoutMs, headers: { Accept: '*/*' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(''); }
      res.setEncoding('utf8'); let data = '';
      res.on('data', (c) => { data += c; if (data.length > max) { req.destroy(); resolve(data); } });
      res.on('end', () => resolve(data)); res.on('error', () => resolve(''));
    });
    req.on('timeout', () => { req.destroy(); resolve(''); }); req.on('error', () => resolve(''));
  });
  const base = baseUrl.replace(/\/+$/, '/');
  const html = await get(base, 1024 * 1024);
  const scripts = [...new Set([...html.matchAll(/(?:src|href)=[\x22\x27]([^\x22\x27]+\.js[^\x22\x27]*)[\x22\x27]/g)].map((m) => m[1]))].slice(0, 10);
  const names = new Set();
  const VERB = /^(get|list|create|update|delete|remove|set|enable|disable|start|stop|restart|deploy|destroy|inspect|run|check|refresh|expose|kill|use|load|send|generate|revoke|activate|deactivate|rename|can|add|subscribe)[A-Z0-9]/;
  for (const src of scripts) {
    let url; try { url = new URL(src, base); } catch { continue; }
    if (url.origin !== new URL(base).origin) continue; // только собственные файлы панели
    for (const m of (await get(url.toString())).matchAll(/[\x22\x27\x60]([a-z][A-Za-z0-9]{2,30})\.([a-z][A-Za-z0-9]{2,50})[\x22\x27\x60]/g)) if (VERB.test(m[2])) names.add(`${m[1]}.${m[2]}`);
  }
  return [...names].sort();
}

/* ------------------------------------------------------------------ */
/* Операции над сервисами (единая точка соответствия процедурам API)   */
/* ------------------------------------------------------------------ */

const isDb = (t) => DB_TYPES.includes(t);
const svcProc = (type, op) => `services.${type}.${op}`;

export function assertType(type) {
  if (!SERVICE_TYPES.includes(type)) throw new PanelError(`Неизвестный тип сервиса: ${type}`);
}

export const ACTIONS = ['deploy', 'start', 'stop', 'restart', 'destroy'];

export async function runAction(client, { type, project, name, action }) {
  assertType(type);
  const ref = { projectName: project, serviceName: name };
  const db = isDb(type);
  switch (action) {
    case 'deploy':
      if (db) throw new PanelError('Деплой неприменим к базам данных');
      return client.mutate(svcProc(type, 'deployService'), ref);
    case 'start': return client.mutate(svcProc(type, db ? 'enableService' : 'startService'), ref);
    case 'stop': return client.mutate(svcProc(type, db ? 'disableService' : 'stopService'), ref);
    case 'restart':
      if (db) { await client.mutate(svcProc(type, 'disableService'), ref); return client.mutate(svcProc(type, 'enableService'), ref); }
      return client.mutate(svcProc(type, 'restartService'), ref);
    case 'destroy': return client.mutate(svcProc(type, 'destroyService'), ref);
    default: throw new PanelError(`Неизвестное действие: ${action}`);
  }
}

export async function inspectService(client, { type, project, name }) {
  assertType(type);
  const ref = { projectName: project, serviceName: name };
  const settle = (p) => p.then((value) => ({ value }), (e) => ({ error: e.message }));
  const [service, domains, ports, mounts] = await Promise.all([
    settle(client.query(svcProc(type, 'inspectService'), ref)),
    settle(client.query('domains.listDomains', ref)),
    // у Compose порты и тома описаны в compose-файле, отдельных процедур панель для них не принимает («Invalid service type»)
    type === 'compose' ? Promise.resolve({ value: [] }) : settle(client.query('ports.listPorts', { ...ref, type })),
    type === 'compose' ? Promise.resolve({ value: [] }) : settle(client.query('mounts.listMounts', { ...ref, type })),
  ]);
  if (service.error) throw new PanelError(service.error);
  return {
    service: service.value,
    domains: domains.value ?? [],
    ports: ports.value ?? [],
    mounts: mounts.value ?? [],
    warnings: [domains, ports, mounts].filter((x) => x.error).map((x) => x.error),
  };
}

const plain = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});

/**
 * Монтирование: у разных версий панели поле `type` — либо тип сервиса (а свойства монтирования вложены в `mount`),
 * либо тип монтирования (volume|bind|file). Пробуем оба варианта; ошибка первого показывается, если не подошёл ни один.
 */
function mountVariants(r, s, p, o, id) {
  const mt = p.type ?? o.type ?? 'volume';
  const flat = { name: p.name ?? o.name, mountPath: p.mountPath ?? o.mountPath, hostPath: p.hostPath ?? o.hostPath, content: p.content ?? o.content };
  const idf = id != null ? { id, mountId: id } : {};
  return [
    { ...o, ...r, ...idf, ...flat, type: s.type, mount: { type: mt, ...flat } },
    { ...o, ...r, ...idf, ...flat, serviceType: s.type, type: mt },
  ];
}

/** Выполняет мутацию, пробуя варианты входных данных, пока не пройдёт валидация панели. */
export async function firstOk(c, proc, variants) {
  let first;
  for (const [i, body] of variants.entries()) {
    try { return await c.mutate(proc, body); } catch (e) {
      first ??= e;
      const retry = i < variants.length - 1 && !['auth', 'network', 'timeout'].includes(e.kind) && (e.status === 400 || /invalid|expected|required/i.test(e.message));
      if (!retry) throw first;
    }
  }
  throw first;
}

const num = (v) => (v === '' || v == null ? undefined : Number(v));

/** Белый список тонких операций; params приходят из UI. */
export const SERVICE_OPS = {
  env: (c, r, { type }, p) => c.mutate(svcProc(type, 'updateEnv'), { ...r, env: String(p.env ?? '') }),
  resources: (c, r, { type }, p) => c.mutate(svcProc(type, 'updateResources'), {
    ...r, memoryLimit: num(p.memoryLimit), memoryReservation: num(p.memoryReservation),
    cpuLimit: num(p.cpuLimit), cpuReservation: num(p.cpuReservation),
  }),
  sourceImage: (c, r, { type }, p) => c.mutate(svcProc(type, 'updateSourceImage'), { ...r, image: String(p.image) }),
  sourceGithub: (c, r, { type }, p) => c.mutate(svcProc(type, 'updateSourceGithub'), {
    ...r, owner: p.owner, repo: p.repo, ref: p.branch || 'main', branch: p.branch || 'main', path: p.path || '/',
  }),
  sourceGit: (c, r, { type }, p) => c.mutate(svcProc(type, 'updateSourceGit'), { ...r, repo: String(p.repo), ref: p.branch || 'main', branch: p.branch || 'main', path: p.path || '/' }),
  domainAdd: (c, r, _s, p) => c.mutate('domains.createDomain', {
    ...r, host: p.host, https: p.https !== false, port: num(p.port) ?? 80, path: p.path || '/',
  }),
  domainUpdate: (c, r, _s, p) => {
    // отправляем исходный объект целиком (на случай полей, о которых мы не знаем) + правки
    const o = plain(p.original); const id = p.id ?? o.id ?? o._id;
    const dk = ['serviceDestination', 'destination', 'service'].find((k) => o[k] && typeof o[k] === 'object');
    const port = num(p.port) ?? o.port ?? o[dk]?.port; const path = p.path ?? o.path ?? o[dk]?.path ?? '/';
    const body = { ...o, ...r, id, domainId: id, host: p.host ?? o.host, https: p.https ?? o.https, path };
    if (dk) body[dk] = { ...o[dk], port, path }; else body.port = port;
    return c.mutate('domains.updateDomain', body);
  },
  domainDelete: (c, r, _s, p) => c.mutate('domains.deleteDomain', { ...r, id: p.id, domainId: p.id }),
  portAdd: (c, r, s, p) => c.mutate('ports.createPort', {
    ...r, type: s.type, published: num(p.published), target: num(p.target), publishedPort: num(p.published), targetPort: num(p.target),
    protocol: p.protocol === 'udp' ? 'udp' : 'tcp',
  }),
  portUpdate: (c, r, s, p) => {
    const o = plain(p.original); const id = p.id ?? o.id ?? o._id;
    const published = num(p.published) ?? o.published; const target = num(p.target) ?? o.target;
    return c.mutate('ports.updatePort', { ...o, ...r, type: s.type, id, portId: id, published, target, publishedPort: published, targetPort: target, protocol: p.protocol === 'udp' ? 'udp' : (p.protocol === 'tcp' ? 'tcp' : o.protocol ?? 'tcp') });
  },
  portDelete: (c, r, s, p) => c.mutate('ports.deletePort', { ...r, type: s.type, id: p.id, portId: p.id }),
  mountAdd: (c, r, s, p) => firstOk(c, 'mounts.createMount', mountVariants(r, s, p, {})),
  mountUpdate: (c, r, s, p) => {
    const o = plain(p.original); const id = p.id ?? o.id ?? o._id;
    return firstOk(c, 'mounts.updateMount', mountVariants(r, s, p, o, id));
  },
  mountDelete: (c, r, s, p) => c.mutate('mounts.deleteMount', { ...r, type: s.type, id: p.id, mountId: p.id }),
  notes: (c, r, _s, p) => c.mutate('common.setNotes', { ...r, notes: String(p.notes ?? '') }),
};

export function runServiceOp(client, op, { type, project, name }, params = {}) {
  assertType(type);
  const fn = SERVICE_OPS[op];
  if (!fn) throw new PanelError(`Неизвестная операция: ${op}`);
  return fn(client, { projectName: project, serviceName: name }, { type }, params);
}

export function createService(client, { type, project, name, image, password }) {
  assertType(type);
  const ref = { projectName: project, serviceName: name, name };
  if (type === 'app') return client.mutate(svcProc('app', 'createService'), { ...ref, ...(image ? { source: { type: 'image', image } } : {}) });
  if (type === 'compose') return client.mutate(svcProc('compose', 'createService'), ref);
  return client.mutate(svcProc(type, 'createService'), { ...ref, ...(password ? { password } : {}) });
}

export const SYSTEM_OPS = {
  prune: (c) => c.mutate('settings.systemPrune'),
  cleanupImages: (c) => c.mutate('settings.cleanupDockerImages'),
  restartPanel: (c) => c.mutate('settings.restartEasypanel'),
  reboot: (c) => c.mutate('server.reboot'),
};
