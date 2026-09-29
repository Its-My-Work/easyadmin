import { api, get, post } from './api.js';
import { renderBulkBar } from './components.js';
import { closeDrawer, openService } from './drawer.js';
import { clear, h, icon, toast, relTime } from './dom.js';
import { store, notify, refresh, subscribe, allServices, can, favorites, recents, svcKey } from './store.js';
import { bulkOpModal, inventoryPage, schedulesPage, templatesPage } from './views2.js';
import { auditPage, dashboard, panelForm, panelPage, servicesPage, settingsPage, pageHead } from './views.js';

const root = document.getElementById('root');
let shell = null;

/* ======================= вход / первичная настройка ======================= */
function authScreen(setup, sso) {
  const ssoError = new URLSearchParams(location.search).get('sso_error');
  if (ssoError) history.replaceState(null, '', location.pathname + location.hash);
  const user = h('input', { class: 'input', autocomplete: 'username', placeholder: 'Логин', autofocus: true });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', placeholder: setup ? 'Пароль (мин. 8 символов)' : 'Пароль' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const code = h('input', { class: 'input', inputmode: 'numeric', maxlength: 7, autocomplete: 'one-time-code', placeholder: 'Код 2FA (6 цифр)', hidden: true });
  const btn = h('button', { class: 'btn primary lg block', type: 'submit' }, setup ? 'Создать и войти' : 'Войти');
  const form = h('form', { class: 'auth-card', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true;
    try { await post(setup ? '/api/setup' : '/api/login', { username: user.value, password: pass.value, code: code.value || undefined }); await boot(); }
    catch (ex) { err.textContent = ex.message; btn.disabled = false; if (ex.data?.needTotp) { code.hidden = false; code.focus(); } }
  } },
    h('div', { class: 'logo lg' }, logoMark(), h('span', null, 'EasyAdmin')),
    h('h2', null, setup ? 'Первый запуск' : 'Вход'),
    h('p', { class: 'muted' }, setup ? 'Создайте учётную запись администратора. Через неё вы будете управлять всеми панелями Easypanel.' : 'Одна авторизация — все ваши панели Easypanel.'),
    user, pass, code, err, btn,
    !setup && sso ? h('div', { class: 'sso' }, h('div', { class: 'or' }, h('span', null, 'или')), h('a', { class: 'btn lg block', href: '/api/oidc/login' }, icon('shield', 16), `Войти через ${sso.name}`)) : null);
  if (ssoError) err.textContent = ssoError;
  clear(root).append(h('div', { class: 'auth' }, form));
}
const logoMark = () => h('span', { class: 'logo-mark' }, icon('layers', 16));

/* ======================= каркас ======================= */
function buildShell() {
  const nav = h('nav', { class: 'nav' });
  const panelsList = h('div', { class: 'nav-panels' });
  const view = h('main', { class: 'view', id: 'view' });
  const updated = h('span', { class: 'muted small' });
  const refreshBtn = h('button', { class: 'btn icon ghost', title: 'Обновить всё', 'aria-label': 'Обновить', onclick: () => refresh(true) }, icon('refresh', 16));
  const sidebar = h('aside', { class: 'sidebar' },
    h('a', { class: 'logo', href: '#/' }, logoMark(), h('span', null, 'EasyAdmin')),
    nav,
    h('div', { class: 'nav-title' }, h('span', null, 'Панели'), can('admin') ? h('button', { class: 'btn icon ghost sm', title: 'Добавить панель', onclick: () => panelForm() }, icon('plus', 14)) : null),
    panelsList,
    h('div', { class: 'side-foot' },
      h('div', { class: 'user' }, h('div', { class: 'avatar' }, store.user.username[0].toUpperCase()), h('div', null, h('b', null, store.user.username), h('div', { class: 'muted small' }, ({ admin: 'администратор', operator: 'оператор', viewer: 'только чтение' })[store.user.role]))),
      h('button', { class: 'btn icon ghost', title: 'Выйти', onclick: async () => { await post('/api/logout'); location.hash = ''; boot(); } }, icon('logout', 16))));
  const back = h('div', { class: 'side-back', onclick: () => document.body.classList.remove('nav-open') });
  const top = h('header', { class: 'topbar' },
    h('button', { class: 'btn icon ghost menu-btn', onclick: () => document.body.classList.toggle('nav-open'), 'aria-label': 'Меню' }, icon('menu', 18)),
    h('button', { class: 'search-trigger', onclick: openPalette }, icon('search', 15), h('span', null, 'Поиск и команды'), h('kbd', null, navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K')),
    h('span', { class: 'spacer' }), updated, refreshBtn);
  clear(root).append(h('div', { class: 'app' }, sidebar, back, h('div', { class: 'content' }, top, view)));
  shell = { nav, panelsList, view, updated, refreshBtn };
}

const NAV = [['#/', 'grid', 'Обзор'], ['#/services', 'layers', 'Все сервисы'], ['#/inventory', 'box', 'Инвентарь'], ['#/templates', 'copy', 'Шаблоны'], ['#/schedules', 'clock', 'Расписания'], ['#/audit', 'activity', 'Журнал'], ['#/settings', 'settings', 'Настройки']];
const dotClass = (s) => (s === 'online' ? 'ok' : s === 'degraded' ? 'warn' : s === 'unknown' ? 'muted' : 'err');

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, a, b, c] = hash.split('/');
  return { hash: '#' + hash, a, b, c };
}

function renderChrome() {
  if (!shell) return;
  const r = route();
  clear(shell.nav).append(...NAV.map(([href, ic, label]) => h('a', { class: `nav-item ${(href === '#/' ? r.hash === '#/' : r.hash.startsWith(href)) ? 'active' : ''}`, href, onclick: () => document.body.classList.remove('nav-open') }, icon(ic, 17), label)));
  clear(shell.panelsList).append(...(store.panels.length ? store.panels.map((p) => {
    const stopped = (p.tree?.projects ?? []).flatMap((x) => x.services).filter((s) => !s.enabled).length;
    return h('a', { class: `nav-panel ${r.a === 'panel' && Number(r.b) === p.id ? 'active' : ''}`, href: `#/panel/${p.id}`, onclick: () => document.body.classList.remove('nav-open') },
      h('i', { class: `dot ${dotClass(p.status)}` }), h('span', { class: 'np-name' }, p.name), stopped ? h('span', { class: 'count warn', title: 'Остановлено сервисов' }, stopped) : null);
  }) : [h('div', { class: 'muted small pad' }, 'Пока пусто')]));
  shell.updated.textContent = store.loadedAt ? `Обновлено ${relTime(store.loadedAt)}` : '';
  shell.refreshBtn.classList.toggle('spin', store.loading);
}

function renderView() {
  if (!shell) return;
  const r = route();
  let node;
  if (!store.loadedAt) node = h('div', { class: 'page' }, h('div', { class: 'panel-grid' }, [1, 2, 3].map(() => h('div', { class: 'skeleton card', style: { height: '190px' } }))));
  else if (r.a === 'panel') node = panelPage(r.b, r.c);
  else if (r.a === 'services') node = servicesPage();
  else if (r.a === 'inventory') node = inventoryPage();
  else if (r.a === 'templates') node = templatesPage();
  else if (r.a === 'schedules') node = schedulesPage();
  else if (r.a === 'audit') node = auditPage();
  else if (r.a === 'settings') node = settingsPage();
  else node = dashboard();
  const scroll = shell.view.scrollTop;
  clear(shell.view);
  if (store.error && store.loadedAt) shell.view.append(h('div', { class: 'callout err banner' }, icon('alert'), `Не удалось обновить данные: ${store.error}`));
  shell.view.append(node);
  shell.view.scrollTop = scroll;
}

let lastSig = '', lastHash = '';
function onStoreChange() {
  renderChrome();
  const r = route();
  const sig = JSON.stringify([store.panels, store.error, store.loadedAt > 0]);
  const typing = shell?.view.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (r.hash !== lastHash || (sig !== lastSig && !typing)) { lastHash = r.hash; lastSig = sig; renderView(); }
}

/* ======================= командная палитра ======================= */
function openPalette() {
  if (document.getElementById('palette')) return;
  const input = h('input', { class: 'input', placeholder: 'Найти сервис, панель или команду…', autocomplete: 'off' });
  const list = h('div', { class: 'pal-list', role: 'listbox' });
  let items = [], idx = 0;
  const close = () => { pal.remove(); document.removeEventListener('keydown', onKey, true); };
  const commands = [
    { title: 'Обзор', hint: 'Страница', ic: 'grid', run: () => (location.hash = '#/') },
    { title: 'Все сервисы', hint: 'Страница', ic: 'layers', run: () => (location.hash = '#/services') },
    { title: 'Журнал действий', hint: 'Страница', ic: 'activity', run: () => (location.hash = '#/audit') },
    { title: 'Настройки', hint: 'Страница', ic: 'settings', run: () => (location.hash = '#/settings') },
    ...(can('admin') ? [{ title: 'Добавить панель', hint: 'Команда', ic: 'plus', run: () => panelForm() }] : []),
    { title: 'Инвентарь: образы и сертификаты', hint: 'Страница', ic: 'box', run: () => (location.hash = '#/inventory') },
    { title: 'Шаблоны', hint: 'Страница', ic: 'copy', run: () => (location.hash = '#/templates') },
    { title: 'Расписания', hint: 'Страница', ic: 'clock', run: () => (location.hash = '#/schedules') },
    { title: 'Обновить данные', hint: 'Команда', ic: 'refresh', run: () => refresh(true) },
    ...store.panels.map((p) => ({ title: p.name, hint: 'Панель', ic: 'server', extra: p.url, color: p.color, run: () => (location.hash = `#/panel/${p.id}`) })),
    ...allServices().map((s) => ({ title: s.name, hint: `${s.panel.name} · ${s.project}`, ic: favorites().has(svcKey(s)) ? 'star' : 'box', extra: s.domain || '', color: favorites().has(svcKey(s)) ? null : s.panel.color, rank: favorites().has(svcKey(s)) ? 2 : recents().includes(svcKey(s)) ? 1 : 0, run: () => openService(s) })),
  ];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = commands.filter((c) => !q || `${c.title} ${c.hint} ${c.extra || ''}`.toLowerCase().includes(q));
    if (!q) items = [...items.filter((c) => c.rank), ...items.filter((c) => !c.rank)];
    else items.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    items = items.slice(0, 30);
    idx = Math.min(idx, Math.max(0, items.length - 1));
    clear(list).append(...(items.length ? items.map((c, i) => h('div', { class: `pal-item ${i === idx ? 'on' : ''}`, role: 'option', onmousemove: () => { idx = i; mark(); }, onclick: () => pick(i) },
      c.color ? h('i', { class: 'swatch', style: { background: c.color } }) : icon(c.ic, 15), h('span', { class: 'pal-title' }, c.title), h('span', { class: 'muted small' }, c.hint))) : [h('div', { class: 'muted pad' }, 'Ничего не найдено')]));
  };
  const mark = () => [...list.children].forEach((el, i) => { el.classList.toggle('on', i === idx); if (i === idx) el.scrollIntoView({ block: 'nearest' }); });
  const pick = (i) => { const c = items[i]; close(); c?.run(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(idx); }
  };
  input.addEventListener('input', () => { idx = 0; draw(); });
  document.addEventListener('keydown', onKey, true);
  const pal = h('div', { class: 'backdrop top', id: 'palette', onmousedown: (e) => { if (e.target === pal) close(); } }, h('div', { class: 'palette' }, h('div', { class: 'pal-input' }, icon('search', 16), input, h('kbd', null, 'Esc')), list));
  document.getElementById('overlay-root').append(pal);
  draw(); input.focus();
}

document.addEventListener('keydown', (e) => {
  if (!store.user) return;
  const tag = document.activeElement?.tagName;
  if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag))) { e.preventDefault(); openPalette(); }
});

/* ======================= запуск ======================= */
let pollTimer;
async function boot() {
  clearInterval(pollTimer); closeDrawer(); shell = null;
  let s;
  try { s = await get('/api/session'); } catch (e) { clear(root).append(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, h('h2', null, 'Сервер недоступен'), h('p', { class: 'muted' }, e.message), h('button', { class: 'btn', onclick: boot }, 'Повторить')))); return; }
  store.user = s.user;
  if (!s.user) { authScreen(s.setupRequired, s.sso); return; }
  store.panels = []; store.loadedAt = 0; store.selection.clear(); renderBulkBar();
  buildShell(); renderChrome(); renderView();
  await refresh(false);
  pollTimer = setInterval(() => { if (!document.hidden) refresh(false, { silent: true }); }, 15_000);
  setInterval(() => shell && renderChromeTime(), 5000);
}
const renderChromeTime = () => { if (shell) shell.updated.textContent = store.loadedAt ? `Обновлено ${relTime(store.loadedAt)}` : ''; };

subscribe(onStoreChange);
window.addEventListener('ea:rerender', () => renderView());
window.addEventListener('ea:bulk-op', (e) => bulkOpModal(e.detail));
window.addEventListener('hashchange', () => { closeDrawer(); onStoreChange(); });
window.addEventListener('ea:unauth', () => { if (store.user) { store.user = null; toast('Сессия истекла — войдите снова', 'error'); boot(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.user) refresh(false, { silent: true }); });
boot();
