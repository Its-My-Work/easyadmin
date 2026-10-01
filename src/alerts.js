import { decrypt, encrypt } from './crypto.js';
import { translate } from '../public/js/i18n-dict.js';
import { sendMail } from './smtp.js';

export const EVENT_TYPES = {
  panel_down: 'Панель недоступна',
  panel_up: 'Панель снова доступна',
  auth_error: 'Ошибка токена панели',
  disk_high: 'Заканчивается диск',
  cert_expiring: 'Истекает сертификат',
  service_down: 'Сервис остановился или упал',
  schedule_failed: 'Ошибка задания по расписанию',
  overload: 'Перегрузка сервера',
};
const DEFAULT_EVENTS = Object.keys(EVENT_TYPES);
const SIX_HOURS = 6 * 3600_000;

/** Каналы уведомлений (Telegram, webhook) и детектор событий по снимкам панелей. */
export function createAlerts({ db, key, config, fetchImpl = globalThis.fetch }) {
  const state = new Map(); // panelId → { fails, down, authErr, diskHigh, diskAt, svc: Map }
  const expected = new Map(); // "panelId|project/name" → ts: действия, сделанные через EasyAdmin, не алертим

  const open = (row) => ({ ...row, config: JSON.parse(decrypt(key, row.config_enc)), events: row.events ? row.events.split(',') : [] });
  const list = () => db.prepare('SELECT * FROM channels ORDER BY id').all().map(open);

  /** Язык уведомлений: настройка в БД (Настройки → Уведомления), по умолчанию EASYADMIN_LANG. */
  const getLang = () => db.prepare("SELECT v FROM settings WHERE k = 'notify_lang'").get()?.v ?? config.lang ?? 'ru';
  const setLang = (l) => db.prepare("INSERT INTO settings (k, v) VALUES ('notify_lang', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(l);
  const tr = (s) => (getLang() === 'en' ? String(s).split('\n').map(translate).join('\n') : s);

  async function sendTo(channel, rawEvent) {
    const event = { ...rawEvent, text: tr(rawEvent.text) };
    const text = `${event.icon ?? '⚠️'} ${event.text}`;
    const c = channel.config;
    if (channel.type === 'telegram') {
      const r = await fetchImpl(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: c.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`Telegram: HTTP ${r.status}`);
    } else if (channel.type === 'webhook') {
      const r = await fetchImpl(c.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(c.secret ? { 'X-EasyAdmin-Secret': c.secret } : {}) },
        body: JSON.stringify({ type: event.type, text: event.text, panel: event.panel ?? null, ts: Date.now() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`Webhook: HTTP ${r.status}`);
    } else if (channel.type === 'email') {
      await sendMail({ ...c, subject: `EasyAdmin: ${tr(EVENT_TYPES[event.type] ?? 'уведомление')}`, text: `${event.text}\n\n— EasyAdmin` });
    } else throw new Error('Неизвестный тип канала');
  }

  async function emit(event) {
    const channels = list().filter((c) => c.enabled && c.events.includes(event.type));
    await Promise.allSettled(channels.map((c) => sendTo(c, event).catch((e) => console.error(`[alerts] ${c.name}: ${e.message}`))));
  }

  const expect = (panelId, label) => expected.set(`${panelId}|${label}`, Date.now());
  const wasExpected = (panelId, label) => Date.now() - (expected.get(`${panelId}|${label}`) ?? 0) < 120_000;

  /** Вызывается после каждого снимка панели. */
  function evaluate(row, snap) {
    const s = state.get(row.id) ?? { fails: 0, down: false, authErr: false, diskHigh: false, diskAt: 0, svc: new Map() };
    state.set(row.id, s);
    const panel = row.name;
    const events = [];
    if (snap.status === 'auth_error') {
      if (!s.authErr) { s.authErr = true; events.push({ type: 'auth_error', icon: '🔑', text: `Панель «${panel}»: токен отклонён (${snap.error})` }); }
    } else if (snap.status === 'offline') {
      s.fails++;
      if (s.fails >= 2 && !s.down) { s.down = true; events.push({ type: 'panel_down', icon: '🔴', text: `Панель «${panel}» недоступна: ${snap.error}` }); }
    } else {
      if (s.down) events.push({ type: 'panel_up', icon: '🟢', text: `Панель «${panel}» снова доступна` });
      s.fails = 0; s.down = false; s.authErr = false;
      const disk = snap.stats?.diskPct;
      if (disk != null) {
        if (disk >= config.diskAlertPct && (!s.diskHigh || Date.now() - s.diskAt > SIX_HOURS)) {
          s.diskHigh = true; s.diskAt = Date.now();
          events.push({ type: 'disk_high', icon: '💾', text: `Панель «${panel}»: диск заполнен на ${Math.round(disk)}%` });
        } else if (disk < config.diskAlertPct - 5) s.diskHigh = false;
      }
      const seen = new Set();
      for (const p of snap.tree?.projects ?? []) for (const svc of p.services) {
        const k = `${p.name}/${svc.name}`; seen.add(k);
        const bad = !svc.enabled ? 'остановлен' : svc.health === 'failing' ? 'не работает (контейнер упал)' : null;
        const was = s.svc.get(k);
        s.svc.set(k, bad ? 'bad' : 'ok');
        if (bad && was === 'ok' && !wasExpected(row.id, k)) events.push({ type: 'service_down', icon: '🟠', text: `Сервис ${k} на панели «${panel}» ${bad}` });
      }
      for (const k of s.svc.keys()) if (!seen.has(k)) s.svc.delete(k);
    }
    for (const e of events) emit({ ...e, panel });
    return events;
  }

  return {
    list, emit, evaluate, expect, sendTo, getLang, setLang,
    seal: (cfg) => encrypt(key, JSON.stringify(cfg)),
    publicChannel: (c) => ({ id: c.id, name: c.name, type: c.type, enabled: !!c.enabled, events: c.events,
      summary: c.type === 'telegram' ? `чат ${c.config.chatId}` : c.type === 'email' ? `${c.config.to}` : (() => { try { return new URL(c.config.url).host; } catch { return ''; } })() }),
    defaultEvents: DEFAULT_EVENTS,
  };
}
