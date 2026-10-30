import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadKey } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { aiDoctorRoutes, buildMessages, collectContext, createDiagnosisCache, fingerprint, looksFailing, normalizeEndpoint, parseContainer, parseSse, parseVerdict, renderContext, sanitize, streamChat, tailLines } from '../src/ai-doctor.js';
import { StreamResponse } from '../src/http.js';
import { splitVerdict } from '../public/js/ai-verdict.js';
import { translate } from '../public/js/i18n-dict.js';

const tmpDb = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-ai-')); return { dir, db: openDb(dir), key: loadKey(dir, 'test-secret') }; };

/** Ответ OpenAI-совместимого сервера в виде SSE. */
const sseBody = (pieces) => {
  const enc = new TextEncoder();
  const frames = [...pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`), 'data: [DONE]\n\n'];
  return new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } });
};
const sseResponse = (pieces, status = 200) => new Response(sseBody(pieces), { status, headers: { 'Content-Type': 'text/event-stream' } });
const collect = async (it) => { let s = ''; for await (const x of it) s += x; return s; };

describe('санитайзер секретов', () => {
  test('приватные ключи, JWT, Bearer и токены известных сервисов', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\nabc123\n-----END RSA PRIVATE KEY-----';
    assert.equal(sanitize(`key:\n${pem}\nend`), 'key:\n[PRIVATE KEY REDACTED]\nend');
    assert.match(sanitize('Authorization: Bearer abcdefghijklmnop12345'), /^Authorization: \*\*\*/);
    assert.ok(!sanitize('Bearer abcdefghijklmnop12345').includes('abcdefghij'));
    assert.equal(sanitize('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4f'), 'jwt [JWT]');
    for (const tok of ['sk-proj-abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'AKIAIOSFODNN7EXAMPLE', 'xoxb-1234567890-abcdefghij']) assert.equal(sanitize(`t ${tok} t`), 't [TOKEN] t', tok);
  });
  test('пароли в URL, JSON и key=value', () => {
    assert.equal(sanitize('postgres://admin:s3cr3tPass@db:5432/app'), 'postgres://admin:***@db:5432/app');
    assert.equal(sanitize('{"password": "hunter2", "user": "bob"}'), '{"password": "***", "user": "bob"}');
    assert.equal(sanitize('connect failed password=hunter2 retry'), 'connect failed password=*** retry');
    assert.equal(sanitize('api_key: "abc def"'), 'api_key: ***');
    assert.ok(!sanitize('DB_PASSWORD=hunter2').includes('hunter2'));
  });
  test('значения .env маскируются, имена остаются', () => {
    const r = sanitize('DATABASE_URL=postgres://u@h/db\nNODE_ENV=production\nexport SMTP_HOST="mail.example.com"\nplain line');
    assert.equal(r, 'DATABASE_URL=***\nNODE_ENV=***\nexport SMTP_HOST=***\nplain line');
  });
  test('IPv4/IPv6 скрываются, loopback и версии остаются', () => {
    assert.equal(sanitize('from 203.0.113.7:443 to 10.0.0.5'), 'from [IP]:443 to [IP]');
    assert.equal(sanitize('ECONNREFUSED 127.0.0.1:5432'), 'ECONNREFUSED 127.0.0.1:5432');
    assert.equal(sanitize('peer 2001:db8:85a3:0:0:8a2e:370:7334 up'), 'peer [IP] up');
    assert.equal(sanitize('peer 2001:db8::ff00:42:8329 up'), 'peer [IP] up');
    assert.equal(sanitize('at 12:34:56 node v20.11.1 ok'), 'at 12:34:56 node v20.11.1 ok');
  });
  test('email и длинные случайные строки; обычный текст не портится', () => {
    assert.equal(sanitize('user bob@example.com failed'), 'user [EMAIL] failed');
    assert.equal(sanitize(`hash ${'a1b2c3d4'.repeat(8)} end`), 'hash [REDACTED] end');
    const plain = 'Error: ENOENT: no such file or directory, open /app/config/settings.json';
    assert.equal(sanitize(plain), plain);
  });
  test('extra: точные значения (токен панели, ключ AI) скрываются в любом месте', () => {
    assert.equal(sanitize('x panelTOKEN123 y panelTOKEN123', { extra: ['panelTOKEN123', 'ab'] }), 'x *** y ***');
  });
});

describe('контекст сбоя', () => {
  test('tailLines: ANSI, дубликаты сворачиваются, берутся последние строки', () => {
    const lines = ['\x1b[31mboom\x1b[0m', 'boom', 'boom', '', 'next', ...Array.from({ length: 300 }, (_, i) => `l${i}`)];
    assert.deepEqual(tailLines(lines.slice(0, 5)), ['boom  (x3)', 'next']);
    const t = tailLines(lines, { maxLines: 10 });
    assert.equal(t.length, 10); assert.equal(t.at(-1), 'l299');
    assert.ok(tailLines(['x'.repeat(500), 'y'.repeat(500)], { maxChars: 600 }).length === 1);
  });
  test('parseContainer: код завершения из Status, OOM по 137', () => {
    const c = parseContainer({ Names: ['/shop_api.1.abc'], State: 'exited', Status: 'Exited (137) 3 minutes ago' });
    assert.deepEqual([c.name, c.state, c.exitCode, c.oomSuspected], ['shop_api.1.abc', 'exited', 137, true]);
    const ok = parseContainer({ name: 'x', state: 'running', Status: 'Up 2 hours', RestartCount: 3 });
    assert.deepEqual([ok.exitCode, ok.restarts, ok.oomSuspected], [null, 3, false]);
    assert.equal(parseContainer(null), null);
    assert.equal(parseContainer({ State: { Status: 'exited', ExitCode: 1 } }).exitCode, 1);
  });
  test('collectContext: логи, контейнер, метрики; секреты вырезаны из итогового текста', async () => {
    const { db } = tmpDb();
    db.prepare('INSERT INTO svc_metrics (panel_id, ts, project, service, cpu, mem, mem_max) VALUES (1, ?, ?, ?, ?, ?, ?)').run(1, 'shop', 'api', 97.5, 480, 512);
    const client = { base: 'http://p', token: 'PANEL-TOKEN-XYZ', query: async (proc, input) => { assert.equal(proc, 'projects.getDockerContainers'); assert.equal(input.service, 'shop_api'); return [{ Names: ['/shop_api.1'], State: 'exited', Status: 'Exited (137) 1 minute ago' }]; } };
    const logs = async () => ['starting', 'connect to 192.168.1.20 password=hunter2 token PANEL-TOKEN-XYZ', 'FATAL: out of memory'];
    const ctx = await collectContext({ client, row: { id: 1 }, service: { project: 'shop', name: 'api', type: 'app', enabled: true, health: 'failing' }, db, logs });
    assert.equal(ctx.containers[0].exitCode, 137);
    assert.deepEqual(ctx.metrics, { cpu: 97.5, mem: 480, memMax: 512 });
    assert.match(ctx.text, /exit code 137 \(killed/); assert.match(ctx.text, /OOM suspected/); assert.match(ctx.text, /RAM 480MB|RAM 480 MB|RAM 480/);
    for (const leak of ['hunter2', '192.168.1.20', 'PANEL-TOKEN-XYZ']) assert.ok(!ctx.text.includes(leak), leak);
    assert.ok(looksFailing(ctx));
  });
  test('collectContext переживает недоступные логи и контейнеры', async () => {
    const { db } = tmpDb();
    const client = { base: 'http://p', token: 't', query: async () => { throw new Error('down'); } };
    const ctx = await collectContext({ client, row: { id: 9 }, service: { project: 'a', name: 'b', type: 'app' }, db, logs: async () => { throw new Error('ws'); } });
    assert.deepEqual([ctx.containers, ctx.logs, ctx.metrics], [[], [], null]);
    assert.match(renderContext(ctx), /no logs available/);
    assert.equal(looksFailing({ enabled: true, health: 'running', containers: [{ state: 'running', exitCode: null }], logs: ['all fine'] }), false);
  });
});

describe('кэш диагнозов (SQLite, TTL 1 час)', () => {
  const ctxOf = (logs, extra = {}) => ({ project: 'p', service: 's', containers: [{ state: 'exited', exitCode: 1 }], logs, ...extra });
  test('fingerprint игнорирует время и числа, но различает суть ошибки, модель и язык', () => {
    const a = fingerprint(ctxOf(['2025-01-01T10:00:00Z ERROR conn 123 refused']));
    assert.equal(a, fingerprint(ctxOf(['2025-02-02T11:22:33Z ERROR conn 999 refused'])));
    assert.notEqual(a, fingerprint(ctxOf(['2025-01-01T10:00:00Z ERROR disk full'])));
    assert.notEqual(a, fingerprint(ctxOf(['2025-01-01T10:00:00Z ERROR conn 123 refused']), { model: 'm' }));
    assert.notEqual(fingerprint(ctxOf(['x']), { lang: 'ru' }), fingerprint(ctxOf(['x']), { lang: 'en' }));
    assert.notEqual(a, fingerprint(ctxOf(['2025-01-01T10:00:00Z ERROR conn 123 refused'], { service: 'other' })));
  });
  test('get/put, истечение по TTL и очистка просроченных', () => {
    const { db } = tmpDb(); let t = 1_000_000;
    const cache = createDiagnosisCache(db, { ttlMs: 3600_000, now: () => t });
    assert.equal(cache.get('h'), null);
    cache.put('h', 'diagnosis');
    t += 3599_000; assert.equal(cache.get('h').content, 'diagnosis');
    t += 2_000; assert.equal(cache.get('h'), null);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_diagnoses').get().c, 0);
    cache.put('old', 'x'); t += 3600_001; cache.put('new', 'y');
    assert.deepEqual(db.prepare('SELECT hash FROM ai_diagnoses').all().map((r) => r.hash), ['new']);
    cache.put('new', 'z'); assert.equal(cache.get('new').content, 'z');
  });
  test('таблица ai_diagnoses: hash, content, created_at', () => {
    const { db } = tmpDb(); createDiagnosisCache(db);
    assert.deepEqual(db.prepare('PRAGMA table_info(ai_diagnoses)').all().map((c) => c.name), ['hash', 'content', 'created_at']);
  });
});

describe('клиент OpenAI-совместимого API', () => {
  test('parseSse: кадры, разрезанные по чанкам, [DONE], ошибка провайдера', async () => {
    const frames = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"IGNORED"}}]}\n\n';
    const chunks = [frames.slice(0, 17), frames.slice(17, 60), frames.slice(60)];
    assert.equal(await collect(parseSse(chunks)), 'Hello');
    await assert.rejects(collect(parseSse(['data: {"error":{"message":"quota"}}\n\n'])), /quota/);
  });
  test('streamChat: URL, заголовки, тело запроса и потоковый ответ', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return sseResponse(['## WHAT\n', 'ok']); };
    const out = await collect(streamChat({ endpoint: 'http://ollama:11434/v1', model: 'llama3', apiKey: 'KEY', messages: [{ role: 'user', content: 'hi' }], fetchImpl }));
    assert.equal(out, '## WHAT\nok');
    assert.equal(seen.url, 'http://ollama:11434/v1/chat/completions');
    assert.equal(seen.init.headers.Authorization, 'Bearer KEY');
    assert.deepEqual([seen.body.model, seen.body.stream], ['llama3', true]);
    await collect(streamChat({ endpoint: 'http://x/v1', model: 'm', messages: [], fetchImpl: async (u, i) => { assert.equal(i.headers.Authorization, undefined); return sseResponse(['a']); } }));
  });
  test('streamChat: сервер без стриминга, HTTP-ошибка (ключ не просачивается), сетевой сбой', async () => {
    const json = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'whole' } }] }), { headers: { 'Content-Type': 'application/json' } });
    assert.equal(await collect(streamChat({ endpoint: 'http://x', model: 'm', messages: [], fetchImpl: json })), 'whole');
    const bad = async () => new Response('invalid key sk-abcdefghijklmnopqrstuvwx', { status: 401 });
    await assert.rejects(collect(streamChat({ endpoint: 'http://x', model: 'm', messages: [], fetchImpl: bad })), (e) => e.status === 502 && /401/.test(e.message) && !e.message.includes('abcdefghij'));
    await assert.rejects(collect(streamChat({ endpoint: 'http://x', model: 'm', messages: [], fetchImpl: async () => { throw new Error('boom'); } })), (e) => e.status === 502);
  });
  test('buildMessages: язык ответа и контекст в запросе', () => {
    const m = buildMessages('CTX', 'de');
    assert.match(m[0].content, /German/); assert.match(m[1].content, /CTX/);
    assert.match(buildMessages('x', 'xx')[0].content, /English/);
  });
  test('normalizeEndpoint', () => {
    assert.equal(normalizeEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
    assert.equal(normalizeEndpoint('http://localhost:11434/v1/chat/completions'), 'http://localhost:11434/v1');
    for (const bad of ['ftp://x', 'not a url', 'https://u:p@host/v1']) assert.throws(() => normalizeEndpoint(bad), (e) => e.status === 400, bad);
  });
});

describe('вердикт', () => {
  const TEXT = '## WHAT\nСервис упал.\n## CAUSE\nOOM: `137`.\n## FIX\n1. Поднять лимит\n2. Перезапустить\n## ACTION\nrestart\n';
  test('parseVerdict на сервере и splitVerdict на клиенте дают одно и то же', () => {
    const v = parseVerdict(TEXT);
    assert.deepEqual(v, { what: 'Сервис упал.', cause: 'OOM: `137`.', fix: '1. Поднять лимит\n2. Перезапустить', action: 'restart' });
    assert.deepEqual(splitVerdict(TEXT), v);
  });
  test('действие вне белого списка → none; неполный и неструктурированный текст', () => {
    assert.equal(parseVerdict('## ACTION\nrm -rf /').action, 'none');
    assert.equal(parseVerdict('## ACTION\ndestroy').action, 'none');
    assert.equal(parseVerdict('## ACTION\nnone').action, 'none');
    assert.equal(parseVerdict('## WHAT\nпоток обо').what, 'поток обо');
    assert.equal(parseVerdict('Просто текст').what, 'Просто текст');
  });
});

describe('маршруты', () => {
  const PANEL = { id: 1, name: 'prod', url: 'http://p' };
  const setup = ({ fetchImpl, user = { id: 7, role: 'admin', username: 'root' }, logs = async () => ['ERROR: connect 10.1.2.3 refused', 'password=hunter2'] } = {}) => {
    const { db, key } = tmpDb(); const audits = [];
    const svc = { name: 'api', type: 'app', enabled: true, health: 'failing' };
    const d = {
      db, key, config: { logsPaths: [] }, fetchImpl, aiLogs: logs,
      audit: (_c, a) => audits.push(a), assertPanel: () => {},
      nameOf: (v) => { if (!/^[A-Za-z0-9_.-]+$/.test(v ?? '')) throw Object.assign(new Error('bad name'), { status: 400 }); return v; },
      panelOr404: (id) => { if (Number(id) !== 1) throw Object.assign(new Error('Панель не найдена'), { status: 404 }); return PANEL; },
      manager: { snapshot: async () => ({ tree: { projects: [{ name: 'shop', services: [svc] }] } }), clientFor: () => ({ base: 'http://p', token: 'TOK', query: async () => [{ Names: ['/shop_api.1'], State: 'exited', Status: 'Exited (1) now' }] }) },
    };
    const routes = aiDoctorRoutes(d);
    const find = (m, u) => routes.find((r) => r[0] === m && r[1] === u);
    const call = (m, u, ctx) => find(m, u)[2]({ user, body: {}, ...ctx, url: new URL(`http://x${ctx.query ?? ''}`) });
    return { db, key, audits, routes, find, call };
  };
  const configure = (t) => t.call('POST', '/api/doctor/settings', { body: { endpoint: 'http://llm.local/v1/', model: 'm1', apiKey: 'SECRET-KEY-123' } });
  /** Прогоняет StreamResponse на фейковых req/res и возвращает разобранные события SSE. */
  const run = async (out) => {
    assert.ok(out instanceof StreamResponse);
    const req = new EventEmitter(); const chunks = []; let head;
    const res = { writableEnded: false, writeHead: (s, h) => { head = { s, h }; }, write: (c) => { chunks.push(c); }, end: () => { res.writableEnded = true; } };
    await out.run(req, res);
    const events = chunks.join('').split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, dt] = b.split('\n'); return [e.slice(7), JSON.parse(dt.slice(6))]; });
    return { head, events, text: events.filter(([e]) => e === 'delta').map(([, d]) => d.text).join(''), last: (n) => events.filter(([e]) => e === n).at(-1)?.[1] };
  };

  test('права: настройки меняет только админ, диагноз — оператор', () => {
    const t = setup();
    assert.equal(t.find('POST', '/api/doctor/settings')[3].admin, true);
    assert.equal(t.find('GET', '/api/doctor/diagnose')[3].min, 'operator');
    assert.equal(t.routes.length, 3);
  });
  test('настройки: apiKey шифруется в БД и не возвращается наружу', async () => {
    const t = setup();
    const r = await configure(t);
    assert.deepEqual(r, { endpoint: 'http://llm.local/v1', model: 'm1', hasKey: true, enabled: true });
    const stored = t.db.prepare("SELECT v FROM settings WHERE k = 'ai_key_enc'").get().v;
    assert.ok(!stored.includes('SECRET-KEY-123')); assert.ok(stored.length > 30);
    assert.ok(!JSON.stringify(await t.call('GET', '/api/doctor/settings', {})).includes('SECRET'));
    assert.ok(!JSON.stringify(t.audits).includes('SECRET'));
    await t.call('POST', '/api/doctor/settings', { body: { model: 'm2' } }); // ключ не затёрт
    assert.equal((await t.call('GET', '/api/doctor/settings', {})).hasKey, true);
    assert.equal((await t.call('POST', '/api/doctor/settings', { body: { apiKey: '' } })).hasKey, false);
    assert.throws(() => t.call('POST', '/api/doctor/settings', { body: { endpoint: 'file:///etc/passwd' } }), (e) => e.status === 400);
    assert.throws(() => t.call('POST', '/api/doctor/settings', { body: { model: 'a b' } }), (e) => e.status === 400);
  });
  test('diagnose без настроек → 409 needSetup; невалидные параметры и неизвестный сервис', async () => {
    const t = setup();
    await assert.rejects(t.call('GET', '/api/doctor/diagnose', { query: '?panelId=1&project=shop&service=api' }), (e) => e.status === 409 && e.extra?.needSetup);
    await configure(t);
    await assert.rejects(t.call('GET', '/api/doctor/diagnose', { query: '?panelId=5&project=shop&service=api' }), (e) => e.status === 404);
    await assert.rejects(t.call('GET', '/api/doctor/diagnose', { query: '?panelId=1&project=sh op&service=api' }), (e) => e.status === 400);
    await assert.rejects(t.call('GET', '/api/doctor/diagnose', { query: '?panelId=1&project=shop&service=nope' }), (e) => e.status === 404);
  });
  test('diagnose: SSE-поток meta → delta → done; в LLM уходят только очищенные данные; повтор берётся из кэша', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => { requests.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }); return sseResponse(['## WHAT\nПадение.\n', '## CAUSE\nrefused\n## FIX\n1. fix\n## ACTION\nrestart']); };
    const t = setup({ fetchImpl }); await configure(t);
    const q = { query: '?panelId=1&project=shop&service=api&lang=ru' };
    const first = await run(await t.call('GET', '/api/doctor/diagnose', q));
    assert.equal(first.head.s, 200); assert.match(first.head.h['Content-Type'], /event-stream/);
    assert.deepEqual(first.events.map(([e]) => e).filter((e, i, a) => a.indexOf(e) === i), ['meta', 'delta', 'done']);
    assert.equal(first.last('meta').containers[0].exitCode, 1);
    assert.equal(first.last('done').verdict.action, 'restart'); assert.equal(first.last('done').cached, false);
    assert.equal(requests.length, 1); assert.equal(requests[0].url, 'http://llm.local/v1/chat/completions'); assert.equal(requests[0].auth, 'Bearer SECRET-KEY-123');
    const sent = JSON.stringify(requests[0].body);
    for (const leak of ['hunter2', '10.1.2.3', 'TOK"']) assert.ok(!sent.includes(leak), leak);
    assert.match(sent, /Russian/);
    const second = await run(await t.call('GET', '/api/doctor/diagnose', q));
    assert.equal(requests.length, 1); assert.ok(second.last('cached')); assert.equal(second.last('done').cached, true); assert.equal(second.text, first.text);
    const forced = await run(await t.call('GET', '/api/doctor/diagnose', { query: `${q.query}&refresh=1` }));
    assert.equal(requests.length, 2); assert.equal(forced.last('done').cached, false);
    assert.deepEqual(t.audits.map((a) => [a.action, a.ok !== false]).slice(-3), [['ai.diagnose', true], ['ai.diagnose', true], ['ai.diagnose', true]]);
  });
  test('ошибка провайдера уходит событием error и в аудит; ответ в кэш не попадает', async () => {
    const t = setup({ fetchImpl: async () => new Response('nope', { status: 500 }) }); await configure(t);
    const r = await run(await t.call('GET', '/api/doctor/diagnose', { query: '?panelId=1&project=shop&service=api' }));
    assert.match(r.last('error').message, /500/); assert.equal(r.last('done'), undefined);
    assert.equal(t.audits.at(-1).ok, false);
    assert.equal(t.db.prepare('SELECT COUNT(*) c FROM ai_diagnoses').get().c, 0);
  });
  test('EASYADMIN_AI=off отключает диагностику', async () => {
    const { db, key } = setup();
    const off = aiDoctorRoutes({ db, key, config: { aiEnabled: false }, audit() {}, nameOf: (v) => v, panelOr404: () => PANEL, assertPanel() {}, manager: {} });
    await assert.rejects(off[0][2]({ url: new URL('http://x/?panelId=1'), user: {} }), (e) => e.status === 404);
    assert.equal((await off[1][2]({})).enabled, false);
  });
});

describe('локализация AI Doctor', () => {
  test('ключевые строки переведены на все 5 языков', () => {
    for (const ru of ['Что случилось', 'Причина', 'Решение', 'Диагностировать заново', 'Удалить ключ', 'Открыть настройки', 'Применить', 'Перезапустить сервис', 'Запустить сервис', 'Сохранено', 'Готово']) {
      const seen = new Set();
      for (const l of ['en', 'zh', 'de', 'es', 'pt']) { const tr = translate(ru, l); assert.notEqual(tr, ru, `${l}: ${ru}`); seen.add(tr); }
      assert.ok(seen.size >= 3, ru);
    }
    assert.equal(translate('AI-провайдер ответил 500', 'de'), 'Der KI-Anbieter antwortete 500');
  });
});
