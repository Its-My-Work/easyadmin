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

/**
 * Форматы, которые пробуются автоматически, — только корректный JSON. Терминал Easypanel делает JSON.parse каждого кадра
 * без обработки ошибок: голый текст (формат raw) роняет весь процесс панели. Поэтому raw — только по явному выбору.
 * Родной формат панели ({"input": …} → {"output": …}) идёт первым.
 */
export const AUTO_FRAMINGS = ['json-input-key', 'json-input', 'json-stdin', 'json-data', 'json-command'];

const MAX_BUFFER = 200_000;
const MAX_INPUT = 16_384;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Адреса WebSocket терминала (несколько вариантов имён параметров — лишние панель игнорирует). */
export function consoleCandidates(baseUrl, { project, name, type, token, paths, extra = {} }) {
  const u = new URL(baseUrl);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return paths.map((p) => {
    const url = new URL(`${proto}//${u.host}${u.pathname.replace(/\/+$/, '')}${p}`);
    if (project && name) { // консоль самого сервера — без сервиса
      url.searchParams.set('service', `${project}_${name}`);
      url.searchParams.set('projectName', project);
      url.searchParams.set('serviceName', name);
      if (type) url.searchParams.set('type', type);
    }
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v); // например container и command для /ws/containerShell
    url.searchParams.set('token', token);
    url.searchParams.set('cols', '120'); url.searchParams.set('rows', '30');
    return url.toString();
  });
}

export function createConsoleHub({ maxPerUser = 3, idleMs = 10 * 60_000, lifeMs = 60 * 60_000, readyMs = 10_000 } = {}) {
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

  /** Ждёт первый вывод (приглашение оболочки): пока панель поднимает контейнер терминала, ввод теряется. */
  async function waitReady(s, ms) {
    for (let t = 0; t < ms && !s.closed && !s.transcript.length; t += 100) await sleep(100);
  }

  async function detectFraming(s) {
    await waitReady(s, readyMs);
    await sleep(300); // баннер/приглашение
    for (const name of AUTO_FRAMINGS) {
      if (s.closed) return null;
      const a = 100 + crypto.randomInt(800); const b = 100 + crypto.randomInt(800);
      const marker = `__EA${a + b}__`;
      s.ws.send(FRAMINGS[name](`echo __EA$((${a}+${b}))__\n`));
      for (let i = 0; i < 8; i++) { await sleep(150); if (s.buffer.includes(marker)) return name; if (s.closed) return null; }
    }
    return null;
  }

  function attach(userId, ws, path) {
    const s = { id: crypto.randomBytes(12).toString('hex'), userId, ws, path, framing: 'raw', detected: false, buffer: '', transcript: [], subs: new Set(), commands: 0, createdAt: Date.now(), lastUsed: Date.now(), closed: false, reason: null };
    const onMessage = (m) => {
      if (s.transcript.length < 20) s.transcript.push(String(m).slice(0, 300));
      const text = outputText(m);
      s.buffer = (s.buffer + text).slice(-MAX_BUFFER);
      emit(s, 'out', { text });
    };
    ws.on('message', onMessage);
    for (const m of ws.early ?? []) onMessage(m); // кадры, пришедшие до подписки
    ws.on('error', (e) => emit(s, 'status', { state: 'error', message: e.message }));
    ws.on('close', () => end(s, s.reason ?? 'Соединение закрыто панелью'));
    return s;
  }

  /**
   * Открывает сеанс. Адреса проверяются ПАРАЛЛЕЛЬНО с коротким таймаутом: панель часто молча игнорирует WebSocket на неверных путях,
   * и последовательный перебор занимал бы минуту (прокси отвечает 502 раньше). Из подключившихся берётся первый по приоритету,
   * у которого удалось определить формат ввода; остальные закрываются.
   */
  async function open({ userId, urls, headers, insecure, framing, handshakeMs = 3500 }) {
    if ([...sessions.values()].filter((x) => x.userId === userId).length >= maxPerUser) throw new ConsoleError(`Открыто слишком много консолей (не более ${maxPerUser}) — закройте лишние`, 429);
    const results = await Promise.allSettled(urls.map((url) => openWebSocket(url, { headers, insecure, timeoutMs: handshakeMs })));
    const attempts = []; const live = [];
    results.forEach((r, i) => {
      const path = new URL(urls[i]).pathname;
      if (r.status === 'fulfilled') live.push({ ws: r.value, path }); else attempts.push(`${path}: ${r.reason?.message ?? r.reason}`);
    });
    if (!live.length) throw new ConsoleError('Не удалось подключиться к консоли панели', 502, { attempts });
    if (framing && framing !== 'auto' && !FRAMINGS[framing]) { live.forEach((x) => x.ws.close()); throw new ConsoleError('Неизвестный формат ввода'); }

    const cands = live.map((x) => attach(userId, x.ws, x.path));
    // формат определяем на всех подключившихся адресах одновременно (у каждого свой сокет), затем выбираем первый по приоритету
    const manual = framing && framing !== 'auto';
    const found = await Promise.all(cands.map((s) => (manual || s.closed ? null : detectFraming(s))));
    let chosen = null; let silent = null;
    cands.forEach((s, i) => {
      if (chosen) return;
      if (s.closed) { attempts.push(`${s.path}: панель закрыла соединение`); return; }
      if (manual) { s.framing = framing; s.detected = true; chosen = s; return; }
      if (found[i]) { s.framing = found[i]; s.detected = true; chosen = s; return; }
      silent ??= s; // соединение есть, но на пробную команду не ответило
    });
    chosen ??= silent;
    for (const s of cands) if (s !== chosen && !s.closed) { s.reason = 'не выбран'; s.subs.clear(); try { s.ws.close(); } catch { /* закрыт */ } s.closed = true; }
    if (!chosen) throw new ConsoleError('Панель закрыла соединение во время подключения', 502, { attempts, transcript: cands.flatMap((c) => c.transcript).slice(0, 20) });
    sessions.set(chosen.id, chosen);
    if (chosen.framing === 'json-input-key') { try { chosen.ws.send(JSON.stringify({ resize: [120, 30] })); } catch { /* закрыт */ } } // родной формат панели понимает {"resize":[колонки, строки]}
    chosen.buffer = ''; // пробная команда и её вывод не нужны пользователю
    return { id: chosen.id, path: chosen.path, framing: chosen.framing, detected: chosen.detected, transcript: chosen.transcript, attempts };
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
