import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { sendMail } from '../src/smtp.js';
import { extractLines, openWebSocket } from '../src/ws.js';
import { createMockPanel } from './mock-easypanel.js';

/* ---------- фейковый SMTP ---------- */
function fakeSmtp() {
  const mails = [];
  const handler = (socket) => {
    let buf = '', data = null, mail = { auth: null, rcpt: [] };
    const w = (s) => socket.write(s + '\r\n');
    w('220 fake ESMTP');
    socket.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data !== null) { if (line === '.') { mail.raw = data; mails.push(mail); mail = { auth: null, rcpt: [] }; data = null; w('250 queued'); } else data += line + '\r\n'; continue; }
        if (/^EHLO/.test(line)) w('250-fake\r\n250-AUTH PLAIN\r\n250 8BITMIME');
        else if (/^AUTH PLAIN/.test(line)) { mail.auth = Buffer.from(line.split(' ')[2], 'base64').toString(); w('235 ok'); }
        else if (/^MAIL FROM/.test(line)) { mail.from = line; w('250 ok'); }
        else if (/^RCPT TO/.test(line)) { mail.rcpt.push(line.slice(8)); w('250 ok'); }
        else if (line === 'DATA') { data = ''; w('354 go'); }
        else if (line === 'QUIT') { w('221 bye'); socket.end(); }
        else w('500 what');
      }
    });
    socket.on('error', () => {});
  };
  return { mails, handler };
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

describe('SMTP-клиент', () => {
  let srv, port, fake;
  before(async () => { fake = fakeSmtp(); srv = net.createServer(fake.handler); port = await listen(srv); });
  after(() => srv.close());
  test('письмо доходит: AUTH, MIME base64, тема в UTF-8, инъекции заголовков вырезаются', async () => {
    await sendMail({ host: '127.0.0.1', port, security: 'none', user: 'u', pass: 'p', from: 'EasyAdmin <ea@example.com>', to: 'a@example.com, b@example.com',
      subject: 'Панель «Прод» недоступна\r\nBcc: evil@x.com', text: 'Строка 1\nСтрока 2' });
    const m = fake.mails.at(-1);
    assert.equal(m.auth, '\0u\0p');
    assert.deepEqual(m.rcpt, ['<a@example.com>', '<b@example.com>']);
    assert.ok(!/^Bcc:/mi.test(m.raw));
    const subj = m.raw.match(/Subject: =\?UTF-8\?B\?(.+?)\?=/)[1];
    assert.match(Buffer.from(subj, 'base64').toString(), /Панель «Прод» недоступна/);
    const body = m.raw.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    assert.equal(Buffer.from(body, 'base64').toString(), 'Строка 1\nСтрока 2');
  });
  test('ошибка сервера превращается в понятное исключение', async () => {
    const bad = net.createServer((s) => { s.write('220 hi\r\n'); s.on('data', () => s.write('554 nope\r\n')); s.on('error', () => {}); });
    const p = await listen(bad);
    await assert.rejects(sendMail({ host: '127.0.0.1', port: p, security: 'none', from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }), /SMTP 554/);
    bad.close();
  });
  test('неверные параметры и недоступный сервер', async () => {
    await assert.rejects(sendMail({ host: '', from: 'a', to: 'b', subject: 's', text: 't' }), /не заданы/);
    await assert.rejects(sendMail({ host: '127.0.0.1', port: 1, security: 'none', from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }), /ECONNREFUSED|refused/i);
  });
  test('неявный TLS (порт 465): шифрованное соединение', { skip: (() => { try { execFileSync('openssl', ['version']); return false; } catch { return 'нет openssl'; } })() }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    const f = fakeSmtp();
    const s = tls.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, f.handler);
    const p = await listen(s);
    await assert.rejects(sendMail({ host: '127.0.0.1', port: p, security: 'tls', from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }), /self.signed|certificate|SSL|DEPTH/i, 'самоподписанный сертификат отвергается');
    await sendMail({ host: '127.0.0.1', port: p, security: 'tls', insecureTls: true, from: 'a@b.c', to: 'd@e.f', subject: 's', text: 'tls-ok' });
    assert.equal(f.mails.length, 1);
    s.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ---------- WebSocket и логи ---------- */
describe('WebSocket-клиент', () => {
  let panel, url;
  before(async () => { panel = createMockPanel({ token: 'T' }); url = await panel.listen(); });
  after(() => panel.close());
  test('приём текста, фрагментов, ping→pong, закрытие', async () => {
    const ws = await openWebSocket(`${url.replace('http', 'ws')}/ws/serviceLogs?service=p_s&token=T`);
    const got = [];
    ws.on('message', (m) => got.push(m));
    await new Promise((r) => setTimeout(r, 200));
    ws.close();
    assert.equal(got[0], 'line one\n\x1b[31mline two\x1b[0m');
    assert.ok(got.includes('frag-mented'), 'фрагментированное сообщение собрано');
    assert.ok(got.some((m) => m.startsWith('tick')));
    assert.ok(panel.calls.some((c) => c.proc === 'ws-pong'), 'на ping отправлен pong');
  });
  test('отказ рукопожатия: 404 и 401', async () => {
    await assert.rejects(openWebSocket(`${url.replace('http', 'ws')}/nope?token=T`), /HTTP 404/);
    await assert.rejects(openWebSocket(`${url.replace('http', 'ws')}/ws/serviceLogs?token=bad`), /HTTP 401/);
  });
  test('extractLines: реальные формы сообщений панели — любые поля, эскейпы, NDJSON, двойное кодирование', () => {
    // объект с неизвестным именем поля: берётся самая длинная строка, \r\n превращаются в переводы строк
    assert.deepEqual(extractLines(JSON.stringify({ type: 'log', chunk: 'INFO: a\r\nINFO: b "q"\r\n' })), ['INFO: a', 'INFO: b "q"']);
    assert.deepEqual(extractLines('{"logs":"one\\ntwo"}'), ['one', 'two']);
    assert.deepEqual(extractLines('{"line":"a"}\n{"line":"b"}'), ['a', 'b'], 'NDJSON');
    assert.deepEqual(extractLines('{"line":"a"}{"line":"b"}'), ['a', 'b'], 'склеенные объекты');
    assert.deepEqual(extractLines('[{"line":"a"},{"line":"b"}]'), ['a', 'b']);
    assert.deepEqual(extractLines(JSON.stringify(JSON.stringify({ message: 'deep\nline' }))), ['deep', 'line'], 'двойное кодирование');
    // текст пришёл экранированным, но не как валидный JSON (как на скриншоте пользователя)
    assert.deepEqual(extractLines('K\\r\\nINFO: 1.2.3.4 - \\"GET /x HTTP/1.1\\" 200\\r\\nINFO: next'), ['K', 'INFO: 1.2.3.4 - "GET /x HTTP/1.1" 200', 'INFO: next']);
    assert.deepEqual(extractLines('обычный текст: "в кавычках"'), ['обычный текст: "в кавычках"'], 'чистый текст не портится');
  });
  test('extractLines: JSON, ANSI, многострочный текст', () => {
    assert.deepEqual(extractLines('{"line":"a"}'), ['a']);
    assert.deepEqual(extractLines('"quoted"'), ['quoted']);
    assert.deepEqual(extractLines('x\n\x1b[31my\x1b[0m\n'), ['x', 'y']);
    assert.deepEqual(extractLines('{"message":"m"}'), ['m']);
  });
});

/* ---------- приложение: логи по SSE, e-mail канал ---------- */
describe('API: логи и email-канал', () => {
  let A, B, app, base, smtp, smtpPort, cookie = '', roCookie = '';
  const api = async (m, p, body, ck = cookie) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', Cookie: ck }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
  };
  const login = async (u, p) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin' }, body: JSON.stringify({ username: u, password: p }) })).headers.get('set-cookie').split(';')[0];
  let idA, idB, idC;
  const readSse = async (path, until, ms = 3000) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    const res = await fetch(base + path, { headers: { Cookie: cookie }, signal: ac.signal });
    let text = '';
    try { for await (const chunk of res.body) { text += Buffer.from(chunk).toString(); if (until(text)) break; } } catch { /* abort */ }
    clearTimeout(t); ac.abort();
    return { status: res.status, text, type: res.headers.get('content-type') };
  };
  before(async () => {
    A = createMockPanel({ token: 'A', seed: { web: [{ name: 'site' }] } });
    B = createMockPanel({ token: 'B', seed: { web: [{ name: 'site' }] }, logsPath: '/api/ws/serviceLogs' }); // второй кандидат
    const C = createMockPanel({ token: 'C', seed: { web: [{ name: 'site' }] }, logsPath: '/unknown' });
    const urls = [await A.listen(), await B.listen(), await C.listen()];
    smtp = fakeSmtp(); const ss = net.createServer(smtp.handler); smtpPort = await listen(ss); smtp.server = ss;
    app = createApp({ config: { ...loadConfig({}), cacheTtlMs: 1, requestTimeoutMs: 3000 }, db: openDb(':memory:'), key: crypto.randomBytes(32) });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    cookie = (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin' }, body: JSON.stringify({ username: 'admin', password: 'password1' }) })).headers.get('set-cookie').split(';')[0];
    idA = (await api('POST', '/api/panels', { name: 'A', url: urls[0], token: 'A' })).data.id;
    idB = (await api('POST', '/api/panels', { name: 'B', url: urls[1], token: 'B' })).data.id;
    idC = (await api('POST', '/api/panels', { name: 'C', url: urls[2], token: 'C' })).data.id;
    await api('POST', '/api/users', { username: 'ro', password: 'password1', role: 'viewer' });
    roCookie = await login('ro', 'password1');
    globalThis.__mocks = [A, B, C, smtp.server];
  });
    after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); for (const m of globalThis.__mocks) await (m.close?.() ?? m.close()); });

  test('SSE-логи: строки, ANSI вырезан, service=проект_сервис, токен передан', async () => {
    const r = await readSse(`/api/panels/${idA}/logs?type=app&project=web&name=site`, (t) => t.includes('json line') && t.includes('frag-mented'));
    assert.equal(r.status, 200); assert.match(r.type, /text\/event-stream/);
    assert.match(r.text, /event: status\ndata: \{"state":"connected"\}/);
    assert.match(r.text, /event: line\ndata: "line one"/);
    assert.match(r.text, /data: "line two"/);
    assert.match(r.text, /data: "json line"/);
    assert.ok(!r.text.includes('\\u001b'));
    const c = A.calls.find((x) => x.proc === 'ws');
    assert.equal(c.input.service, 'web_site'); assert.equal(c.input.auth, 'Bearer A');
  });
  test('логи compose-сервиса: compose=true (иначе панель бесконечно пишет «Waiting for service … to start»), у остальных compose=false', async () => {
    assert.equal(A.calls.find((x) => x.proc === 'ws').input.compose, 'false');
    const n = A.calls.filter((x) => x.proc === 'ws').length;
    const cr = await readSse(`/api/panels/${idA}/logs?type=compose&project=web&name=site`, (t) => t.includes('db ready'));
    assert.match(cr.text, /data: "web-1  \| hello web"/); assert.match(cr.text, /data: "db-1   \| db ready"/);
    assert.equal(A.calls.filter((x) => x.proc === 'ws')[n].input.compose, 'true');
  });
  test('при закрытии клиента соединение с панелью закрывается', async () => {
    await readSse(`/api/panels/${idA}/logs?type=app&project=web&name=site`, (t) => t.includes('tick 1'));
    await new Promise((r) => setTimeout(r, 150));
    const before = A.calls.filter((x) => x.proc === 'ws').length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(A.calls.filter((x) => x.proc === 'ws').length, before);
  });
  test('перебор путей: панель со вторым вариантом пути работает', async () => {
    const r = await readSse(`/api/panels/${idB}/logs?type=app&project=web&name=site`, (t) => t.includes('json line'));
    assert.match(r.text, /"state":"connected"/);
  });
  test('нет подходящего пути → понятное сообщение об ошибке', async () => {
    const r = await readSse(`/api/panels/${idC}/logs?type=app&project=web&name=site`, (t) => t.includes('"state":"error"'));
    assert.match(r.text, /Не удалось подключиться к логам/); assert.match(r.text, /EASYPANEL_LOGS_PATHS/);
  });
  test('логи недоступны наблюдателю и по неверным именам', async () => {
    const ro = await fetch(base + `/api/panels/${idA}/logs?type=app&project=web&name=site`, { headers: { Cookie: roCookie } });
    assert.equal(ro.status, 403);
    assert.equal((await fetch(base + `/api/panels/${idA}/logs?type=app&project=../x&name=site`, { headers: { Cookie: cookie } })).status, 400);
  });

  test('email-канал: создание, пароль не утекает, тест доставляет письмо', async () => {
    assert.equal((await api('POST', '/api/channels', { type: 'email', name: 'Почта', host: '127.0.0.1', port: smtpPort, security: 'none', user: 'bot', pass: 'sekret', from: 'ea@example.com', to: 'ops@example.com, cto@example.com', events: ['panel_down'] })).status, 200);
    const list = (await api('GET', '/api/channels')).data.channels;
    assert.ok(!JSON.stringify(list).includes('sekret'));
    assert.equal(list[0].type, 'email'); assert.match(list[0].summary, /ops@example.com/);
    assert.equal((await api('POST', `/api/channels/${list[0].id}/test`)).status, 200);
    const m = smtp.mails.at(-1);
    assert.equal(m.auth, '\0bot\0sekret'); assert.equal(m.rcpt.length, 2);
    assert.equal((await api('POST', '/api/channels', { type: 'email', name: 'x', host: '127.0.0.1', security: 'weird', from: 'a@b.c', to: 'd@e.f' })).status, 400);
    assert.equal((await api('POST', '/api/channels', { type: 'email', name: 'x', host: '127.0.0.1' })).status, 400);
  });
  test('ошибка SMTP в тесте канала отдаётся как 502', async () => {
    const id = (await api('GET', '/api/channels')).data.channels[0].id;
    await api('PUT', `/api/channels/${id}`, { port: 1, name: 'Почта' });
    assert.equal((await api('POST', `/api/channels/${id}/test`)).status, 502);
  });
});

/* ---------- OIDC ---------- */
describe('SSO (OIDC)', () => {
  let idp, idpUrl, keys, identity, tamper;
  const kid = 'k1';
  const servers = [];
  const codes = new Map();
  const b64u = (x) => Buffer.from(x).toString('base64url');
  const sign = (payload, priv) => { const h = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })); const p = b64u(JSON.stringify(payload)); return `${h}.${p}.${b64u(crypto.sign('sha256', Buffer.from(`${h}.${p}`), priv))}`; };

  const mkApp = async (env) => {
    const config = { ...loadConfig({ EASYADMIN_PUBLIC_URL: 'http://placeholder', ...env }), cacheTtlMs: 1 };
    const app = createApp({ config, db: openDb(':memory:'), key: crypto.randomBytes(32) });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    config.publicUrl = base; // redirect_uri должен вести на сам сервер (порт известен только после запуска)
    const rec = { app, base }; servers.push(rec);
    return rec;
  };
  const flow = async (base) => {
    const l = await fetch(`${base}/api/oidc/login`, { redirect: 'manual' });
    assert.equal(l.status, 302, 'login → редирект к провайдеру');
    const a = await fetch(l.headers.get('location'), { redirect: 'manual' });
    const cb = await fetch(a.headers.get('location'), { redirect: 'manual' });
    return { status: cb.status, location: cb.headers.get('location'), cookie: cb.headers.get('set-cookie')?.split(';')[0], callback: a.headers.get('location') };
  };
  const me = async (base, cookie) => (await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json()).user;
  const errOf = (loc) => decodeURIComponent(new URL(loc, 'http://x').searchParams.get('sso_error') ?? '');
  let A; // основное приложение с ограничением домена

  before(async () => {
    keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    idp = http.createServer(async (req, res) => {
      const u = new URL(req.url, idpUrl);
      const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/.well-known/openid-configuration') return json({ issuer: idpUrl, authorization_endpoint: `${idpUrl}/authorize`, token_endpoint: `${idpUrl}/token`, jwks_uri: `${idpUrl}/jwks` });
      if (u.pathname === '/jwks') return json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
      if (u.pathname === '/authorize') {
        const code = crypto.randomUUID();
        codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), method: u.searchParams.get('code_challenge_method') });
        const back = new URL(u.searchParams.get('redirect_uri')); back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state'));
        res.writeHead(302, { Location: back.toString() }); return res.end();
      }
      if (u.pathname === '/token') {
        const c = []; for await (const x of req) c.push(x);
        const form = new URLSearchParams(Buffer.concat(c).toString());
        const rec = codes.get(form.get('code')); codes.delete(form.get('code'));
        if (!rec || req.headers.authorization !== `Basic ${Buffer.from('cid:csecret').toString('base64')}`) { res.writeHead(400); return res.end('{}'); }
        if (rec.method !== 'S256' || crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url') !== rec.challenge) { res.writeHead(400); return res.end('{}'); }
        const claims = { iss: idpUrl, aud: tamper === 'aud' ? 'other' : 'cid', sub: identity.sub, email: identity.email, email_verified: identity.verified ?? true, name: identity.name ?? identity.email,
          nonce: tamper === 'nonce' ? 'x' : rec.nonce, exp: Math.floor(Date.now() / 1000) + (tamper === 'expired' ? -3600 : 600) };
        return json({ id_token: sign(claims, tamper === 'sig' ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : keys.privateKey), token_type: 'Bearer' });
      }
      res.writeHead(404); res.end();
    });
    idpUrl = `http://127.0.0.1:${await listen(idp)}`;
    A = await mkApp({ OIDC_ISSUER: idpUrl, OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csecret', OIDC_NAME: 'Corp SSO', OIDC_ADMIN_EMAILS: 'boss@corp.com', OIDC_ALLOWED_DOMAINS: 'corp.com' });
  });
  after(() => { for (const s of servers) { s.app.stop(); s.app.server.closeAllConnections(); s.app.server.close(); } idp.close(); });
  const as = (id) => { identity = id; tamper = null; };

  test('SSO виден на странице входа', async () => {
    assert.deepEqual((await (await fetch(`${A.base}/api/session`)).json()).sso, { name: 'Corp SSO' });
  });
  test('первый вход в пустую систему делает администратором; повторный вход — тот же пользователь', async () => {
    as({ sub: 's-first', email: 'first@corp.com' });
    const r = await flow(A.base);
    assert.equal(r.location, '/'); assert.ok(r.cookie);
    const u = await me(A.base, r.cookie);
    assert.equal(u.role, 'admin'); assert.equal(u.username, 'first@corp.com');
    const again = await me(A.base, (await flow(A.base)).cookie);
    assert.equal(again.id, u.id);
  });
  test('новые пользователи получают роль по умолчанию (viewer), админы — по списку', async () => {
    as({ sub: 's-alice', email: 'Alice@Corp.com' });
    const alice = await me(A.base, (await flow(A.base)).cookie);
    assert.equal(alice.role, 'viewer'); assert.equal(alice.username, 'alice@corp.com');
    as({ sub: 's-boss', email: 'boss@corp.com' });
    assert.equal((await me(A.base, (await flow(A.base)).cookie)).role, 'admin');
  });
  test('пароль SSO-пользователя не подходит для обычного входа', async () => {
    const r = await fetch(`${A.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin' }, body: JSON.stringify({ username: 'alice@corp.com', password: '' }) });
    assert.equal(r.status, 401);
  });
  test('чужой домен и неподтверждённая почта отклоняются', async () => {
    as({ sub: 's-evil', email: 'evil@other.com' });
    let r = await flow(A.base);
    assert.match(errOf(r.location), /домен/); assert.equal(r.cookie, undefined);
    as({ sub: 's-unv', email: 'unv@corp.com', verified: false });
    r = await flow(A.base);
    assert.match(errOf(r.location), /не подтверждена/); assert.equal(r.cookie, undefined);
  });
  test('подделки id_token отклоняются: подпись, nonce, срок, aud', async () => {
    for (const [t, re] of [['sig', /Подпись/], ['nonce', /nonce/], ['expired', /просрочен/], ['aud', /aud/]]) {
      identity = { sub: `s-${t}`, email: `${t}@corp.com` }; tamper = t;
      const r = await flow(A.base);
      assert.match(errOf(r.location), re, t); assert.equal(r.cookie, undefined, t);
    }
  });
  test('state одноразовый и обязателен', async () => {
    as({ sub: 's-replay', email: 'replay@corp.com' });
    const r = await flow(A.base);
    assert.ok(r.cookie);
    const replay = await fetch(r.callback, { redirect: 'manual' });
    assert.match(errOf(replay.headers.get('location')), /истекла|недействительна/);
    const nostate = await fetch(`${A.base}/api/oidc/callback?code=x`, { redirect: 'manual' });
    assert.match(errOf(nostate.headers.get('location')), /истекла|недействительна/);
    const denied = await fetch(`${A.base}/api/oidc/callback?error=access_denied&error_description=${encodeURIComponent('Отказано')}`, { redirect: 'manual' });
    assert.equal(errOf(denied.headers.get('location')), 'Отказано');
  });
  test('привязка к существующему локальному пользователю по подтверждённой почте сохраняет его роль', async () => {
    const B = await mkApp({ OIDC_ISSUER: idpUrl, OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csecret' });
    const setup = await fetch(`${B.base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin' }, body: JSON.stringify({ username: 'root', password: 'password1' }) });
    const ck = setup.headers.get('set-cookie').split(';')[0];
    await fetch(`${B.base}/api/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', Cookie: ck }, body: JSON.stringify({ username: 'bob@corp.com', password: 'password1', role: 'operator' }) });
    as({ sub: 's-bob', email: 'bob@corp.com' });
    const u = await me(B.base, (await flow(B.base)).cookie);
    assert.equal(u.username, 'bob@corp.com'); assert.equal(u.role, 'operator');
    const users = await (await fetch(`${B.base}/api/users`, { headers: { Cookie: ck } })).json();
    assert.equal(users.filter((x) => x.username === 'bob@corp.com').length, 1, 'дубликат не создан');
  });
  test('без настройки SSO и с небезопасным издателем', async () => {
    const off = await mkApp({});
    assert.equal((await fetch(`${off.base}/api/oidc/login`, { redirect: 'manual' })).status, 400);
    assert.equal((await (await fetch(`${off.base}/api/session`)).json()).sso, null);
    const insecure = await mkApp({ OIDC_ISSUER: 'http://idp.example.com', OIDC_CLIENT_ID: 'cid' });
    const r = await fetch(`${insecure.base}/api/oidc/login`, { redirect: 'manual' });
    assert.match(errOf(r.headers.get('location')), /HTTPS/);
  });
});
