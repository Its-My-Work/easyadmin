import { lang, locale, t } from './i18n.js';

/**
 * Публичная страница статуса: загружает /api/status/snapshot и рисует общий статус,
 * 90-дневные полоски аптайма и активные инциденты. Без авторизации, без сторонних библиотек.
 */

const THEME_KEY = 'ea-status-theme';
const REFRESH_MS = 30_000;
const OVERALL = {
  operational: 'Все системы в норме', maintenance: 'Плановые работы',
  partial_outage: 'Частичный сбой', major_outage: 'Крупный сбой',
};
const STATE = { operational: 'В норме', degraded: 'Деградация', outage: 'Сбой', unknown: 'Нет данных' };
const INCIDENT_STATUS = { investigating: 'Расследуем', identified: 'Причина найдена', monitoring: 'Наблюдаем', resolved: 'Решён' };
const SEVERITY = { minor: 'Незначительный', major: 'Серьёзный', maintenance: 'Плановые работы' };

const el = (tag, props, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
};

const app = document.getElementById('app');
const fmtDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtTime = (ms) => new Date(ms).toLocaleString(locale());

/* ---------- тема ---------- */
const isLight = () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'light';
try { const saved = localStorage.getItem(THEME_KEY); if (saved) document.documentElement.dataset.theme = saved; } catch { /* тема системная */ }
function toggleTheme() {
  const next = isLight() ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* приватный режим */ }
  themeBtn.textContent = isLight() ? '🌙' : '☀️';
}
const themeBtn = el('button', { type: 'button', 'aria-label': t('Сменить тему'), title: t('Сменить тему'), onclick: toggleTheme }, isLight() ? '🌙' : '☀️');

/* ---------- отрисовка ---------- */
const barClass = (up) => (up == null ? '' : up >= 99.9 ? 'ok' : up >= 95 ? 'warn' : 'bad');

export function bars(days) {
  return el('div', { class: 'bars', role: 'img', 'aria-label': t('Аптайм за 90 дней') },
    days.map((x) => el('div', { class: `bar ${barClass(x.up)}`, tabindex: '0' },
      el('span', { class: 'tip' }, `${fmtDate(x.d)} · ${x.up == null ? t('Нет данных') : `${x.up}%`}`))));
}

function serviceCard(s) {
  return el('section', { class: 'card' },
    el('div', { class: 'svc-head' },
      el('span', { class: 'svc-name' }, s.name),
      el('span', { class: `state ${s.state}` }, t(STATE[s.state] ?? STATE.unknown), s.uptime == null ? '' : ` · ${s.uptime}%`)),
    bars(s.days),
    el('div', { class: 'axis' }, el('span', null, t('90 дней назад')), el('span', null, t('Сегодня'))));
}

function incidentCard(i) {
  return el('article', { class: 'card inc' },
    el('h3', null, el('span', { class: `tag ${i.severity}` }, t(SEVERITY[i.severity] ?? i.severity)), i.title),
    el('div', { class: 'meta' }, `${t(INCIDENT_STATUS[i.status] ?? i.status)} · ${fmtTime(i.updatedAt)}`, i.components.length ? ` · ${i.components.map((c) => c.name).join(', ')}` : ''),
    i.message ? el('p', null, i.message) : null);
}

export function render(snap) {
  document.title = snap.title;
  app.replaceChildren(
    el('header', null, snap.logoUrl ? el('img', { src: snap.logoUrl, alt: '' }) : null, el('h1', null, snap.title), themeBtn),
    snap.description ? el('p', { class: 'desc' }, snap.description) : null,
    el('div', { class: `banner ${snap.status}`, role: 'status' }, t(OVERALL[snap.status] ?? OVERALL.operational)),
    snap.incidents.length ? el('h2', null, t('Активные инциденты')) : null,
    snap.incidents.map(incidentCard),
    snap.services.length ? snap.services.map(serviceCard) : el('p', { class: 'muted' }, t('Сервисы не добавлены')),
    el('footer', null, `${t('Обновлено')}: ${fmtTime(snap.updatedAt)} · Powered by EasyAdmin`));
}

let etag = null;
async function load() {
  try {
    const res = await fetch('/api/status/snapshot', { headers: etag ? { 'If-None-Match': etag } : {} });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(String(res.status));
    etag = res.headers.get('ETag');
    render(await res.json());
  } catch {
    if (!app.firstChild) app.replaceChildren(el('p', { class: 'muted' }, t('Страница статуса недоступна')));
  }
}

document.documentElement.lang = lang;
load();
setInterval(load, REFRESH_MS);
