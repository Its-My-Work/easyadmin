import crypto from 'node:crypto';
import { translate } from '../public/js/i18n-dict.js';
import { LANGS, buildMessages, collectContext, createDiagnosisCache, fetchLogTail, fingerprint, loadSettings, parseVerdict, sanitize, streamChat, tailLines } from './ai-doctor.js';
import { runAction } from './easypanel.js';
import { HttpError, RawResponse } from './http.js';

/**
 * Интерактивные алерты: кнопки действий под сообщением о сбое (Telegram) и ссылки-действия (почта, webhook).
 * Токен действия подписан HMAC-SHA256 ключом, производным от EASYADMIN_SECRET, живёт 15 минут и одноразовый.
 */

export const TOKEN_TTL_MS = 15 * 60_000;
export const MUTE_MS = 3600_000;
export const ACTION_LIST = ['restart', 'logs', 'ai', 'mute'];
export const LOG_LINES = 20;
const CB_PREFIX = 'ea1.';
const CB_RE = /^ea1\.[A-Za-z0-9_-]{16}$/;
const TG_LIMIT = 3900;
const UI_LANGS = ['ru', 'en', 'zh', 'de', 'es', 'pt'];

/* ---------------- подпись токенов ---------------- */

export class TokenError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const hmacKey = (key) => crypto.createHmac('sha256', key).update('easyadmin/interactive-alerts/v1').digest();
const mac = (key, body) => crypto.createHmac('sha256', hmacKey(key)).update(body).digest();

/** token = base64url(payload JSON) . base64url(HMAC-SHA256). Payload: { panelId, project, service, action, exp, n } */
export function signToken(key, { panelId, project, service, action, exp, n = crypto.randomBytes(12).toString('base64url') }) {
  const body = b64(JSON.stringify({ panelId, project, service, action, exp, n }));
  return `${body}.${b64(mac(key, body))}`;
}

/** Проверяет подпись и срок; возвращает payload либо бросает TokenError(malformed | signature | expired). */
export function verifyToken(key, token, nowMs = Date.now()) {
  const [body, sig, extra] = String(token ?? '').split('.');
  if (!body || !sig || extra !== undefined) throw new TokenError('malformed', 'Некорректная ссылка действия');
  const want = mac(key, body);
  let got;
  try { got = Buffer.from(sig, 'base64url'); } catch { got = Buffer.alloc(0); }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new TokenError('signature', 'Некорректная ссылка действия');
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new TokenError('malformed', 'Некорректная ссылка действия'); }
  if (!p || !Number.isInteger(p.panelId) || typeof p.project !== 'string' || typeof p.service !== 'string' || !ACTION_LIST.includes(p.action) || !Number.isFinite(p.exp) || typeof p.n !== 'string') {
    throw new TokenError('malformed', 'Некорректная ссылка действия');
  }
  if (nowMs >= p.exp) throw new TokenError('expired', 'Ссылка действия устарела');
  return p;
}

/** Достаёт callback_query из апдейта Telegram: { id, data, chatId, messageId, text, markup, from } либо null. */
export function parseCallback(update) {
  const cq = update?.callback_query;
  if (!cq || typeof cq.data !== 'string' || !CB_RE.test(cq.data)) return null;
  const m = cq.message ?? {};
  if (m.chat?.id == null) return null;
  return {
    id: String(cq.id), data: cq.data, chatId: String(m.chat.id), messageId: m.message_id ?? null,
    text: m.text ?? '', markup: m.reply_markup?.inline_keyboard ?? null,
    from: { id: cq.from?.id ?? null, name: cq.from?.username ? `@${cq.from.username}` : String(cq.from?.id ?? '?') },
  };
}

/** Карта кнопок для inline_keyboard: по две в ряд. */
export const keyboardOf = (buttons) => {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
};

const clip = (s, n = TG_LIMIT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createInteractiveAlerts({ db, key, config = {}, manager, alerts, audit = () => {}, fetchImpl = globalThis.fetch, now = Date.now, logsFn = fetchLogTail, ttlMs = TOKEN_TTL_MS, apiBase = 'https://api.telegram.org' }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_refs (nonce TEXT PRIMARY KEY, token TEXT NOT NULL, exp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS alert_used (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS alert_mutes (panel_id INTEGER NOT NULL, project TEXT NOT NULL, service TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (panel_id, project, service));
  `);
  const diagCache = createDiagnosisCache(db, { now });
  const enabled = () => config.interactive !== false;
  const lang = () => alerts?.getLang?.() ?? config.lang ?? 'ru';
  /** Перевод на язык уведомлений (ru|en) или любой из шести; {0}, {1} — подстановки. */
  const tr = (s, args = [], l = lang()) => translate(s, l).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
  const webhookSecret = crypto.createHmac('sha256', hmacKey(key)).update('telegram-webhook').digest('hex').slice(0, 48);

  /* ---------------- выпуск и погашение токенов ---------------- */

  function gc() {
    const t0 = now();
    db.prepare('DELETE FROM alert_refs WHERE exp <= ?').run(t0);
    db.prepare('DELETE FROM alert_used WHERE exp <= ?').run(t0);
    db.prepare('DELETE FROM alert_mutes WHERE until <= ?').run(t0);
  }

  /** Выпускает токен; в Telegram уходит короткий идентификатор (callback_data ≤ 64 байт), полный токен лежит в SQLite. */
  function issue(ref, action) {
    gc();
    const exp = now() + ttlMs;
    const token = signToken(key, { panelId: ref.panelId, project: ref.project, service: ref.service, action, exp });
    const nonce = verifyToken(key, token, now()).n;
    db.prepare('INSERT INTO alert_refs (nonce, token, exp) VALUES (?,?,?)').run(nonce, token, exp);
    return { token, callbackData: CB_PREFIX + nonce.slice(0, 16), nonce };
  }

  /** Проверка без погашения (страница подтверждения). */
  function peek(token) {
    const p = verifyToken(key, token, now());
    if (db.prepare('SELECT 1 FROM alert_used WHERE nonce = ?').get(p.n)) throw new TokenError('replay', 'Ссылка действия уже использована');
    return p;
  }

  /** Проверка и одноразовое погашение: повторный вызов с тем же токеном — TokenError('replay'). */
  function redeem(token) {
    const p = verifyToken(key, token, now());
    const r = db.prepare('INSERT OR IGNORE INTO alert_used (nonce, exp) VALUES (?,?)').run(p.n, p.exp);
    if (r.changes !== 1) throw new TokenError('replay', 'Ссылка действия уже использована');
    db.prepare('DELETE FROM alert_refs WHERE nonce = ?').run(p.n);
    return p;
  }

  const redeemCallback = (data) => {
    const row = db.prepare('SELECT token FROM alert_refs WHERE nonce = ?').get(data.slice(CB_PREFIX.length));
    if (!row) throw new TokenError('unknown', 'Ссылка действия устарела');
    return redeem(row.token);
  };

  /* ---------------- заглушение ---------------- */

  const isMuted = (panelId, project, service) => {
    const r = db.prepare('SELECT until FROM alert_mutes WHERE panel_id = ? AND project = ? AND service = ?').get(panelId, project, service);
    return !!r && r.until > now();
  };
  const mute = (panelId, project, service, ms = MUTE_MS) => {
    db.prepare('INSERT INTO alert_mutes (panel_id, project, service, until) VALUES (?,?,?,?) ON CONFLICT(panel_id, project, service) DO UPDATE SET until = excluded.until').run(panelId, project, service, now() + ms);
    return now() + ms;
  };

  /* ---------------- кнопки и ссылки ---------------- */

  const LABELS = {
    restart: ['🔄', 'Перезапустить'],
    logs: ['📜', 'Логи (20 строк)'],
    ai: ['🤖', 'AI Диагноз'],
    mute: ['🔕', 'Заглушить 1ч'],
  };
  const label = (a, l) => `${LABELS[a][0]} ${tr(LABELS[a][1], [], l)}`;

  /** inline_keyboard для сообщения о сбое сервиса. */
  function keyboard(ref) {
    return keyboardOf(ACTION_LIST.map((a) => ({ text: label(a), callback_data: issue(ref, a).callbackData })));
  }

  /** Ссылки-действия для почты/webhook (нужен EASYADMIN_PUBLIC_URL). */
  function links(ref) {
    if (!enabled() || !config.publicUrl) return [];
    const base = config.publicUrl.replace(/\/+$/, '');
    return ACTION_LIST.map((a) => ({ action: a, label: label(a), url: `${base}/api/alerts/action/${issue(ref, a).token}` }));
  }

  /** Нужны ли кнопки в этом канале. */
  const enabledFor = (channel) => enabled() && channel.type === 'telegram' && channel.config.interactive !== false;

  /* ---------------- действия ---------------- */

  async function findService(row, project, service, t) {
    const tree = (await manager.snapshot(row.id))?.tree?.projects ?? [];
    const svc = tree.find((p) => p.name === project)?.services.find((s) => s.name === service);
    if (!svc) throw new Error(t('Сервис не найден'));
    return svc;
  }

  async function diagnose(row, svc, client, t) {
    if (config.aiEnabled === false) throw new Error(t('AI Doctor отключён (EASYADMIN_AI=off)'));
    const settings = loadSettings(db, key);
    if (!settings.endpoint || !settings.model) throw new Error(t('AI Doctor не настроен: укажите адрес провайдера и модель в настройках'));
    const l = LANGS[lang()] ? lang() : 'en';
    const info = await collectContext({ client, row, service: svc, db, logs: logsFn, paths: config.logsPaths, extraSecrets: [settings.apiKey] });
    const hash = fingerprint(info, { model: settings.model, lang: l });
    let content = diagCache.get(hash)?.content;
    if (!content) {
      content = '';
      for await (const piece of streamChat({ endpoint: settings.endpoint, model: settings.model, apiKey: settings.apiKey, messages: buildMessages(info.text, l), fetchImpl })) content += piece;
      if (!content.trim()) throw new Error(t('AI-провайдер вернул пустой ответ'));
      diagCache.put(hash, content);
    }
    const v = parseVerdict(content);
    return [v.what && `${t('Что случилось')}: ${v.what}`, v.cause && `${t('Причина')}: ${v.cause}`, v.fix && `${t('Решение')}: ${v.fix}`].filter(Boolean).join('\n\n');
  }

  /**
   * Выполняет действие из проверенного payload.
   * Возвращает { status, detail?, body? }: status — короткая строка для замены кнопок, body — отдельное сообщение (логи, диагноз).
   */
  async function execute(p, actor = 'alert', l = lang()) {
    const t = (s, args = []) => tr(s, args, l);
    const row = manager.getRow(p.panelId);
    if (!row) throw new Error(t('Панель не найдена'));
    const target = `${p.project}/${p.service}`;
    const ctx = { user: { username: actor } };
    try {
      let out;
      if (p.action === 'mute') {
        mute(row.id, p.project, p.service);
        out = { status: t('🔕 Алерты по {0} заглушены на 1 час', [target]) };
      } else {
        const svc = await findService(row, p.project, p.service, t);
        const client = manager.clientFor(row);
        if (p.action === 'restart') {
          alerts?.expect?.(row.id, target);
          try { await runAction(client, { type: svc.type, project: p.project, name: p.service, action: 'restart' }); } finally { manager.invalidate(row.id); }
          out = { status: t('✅ Сервис {0} перезапущен', [target]) };
        } else if (p.action === 'logs') {
          const raw = await logsFn(client, row, { project: p.project, service: p.service, compose: svc.type === 'compose' }, { paths: config.logsPaths });
          const lines = sanitize(tailLines(raw, { maxLines: LOG_LINES, maxChars: 3200 }).join('\n'), { extra: [client.token] });
          out = { status: t('📜 Логи {0} отправлены', [target]), body: lines ? `${t('📜 Логи {0} (последние {1} строк)', [target, LOG_LINES])}\n${lines}` : t('Логи недоступны или пусты'), pre: !!lines };
        } else {
          const text = await diagnose(row, svc, client, t);
          out = { status: t('🤖 AI-диагноз {0} отправлен', [target]), body: `${t('🤖 AI-диагноз {0}', [target])}\n\n${text}` };
        }
      }
      audit(ctx, { action: `alert.${p.action}`, panel: row, target, detail: actor });
      return out;
    } catch (e) {
      audit(ctx, { action: `alert.${p.action}`, panel: row, target, ok: false, detail: e.message });
      throw e;
    }
  }

  /* ---------------- Telegram ---------------- */

  async function tg(botToken, method, body) {
    const r = await fetchImpl(`${apiBase}/bot${botToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? ((body.timeout ?? 0) + 15) * 1000 : 10_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw Object.assign(new Error(`Telegram: HTTP ${r.status}${j.description ? ` ${j.description}` : ''}`), { status: r.status });
    return j.result;
  }

  const tgChannels = () => (alerts?.list?.() ?? []).filter((c) => c.enabled && enabledFor(c) && c.config.botToken && c.config.chatId);

  /**
   * Обрабатывает апдейт Telegram. Возвращает { handled, done }:
   * на callback_query сразу отвечает (answerCallbackQuery), а действие выполняется в `done` (его можно не ждать).
   */
  async function handleUpdate(update) {
    const cb = parseCallback(update);
    if (!cb) return { handled: false, done: Promise.resolve() };
    const channel = tgChannels().find((c) => String(c.config.chatId) === cb.chatId);
    if (!channel) return { handled: false, done: Promise.resolve() };
    const bot = channel.config.botToken;
    const answer = (text, alert = false) => tg(bot, 'answerCallbackQuery', { callback_query_id: cb.id, text: clip(text, 190), show_alert: alert }).catch((e) => console.error(`[alerts] answerCallbackQuery: ${e.message}`));

    let p;
    try { p = redeemCallback(cb.data); } catch (e) {
      if (!(e instanceof TokenError)) throw e;
      await answer(e.code === 'replay' ? tr('Кнопка уже использована') : tr('Кнопка устарела — дождитесь нового алерта'), true);
      return { handled: true, ok: false, done: Promise.resolve() };
    }
    const pending = { restart: 'Перезапуск запущен…', logs: 'Получаю логи…', ai: 'Запускаю AI-диагностику…', mute: 'Заглушаю алерты…' }[p.action];
    await answer(tr(pending));

    const done = (async () => {
      const edit = (line) => {
        // кнопка, которую нажали, пропадает; остальные остаются рабочими
        const rest = (cb.markup ?? []).map((row) => row.filter((b) => b.callback_data !== cb.data)).filter((row) => row.length);
        return tg(bot, 'editMessageText', { chat_id: cb.chatId, message_id: cb.messageId, text: clip(`${cb.text}\n\n${line}`), disable_web_page_preview: true, reply_markup: { inline_keyboard: rest } })
          .catch((e) => console.error(`[alerts] editMessageText: ${e.message}`));
      };
      try {
        const out = await execute(p, `telegram:${cb.from.name}`);
        if (out.body) {
          const msg = out.pre ? { text: clip(`<pre>${esc(out.body)}</pre>`, 4000), parse_mode: 'HTML' } : { text: clip(out.body) };
          await tg(bot, 'sendMessage', { chat_id: cb.chatId, reply_to_message_id: cb.messageId, disable_web_page_preview: true, ...msg })
            .catch((e) => console.error(`[alerts] sendMessage: ${e.message}`));
        }
        await edit(out.status);
        return true;
      } catch (e) {
        await edit(tr('❌ Не удалось выполнить действие: {0}', [e.message]));
        return false;
      }
    })();
    return { handled: true, ok: true, done };
  }

  const webhookUrl = () => `${String(config.publicUrl ?? '').replace(/\/+$/, '')}/api/alerts/telegram/webhook`;
  const checkSecret = (header) => {
    const a = Buffer.from(String(header ?? '')), b = Buffer.from(webhookSecret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  /** Регистрирует вебхук у всех интерактивных ботов (нужен публичный HTTPS-адрес). */
  async function setupWebhook() {
    if (!config.publicUrl || !/^https:\/\//i.test(config.publicUrl)) throw new HttpError(409, 'Для вебхука Telegram нужен HTTPS-адрес в EASYADMIN_PUBLIC_URL');
    const bots = [...new Set(tgChannels().map((c) => c.config.botToken))];
    if (!bots.length) throw new HttpError(409, 'Нет включённых Telegram-каналов');
    for (const bot of bots) await tg(bot, 'setWebhook', { url: webhookUrl(), secret_token: webhookSecret, allowed_updates: ['callback_query'] });
    return { ok: true, url: webhookUrl(), bots: bots.length };
  }

  /* ---------------- polling (без публичного адреса) ---------------- */

  const offsets = new Map();
  const loops = new Map(); // botToken → AbortController
  let supervisor = null;

  /** Один запрос getUpdates для бота; апдейты обрабатываются, смещение запоминается. */
  async function pollOnce(bot, { timeout = 0 } = {}) {
    const updates = await tg(bot, 'getUpdates', { offset: offsets.get(bot), timeout, allowed_updates: ['callback_query'] });
    const dones = [];
    for (const u of updates ?? []) {
      offsets.set(bot, u.update_id + 1);
      try { dones.push((await handleUpdate(u)).done); } catch (e) { console.error(`[alerts] callback: ${e.message}`); }
    }
    await Promise.allSettled(dones);
    return updates?.length ?? 0;
  }

  const sleep = (ms, signal) => new Promise((resolve) => { const id = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true }); });

  async function loop(bot, signal) {
    await tg(bot, 'deleteWebhook', {}).catch(() => {}); // getUpdates не работает вместе с вебхуком
    while (!signal.aborted) {
      try { await pollOnce(bot, { timeout: 25 }); } catch (e) {
        if (!signal.aborted) { console.error(`[alerts] polling: ${e.message}`); await sleep(e.status === 409 ? 30_000 : 5_000, signal); }
      }
    }
  }

  function syncPolling() {
    const want = new Set(config.publicUrl ? [] : tgChannels().map((c) => c.config.botToken));
    for (const [bot, ac] of loops) if (!want.has(bot)) { ac.abort(); loops.delete(bot); }
    for (const bot of want) if (!loops.has(bot)) { const ac = new AbortController(); loops.set(bot, ac); loop(bot, ac.signal); }
  }
  function startPolling() {
    if (supervisor || !enabled()) return;
    syncPolling();
    supervisor = setInterval(syncPolling, 30_000); supervisor.unref?.();
  }
  function stopPolling() {
    clearInterval(supervisor); supervisor = null;
    for (const ac of loops.values()) ac.abort();
    loops.clear();
  }

  /* ---------------- страница подтверждения (ссылка из почты / Discord) ---------------- */

  const pageLang = (req) => {
    const first = String(req?.headers?.['accept-language'] ?? '').split(',')[0].trim().slice(0, 2).toLowerCase();
    return UI_LANGS.includes(first) ? first : lang();
  };
  const PAGE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" };
  const page = (l, title, body, status = 200) => new RawResponse(
    `<!doctype html><html lang="${l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>EasyAdmin</title>
<style>body{font:16px system-ui,sans-serif;background:#0f1117;color:#e6e8ee;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:560px;padding:28px;background:#171a23;border:1px solid #2a2f3d;border-radius:12px}h1{font-size:20px;margin:0 0 12px}pre{white-space:pre-wrap;word-break:break-word;background:#0f1117;padding:12px;border-radius:8px;font-size:13px}button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#6366f1;color:#fff;cursor:pointer}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`,
    'text/html; charset=utf-8', PAGE_HEADERS, status);

  const errPage = (l, e) => {
    const known = e instanceof TokenError;
    const msg = e.code === 'replay' ? tr('Ссылка действия уже использована', [], l) : known ? tr(e.code === 'expired' ? 'Ссылка действия устарела' : 'Некорректная ссылка действия', [], l) : e.message;
    return page(l, tr('Действие не выполнено', [], l), `<p>${esc(msg)}</p>`, known ? 410 : 500);
  };

  function confirmPage(token, req) {
    const l = pageLang(req);
    try {
      const p = peek(token);
      const names = { restart: 'Перезапустить', logs: 'Логи (20 строк)', ai: 'AI Диагноз', mute: 'Заглушить 1ч' };
      return page(l, `${tr(names[p.action], [], l)}: ${p.project}/${p.service}`,
        `<p>${esc(tr('Подтвердите действие. Ссылка одноразовая и действует 15 минут.', [], l))}</p><form method="post" action="/api/alerts/action/${esc(token)}"><button type="submit">${esc(tr('Подтвердить', [], l))}</button></form>`);
    } catch (e) { return errPage(l, e); }
  }

  async function runLink(token, req) {
    const l = pageLang(req);
    try {
      const p = redeem(token);
      const out = await execute(p, 'link', l);
      const body = out.body ? `<p>${esc(out.status)}</p><pre>${esc(out.body)}</pre>` : `<p>${esc(out.status)}</p>`;
      return page(l, tr('Готово', [], l), body);
    } catch (e) { return errPage(l, e); }
  }

  return { enabled, enabledFor, issue, peek, redeem, redeemCallback, keyboard, links, isMuted, mute, execute, handleUpdate, pollOnce, startPolling, stopPolling, setupWebhook, checkSecret, confirmPage, runLink, webhookUrl };
}

/* ---------------- маршруты ---------------- */

export function interactiveAlertsRoutes(d) {
  const { interactive } = d;
  if (!interactive) return [];

  /** Вебхук Telegram: подлинность — по secret_token, действие — по подписанному одноразовому токену. */
  const webhook = async (ctx) => {
    if (!interactive.checkSecret(ctx.req.headers['x-telegram-bot-api-secret-token'])) throw new HttpError(401, 'Неверный секрет вебхука');
    const r = await interactive.handleUpdate(ctx.body);
    r.done.catch((e) => console.error(`[alerts] callback: ${e.message}`)); // Telegram ждёт быстрый 200
    return { ok: true };
  };

  return [
    ['POST', '/api/alerts/telegram/webhook', webhook, { hook: true }],
    ['POST', '/api/alerts/telegram/callback', webhook, { hook: true }],
    ['POST', '/api/alerts/telegram/setup', async (ctx) => {
      const r = await interactive.setupWebhook();
      d.audit(ctx, { action: 'alerts.telegram.setup', target: r.url });
      return r;
    }, { admin: true }],
    ['GET', '/api/alerts/action/:token', (ctx) => interactive.confirmPage(ctx.params.token, ctx.req), { public: true }],
    ['POST', '/api/alerts/action/:token', (ctx) => interactive.runLink(ctx.params.token, ctx.req), { hook: true, raw: true }],
  ];
}
