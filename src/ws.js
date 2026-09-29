import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Минимальный WebSocket-клиент (только приём текста): рукопожатие, разбор кадров, ping/pong, close. */
export function openWebSocket(urlStr, { headers = {}, insecure = false, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const secure = u.protocol === 'wss:' || u.protocol === 'https:';
    const mod = secure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const req = mod.request({
      host: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, method: 'GET',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...headers },
      agent: false, rejectUnauthorized: !insecure, timeout: timeoutMs,
    });
    const ee = new EventEmitter();
    req.on('timeout', () => { req.destroy(new Error('таймаут рукопожатия')); });
    req.on('error', reject);
    req.on('response', (res) => { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); });
    req.on('upgrade', (res, socket, head) => {
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) { socket.destroy(); return reject(new Error('неверный Sec-WebSocket-Accept')); }
      socket.setTimeout(0);
      let buf = Buffer.alloc(0), frag = [], closed = false;
      const send = (opcode, payload = Buffer.alloc(0)) => {
        if (socket.destroyed) return;
        const mask = crypto.randomBytes(4); const len = payload.length;
        const header = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), Buffer.from([len >> 8, len & 255])]);
        const masked = Buffer.from(payload); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        socket.write(Buffer.concat([header, mask, masked]));
      };
      const finish = () => { if (!closed) { closed = true; ee.emit('close'); } };
      const parse = () => {
        for (;;) {
          if (buf.length < 2) return;
          const fin = !!(buf[0] & 0x80), opcode = buf[0] & 15, masked = !!(buf[1] & 0x80);
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (len > 16 * 1024 * 1024) { socket.destroy(); return; }
          if (buf.length < off + (masked ? 4 : 0) + len) return;
          const mk = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
          const payload = Buffer.from(buf.subarray(off, off + len)); if (mk) for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i % 4];
          buf = buf.subarray(off + len);
          if (opcode === 8) { send(8); socket.end(); finish(); return; }
          if (opcode === 9) { send(10, payload); continue; }
          if (opcode === 10) continue;
          if (opcode === 1 || opcode === 2 || opcode === 0) {
            frag.push(payload);
            if (fin) { ee.emit('message', Buffer.concat(frag).toString('utf8')); frag = []; }
          }
        }
      };
      socket.on('data', (d) => { buf = Buffer.concat([buf, d]); parse(); });
      socket.on('close', finish);
      socket.on('error', (e) => { ee.emit('error', e); finish(); });
      ee.close = () => { try { send(8); } catch { /* уже закрыт */ } socket.destroy(); finish(); };
      resolve(ee);
      if (head?.length) setImmediate(() => { buf = Buffer.concat([buf, head]); parse(); }); // кадры, пришедшие вместе с 101, — после того как вызывающий подпишется
    });
    req.end();
  });
}

/** Кандидаты адресов WebSocket логов: точный путь зависит от версии Easypanel, поэтому пробуем по очереди. */
export function logSocketCandidates(baseUrl, { project, name, token, paths }) {
  const u = new URL(baseUrl);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const service = `${project}_${name}`;
  return paths.map((p) => {
    const url = new URL(`${proto}//${u.host}${u.pathname.replace(/\/+$/, '')}${p}`);
    url.searchParams.set('service', service);
    url.searchParams.set('token', token);
    return url.toString();
  });
}

const TEXT_KEYS = ['line', 'message', 'data', 'log', 'logs', 'text', 'msg', 'output', 'content', 'payload', 'body', 'stdout', 'stderr'];

const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

/** Ищет в разобранном JSON текст лога: известные ключи → массивы → самая длинная строка. */
function pickText(v, depth = 0) {
  if (typeof v === 'string') return v;
  if (v == null || depth > 4) return null;
  if (Array.isArray(v)) return v.map((x) => pickText(x, depth + 1)).filter((x) => x != null).join('\n');
  if (typeof v === 'object') {
    for (const k of TEXT_KEYS) if (k in v) { const r = pickText(v[k], depth + 1); if (r != null) return r; }
    let best = null; // неизвестные ключи: берём самую длинную строку среди значений
    for (const x of Object.values(v)) { const r = typeof x === 'string' ? x : x && typeof x === 'object' ? pickText(x, depth + 1) : null; if (r && (best == null || r.length > best.length)) best = r; }
    return best;
  }
  return null;
}

/** Раскрывает «литеральные» эскейпы (\r\n, \", \uXXXX), если текст пришёл экранированным без разбора JSON. */
function unescapeLoose(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|[nrt"\\/])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/' })[c] ?? String.fromCharCode(parseInt(c.slice(1), 16)));
}

/**
 * Достаёт строки лога из сообщения WebSocket. Понимает: чистый текст; JSON-строку; JSON-объект с любыми
 * названиями полей; массив; несколько объектов подряд (NDJSON / склеенные); двойное кодирование; экранированный текст.
 */
export function extractLines(raw) {
  let text = String(raw);
  for (let i = 0; i < 3; i++) { // до трёх слоёв кодирования
    const t = text.trim();
    if (!/^[\[{"]/.test(t)) break;
    let parsed = tryJson(t);
    if (parsed === undefined && /^\{[\s\S]*\}\s*[\r\n]*$/.test(t)) { // NDJSON / несколько объектов подряд
      const parts = t.split(/\}\s*(?=\{)/).map((x, k, arr) => (k < arr.length - 1 ? `${x}}` : x));
      const objs = parts.map(tryJson);
      if (parts.length > 1 && objs.every((o) => o !== undefined)) parsed = objs;
    }
    if (parsed === undefined) break;
    const next = pickText(parsed);
    if (next == null || next === text) break;
    text = next;
  }
  if (!text.includes('\n') && /\\r?\\n|\\"|\\u00/.test(text)) text = unescapeLoose(text);
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.replace(/\r/g, '')).filter((l) => l.length);
}
