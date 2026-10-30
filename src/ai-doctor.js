import crypto from 'node:crypto';
import { decrypt, encrypt } from './crypto.js';
import { HttpError, SECURITY_HEADERS, StreamResponse } from './http.js';
import { extractLines, logSocketCandidates, openWebSocket } from './ws.js';

/**
 * AI Doctor: собирает контекст сбоя сервиса, вырезает секреты, спрашивает любую OpenAI-совместимую модель
 * (OpenAI, OmniRoute, DeepSeek, Ollama, Groq …) и потоком (SSE) отдаёт разбор: что случилось, причина, решение.
 */

export const CACHE_TTL_MS = 3600_000;
export const LANGS = { ru: 'Russian', en: 'English', zh: 'Simplified Chinese', de: 'German', es: 'Spanish', pt: 'Portuguese' };
export const ACTIONS_ALLOWED = ['restart', 'start'];
const MAX_LOG_LINES = 150;
const MAX_LOG_CHARS = 12_000;

/* ---------------- санитайзер секретов ---------------- */

const KEY_WORDS = '(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth(?:orization)?|credential|signature|cookie|session[_-]?id|dsn)';
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[PRIVATE KEY REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[JWT]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[TOKEN]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}/g, '[TOKEN]'],
  // схема://пользователь:пароль@хост
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/gi, '$1***@'],
  // "password": "…", password=…, TOKEN: …
  [new RegExp(`("[^"\\s]*${KEY_WORDS}[^"\\s]*"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), '$1"***"'],
  [new RegExp(`(\\b[\\w.-]*${KEY_WORDS}[\\w.-]*\\s*[=:]\\s*)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;&"']+)`, 'gi'), '$1***'],
  // значения .env: ИМЯ_ПЕРЕМЕННОЙ=значение
  [/^(\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}=)(?:"[^"\n]*"|'[^'\n]*'|\S+).*$/gm, '$1***'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  // IPv6 (полные и сжатые формы) — до IPv4, чтобы не задеть «::ffff:1.2.3.4» частично
  [/(?<![\w:.])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi, '[IP]'],
  [/(?<![\w:.])(?:[0-9a-f]{1,4}:){1,6}(?::[0-9a-f]{1,4}){1,6}(?![\w:])|(?<![\w:.])(?:[0-9a-f]{1,4}:){1,7}:(?![\w:])/gi, '[IP]'],
  // IPv4; локальные 127.* и 0.0.0.0 оставляем — они нужны для диагностики («ECONNREFUSED 127.0.0.1:5432»)
  [/(?<![\w.])(?!127\.|0\.0\.0\.0(?![\d.]))(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\w.]*\w)/g, '[IP]'],
  // длинные случайные строки (ключи, хэши): буквы + цифры, 40+ символов
  [/(?<![\w-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![\w-])/g, '[REDACTED]'],
];

/** Вырезает из текста секреты и IP-адреса. `extra` — точные значения (токены панели, ключ AI), которые нужно скрыть в любом виде. */
export function sanitize(text, { extra = [] } = {}) {
  let out = String(text ?? '');
  for (const v of extra) if (typeof v === 'string' && v.length >= 6) out = out.split(v).join('***');
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

/* ---------------- контекст сбоя ---------------- */

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Хвост лога: без ANSI, подряд идущие дубликаты свёрнуты, ограничение по строкам и символам (берутся последние). */
export function tailLines(lines, { maxLines = MAX_LOG_LINES, maxChars = MAX_LOG_CHARS } = {}) {
  const out = [];
  let prev = null, n = 0;
  const flush = () => { if (n > 1) out[out.length - 1] += `  (x${n})`; };
  for (const raw of lines) {
    const line = String(raw).replace(ANSI, '').trimEnd().slice(0, 600);
    if (!line) continue;
    if (line === prev) { n++; continue; }
    flush(); out.push(line); prev = line; n = 1;
  }
  flush();
  let res = out.slice(-maxLines);
  while (res.join('\n').length > maxChars && res.length > 1) res = res.slice(1);
  return res;
}

/** Код завершения и состояние контейнера из ответа docker: «Exited (137) 2 minutes ago», State/Status/ExitCode. */
export function parseContainer(c) {
  if (!c || typeof c !== 'object') return null;
  const state = String(c.State?.Status ?? c.State ?? c.state ?? '').toLowerCase();
  const status = String(c.Status ?? c.status ?? '');
  let exitCode = c.ExitCode ?? c.exitCode ?? c.State?.ExitCode ?? null;
  const m = /\bexited\s*\((-?\d+)\)/i.exec(status);
  if (exitCode == null && m) exitCode = Number(m[1]);
  if (exitCode != null) exitCode = Number(exitCode);
  const restarts = Number(c.RestartCount ?? c.restartCount ?? 0) || 0;
  const oom = c.State?.OOMKilled === true || exitCode === 137;
  return { name: String(c.Names?.[0] ?? c.name ?? c.Name ?? '').replace(/^\//, ''), state: state || 'unknown', status, exitCode: Number.isFinite(exitCode) ? exitCode : null, restarts, oomSuspected: !!oom };
}

const EXIT_HINTS = { 0: 'clean exit', 1: 'application error', 125: 'docker run failed', 126: 'command not executable', 127: 'command not found', 137: 'killed (SIGKILL, often out-of-memory)', 139: 'segmentation fault', 143: 'terminated (SIGTERM)' };

/** Текстовое описание контекста для модели. Все данные уже прошли через sanitize(). */
export function renderContext(ctx) {
  const lines = [`Service: ${ctx.project}/${ctx.service} (type: ${ctx.type ?? 'unknown'})`];
  lines.push(`Enabled in panel: ${ctx.enabled == null ? 'unknown' : ctx.enabled ? 'yes' : 'no'}; health: ${ctx.health ?? 'unknown'}`);
  const cs = ctx.containers ?? [];
  if (!cs.length) lines.push('Containers: none found');
  for (const c of cs) lines.push(`Container ${c.name || '?'}: state=${c.state}${c.status ? `, status="${c.status}"` : ''}${c.exitCode != null ? `, exit code ${c.exitCode} (${EXIT_HINTS[c.exitCode] ?? 'unknown'})` : ''}${c.restarts ? `, restarts=${c.restarts}` : ''}${c.oomSuspected ? ', OOM suspected' : ''}`);
  if (ctx.metrics) lines.push(`Resources (latest sample): CPU ${fmt(ctx.metrics.cpu, '%')}, RAM ${fmt(ctx.metrics.mem, ' MB')}${ctx.metrics.memMax != null ? `, RAM peak ${fmt(ctx.metrics.memMax, ' MB')}` : ''}`);
  lines.push('', `Last ${ctx.logs.length} log lines:`, ctx.logs.length ? ctx.logs.join('\n') : '(no logs available)');
  return lines.join('\n');
}
const fmt = (v, unit) => (v == null ? 'n/a' : `${Math.round(v * 10) / 10}${unit}`);

/** Хвост логов сервиса через WebSocket панели: ждём первый пакет, затем затишье. */
export async function fetchLogTail(client, row, { project, service, compose = false }, { paths, openWs = openWebSocket, idleMs = 700, maxMs = 4000 } = {}) {
  const lines = [];
  for (const url of logSocketCandidates(client.base, { project, name: service, token: client.token, paths, compose })) {
    let ws;
    try { ws = await openWs(url, { headers: { Authorization: `Bearer ${client.token}`, Origin: new URL(client.base).origin }, insecure: !!row.insecure_tls }); } catch { continue; }
    await new Promise((resolve) => {
      let idle;
      const done = () => { clearTimeout(idle); clearTimeout(cap); resolve(); };
      const cap = setTimeout(done, maxMs);
      const arm = () => { clearTimeout(idle); idle = setTimeout(done, idleMs); };
      ws.on('message', (m) => { lines.push(...extractLines(m)); arm(); });
      ws.on('close', done); ws.on('error', done);
      idle = setTimeout(done, idleMs * 3);
    });
    try { ws.close(); } catch { /* уже закрыт */ }
    if (lines.length) break;
  }
  return lines;
}

/**
 * Собирает контекст сбоя: хвост логов, состояние контейнера и код завершения, расход RAM/CPU.
 * Любой источник — best-effort: недоступный не мешает диагностике.
 */
export async function collectContext({ client, row, service: svc, db, logs, paths, extraSecrets = [] }) {
  const { project, name, type } = svc;
  const [rawLogs, containers] = await Promise.all([
    (logs ?? fetchLogTail)(client, row, { project, service: name, compose: type === 'compose' }, { paths }).catch(() => []),
    Promise.resolve(client.query('projects.getDockerContainers', { service: `${project}_${name}` })).catch(() => null),
  ]);
  const list = (Array.isArray(containers) ? containers : containers?.containers ?? []).map(parseContainer).filter(Boolean);
  let metrics = null;
  try {
    const m = db?.prepare('SELECT cpu, mem, mem_max memMax FROM svc_metrics WHERE panel_id = ? AND project = ? AND service = ? ORDER BY ts DESC LIMIT 1').get(row.id, project, name);
    if (m) metrics = { cpu: m.cpu, mem: m.mem, memMax: m.memMax };
  } catch { /* таблицы метрик нет */ }
  const ctx = { project, service: name, type, enabled: svc.enabled ?? null, health: svc.health ?? null, containers: list, metrics, logs: tailLines(rawLogs) };
  const text = sanitize(renderContext(ctx), { extra: [client.token, ...extraSecrets] });
  return { ...ctx, logs: sanitize(ctx.logs.join('\n'), { extra: [client.token, ...extraSecrets] }).split('\n').filter(Boolean), text };
}

/** Есть ли в контексте признаки сбоя (иначе диагностировать нечего, а токены тратить зря). */
export const looksFailing = (ctx) => ctx.enabled === false || ctx.health === 'failing' || ctx.health === 'missing'
  || ctx.containers.some((c) => c.state !== 'running' || (c.exitCode != null && c.exitCode !== 0))
  || ctx.logs.some((l) => /\b(error|fatal|panic|exception|fail(ed)?|denied|refused|timeout|oom|killed)\b/i.test(l));

/* ---------------- кэш повторных ошибок ---------------- */

/** Отпечаток ошибки: служба + код выхода + хвост лога без времён, чисел и идентификаторов — одинаковый сбой даёт один хэш. */
export function fingerprint(ctx, { model = '', lang = 'en' } = {}) {
  const norm = ctx.logs.slice(-40).map((l) => l
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const body = JSON.stringify([ctx.project, ctx.service, ctx.containers.map((c) => [c.state, c.exitCode]), norm, model, lang]);
  return crypto.createHash('sha256').update(body).digest('hex');
}

export function createDiagnosisCache(db, { ttlMs = CACHE_TTL_MS, now = Date.now } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS ai_diagnoses (hash TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL)');
  return {
    get(hash) {
      const r = db.prepare('SELECT content, created_at FROM ai_diagnoses WHERE hash = ?').get(hash);
      if (!r) return null;
      if (now() - r.created_at >= ttlMs) { db.prepare('DELETE FROM ai_diagnoses WHERE hash = ?').run(hash); return null; }
      return r;
    },
    put(hash, content) {
      db.prepare('DELETE FROM ai_diagnoses WHERE created_at < ?').run(now() - ttlMs);
      db.prepare('INSERT OR REPLACE INTO ai_diagnoses (hash, content, created_at) VALUES (?,?,?)').run(hash, content, now());
    },
  };
}

/* ---------------- настройки провайдера ---------------- */

const K = { endpoint: 'ai_endpoint', model: 'ai_model', key: 'ai_key_enc' };
const getSetting = (db, k) => db.prepare('SELECT v FROM settings WHERE k = ?').get(k)?.v ?? '';
const setSetting = (db, k, v) => (v === '' ? db.prepare('DELETE FROM settings WHERE k = ?').run(k) : db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?,?)').run(k, v));

export function normalizeEndpoint(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new HttpError(400, 'Некорректный адрес AI-провайдера'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Адрес AI-провайдера должен начинаться с http:// или https://');
  if (u.username || u.password) throw new HttpError(400, 'Не указывайте логин и пароль в адресе — используйте поле «API-ключ»');
  return u.toString().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

export function loadSettings(db, key) {
  const enc = getSetting(db, K.key);
  let apiKey = '';
  if (enc) { try { apiKey = decrypt(key, enc); } catch { apiKey = ''; } }
  return { endpoint: getSetting(db, K.endpoint), model: getSetting(db, K.model), apiKey };
}

/* ---------------- клиент OpenAI-совместимого API ---------------- */

export const SYSTEM_PROMPT = `You are AI Doctor, a senior DevOps engineer inside the EasyAdmin panel for Easypanel (Docker/Swarm hosting).
You receive the failure context of ONE service: container state, exit code, resource usage and the tail of its logs. Secrets and IP addresses were already masked ("***", "[IP]") — never ask for them.
Answer ONLY with these four sections, using exactly these headings, in this order:
## WHAT
One or two sentences: what happened.
## CAUSE
The most likely root cause, citing the evidence from the logs. If unsure, say so and name the alternatives.
## FIX
A short numbered list of concrete steps. Use \`inline code\` for commands and variable names.
## ACTION
A single word on its own line: "restart" if restarting the service is a sensible safe first step, "start" if the service is just stopped, otherwise "none".
Be concise and practical. Do not invent facts that are not in the context.`;

export function buildMessages(ctxText, lang) {
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\nWrite the content of the sections in ${LANGS[lang] ?? 'English'} (keep the headings and the ACTION word in English).` },
    { role: 'user', content: `Diagnose this service failure.\n\n${ctxText}` },
  ];
}

/** Разбор SSE-потока chat/completions: асинхронный генератор кусочков текста. */
export async function* parseSse(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new HttpError(502, `AI: ${String(j.error.message ?? j.error).slice(0, 300)}`);
        const piece = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content;
        if (piece) yield piece;
      }
    }
  }
}

/** Запрос к `{endpoint}/chat/completions` со stream:true. Работает с любым совместимым сервером. */
export async function* streamChat({ endpoint, model, apiKey, messages, fetchImpl = globalThis.fetch, signal, timeoutMs = 60_000, maxTokens = 1200, temperature = 0.2 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    let res;
    try {
      res = await fetchImpl(`${endpoint}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages, stream: true, temperature, max_tokens: maxTokens }),
      });
    } catch (e) { throw new HttpError(502, `Не удалось связаться с AI-провайдером: ${e.cause?.code ?? e.message}`); }
    if (!res.ok) {
      const detail = sanitize(await res.text().catch(() => '')).slice(0, 300);
      throw new HttpError(502, `AI-провайдер ответил ${res.status}` + (detail ? `: ${detail}` : ''));
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!/event-stream/i.test(ct)) { // сервер проигнорировал stream:true и вернул готовый ответ
      const j = await res.json().catch(() => ({}));
      const text = j.choices?.[0]?.message?.content;
      if (!text) throw new HttpError(502, 'AI-провайдер вернул пустой ответ');
      yield text; return;
    }
    yield* parseSse(res.body);
  } finally { clearTimeout(timer); }
}

/* ---------------- вердикт ---------------- */

/** Делит ответ модели на разделы WHAT / CAUSE / FIX / ACTION. Работает и на неполном (стримящемся) тексте. */
export function parseVerdict(text) {
  const out = { what: '', cause: '', fix: '', action: 'none' };
  const parts = String(text ?? '').split(/^\s*#{1,3}\s*(WHAT|CAUSE|FIX|ACTION)\b[^\n]*$/gim);
  for (let i = 1; i < parts.length; i += 2) {
    const k = parts[i].toLowerCase(); const body = (parts[i + 1] ?? '').trim();
    if (k === 'action') { const w = /\b(restart|start|none)\b/i.exec(body)?.[1]?.toLowerCase(); out.action = ACTIONS_ALLOWED.includes(w) ? w : 'none'; } else out[k] = body;
  }
  if (!parts[1] && text) out.what = String(text).trim(); // модель не придерживалась формата
  return out;
}

/* ---------------- маршруты ---------------- */

export function aiDoctorRoutes(d) {
  const { db, key, config, audit, manager, panelOr404, assertPanel, nameOf } = d;
  const cache = createDiagnosisCache(db, { now: d.now });
  const active = new Map(); // userId → число идущих запросов
  const MAX_PER_USER = 2;
  const enabled = () => config?.aiEnabled !== false;
  const publicSettings = () => { const s = loadSettings(db, key); return { endpoint: s.endpoint, model: s.model, hasKey: !!s.apiKey, enabled: enabled() }; };

  const handler = async (ctx) => {
    if (!enabled()) throw new HttpError(404, 'AI Doctor отключён (EASYADMIN_AI=off)');
    const q = ctx.url.searchParams;
    const row = panelOr404(q.get('panelId')); assertPanel(ctx, row.id);
    const project = nameOf(q.get('project'), 'project'), service = nameOf(q.get('service'), 'service');
    const lang = LANGS[q.get('lang')] ? q.get('lang') : 'en';
    const refresh = q.get('refresh') === '1';
    const settings = loadSettings(db, key);
    if (!settings.endpoint || !settings.model) throw new HttpError(409, 'AI Doctor не настроен: укажите адрес провайдера и модель в настройках', { needSetup: true });
    const uid = ctx.user?.id ?? 0;
    if ((active.get(uid) ?? 0) >= MAX_PER_USER) throw new HttpError(429, 'Уже идёт диагностика — дождитесь её завершения');
    const tree = (await manager.snapshot(row.id))?.tree?.projects ?? [];
    const svc = tree.find((p) => p.name === project)?.services.find((s) => s.name === service);
    if (!svc) throw new HttpError(404, 'Сервис не найден');

    return new StreamResponse(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
      const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      active.set(uid, (active.get(uid) ?? 0) + 1);
      const target = `${project}/${service}`;
      try {
        const c = manager.clientFor(row);
        const info = await collectContext({ client: c, row, service: svc, db, logs: d.aiLogs, paths: config?.logsPaths, extraSecrets: [settings.apiKey] });
        send('meta', { project, service, type: svc.type, containers: info.containers.map(({ name, state, exitCode, oomSuspected }) => ({ name, state, exitCode, oomSuspected })), logLines: info.logs.length, metrics: info.metrics, failing: looksFailing(info) });
        const hash = fingerprint(info, { model: settings.model, lang });
        const hit = refresh ? null : cache.get(hash);
        let content = '';
        if (hit) {
          content = hit.content;
          send('cached', { createdAt: hit.created_at });
          for (let i = 0; i < content.length; i += 48) send('delta', { text: content.slice(i, i + 48) });
        } else {
          for await (const piece of streamChat({ endpoint: settings.endpoint, model: settings.model, apiKey: settings.apiKey, messages: buildMessages(info.text, lang), fetchImpl: d.fetchImpl ?? globalThis.fetch, signal: ac.signal })) {
            content += piece; send('delta', { text: piece });
          }
          if (!content.trim()) throw new HttpError(502, 'AI-провайдер вернул пустой ответ');
          cache.put(hash, content);
        }
        const verdict = parseVerdict(content);
        send('done', { verdict, cached: !!hit });
        audit(ctx, { action: 'ai.diagnose', panel: row, target, detail: `${settings.model}${hit ? ' (cache)' : ''}` });
      } catch (e) {
        if (!ac.signal.aborted) {
          send('error', { message: e instanceof HttpError ? e.message : `Ошибка диагностики: ${e.message}` });
          audit(ctx, { action: 'ai.diagnose', panel: row, target, ok: false, detail: String(e.message).slice(0, 200) });
        }
      } finally {
        active.set(uid, Math.max(0, (active.get(uid) ?? 1) - 1));
        if (!res.writableEnded) res.end();
      }
    });
  };

  return [
    ['GET', '/api/doctor/diagnose', handler, { min: 'operator' }],
    ['GET', '/api/doctor/settings', () => publicSettings(), { min: 'operator' }],
    ['POST', '/api/doctor/settings', (ctx) => {
      const b = ctx.body ?? {};
      if (b.endpoint !== undefined) setSetting(db, K.endpoint, b.endpoint === '' ? '' : normalizeEndpoint(b.endpoint));
      if (b.model !== undefined) {
        const m = String(b.model).trim();
        if (m.length > 120 || /[\s"'<>]/.test(m)) throw new HttpError(400, 'Некорректное имя модели');
        setSetting(db, K.model, m);
      }
      if (b.apiKey !== undefined) {
        const k = String(b.apiKey).trim();
        if (k.length > 500) throw new HttpError(400, 'Слишком длинный API-ключ');
        setSetting(db, K.key, k ? encrypt(key, k) : '');
      }
      audit(ctx, { action: 'ai.settings', target: 'AI Doctor', detail: [b.endpoint !== undefined && 'endpoint', b.model !== undefined && 'model', b.apiKey !== undefined && (b.apiKey ? 'key set' : 'key cleared')].filter(Boolean).join(', ') });
      return publicSettings();
    }, { admin: true }],
  ];
}
