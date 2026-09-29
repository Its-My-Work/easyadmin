import http from 'node:http';
import https from 'node:https';

const PROC = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_BYTES = 32 * 1024 * 1024;

export class PanelError extends Error {
  constructor(message, { kind = 'error', status } = {}) {
    super(message);
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
          const err = json?.error;
          if (err) {
            const code = err.json?.data?.code ?? err.data?.code;
            const msg = err.json?.message ?? err.message ?? 'Ошибка панели';
            const auth = code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || status === 401 || status === 403;
            return finish(reject, new PanelError(msg, { kind: auth ? 'auth' : 'error', status }));
          }
          if (status >= 300 && status < 400) {
            return finish(reject, new PanelError(`Панель перенаправляет на ${res.headers.location || '?'} — укажите итоговый адрес (обычно https://)`, { status }));
          }
          if (status === 401 || status === 403) return finish(reject, new PanelError('Токен отклонён панелью', { kind: 'auth', status }));
          if (status >= 400) return finish(reject, new PanelError(`HTTP ${status} (${proc}): ${data.slice(0, 160)}`, { status }));
          if (json === undefined) return finish(reject, new PanelError('Ответ не похож на API Easypanel (проверьте адрес)', { status }));
          const payload = json?.result?.data;
          finish(resolve, payload && typeof payload === 'object' && 'json' in payload ? payload.json : (json?.result ? null : json));
        });
      });
      req.on('error', (e) => finish(reject, new PanelError(e.code === 'ECONNREFUSED' ? 'Соединение отклонено' : e.message, { kind: 'network' })));
      const timer = setTimeout(() => { req.destroy(); finish(reject, new PanelError(`Таймаут ${this.timeoutMs} мс (${proc})`, { kind: 'timeout' })); }, this.timeoutMs);
      if (body) req.write(body);
      req.end();
    });
  }
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
  const projects = new Map();
  const ensure = (name) => {
    if (!projects.has(name)) projects.set(name, { name, services: [] });
    return projects.get(name);
  };
  const projArr = Array.isArray(raw) ? raw : Array.isArray(raw?.projects) ? raw.projects : [];
  const svcArr = Array.isArray(raw?.services) ? raw.services : [];
  const addSvc = (pname, s) => {
    const name = s.name ?? s.serviceName;
    if (!name) return;
    const p = ensure(pname);
    if (p.services.some((x) => x.name === name)) return;
    p.services.push({
      project: pname, name,
      type: s.type ?? s.kind ?? 'app',
      enabled: s.enabled !== false,
      domain: s.domain ?? s.primaryDomain ?? null,
    });
  };
  for (const p of projArr) {
    const name = p?.name ?? p?.projectName;
    if (!name) continue;
    ensure(name);
    for (const s of p.services ?? []) addSvc(name, s);
  }
  for (const s of svcArr) addSvc(s.projectName ?? s.project ?? '—', s);
  const list = [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  list.forEach((p) => p.services.sort((a, b) => a.name.localeCompare(b.name)));
  return { projects: list };
}

export function normalizeStats(s) {
  if (!s || typeof s !== 'object') return null;
  return {
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
    settle(client.query('ports.listPorts', ref)),
    settle(client.query('mounts.listMounts', ref)),
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
  domainAdd: (c, r, _s, p) => c.mutate('domains.createDomain', {
    ...r, host: p.host, https: p.https !== false, port: num(p.port) ?? 80, path: p.path || '/',
  }),
  domainDelete: (c, r, _s, p) => c.mutate('domains.deleteDomain', { ...r, id: p.id, domainId: p.id }),
  portAdd: (c, r, _s, p) => c.mutate('ports.createPort', {
    ...r, published: num(p.published), target: num(p.target), publishedPort: num(p.published), targetPort: num(p.target),
    protocol: p.protocol === 'udp' ? 'udp' : 'tcp',
  }),
  portDelete: (c, r, _s, p) => c.mutate('ports.deletePort', { ...r, id: p.id, portId: p.id }),
  mountAdd: (c, r, _s, p) => c.mutate('mounts.createMount', {
    ...r, type: p.type || 'volume', name: p.name, mountPath: p.mountPath, hostPath: p.hostPath, content: p.content,
  }),
  mountDelete: (c, r, _s, p) => c.mutate('mounts.deleteMount', { ...r, id: p.id, mountId: p.id }),
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
