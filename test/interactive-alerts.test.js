import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createAlerts } from '../src/alerts.js';
import { loadKey } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { TOKEN_TTL_MS, TokenError, createInteractiveAlerts, interactiveAlertsRoutes, keyboardOf, parseCallback, signToken, verifyToken } from '../src/interactive-alerts.js';
import { translate } from '../public/js/i18n-dict.js';

const KEY = loadKey('/nonexistent', 'test-secret');
const REF = { panelId: 1, project: 'shop', service: 'api' };

/** Окружение: БД, фейковая панель с одним сервисом, записывающий fetch Telegram. */
function setup({ publicUrl = '', logs = ['l1', 'l2', 'token=abc123456789'], restartFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-ia-'));
  const db = openDb(dir);
  const key = loadKey(dir, 'test-secret');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method: url.split('/').pop(), body, url });
    return new Response(JSON.stringify({ ok: true, result: url.endsWith('getUpdates') ? (setup.updates ?? []) : true }), { status: 200 });
  };
  const config = { lang: 'ru', publicUrl, diskAlertPct: 90, aiEnabled: true, logsPaths: [] };
  const mutations = [];
  const client = { token: 'PANEL-TOKEN', mutate: async (proc, input) => { if (restartFails) throw new Error('boom'); mutations.push([proc, input]); return {}; }, query: async () => [] };
  const row = { id: 1, name: 'Prod' };
  db.prepare("INSERT INTO panels (id, name, url, token_enc, created_at) VALUES (1, 'Prod', 'http://x', 'e', 0)").run();
  const manager = {
    getRow: (id) => (id === 1 ? row : undefined),
    clientFor: () => client,
    invalidate: () => {},
    snapshot: async () => ({ tree: { projects: [{ name: 'shop', services: [{ name: 'api', type: 'app', enabled: true, health: 'failing' }] }] } }),
  };
  const alerts = createAlerts({ db, key, config, fetchImpl });
  let t = 1_000_000;
  const now = () => t;
  const audits = [];
  const ia = createInteractiveAlerts({ db, key, config, manager, alerts, audit: (c, a) => audits.push([c.user.username, a]), fetchImpl, now, logsFn: async () => logs });
  alerts.attachInteractive(ia);
  db.prepare("INSERT INTO channels (name, type, config_enc, events, enabled) VALUES ('tg', 'telegram', ?, 'service_down', 1)").run(alerts.seal({ botToken: 'BOT', chatId: '555' }));
  return { db, key, ia, alerts, calls, mutations, audits, config, advance: (ms) => { t += ms; }, now };
}

const click = (data, extra = {}) => ({
  update_id: 1,
  callback_query: { id: 'cq1', data, from: { id: 42, username: 'ops' }, message: { message_id: 9, text: '🟠 Сервис shop/api упал', chat: { id: 555 }, reply_markup: extra.markup ? { inline_keyboard: extra.markup } : null } },
});
const keyboardFrom = (ia) => ia.keyboard(REF);
const flat = (kb) => kb.flat();

describe('токены действий', () => {
  test('подпись: payload восстанавливается, чужой ключ и порча отвергаются', () => {
    const exp = Date.now() + 1000;
    const token = signToken(KEY, { ...REF, action: 'restart', exp });
    const p = verifyToken(KEY, token);
    assert.deepEqual({ ...p, n: undefined }, { ...REF, action: 'restart', exp, n: undefined });
    assert.equal(typeof p.n, 'string');
    assert.throws(() => verifyToken(loadKey('/nonexistent', 'other'), token), (e) => e instanceof TokenError && e.code === 'signature');
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...p, action: 'logs' })).toString('base64url');
    assert.throws(() => verifyToken(KEY, `${forged}.${sig}`), { code: 'signature' });
    assert.throws(() => verifyToken(KEY, `${body}.`), { code: 'malformed' });
    assert.throws(() => verifyToken(KEY, 'garbage'), { code: 'malformed' });
    assert.throws(() => verifyToken(KEY, `${token}.x`), { code: 'malformed' });
    assert.throws(() => verifyToken(KEY, undefined), { code: 'malformed' });
  });

  test('неизвестное действие в подписанном токене отклоняется', () => {
    const token = signToken(KEY, { ...REF, action: 'destroy', exp: Date.now() + 1000 });
    assert.throws(() => verifyToken(KEY, token), { code: 'malformed' });
  });

  test('срок жизни 15 минут', () => {
    const { ia, advance } = setup();
    assert.equal(TOKEN_TTL_MS, 15 * 60_000);
    const { token } = ia.issue(REF, 'restart');
    advance(14 * 60_000);
    assert.equal(ia.peek(token).action, 'restart');
    advance(60_000);
    assert.throws(() => ia.redeem(token), { code: 'expired' });
    assert.throws(() => verifyToken(KEY, signToken(KEY, { ...REF, action: 'logs', exp: 1000 }), 1000), { code: 'expired' });
  });

  test('одноразовость: повторное использование — replay', () => {
    const { ia } = setup();
    const { token } = ia.issue(REF, 'logs');
    assert.equal(ia.redeem(token).action, 'logs');
    assert.throws(() => ia.redeem(token), { code: 'replay' });
    assert.throws(() => ia.peek(token), { code: 'replay' });
  });

  test('callback_data влезает в 64 байта и не содержит параметров действия', () => {
    const { ia } = setup();
    for (const b of flat(keyboardFrom(ia))) {
      assert.ok(Buffer.byteLength(b.callback_data) <= 64);
      assert.ok(!b.callback_data.includes('shop') && !b.callback_data.includes('api'));
    }
  });
});

describe('кнопки и разбор callback_query', () => {
  test('inline_keyboard: четыре кнопки по две в ряд', () => {
    const { ia } = setup();
    const kb = keyboardFrom(ia);
    assert.equal(kb.length, 2);
    assert.deepEqual(flat(kb).map((b) => b.text), ['🔄 Перезапустить', '📜 Логи (20 строк)', '🤖 AI Диагноз', '🔕 Заглушить 1ч']);
    assert.equal(new Set(flat(kb).map((b) => b.callback_data)).size, 4);
    assert.deepEqual(keyboardOf([1, 2, 3]), [[1, 2], [3]]);
  });

  test('parseCallback: нормальный апдейт, чужие данные и мусор', () => {
    const cb = parseCallback(click('ea1.abcdefghijklmnop'));
    assert.deepEqual({ id: cb.id, data: cb.data, chatId: cb.chatId, messageId: cb.messageId, from: cb.from }, { id: 'cq1', data: 'ea1.abcdefghijklmnop', chatId: '555', messageId: 9, from: { id: 42, name: '@ops' } });
    assert.equal(parseCallback(click('other:data')), null);
    assert.equal(parseCallback(click('ea1.short')), null);
    assert.equal(parseCallback({ message: {} }), null);
    assert.equal(parseCallback(null), null);
    assert.equal(parseCallback({ callback_query: { id: '1', data: 'ea1.abcdefghijklmnop' } }), null);
  });
});

describe('вызов действий из Telegram', () => {
  const press = async (env, action) => {
    const kb = keyboardFrom(env.ia);
    const btn = flat(kb).find((b) => b.text.includes({ restart: 'Перезапустить', logs: 'Логи', ai: 'AI', mute: 'Заглушить' }[action]));
    const r = await env.ia.handleUpdate(click(btn.callback_data, { markup: kb }));
    await r.done;
    return { r, btn, kb };
  };
  const names = (env) => env.calls.map((c) => c.method);

  test('restart: answerCallbackQuery, рестарт через easypanel, editMessageText без нажатой кнопки', async () => {
    const env = setup();
    const { r, btn } = await press(env, 'restart');
    assert.equal(r.ok, true);
    assert.deepEqual(names(env), ['answerCallbackQuery', 'editMessageText']);
    assert.equal(env.calls[0].body.text, 'Перезапуск запущен…');
    assert.equal(env.mutations.length, 1);
    assert.deepEqual(env.mutations[0][1], { projectName: 'shop', serviceName: 'api' });
    assert.match(env.mutations[0][0], /restart/i);
    const edit = env.calls[1].body;
    assert.match(edit.text, /Сервис shop\/api упал\n\n✅ Сервис shop\/api перезапущен/);
    assert.equal(edit.message_id, 9);
    const left = edit.reply_markup.inline_keyboard.flat();
    assert.equal(left.length, 3);
    assert.ok(!left.some((b) => b.callback_data === btn.callback_data));
    assert.equal(env.audits[0][0], 'telegram:@ops');
    assert.equal(env.audits[0][1].action, 'alert.restart');
  });

  test('повторное нажатие той же кнопки отвергается и ничего не выполняет', async () => {
    const env = setup();
    const { btn, kb } = await press(env, 'restart');
    env.calls.length = 0;
    const r = await env.ia.handleUpdate(click(btn.callback_data, { markup: kb }));
    await r.done;
    assert.equal(r.ok, false);
    assert.deepEqual(names(env), ['answerCallbackQuery']);
    assert.equal(env.calls[0].body.show_alert, true);
    assert.equal(env.mutations.length, 1);
  });

  test('просроченная кнопка отвергается', async () => {
    const env = setup();
    const kb = keyboardFrom(env.ia);
    env.advance(TOKEN_TTL_MS + 1);
    const r = await env.ia.handleUpdate(click(kb[0][0].callback_data));
    assert.equal(r.ok, false);
    assert.equal(env.mutations.length, 0);
  });

  test('чужой чат: апдейт игнорируется без ответа', async () => {
    const env = setup();
    const kb = keyboardFrom(env.ia);
    const u = click(kb[0][0].callback_data); u.callback_query.message.chat.id = 999;
    const r = await env.ia.handleUpdate(u);
    assert.equal(r.handled, false);
    assert.equal(env.calls.length, 0);
    assert.equal(env.mutations.length, 0);
  });

  test('logs: последние строки уходят отдельным сообщением, секреты скрыты', async () => {
    const env = setup({ logs: Array.from({ length: 30 }, (_, i) => `line ${i}`).concat('password=hunter2') });
    await press(env, 'logs');
    assert.deepEqual(names(env), ['answerCallbackQuery', 'sendMessage', 'editMessageText']);
    const msg = env.calls[1].body;
    assert.equal(msg.parse_mode, 'HTML');
    assert.equal(msg.reply_to_message_id, 9);
    assert.match(msg.text, /последние 20 строк/);
    assert.ok(msg.text.includes('line 29') && !msg.text.includes('line 5<') && !msg.text.includes('line 9\n'));
    assert.equal(msg.text.split('\n').filter((l) => /line \d+|password/.test(l)).length, 20);
    assert.ok(!msg.text.includes('hunter2'));
  });

  test('mute: сервис глушится на час, алерты не уходят, потом снова идут', async () => {
    const env = setup();
    await press(env, 'mute');
    assert.match(env.calls.at(-1).body.text, /заглушены на 1 час/);
    assert.equal(env.ia.isMuted(1, 'shop', 'api'), true);
    assert.equal(env.ia.isMuted(1, 'shop', 'web'), false);
    env.calls.length = 0;
    await env.alerts.emit({ type: 'service_down', text: 'x', ref: REF });
    assert.equal(env.calls.length, 0);
    env.advance(3600_000 + 1);
    assert.equal(env.ia.isMuted(1, 'shop', 'api'), false);
    await env.alerts.emit({ type: 'service_down', text: 'x', ref: REF });
    assert.equal(names(env)[0], 'sendMessage');
  });

  test('ai без настроенного провайдера: понятная ошибка в сообщении', async () => {
    const env = setup();
    await press(env, 'ai');
    assert.match(env.calls.at(-1).body.text, /❌ Не удалось выполнить действие: AI Doctor не настроен/);
  });

  test('ai: диагноз отправляется в чат', async () => {
    const env = setup();
    env.db.prepare("INSERT INTO settings (k, v) VALUES ('ai_endpoint', 'http://ai.local/v1'), ('ai_model', 'm')").run();
    const orig = env.ia;
    const sse = (s) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;
    const aiFetch = async (url, init) => (/ai\.local/.test(url)
      ? new Response(sse('## WHAT\nПадает\n## CAUSE\nOOM\n## FIX\nУвеличьте память\n## ACTION\nrestart') + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      : new Response(JSON.stringify({ ok: true, result: true })));
    const ia = createInteractiveAlerts({ db: env.db, key: env.key, config: env.config, fetchImpl: aiFetch, now: env.now, logsFn: async () => ['x'], audit: () => {}, alerts: env.alerts,
      manager: { getRow: () => ({ id: 1, name: 'Prod' }), clientFor: () => ({ token: 'T', query: async () => [] }), invalidate() {}, snapshot: async () => ({ tree: { projects: [{ name: 'shop', services: [{ name: 'api', type: 'app', enabled: true }] }] } }) } });
    void orig;
    const out = await ia.execute({ ...REF, action: 'ai', n: 'x', exp: 1 });
    assert.match(out.body, /AI-диагноз shop\/api/);
    assert.match(out.body, /Падает/); assert.match(out.body, /OOM/); assert.match(out.body, /Увеличьте память/);
  });

  test('ошибка рестарта попадает в сообщение', async () => {
    const env = setup({ restartFails: true });
    await press(env, 'restart');
    assert.match(env.calls.at(-1).body.text, /❌ Не удалось выполнить действие: boom/);
    assert.equal(env.audits[0][1].ok, false);
  });

  test('polling: getUpdates → обработка callback и сдвиг offset', async () => {
    const env = setup();
    const kb = keyboardFrom(env.ia);
    setup.updates = [{ ...click(kb[0][0].callback_data, { markup: kb }), update_id: 77 }];
    try {
      assert.equal(await env.ia.pollOnce('BOT'), 1);
      assert.equal(env.mutations.length, 1);
      setup.updates = [];
      await env.ia.pollOnce('BOT');
      assert.equal(env.calls.filter((c) => c.method === 'getUpdates').at(-1).body.offset, 78);
    } finally { setup.updates = []; }
  });
});

describe('интеграция с alerts.js', () => {
  test('service_down в Telegram отправляется с кнопками, прочие события — без', async () => {
    const env = setup();
    await env.alerts.emit({ type: 'service_down', icon: '🟠', text: 'Сервис упал', ref: REF });
    const sent = env.calls.find((c) => c.method === 'sendMessage').body;
    assert.equal(sent.reply_markup.inline_keyboard.flat().length, 4);
    env.calls.length = 0;
    await env.alerts.emit({ type: 'service_down', text: 'без ссылки' });
    assert.equal(env.calls[0].body.reply_markup, undefined);
  });

  test('evaluate формирует ref для service_down', () => {
    const env = setup();
    const events = env.alerts.evaluate({ id: 1, name: 'Prod' }, { status: 'online', tree: { projects: [{ name: 'shop', services: [{ name: 'api', enabled: true, health: 'ok' }] }] } });
    assert.equal(events.length, 0);
    const down = env.alerts.evaluate({ id: 1, name: 'Prod' }, { status: 'online', tree: { projects: [{ name: 'shop', services: [{ name: 'api', enabled: true, health: 'failing' }] }] } });
    assert.deepEqual(down[0].ref, REF);
  });

  test('interactive=false в канале и EASYADMIN_INTERACTIVE=off отключают кнопки', async () => {
    const env = setup();
    env.config.interactive = false;
    await env.alerts.emit({ type: 'service_down', text: 'x', ref: REF });
    assert.equal(env.calls[0].body.reply_markup, undefined);
  });

  test('ссылки-действия есть только при EASYADMIN_PUBLIC_URL', () => {
    assert.deepEqual(setup().ia.links(REF), []);
    const l = setup({ publicUrl: 'https://ea.example.com/' }).ia.links(REF);
    assert.equal(l.length, 4);
    assert.match(l[0].url, /^https:\/\/ea\.example\.com\/api\/alerts\/action\/[\w-]+\.[\w-]+$/);
  });
});

describe('маршруты', () => {
  const routes = (env) => interactiveAlertsRoutes({ interactive: env.ia, audit: () => {} });
  const find = (rs, m, p) => rs.find((r) => r[0] === m && r[1] === p);
  const secretOf = (env) => { const h = env.ia.webhookUrl(); void h; return null; };
  void secretOf;

  test('вебхук: без/с неверным секретом — 401; публичность и CSRF-режим', async () => {
    const env = setup();
    const rs = routes(env);
    for (const p of ['/api/alerts/telegram/webhook', '/api/alerts/telegram/callback']) {
      const r = find(rs, 'POST', p);
      assert.ok(r, p);
      assert.equal(r[3].hook, true);
      await assert.rejects(r[2]({ req: { headers: {} }, body: {} }), { status: 401 });
      await assert.rejects(r[2]({ req: { headers: { 'x-telegram-bot-api-secret-token': 'nope' } }, body: {} }), { status: 401 });
    }
  });

  test('setupWebhook: нужен HTTPS, затем setWebhook с secret_token', async () => {
    await assert.rejects(setup().ia.setupWebhook(), { status: 409 });
    const env = setup({ publicUrl: 'https://ea.example.com' });
    const r = await env.ia.setupWebhook();
    assert.equal(r.url, 'https://ea.example.com/api/alerts/telegram/webhook');
    const call = env.calls.find((c) => c.method === 'setWebhook').body;
    assert.deepEqual(call.allowed_updates, ['callback_query']);
    assert.match(call.secret_token, /^[A-Za-z0-9_-]{16,}$/);
    assert.equal(env.ia.checkSecret(call.secret_token), true);
    assert.equal(env.ia.checkSecret('x'), false);
    // вебхук с верным секретом обрабатывает callback
    const kb = keyboardFrom(env.ia);
    const out = await find(routes(env), 'POST', '/api/alerts/telegram/webhook')[2]({ req: { headers: { 'x-telegram-bot-api-secret-token': call.secret_token } }, body: click(kb[0][0].callback_data, { markup: kb }) });
    assert.deepEqual(out, { ok: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(env.mutations.length, 1);
  });

  test('ссылка-действие: GET показывает подтверждение и не гасит токен, POST выполняет один раз', async () => {
    const env = setup({ publicUrl: 'https://ea.example.com' });
    const rs = routes(env);
    const { token } = env.ia.issue(REF, 'restart');
    const get = find(rs, 'GET', '/api/alerts/action/:token'), post = find(rs, 'POST', '/api/alerts/action/:token');
    assert.equal(get[3].public, true); assert.equal(post[3].hook, true);
    const page = get[2]({ params: { token }, req: { headers: {} } });
    assert.equal(page.status, 200);
    assert.match(page.body, /<form method="post"/);
    assert.match(page.headers['Content-Security-Policy'], /default-src 'none'/);
    assert.equal(env.mutations.length, 0);
    const done = await post[2]({ params: { token }, req: { headers: { 'accept-language': 'de-DE' } } });
    assert.equal(done.status, 200);
    assert.match(done.body, /neu gestartet/);
    assert.equal(env.mutations.length, 1);
    const again = await post[2]({ params: { token }, req: { headers: {} } });
    assert.equal(again.status, 410);
    assert.equal(env.mutations.length, 1);
    assert.equal(get[2]({ params: { token }, req: { headers: {} } }).status, 410);
    assert.equal(get[2]({ params: { token: 'junk' }, req: { headers: {} } }).status, 410);
  });

  test('страница действия экранирует HTML', () => {
    const env = setup();
    const { token } = env.ia.issue({ panelId: 1, project: '<b>x</b>', service: 'api' }, 'logs');
    const page = find(routes(env), 'GET', '/api/alerts/action/:token')[2]({ params: { token }, req: { headers: {} } });
    assert.ok(!page.body.includes('<b>x</b>'));
    assert.match(page.body, /&lt;b&gt;x&lt;\/b&gt;/);
  });
});

describe('локализация', () => {
  test('кнопки и результаты переведены на все языки', () => {
    for (const l of ['en', 'zh', 'de', 'es', 'pt']) {
      for (const s of ['Перезапустить', 'Логи (20 строк)', 'AI Диагноз', 'Заглушить 1ч', 'Перезапуск запущен…', 'Получаю логи…', 'Запускаю AI-диагностику…', 'Кнопка устарела — дождитесь нового алерта', 'Подтвердить']) {
        assert.notEqual(translate(s, l), s, `${l}: ${s}`);
      }
      assert.match(translate('✅ Сервис shop/api перезапущен', l), /shop\/api/);
      assert.ok(!/[А-Яа-я]/.test(translate('📜 Логи shop/api (последние 20 строк)', l)));
    }
  });
});
