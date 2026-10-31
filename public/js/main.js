import { lang, setLang, t } from './i18n.js';
import { GROUP_LABEL, highlight, orderItems } from './palette-order.js';
import { api, get, post } from './api.js';
import { renderBulkBar } from './components.js';
import { closeDrawer, openService } from './drawer.js';
import { clear, h, icon, toast, relTime } from './dom.js';
import { fmtServer, serverNow, serverTz, setServerTime, tzOffset } from './clock.js';
import { STATUS, store, notify, refresh, subscribe, allServices, can, favorites, recents, svcKey } from './store.js';
import { bulkOpModal, inventoryPage, schedulesPage, templatesPage } from './views2.js';
import { avatar, profilePage, usersPage } from './pages-users.js';
import { consolePage, selectConsolePanel } from './server-console.js';
import { backupsPage } from './backups-page.js';
import { filesPage, jumpFiles } from './files-page.js';
import { THEMES, applyTheme } from './theme-picker.js';
import { AVAILABLE_LANGS } from './i18n.js';
import { argOptions, buildRows, needsConfirm, nextNeed, parseQuery, prefixHints, runCommand } from './palette-commands.js';
import { auditPage, dashboard, panelForm, panelPage, servicesPage, settingsPage, pageHead, themePickerModal, languagePickerModal } from './views.js';

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
  clear(root).append(h('div', { class: 'auth' }, langToggle('lang-corner'), form));
}
/** Переключатель языка интерфейса: показывает текущий, по клику открывает выбор языка. */
const langToggle = (cls = '') => h('button', { class: `btn ghost sm lang-btn ${cls}`, type: 'button', title: 'Language / Язык', 'aria-label': 'Language / Язык', onclick: () => languagePickerModal() }, icon('globe', 14), h('span', { class: 'lang-txt' }, lang.toUpperCase()));
/** Кнопка выбора темы оформления в шапке */
const themeToggle = (cls = '') => h('button', { class: `btn icon ghost sm theme-btn ${cls}`, type: 'button', title: t('Тема оформления'), 'aria-label': t('Тема оформления'), onclick: () => themePickerModal() }, icon('palette', 14));
const ghLink = (cls = '') => h('a', { class: `btn icon ghost sm gh-btn ${cls}`, href: 'https://github.com/Its-My-Work/easyadmin', target: '_blank', rel: 'noopener noreferrer', title: 'GitHub · Star on GitHub', 'aria-label': 'GitHub' }, icon('github', 15));
const logoMark = () => h('span', { class: 'logo-mark' }, icon('layers', 16));

/* ======================= каркас ======================= */
function buildShell() {
  const nav = h('nav', { class: 'nav' });
  const panelsList = h('div', { class: 'nav-panels' });
  const view = h('main', { class: 'view', id: 'view' });
  const updated = h('span', { class: 'muted small' });
  const clock = h('span', { class: 'server-clock', role: 'timer' });
  const refreshBtn = h('button', { class: 'btn icon ghost', title: 'Обновить всё', 'aria-label': 'Обновить', onclick: () => refresh(true) }, icon('refresh', 16));
  const sidebar = h('aside', { class: 'sidebar' },
    h('a', { class: 'logo', href: '#/' }, logoMark(), h('span', null, 'EasyAdmin')),
    nav,
    h('div', { class: 'nav-title' }, h('span', null, 'Панели'), can('admin') ? h('button', { class: 'btn icon ghost sm', title: 'Добавить панель', onclick: () => panelForm() }, icon('plus', 14)) : null),
    panelsList);
  const back = h('div', { class: 'side-back', onclick: () => document.body.classList.remove('nav-open') });
  const top = h('header', { class: 'topbar' },
    h('button', { class: 'btn icon ghost menu-btn', title: 'Свернуть / развернуть меню', onclick: toggleMenu, 'aria-label': 'Меню' }, icon('menu', 18)),
    h('button', { class: 'search-trigger', title: 'Поиск и команды', 'aria-label': 'Поиск и команды', onclick: openPalette }, icon('search', 15), h('span', null, 'Поиск и команды'), h('kbd', null, navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K')),
    h('span', { class: 'spacer' }), clock, updated, refreshBtn, h('span', { class: 'top-sep' }), ghLink(), themeToggle(), langToggle(),
    h('a', { class: 'user user-chip', href: '#/profile', title: 'Профиль' }, avatar(store.user, 30), h('div', null, h('b', null, store.user.displayName || store.user.username), h('div', { class: 'muted small' }, ({ admin: 'администратор', operator: 'оператор', viewer: 'только чтение' })[store.user.role]))),
    h('button', { class: 'btn icon ghost', title: 'Выйти', 'aria-label': 'Выйти', onclick: async () => { await post('/api/logout'); location.hash = ''; boot(); } }, icon('logout', 16)));
  clear(root).append(h('div', { class: 'app' }, sidebar, back, h('div', { class: 'content' }, top, view)));
  shell = { nav, panelsList, view, updated, refreshBtn, clock };
  paintClock();
}

/** Дата и время сервера в шапке: тикает раз в секунду по смещению от серверных часов, пояс — из настроек. */
function paintClock() {
  if (!shell?.clock) return;
  const ts = serverNow();
  const date = fmtServer(ts, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = fmtServer(ts, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const label = `${date} ${time}`;
  if (shell.clock.dataset.v !== label) {
    shell.clock.dataset.v = label;
    shell.clock.replaceChildren(icon('clock', 14), h('span', { class: 'sc-date' }, date), h('b', null, time));
    shell.clock.title = `${t('Время сервера EasyAdmin')}: ${serverTz() ?? ''} (${tzOffset(serverTz() || undefined, ts)})`;
  }
}
async function syncServerTime() {
  try { setServerTime(await get('/api/time')); paintClock(); } catch { /* часы пойдут по времени браузера */ }
}
window.addEventListener('ea:timezone', syncServerTime);
setInterval(paintClock, 1000);
setInterval(() => { if (store.user && !document.hidden) syncServerTime(); }, 300_000);

const NAV = [['#/', 'grid', 'Обзор'], ['#/console', 'terminal', 'Консоль', 'admin'], ['#/services', 'layers', 'Сервисы'], ['#/inventory', 'box', 'Инвентарь'], ['#/templates', 'copy', 'Шаблоны'], ['#/schedules', 'clock', 'Расписания'], ['#/audit', 'activity', 'Журнал'], ['#/files', 'folder', 'Файлы', 'admin'], ['#/backups', 'database', 'Бэкапы', 'admin'], ['#/users', 'users', 'Пользователи', 'admin'], ['#/settings', 'settings', 'Настройки', 'admin']];
const dotClass = (s) => (s === 'online' ? 'ok' : s === 'degraded' ? 'warn' : s === 'unknown' ? 'muted' : 'err');

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, a, b, c] = hash.split('/');
  return { hash: '#' + hash, a, b, c };
}

const NARROW = window.matchMedia('(max-width: 900px)');
function toggleMenu() {
  if (NARROW.matches) return document.body.classList.toggle('nav-open'); // на узком экране меню выезжает поверх страницы
  const on = document.body.classList.toggle('nav-collapsed'); // на широком — сворачивается совсем, состояние помним
  try { localStorage.setItem('ea-nav-collapsed', on ? '1' : '0'); } catch { /* приватный режим */ }
}
try { if (localStorage.getItem('ea-nav-collapsed') === '1') document.body.classList.add('nav-collapsed'); } catch { /* нет доступа к хранилищу */ }

function renderChrome() {
  if (!shell) return;
  const r = route();
  const chromeSig = JSON.stringify([r.hash, r.a, r.b, store.user?.role, store.panels.map((p) => [p.id, p.name, p.status, p.color, (p.tree?.projects ?? []).flatMap((x) => x.services).filter((x) => !x.enabled).length])]);
  const rebuild = chromeSig !== shell.chromeSig; shell.chromeSig = chromeSig;
  if (rebuild) clear(shell.nav).append(...NAV.filter(([, , , need]) => !need || can(need)).map(([href, ic, label]) => h('a', { class: `nav-item ${(href === '#/' ? r.hash === '#/' : r.hash.startsWith(href)) ? 'active' : ''}`, href, onclick: () => document.body.classList.remove('nav-open') }, icon(ic, 17), label)));
  if (rebuild) clear(shell.panelsList).append(...(store.panels.length ? store.panels.map((p) => {
    const stopped = (p.tree?.projects ?? []).flatMap((x) => x.services).filter((s) => !s.enabled).length;
    return h('a', { class: `nav-panel ${r.a === 'panel' && Number(r.b) === p.id ? 'active' : ''}`, href: `#/panel/${p.id}`, onclick: () => document.body.classList.remove('nav-open') },
      h('i', { class: 'swatch', style: { background: p.color } }), h('span', { class: 'np-name' }, p.name), stopped ? h('span', { class: 'count warn', title: 'Остановлено сервисов' }, stopped) : null,
      h('i', { class: `dot ${dotClass(p.status)}`, title: (STATUS[p.status] ?? STATUS.unknown)[0] }));
  }) : [h('div', { class: 'muted small pad' }, 'Пока пусто')]));
  shell.updated.textContent = store.loadedAt ? `Обновлено ${relTime(store.loadedAt)}` : '';
  shell.refreshBtn.classList.toggle('spin', store.loading && !store.quiet);
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
  else if (r.a === 'files') node = can('admin') ? filesPage() : dashboard();
  else if (r.a === 'backups') node = can('admin') ? backupsPage() : dashboard();
  else if (r.a === 'settings') node = can('admin') ? settingsPage() : profilePage();
  else if (r.a === 'profile') node = profilePage();
  else if (r.a === 'users') node = usersPage();
  else if (r.a === 'console') node = can('admin') ? consolePage() : dashboard();
  else node = dashboard();
  // Прокручивается вся страница (window), а не .view: запоминаем её позицию и на время замены держим высоту,
  // иначе документ на миг «схлопывается» и браузер возвращает страницу наверх.
  const sameRoute = r.hash === lastHash;
  renderedReal = !!store.loadedAt;
  const scrollY = window.scrollY, viewH = shell.view.offsetHeight;
  // фоновое обновление: без анимаций и с одной атомарной заменой содержимого — никакого «моргания»
  const quiet = store.quiet && sameRoute;
  if (quiet) shell.view.classList.add('quiet');
  if (sameRoute) shell.view.style.minHeight = `${viewH}px`;
  shell.view.replaceChildren(...(store.error && store.loadedAt ? [h('div', { class: 'callout err banner' }, icon('alert'), `Не удалось обновить данные: ${store.error}`)] : []), node);
  if (sameRoute) window.scrollTo(window.scrollX, scrollY); else window.scrollTo(0, 0);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    shell.view.style.minHeight = '';
    if (quiet) shell.view.classList.remove('quiet');
    if (sameRoute && Math.abs(window.scrollY - scrollY) > 2) window.scrollTo(window.scrollX, scrollY);
  }));
}

let lastSig = '', lastHash = '', renderedReal = false; // renderedReal: на экране уже настоящая страница, а не скелетон ожидания данных
/**
 * Страницы, которые сами подгружают свои данные (журнал, настройки, расписания, шаблоны, инвентарь, пользователи, вкладки панели кроме «Сервисов»),
 * при фоновом обновлении списка панелей не перестраиваем: иначе они мигают скелетоном и теряют прокрутку. Они обновляются при переходе или своими кнопками.
 */
const selfLoading = (r) => ['audit', 'settings', 'profile', 'users', 'schedules', 'templates', 'inventory', 'console', 'backups', 'files'].includes(r.a) || (r.a === 'panel' && !!r.c && r.c !== 'services');
function onStoreChange() {
  renderChrome();
  const r = route();
  const sig = JSON.stringify([store.panels, store.error, store.loadedAt > 0]);
  const typing = shell?.view.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (selfLoading(r) && r.hash === lastHash && renderedReal) { lastSig = sig; return; }
  if (r.hash !== lastHash || (sig !== lastSig && !typing)) { renderView(); lastHash = r.hash; lastSig = sig; }
}

/* ======================= командная палитра 2.0 ======================= */
const lsPut = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } };
const paletteUi = {
  api: { post }, toast, t,
  go: (hash) => { location.hash = hash; },
  openService: (s, tab) => { if (tab) lsPut('ea-drawer-tab', tab); openService(s); },
  openFiles: (id, path) => { jumpFiles(id, path); if (location.hash === '#/files') window.dispatchEvent(new Event('ea:rerender')); else location.hash = '#/files'; },
  openConsole: (id) => { selectConsolePanel(id); location.hash = '#/console'; },
  applyTheme, setLang,
};
const paletteCtx = () => {
  let filesPanelId = null; try { filesPanelId = JSON.parse(localStorage.getItem('ea-files-panel')); } catch { /* нет значения */ }
  return { panels: store.panels, services: allServices(), can, t, filesPanelId,
    themes: THEMES.map((x) => ({ id: x.id, label: x.label })), langs: AVAILABLE_LANGS.map((x) => ({ code: x.code, label: x.label })) };
};

function openPalette() {
  if (document.getElementById('palette')) return;
  const input = h('input', { class: 'input', placeholder: t('Найти сервис, панель или команду…'), autocomplete: 'off' });
  const list = h('div', { class: 'pal-list', role: 'listbox' });
  const chips = h('div', { class: 'pal-chips' });
  const prefixBar = h('div', { class: 'pal-prefixes' }, prefixHints().map((p) => h('button', { type: 'button', class: 'pal-prefix', title: t(p.hint), onclick: () => { input.value = p.prefix; flow = null; idx = 0; draw(); input.focus(); } }, h('kbd', null, p.prefix), h('span', null, t(p.title)))));
  const ctx = paletteCtx();
  let rows = [], idx = 0, flow = null; // flow — многошаговая команда: { cmd, args, rest, confirm }
  const close = () => { pal.remove(); document.removeEventListener('keydown', onKey, true); };
  const go = (hash) => () => { location.hash = hash; };
  const fav = favorites(), rec = recents();
  // порядок страниц — как в боковом меню
  const pages = [['Обзор', 'grid', '#/'], ...(can('admin') ? [['Консоль сервера', 'terminal', '#/console']] : []), ['Сервисы', 'layers', '#/services'], ['Инвентарь', 'box', '#/inventory'], ['Шаблоны', 'copy', '#/templates'], ['Расписания', 'clock', '#/schedules'], ['Журнал действий', 'activity', '#/audit'], ...(can('admin') ? [['Файлы', 'folder', '#/files'], ['Бэкапы', 'database', '#/backups'], ['Пользователи', 'users', '#/users'], ['Настройки', 'settings', '#/settings']] : []), ['Профиль', 'users', '#/profile']];
  const items = [
    ...pages.map(([title, ic, hash], order) => ({ title, shown: t(title), hint: 'Страница', ic, group: 'page', order, run: go(hash) })),
    ...(can('admin') ? [{ title: 'Добавить панель', shown: t('Добавить панель'), hint: 'Команда', ic: 'plus', group: 'cmd', order: 0, run: () => panelForm() }] : []),
    { title: 'Обновить данные', shown: t('Обновить данные'), hint: 'Команда', ic: 'refresh', group: 'cmd', order: 1, run: () => refresh(true) },
    ...store.panels.map((p, order) => ({ title: p.name, hint: 'Панель', extra: p.url, ic: 'server', color: p.color, group: 'panel', order, run: go(`#/panel/${p.id}`) })),
    ...allServices().map((s) => {
      const k = svcKey(s), ri = rec.indexOf(k);
      return { title: s.name, hint: `${s.panel.name} · ${s.project}`, extra: s.domain || '', ic: fav.has(k) ? 'star' : 'box', color: fav.has(k) ? null : s.panel.color,
        group: fav.has(k) ? 'fav' : ri >= 0 ? 'recent' : 'service', recentIndex: ri, sortKey: `${s.name} ${s.panel.name} ${s.project}`, run: () => openService(s) };
    }),
  ];

  /** Что сейчас запрашивает поток: аргумент или подтверждение. */
  const flowNeed = () => (flow ? nextNeed(flow.cmd, flow.args) : null);
  const PLACEHOLDER = { service: 'Выберите сервис…', panel: 'Выберите панель…', path: 'Введите путь…', choice: 'Выберите вариант…' };
  const entry = (r, q = '') => ({ title: r.title, hint: r.hint, ic: r.ic, color: r.color, hotkey: r.hotkey, keys: r.keys, q, act: r.act ?? (() => {}) });

  const entries = () => {
    const raw = input.value;
    if (flow) {
      if (flow.confirm) return [{ title: `${t(flow.cmd.title)}?`, hint: t('Enter — подтвердить, Esc — отмена'), ic: 'alert', danger: flow.cmd.risk === 'high', act: () => finish() }];
      const need = flowNeed();
      return argOptions(need, raw.trim(), ctx, flow.cmd).map((o) => entry({ ...o, act: () => { flow.args[need] = o.value; advance(); } }, raw.trim()));
    }
    const parsed = parseQuery(raw);
    if (parsed.prefix) {
      return buildRows(raw, ctx).map((r) => entry({ ...r, title: r.type === 'command' || r.type === 'go' ? r.title : r.title, act:
        r.type === 'command' ? () => startFlow(r.cmd, { ...r.args }, r.rest)
          : r.type === 'go' ? () => { close(); location.hash = r.hash; }
            : r.type === 'fill' ? () => { input.value = r.text; idx = 0; draw(); } : () => {} }, parsed.text));
    }
    rows = orderItems(items, parsed.text);
    return rows.map(({ section, item: c }) => ({ ...entry({ title: t(c.title), hint: c.hint, ic: c.ic, color: c.color, act: () => { close(); c.run(); } }, parsed.text), section, extra: c.group === 'service' ? c.extra : '' }));
  };

  function startFlow(cmd, args, rest) { flow = { cmd, args, rest, confirm: false, presets: new Set(Object.keys(args)) }; input.value = rest || ''; idx = 0; advance(true); }
  function advance(first = false) {
    flow.confirm = false;
    if (!flowNeed()) {
      if (needsConfirm(flow.cmd)) { flow.confirm = true; input.value = ''; idx = 0; return draw(); }
      return finish();
    }
    if (!first) input.value = '';
    idx = 0; draw(); input.focus();
  }
  function finish() { const { cmd, args } = flow; close(); runCommand(cmd, args, paletteUi); }
  function back() {
    if (flow.confirm) { flow.confirm = false; }
    else {
      const filled = flow.cmd.needs.filter((k) => flow.args[k] != null && flow.args[k] !== '');
      if (!filled.length || filled.every((k) => flow.presets?.has(k))) { flow = null; input.value = ''; idx = 0; return draw(); }
      delete flow.args[filled[filled.length - 1]];
    }
    input.value = ''; idx = 0; draw();
  }

  let view = [];
  const draw = () => {
    view = entries();
    idx = Math.min(idx, Math.max(0, view.length - 1));
    const need = flowNeed();
    input.placeholder = flow ? t(PLACEHOLDER[need] ?? 'Enter — выполнить') : t('Найти сервис, панель или команду…');
    clear(chips);
    if (flow) {
      chips.append(h('span', { class: 'pal-chip cmd' }, t(flow.cmd.title)));
      for (const k of flow.cmd.needs) if (flow.args[k] != null && flow.args[k] !== '') chips.append(h('span', { class: 'pal-chip' }, String(flow.args[k].name ?? flow.args[k].label ?? flow.args[k])));
    }
    chips.hidden = !flow;
    prefixBar.hidden = !!flow || !!parseQuery(input.value).text || !!parseQuery(input.value).prefix;
    clear(list);
    if (!view.length) { list.append(h('div', { class: 'muted pad' }, t('Ничего не найдено'))); return; }
    const showSections = !flow && !parseQuery(input.value).prefix && !input.value.trim();
    view.forEach((c, i) => {
      if (c.section && showSections) list.append(h('div', { class: 'pal-group' }, t(GROUP_LABEL[c.section])));
      list.append(h('div', { class: `pal-item ${i === idx ? 'on' : ''}${c.danger ? ' danger' : ''}`, role: 'option', 'data-i': i, onmousemove: () => { idx = i; mark(); }, onclick: () => pick(i) },
        c.color ? h('i', { class: 'swatch', style: { background: c.color } }) : icon(c.ic ?? 'search', 15),
        h('span', { class: 'pal-title' }, ...highlight(String(c.title), c.q).map((p) => (p.match ? h('mark', null, p.text) : p.text)), c.extra ? h('span', { class: 'muted small pal-extra' }, c.extra) : null),
        c.keys || c.hotkey ? h('span', { class: 'pal-keys' }, String(c.keys ?? c.hotkey).split(' ').map((k) => h('kbd', null, k))) : null,
        h('span', { class: 'muted small' }, t(c.hint ?? ''))));
    });
  };
  const mark = () => list.querySelectorAll('.pal-item').forEach((el) => { const on = Number(el.dataset.i) === idx; el.classList.toggle('on', on); if (on) el.scrollIntoView({ block: 'nearest' }); });
  const pick = (i) => view[i]?.act();
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, view.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); mark(); }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); idx = 0; mark(); }
    else if (e.key === 'Backspace' && flow && !input.value) { e.preventDefault(); back(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(idx); }
  };
  input.addEventListener('input', () => { idx = 0; draw(); });
  document.addEventListener('keydown', onKey, true);
  const pal = h('div', { class: 'backdrop top', id: 'palette', onmousedown: (e) => { if (e.target === pal) close(); } }, h('div', { class: 'palette' }, h('div', { class: 'pal-input' }, icon('search', 16), chips, input, h('kbd', null, 'Esc')), prefixBar, list,
    h('div', { class: 'pal-foot muted small' }, t('↑↓ — выбор · Enter — выполнить · Backspace — назад · Esc — закрыть'))));
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
  await syncServerTime();
  buildShell(); renderChrome(); renderView();
  await refresh(false);
  pollTimer = setInterval(() => { if (!document.hidden) refresh(false, { silent: true }); }, 15_000);
  setInterval(() => shell && renderChromeTime(), 5000);
}
const renderChromeTime = () => { if (shell) shell.updated.textContent = store.loadedAt ? `Обновлено ${relTime(store.loadedAt)}` : ''; };

subscribe(onStoreChange);
window.addEventListener('ea:rerender', () => renderView());
window.addEventListener('ea:profile', () => { buildShell(); renderChrome(); renderView(); }); // имя в боковой панели обновляется сразу
window.addEventListener('ea:bulk-op', (e) => bulkOpModal(e.detail));
window.addEventListener('hashchange', () => { closeDrawer(); onStoreChange(); });
window.addEventListener('ea:unauth', () => { if (store.user) { store.user = null; toast('Сессия истекла — войдите снова', 'error'); boot(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.user) refresh(false, { silent: true }); });
boot();
