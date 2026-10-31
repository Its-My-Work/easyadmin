import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim(); // защита от инъекции заголовков
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s) => s.match(/.{1,76}/g)?.join('\r\n') ?? '';

/** Минимальный SMTP-клиент: TLS / STARTTLS / без шифрования, AUTH PLAIN. */
export function sendMail({ host, port = 587, security = 'starttls', user, pass, from, to, subject, text, insecureTls = false, timeoutMs = 15_000 }) {
  const rcpts = (Array.isArray(to) ? to : String(to).split(',')).map(clean).filter(Boolean);
  if (!host || !from || !rcpts.length) return Promise.reject(new Error('SMTP: не заданы сервер, отправитель или получатель'));
  return new Promise((resolve, reject) => {
    let socket, buf = '', waiter = null, done = false;
    const fail = (e) => { if (!done) { done = true; clearTimeout(timer); socket?.destroy(); reject(e instanceof Error ? e : new Error(String(e))); } };
    const ok = () => { if (!done) { done = true; clearTimeout(timer); socket.end(); resolve(); } };
    const timer = setTimeout(() => fail(new Error(`SMTP: таймаут ${timeoutMs} мс`)), timeoutMs);

    const onData = (d) => { buf += d.toString('utf8'); pump(); };
    const pump = () => { // ответ завершён строкой вида «250 …» (без дефиса после кода)
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
          const reply = lines.slice(0, i + 1);
          buf = lines.slice(i + 1).join('\r\n');
          const w = waiter; waiter = null;
          if (w) w({ code: Number(reply.at(-1).slice(0, 3)), lines: reply });
          return pump();
        }
      }
    };
    const reply = () => new Promise((r) => { waiter = r; pump(); });
    const cmd = async (line, expect) => {
      if (line != null) socket.write(line + '\r\n');
      const r = await reply();
      if (!expect.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.lines.at(-1).slice(4)}`);
      return r;
    };
    const attach = (s) => { socket = s; s.on('data', onData); s.on('error', fail); s.on('close', () => { if (!done) fail(new Error('SMTP: соединение закрыто')); }); };

    (async () => {
      const opts = { host, port: Number(port), ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: !insecureTls };
      if (security === 'tls') await new Promise((r, j) => { const s = tls.connect(opts, r); attach(s); s.once('error', j); });
      else await new Promise((r, j) => { const s = net.connect({ host, port: Number(port) }, r); attach(s); s.once('error', j); });
      await cmd(null, [220]);
      const hello = () => cmd('EHLO easyadmin.local', [250]);
      let caps = await hello();
      if (security === 'starttls') {
        await cmd('STARTTLS', [220]);
        socket.removeListener('data', onData);
        const plain = socket; plain.removeAllListeners('close'); plain.removeAllListeners('error');
        await new Promise((r, j) => { const s = tls.connect({ ...opts, socket: plain }, r); attach(s); s.once('error', j); });
        caps = await hello();
      }
      if (user) await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass ?? ''}`).toString('base64')}`, [235]);
      await cmd(`MAIL FROM:<${clean(from).replace(/^.*<|>.*$/g, '')}>`, [250]);
      for (const r of rcpts) await cmd(`RCPT TO:<${r.replace(/^.*<|>.*$/g, '')}>`, [250, 251]);
      await cmd('DATA', [354]);
      const msg = [
        `From: ${clean(from)}`, `To: ${rcpts.join(', ')}`, `Subject: =?UTF-8?B?${b64(clean(subject))}?=`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@easyadmin>`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(String(text))),
      ].join('\r\n');
      await cmd(`${msg}\r\n.`, [250]);
      socket.write('QUIT\r\n');
      ok();
    })().catch(fail);
  });
}
