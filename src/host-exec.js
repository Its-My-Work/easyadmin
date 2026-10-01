import crypto from 'node:crypto';
import { consoleCandidates } from './console.js';
import { openWebSocket, outputText } from './ws.js';
import { HttpError } from './http.js';

/**
 * Одна команда на хосте через встроенную консоль Easypanel (/ws/hostShell, root-оболочка хоста). Команда задаётся кодом, не пользователем.
 * Итог определяется по маркеру, вычисленному оболочкой (`$((a+b))`): эхо набранной строки содержит выражение, а не результат.
 * ВАЖНО: оболочка живёт в docker-контейнере и умирает вместе с Docker — долгие и опасные действия запускаются отдельным юнитом systemd.
 */
export async function runOnHost(c, row, script, { timeoutMs = 45_000, readyMs = 8000, insecure = false } = {}) {
  const a = 100 + crypto.randomInt(800); const b = 100 + crypto.randomInt(800); const sum = a + b;
  const ok = `__EAOK${sum}__`; const fail = `__EAFAIL${sum}__`;
  const line = `( ${script} ) && echo __EAOK$((${a}+${b}))__ || echo __EAFAIL$((${a}+${b}))__\n`;
  const [url] = consoleCandidates(c.base, { token: c.token, paths: ['/ws/hostShell'] });
  let ws;
  try { ws = await openWebSocket(url, { headers: { Authorization: `Bearer ${c.token}`, Origin: new URL(c.base).origin }, insecure: !!row.insecure_tls || insecure, timeoutMs: readyMs }); }
  catch (e) { throw new HttpError(502, `Не удалось открыть консоль хоста панели: ${e.message}`); }
  let buf = ''; let ready = ws.early.length > 0; let done = null;
  const feed = (m) => { buf += outputText(m); ready = true; if (buf.includes(ok)) done = 'ok'; else if (buf.includes(fail)) done = 'fail'; };
  ws.early.forEach(feed); ws.on('message', feed); ws.on('error', () => {});
  const clean = (t) => t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  try {
    for (let t = 0; t < readyMs && !ready; t += 100) await new Promise((r) => setTimeout(r, 100)); // пока панель поднимает контейнер оболочки, ввод теряется
    await new Promise((r) => setTimeout(r, 300));
    ws.send(JSON.stringify({ input: line }));
    for (let t = 0; t < timeoutMs && !done; t += 100) await new Promise((r) => setTimeout(r, 100));
  } finally { ws.close(); }
  const text = clean(buf).split('\n').filter((l) => !l.includes('__EAOK$((') && !l.includes('__EAFAIL$((') && !l.includes(ok) && !l.includes(fail)).join('\n').trim();
  if (!done) throw new HttpError(504, 'Консоль хоста не ответила вовремя');
  return { ok: done === 'ok', output: text };
}
