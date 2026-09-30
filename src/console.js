import crypto from 'node:crypto';
import { openWebSocket, outputText } from './ws.js';

/**
 * Консоль сервиса: сеанс терминала через WebSocket панели Easypanel.
 * Точный путь и формат сообщений зависят от версии панели, поэтому:
 *  - путь перебирается (известные названия + найденные в интерфейсе панели + указанный вручную);
 *  - формат ввода определяется пробной командой `echo __EA$((a+b))__` (результат отличается от набранного текста);
 *  - первые кадры и попытки сохраняются для диагностики.
 */
export class ConsoleError extends Error {
  constructor(message, status = 400, extra) { super(message); this.status = status; this.extra = extra; }
}

export const FRAMINGS = {
  raw: (d) => d,
  'json-input': (d) => JSON.stringify({ type: 'input', data: d }),
  'json-stdin': (d) => JSON.stringify({ type: 'stdin', data: d }),
  'json-data': (d) => JSON.stringify({ data: d }),
  'json-input-key': (d) => JSON.stringify({ input: d }),
  'json-command': (d) => JSON.stringify({ command: d }),
};

const MAX_BUFFER = 200_000;
const MAX_INPUT = 16_384;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Адреса WebSocket терминала (несколько вариантов имён параметров — лишние панель игнорирует). */
export function consoleCandidates(baseUrl, { project, name, type, token, paths }) {
  const u = new URL(baseUrl);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return paths.map((p) => {
    const url = new URL(`${proto}//${u.host}${u.pathname.replace(/\/+$/, '')}${p}`);
    url.searchParams.set('service', `${project}_${name}`);
    url.searchParams.set('projectName', project);
    url.searchParams.set('serviceName', name);
    if (type) url.searchParams.set('type', type);
    url.searchParams.set('token', token);
    url.searchParams.set('cols', '120'); url.searchParams.set('rows', '30');
    return url.toString();
  });
}

export function createConsoleHub({ maxPerUser = 3, idleMs = 10 * 60_000, lifeMs = 60 * 60_000 } = {}) {
  const sessions = new Map();

  const sweep = setInterval(() => {
    const t = Date.now();
    for (const s of sessions.values()) if (t - s.lastUsed > idleMs || t - s.createdAt > lifeMs) end(s, t - s.lastUsed > idleMs ? 'Сеанс закрыт: долго не было ввода' : 'Сеанс закрыт: истёк срок (1 час)');
  }, 30_000);
  sweep.unref();

  function emit(s, event, data) { for (const cb of s.subs) { try { cb(event, data); } catch { /* подписчик ушёл */ } } }
  function end(s, reason) {
    if (s.closed) return;
    s.closed = true; s.reason = reason;
    try { s.ws.close(); } catch { /* уже закрыт */ }
    emit(s, 'status', { state: 'closed', message: reason });
    sessions.delete(s.id);
  }

  async function detectFraming(s) {
    await sleep(350); // баннер/приглашение
    for (const name of Object.keys(FRAMINGS)) {
      if (s.closed) return null;
      const a = 100 + crypto.randomInt(800); const b = 100 + crypto.randomInt(800);
      const marker = `__EA${a + b}__`;
      s.ws.send(FRAMINGS[name](`echo __EA$((${a}+${b}))__\n`));
      for (let i = 0; i < 8; i++) { await sleep(150); if (s.buffer.includes(marker)) return name; }
    }
    return null;
  }

  /** Открывает сеанс: перебирает адреса, затем определяет формат ввода. */
  async function open({ userId, urls, headers, insecure, framing }) {
    if ([...sessions.values()].filter((x) => x.userId === userId).length >= maxPerUser) throw new ConsoleError(`Открыто слишком много консолей (не более ${maxPerUser}) — закройте лишние`, 429);
    const attempts = []; let ws = null; let path = null;
    for (const url of urls) {
      try { ws = await openWebSocket(url, { headers, insecure, timeoutMs: 6000 }); path = new URL(url).pathname; break; } catch (e) { attempts.push(`${new URL(url).pathname}: ${e.message}`); }
    }
    if (!ws) throw new ConsoleError('Не удалось подключиться к консоли панели', 502, { attempts });
    const s = { id: crypto.randomBytes(12).toString('hex'), userId, ws, path, framing: 'raw', detected: false, buffer: '', transcript: [], subs: new Set(), commands: 0, createdAt: Date.now(), lastUsed: Date.now(), closed: false, reason: null };
    sessions.set(s.id, s);
    ws.on('message', (m) => {
      if (s.transcript.length < 20) s.transcript.push(String(m).slice(0, 300));
      const text = outputText(m);
      s.buffer = (s.buffer + text).slice(-MAX_BUFFER);
      emit(s, 'out', { text });
    });
    ws.on('error', (e) => emit(s, 'status', { state: 'error', message: e.message }));
    ws.on('close', () => end(s, s.reason ?? 'Соединение закрыто панелью'));
    if (framing && framing !== 'auto') {
      if (!FRAMINGS[framing]) { end(s, 'Неизвестный формат ввода'); throw new ConsoleError('Неизвестный формат ввода'); }
      s.framing = framing; s.detected = true;
    } else {
      const found = await detectFraming(s);
      if (found) { s.framing = found; s.detected = true; }
      if (s.closed) throw new ConsoleError('Панель закрыла соединение во время подключения', 502, { attempts, transcript: s.transcript });
    }
    s.buffer = ''; // пробная команда и её вывод не нужны пользователю
    return { id: s.id, path, framing: s.framing, detected: s.detected, transcript: s.transcript, attempts };
  }

  const need = (id, userId) => {
    const s = sessions.get(id);
    if (!s || s.userId !== userId) throw new ConsoleError('Сеанс консоли не найден или закрыт', 404);
    return s;
  };

  return {
    open,
    input(id, userId, data) {
      const s = need(id, userId);
      const text = String(data ?? '');
      if (!text || text.length > MAX_INPUT) throw new ConsoleError(`Ввод должен быть непустым и не длиннее ${MAX_INPUT} символов`);
      s.lastUsed = Date.now(); s.commands += (text.match(/\n/g) ?? []).length;
      s.ws.send(FRAMINGS[s.framing](text));
    },
    subscribe(id, userId, cb) {
      const s = need(id, userId);
      if (s.buffer) cb('out', { text: s.buffer });
      s.subs.add(cb);
      return () => s.subs.delete(cb);
    },
    setFraming(id, userId, framing) { const s = need(id, userId); if (!FRAMINGS[framing]) throw new ConsoleError('Неизвестный формат ввода'); s.framing = framing; s.detected = true; return s.framing; },
    close(id, userId) { const s = need(id, userId); const info = { commands: s.commands, path: s.path }; end(s, 'Сеанс закрыт'); return info; },
    info(id, userId) { const s = need(id, userId); return { path: s.path, framing: s.framing, detected: s.detected, commands: s.commands }; },
    closeAll() { for (const s of [...sessions.values()]) end(s, 'Сервер останавливается'); clearInterval(sweep); },
    get size() { return sessions.size; },
  };
}
