import { del, get, post, put } from './api.js';
import { empty, matches, meter, panelChip, serviceFilters, serviceRow, statusBadge, svcBadge, typeChip } from './components.js';
import { openService } from './drawer.js';
import { clear, confirmDialog, field, fmtTime, gb, h, host, icon, modal, pct, relTime, toast, uptime } from './dom.js';
import { allServices, panelById, refresh, store } from './store.js';

const go = (hash) => { location.hash = hash; };

/* ======================= Обзор ======================= */
export function dashboard() {
  const panels = store.panels;
  if (!panels.length && store.loadedAt) {
    return h('div', { class: 'page' }, pageHead('Обзор'), welcome());
  }
  const svcs = allServices();
  const online = panels.filter((p) => p.status === 'online' || p.status === 'degraded').length;
  const running = svcs.filter((s) => s.enabled).length;
  const cpus = panels.map((p) => p.stats?.cpu).filter((x) => x != null);
  const avg = cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null;
  const attention = [
    ...panels.filter((p) => !['online', 'degraded'].includes(p.status) && p.status !== 'unknown').map((p) => ({ kind: 'panel', p })),
    ...svcs.filter((s) => !s.enabled).map((s) => ({ kind: 'svc', s })),
  ];
  return h('div', { class: 'page' },
    pageHead('Обзор', h('button', { class: 'btn primary', onclick: () => panelForm() }, icon('plus', 15), 'Добавить панель')),
    h('div', { class: 'kpis' },
      kpi('Панели', `${online}/${panels.length}`, online === panels.length ? 'Все на связи' : `${panels.length - online} недоступно`, online === panels.length ? 'ok' : 'err', 'server'),
      kpi('Проекты', panels.reduce((n, p) => n + (p.tree?.projects.length ?? 0), 0), 'на всех панелях', '', 'folder'),
      kpi('Сервисы', `${running}/${svcs.length}`, `${svcs.length - running} остановлено`, svcs.length - running ? 'warn' : 'ok', 'layers'),
      kpi('Средний CPU', pct(avg), 'по онлайн-панелям', avg > 85 ? 'err' : avg > 65 ? 'warn' : '', 'activity')),
    h('div', { class: 'panel-grid' }, panels.map(panelCard)),
    attention.length ? h('section', { class: 'card' }, h('h3', null, 'Требуют внимания'),
      h('div', { class: 'list' }, attention.slice(0, 12).map((a) => a.kind === 'panel'
        ? h('a', { class: 'list-item link', href: `#/panel/${a.p.id}` }, h('div', null, panelChip(a.p), h('div', { class: 'muted small' }, a.p.error || 'Нет связи')), statusBadge(a.p.status))
        : h('div', { class: 'list-item link', onclick: () => openService(a.s) }, h('div', null, h('b', null, `${a.s.project}/${a.s.name}`), h('div', { class: 'muted small' }, a.s.panel.name)), svcBadge(false))))) : null);
}

function welcome() {
  return h('div', { class: 'card hero' }, h('div', { class: 'hero-ic' }, icon('server', 28)), h('h2', null, 'Добавьте первую панель Easypanel'),
    h('p', { class: 'muted' }, 'Понадобится адрес панели и API-токен (Easypanel → Settings → Users → Generate API Token). Токен хранится в зашифрованном виде.'),
    h('button', { class: 'btn primary lg', onclick: () => panelForm() }, icon('plus', 16), 'Подключить панель'));
}

const kpi = (label, value, sub, tone, ic) => h('div', { class: `kpi ${tone}` }, h('div', { class: 'kpi-ic' }, icon(ic, 18)), h('div', null, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-sub' }, sub)));

function panelCard(p) {
  const svcs = (p.tree?.projects ?? []).flatMap((x) => x.services);
  const stopped = svcs.filter((s) => !s.enabled).length;
  const down = !['online', 'degraded'].includes(p.status);
  return h('a', { class: `panel-card ${down ? 'down' : ''}`, href: `#/panel/${p.id}`, style: { '--pc': p.color } },
    h('div', { class: 'pc-head' }, h('div', null, h('h3', null, p.name), h('div', { class: 'muted small' }, host(p.url))), statusBadge(p.status)),
    down ? h('div', { class: 'callout err compact' }, icon('alert', 14), p.error || 'Нет данных') : h('div', { class: 'meters' }, meter('CPU', p.stats?.cpu), meter('RAM', p.stats?.memPct), meter('Диск', p.stats?.diskPct)),
    h('div', { class: 'pc-foot' }, h('span', null, icon('folder', 13), `${p.tree?.projects.length ?? 0}`), h('span', null, icon('layers', 13), `${svcs.length}`),
      stopped ? h('span', { class: 'warn-text' }, `${stopped} остановлено`) : null, h('span', { class: 'spacer' }), p.latencyMs ? h('span', { class: 'muted' }, `${p.latencyMs} мс`) : null),
    p.tags?.length ? h('div', { class: 'tags' }, p.tags.map((t) => h('span', { class: 'tag' }, t))) : null);
}

export const pageHead = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'inline' }, actions));

/* ======================= Панель ======================= */
const panelFilters = new Map();
export function panelPage(id, sub) {
  const p = panelById(id);
  if (!p) return h('div', { class: 'page' }, empty('Панель не найдена', 'Возможно, она была удалена.', h('a', { class: 'btn', href: '#/' }, 'К обзору')));
  const tab = sub || 'services';
  const st = p.stats;
  const down = !['online', 'degraded'].includes(p.status);
  const tabs = [['services', 'Сервисы'], ['activity', 'Активность'], ['console', 'Консоль API']];
  const content = h('div');
  const page = h('div', { class: 'page', style: { '--pc': p.color } },
    h('div', { class: 'page-head' },
      h('div', { class: 'ph-title' }, h('i', { class: 'swatch lg', style: { background: p.color } }), h('div', null, h('h1', null, p.name), h('a', { class: 'muted small', href: p.url, target: '_blank', rel: 'noopener' }, host(p.url), ' ', icon('external', 11)))),
      h('div', { class: 'inline' }, statusBadge(p.status),
        h('button', { class: 'btn', onclick: () => newProject(p) }, icon('plus', 14), 'Проект'),
        h('button', { class: 'btn primary', onclick: () => newService(p) }, icon('plus', 14), 'Сервис'),
        h('button', { class: 'btn icon', title: 'Система', onclick: () => systemMenu(p) }, icon('settings', 16)),
        h('button', { class: 'btn icon', title: 'Настройки панели', onclick: () => panelForm(p) }, icon('edit', 15)))),
    down ? h('div', { class: 'callout err' }, icon('alert'), h('div', null, h('b', null, p.status === 'auth_error' ? 'Токен отклонён' : 'Панель недоступна'), h('p', null, p.error || ''), p.tree ? h('p', { class: 'muted' }, 'Показаны последние известные данные.') : null)) : null,
    st ? h('div', { class: 'statstrip' },
      meter('CPU', st.cpu, `${st.cpus ?? '?'} ядер · load ${st.load?.[0] ?? '—'}`), meter('RAM', st.memPct, `${Math.round((st.memUsedMb ?? 0) / 102.4) / 10} / ${Math.round((st.memTotalMb ?? 0) / 102.4) / 10} ГБ`),
      meter('Диск', st.diskPct, `${gb(st.diskUsedGb)} / ${gb(st.diskTotalGb)}`), h('div', { class: 'meter' }, h('div', { class: 'meter-top' }, h('span', null, 'Аптайм'), h('b', null, uptime(st.uptime))), h('div', { class: 'meter-extra' }, `Сеть ↓${Math.round(st.netIn ?? 0)} ↑${Math.round(st.netOut ?? 0)} МБ`))) : null,
    h('div', { class: 'tabs page-tabs' }, tabs.map(([t, l]) => h('a', { class: `tab ${tab === t ? 'active' : ''}`, href: `#/panel/${p.id}${t === 'services' ? '' : '/' + t}` }, l))),
    content);
  if (tab === 'services') content.append(servicesTab(p));
  else if (tab === 'activity') content.append(activityTab(p));
  else content.append(consoleTab(p));
  return page;
}

function servicesTab(p) {
  const f = panelFilters.get(p.id) ?? { q: '', type: 'all', status: 'all' };
  panelFilters.set(p.id, f);
  const list = h('div', { class: 'stack' });
  const draw = () => {
    clear(list);
    const projects = p.tree?.projects ?? [];
    if (!projects.length) return list.append(empty('Проектов пока нет', 'Создайте проект, чтобы разместить в нём сервисы.', h('button', { class: 'btn primary', onclick: () => newProject(p) }, 'Создать проект')));
    let shown = 0;
    for (const pr of projects) {
      const rows = pr.services.map((s) => ({ ...s, panelId: p.id, panel: p })).filter((s) => matches(s, { ...f, panel: 'all' }));
      const filtering = f.q || f.type !== 'all' || f.status !== 'all';
      if (filtering && !rows.length) continue;
      shown += rows.length;
      list.append(h('section', { class: 'card project' },
        h('div', { class: 'project-head' }, icon('folder', 16), h('h3', null, pr.name), h('span', { class: 'muted' }, `${pr.services.length}`), h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm ghost', onclick: () => newService(p, pr.name) }, icon('plus', 13), 'Сервис'),
          h('button', { class: 'btn sm ghost danger-text', onclick: () => destroyProject(p, pr) }, icon('trash', 13))),
        rows.length ? h('table', { class: 'tbl' }, h('tbody', null, rows.map((s) => serviceRow(s, { showPanel: false, openService })))) : h('div', { class: 'muted pad' }, 'В проекте нет сервисов.')));
    }
    if (!shown && (f.q || f.type !== 'all' || f.status !== 'all')) list.append(empty('Ничего не найдено', 'Измените фильтры.'));
  };
  const filters = serviceFilters(f, draw);
  draw();
  return h('div', { class: 'stack' }, filters, list);
}

function activityTab(p) {
  const box = h('div', { class: 'card' }, h('div', { class: 'skeleton', style: { height: '80px' } }));
  get(`/api/panels/${p.id}/actions`).then((r) => {
    const items = Array.isArray(r) ? r : (r?.actions ?? []);
    clear(box).append(items.length ? h('div', { class: 'list' }, items.slice(0, 50).map((a) => h('div', { class: 'list-item' }, h('div', null, h('b', null, a.type ?? a.name ?? 'action'), h('div', { class: 'muted small' }, [a.projectName, a.serviceName].filter(Boolean).join('/') || '')), h('span', { class: 'muted small' }, a.createdAt ? relTime(new Date(a.createdAt).getTime()) : '')))) : empty('История пуста', 'Здесь появятся деплои и другие операции панели.'));
  }).catch((e) => clear(box).append(h('div', { class: 'callout err' }, icon('alert'), e.message)));
  return box;
}

function consoleTab(p) {
  const proc = h('input', { class: 'input mono', placeholder: 'projects.listProjects', value: 'projects.listProjectsAndServices' });
  const kind = h('select', { class: 'input' }, h('option', { value: 'query' }, 'query (GET)'), h('option', { value: 'mutation' }, 'mutation (POST)'));
  const input = h('textarea', { class: 'input mono', rows: 5, placeholder: '{"projectName":"my-project"}' });
  const out = h('pre', { class: 'code', style: { minHeight: '120px' } }, '// результат');
  const run = async () => {
    let parsed; if (input.value.trim()) { try { parsed = JSON.parse(input.value); } catch { return toast('Некорректный JSON', 'error'); } }
    if (kind.value === 'mutation' && !await confirmDialog({ title: 'Выполнить mutation?', message: `${proc.value} на панели «${p.name}»`, confirmText: 'Выполнить' })) return;
    out.textContent = '…';
    try { out.textContent = JSON.stringify((await post(`/api/panels/${p.id}/trpc`, { kind: kind.value, procedure: proc.value.trim(), input: parsed })).result, null, 2); }
    catch (e) { out.textContent = `Ошибка: ${e.message}`; }
  };
  return h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Прямой вызов любой tRPC-процедуры панели — на случай функций, которых ещё нет в интерфейсе. Мутации попадают в журнал.'),
    h('div', { class: 'grid-2' }, field('Процедура', proc), field('Тип', kind)), field('Input (JSON)', input), h('div', null, h('button', { class: 'btn primary', onclick: run }, icon('terminal', 14), 'Выполнить')), out);
}

/* ---------- формы: проект / сервис / система ---------- */
export function newProject(p) {
  const name = h('input', { class: 'input', placeholder: 'my-project', autocomplete: 'off' });
  modal({ title: `Новый проект · ${p.name}`, body: field('Имя проекта', name, 'Латиница, цифры, - _ .'), actions: [{ label: 'Отмена', kind: 'ghost' }, {
    label: 'Создать', kind: 'primary', onClick: async () => { await post(`/api/panels/${p.id}/projects`, { name: name.value.trim() }); toast('Проект создан', 'success'); refresh(true, { silent: true }); } }] });
}

async function destroyProject(p, pr) {
  if (!await confirmDialog({ title: 'Удалить проект?', danger: true, confirmText: 'Удалить проект', typeToConfirm: pr.name, message: `Проект «${pr.name}» и все его сервисы (${pr.services.length}) на панели «${p.name}» будут удалены.` })) return;
  try { await del(`/api/panels/${p.id}/projects/${encodeURIComponent(pr.name)}`); toast('Проект удалён', 'success'); refresh(true, { silent: true }); } catch (e) { toast(e.message, 'error'); }
}

export function newService(p, project) {
  const projects = p.tree?.projects ?? [];
  if (!projects.length) return toast('Сначала создайте проект', 'error');
  const proj = h('select', { class: 'input' }, projects.map((x) => h('option', { value: x.name, selected: x.name === project }, x.name)));
  const type = h('select', { class: 'input', onchange: sync }, [['app', 'Приложение (App)'], ['postgres', 'PostgreSQL'], ['mysql', 'MySQL'], ['mariadb', 'MariaDB'], ['mongo', 'MongoDB'], ['redis', 'Redis'], ['compose', 'Docker Compose']].map(([v, l]) => h('option', { value: v }, l)));
  const name = h('input', { class: 'input', placeholder: 'my-service', autocomplete: 'off' });
  const image = h('input', { class: 'input mono', placeholder: 'nginx:latest (необязательно)' });
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'пусто = сгенерировать', autocomplete: 'new-password' });
  const imgF = field('Docker-образ', image), passF = field('Пароль БД', pass);
  function sync() { imgF.hidden = type.value !== 'app'; passF.hidden = ['app', 'compose'].includes(type.value); }
  sync();
  modal({ title: `Новый сервис · ${p.name}`, body: h('div', { class: 'stack' }, field('Проект', proj), field('Тип', type), field('Имя', name), imgF, passF), actions: [{ label: 'Отмена', kind: 'ghost' }, {
    label: 'Создать', kind: 'primary', onClick: async () => { await post(`/api/panels/${p.id}/services`, { type: type.value, project: proj.value, name: name.value.trim(), image: image.value.trim() || undefined, password: pass.value || undefined }); toast('Сервис создан', 'success'); refresh(true, { silent: true }); } }] });
}

function systemMenu(p) {
  const item = (label, desc, op, danger, typed) => h('button', { class: `list-item link btn-row ${danger ? 'danger-text' : ''}`, onclick: async () => {
    if (!await confirmDialog({ title: label, message: desc, danger, confirmText: 'Выполнить', typeToConfirm: typed })) return;
    try { await post(`/api/panels/${p.id}/system`, { op }); toast(`${label}: готово`, 'success'); refresh(true, { silent: true }); } catch (e) { toast(e.message, 'error'); }
  } }, h('div', null, h('b', null, label), h('div', { class: 'muted small' }, desc)), icon('chevron', 16));
  modal({ title: `Система · ${p.name}`, body: h('div', { class: 'list' },
    item('Очистить образы Docker', 'Удалит неиспользуемые образы.', 'cleanupImages'),
    item('Docker system prune', 'Удалит неиспользуемые контейнеры, сети и образы.', 'prune', true),
    item('Перезапустить Easypanel', 'Сама панель будет недоступна пару минут.', 'restartPanel', true),
    item('Перезагрузить сервер', 'Сервер целиком уйдёт в перезагрузку.', 'reboot', true, p.name)), actions: [{ label: 'Закрыть', kind: 'ghost' }] });
}

/* ======================= Все сервисы ======================= */
const allFilter = { q: '', type: 'all', status: 'all', panel: 'all' };
export function servicesPage() {
  const wrap = h('div');
  const draw = () => {
    const rows = allServices().filter((s) => matches(s, allFilter));
    clear(wrap).append(rows.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', { class: 'w-check' }, selectAll(rows)), h('th', null, 'Сервис'), h('th', { class: 'hide-sm' }, 'Панель / проект'), h('th', { class: 'hide-sm' }, 'Тип'), h('th', null, 'Статус'), h('th', null))),
      h('tbody', null, rows.map((s) => serviceRow(s, { showPanel: true, openService }))))) : empty('Ничего не найдено', store.panels.length ? 'Измените фильтры.' : 'Подключите панель, чтобы увидеть сервисы.'));
    count.textContent = `${rows.length} из ${allServices().length}`;
  };
  const count = h('span', { class: 'muted' });
  const filters = serviceFilters(allFilter, draw, { showPanels: true });
  draw();
  return h('div', { class: 'page' }, pageHead('Все сервисы', count), h('div', { class: 'stack' }, filters, wrap));
}

import { toggleSelect } from './components.js';
function selectAll(rows) {
  const all = rows.length && rows.every((s) => store.selection.has([s.panelId, s.type, s.project, s.name].join('\u0000')));
  return h('input', { type: 'checkbox', checked: all, title: 'Выбрать все', onchange: (e) => { rows.forEach((s) => toggleSelect(s, e.target.checked)); e.target.closest('.page')?.querySelectorAll('tbody input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; }); } });
}

/* ======================= Журнал ======================= */
const ACTION_NAMES = { 'service.deploy': 'Деплой', 'service.restart': 'Перезапуск', 'service.start': 'Запуск', 'service.stop': 'Остановка', 'service.destroy': 'Удаление сервиса', 'service.create': 'Создание сервиса', 'service.env': 'Правка env', 'project.create': 'Создание проекта', 'project.destroy': 'Удаление проекта', 'panel.add': 'Панель добавлена', 'panel.update': 'Панель изменена', 'panel.remove': 'Панель удалена', login: 'Вход' };
export function auditPage() {
  const box = h('div', { class: 'card flush' }, h('div', { class: 'skeleton', style: { height: '160px' } }));
  get('/api/audit?limit=200').then((rows) => {
    clear(box).append(rows.length ? h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Время', 'Пользователь', 'Действие', 'Панель', 'Объект', ''].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((r) => h('tr', null, h('td', { class: 'muted nowrap' }, fmtTime(r.ts)), h('td', null, r.username ?? '—'),
        h('td', null, ACTION_NAMES[r.action] ?? (r.action.startsWith('bulk.') ? `Массово: ${ACTION_NAMES['service.' + r.action.slice(5)] ?? r.action.slice(5)}` : r.action)),
        h('td', null, r.panelName ?? '—'), h('td', { class: 'mono small' }, r.target ?? ''),
        h('td', null, r.ok ? h('span', { class: 'badge ok' }, 'ок') : h('span', { class: 'badge err', title: r.detail }, 'ошибка')))))) : empty('Журнал пуст'));
  });
  return h('div', { class: 'page' }, pageHead('Журнал действий'), box);
}

/* ======================= Настройки ======================= */
export function settingsPage() {
  const page = h('div', { class: 'page' }, pageHead('Настройки'));
  page.append(
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Панели'), h('button', { class: 'btn primary sm', onclick: () => panelForm() }, icon('plus', 14), 'Добавить')),
      store.panels.length ? h('div', { class: 'list' }, store.panels.map((p, i) => h('div', { class: 'list-item' },
        h('div', { class: 'inline' }, h('i', { class: 'swatch lg', style: { background: p.color } }), h('div', null, h('b', null, p.name), h('div', { class: 'muted small' }, p.url))),
        h('div', { class: 'inline' }, statusBadge(p.status),
          h('button', { class: 'btn icon ghost sm', disabled: i === 0, title: 'Выше', onclick: () => move(i, -1) }, icon('up', 14)),
          h('button', { class: 'btn icon ghost sm', disabled: i === store.panels.length - 1, title: 'Ниже', onclick: () => move(i, 1) }, icon('down', 14)),
          h('button', { class: 'btn icon ghost sm', title: 'Изменить', onclick: () => panelForm(p) }, icon('edit', 14)))))) : h('p', { class: 'muted' }, 'Панелей пока нет.')),
    usersCard(), passwordCard(), themeCard());
  return page;
}
async function move(i, d) {
  const a = store.panels[i], b = store.panels[i + d];
  await Promise.all([put(`/api/panels/${a.id}`, { position: i + d + 1 }), put(`/api/panels/${b.id}`, { position: i + 1 })]);
  refresh(true);
}

function usersCard() {
  const box = h('div', { class: 'list' });
  const load = () => get('/api/users').then((users) => {
    clear(box).append(...users.map((u) => h('div', { class: 'list-item' }, h('div', null, h('b', null, u.username), h('span', { class: `badge ${u.role === 'admin' ? 'ok' : 'muted'} ml` }, u.role === 'admin' ? 'администратор' : 'только чтение')),
      u.id === store.user.id ? h('span', { class: 'muted small' }, 'это вы') : h('button', { class: 'btn icon ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: 'Удалить пользователя?', message: u.username, danger: true, confirmText: 'Удалить' })) { await del(`/api/users/${u.id}`); load(); } } }, icon('trash', 14)))));
  }).catch(() => clear(box).append(h('p', { class: 'muted' }, 'Доступно только администратору.')));
  load();
  const add = () => {
    const u = h('input', { class: 'input', autocomplete: 'off' }), pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const role = h('select', { class: 'input' }, h('option', { value: 'viewer' }, 'Только чтение'), h('option', { value: 'admin' }, 'Администратор'));
    modal({ title: 'Новый пользователь', body: h('div', { class: 'stack' }, field('Логин', u), field('Пароль', pw, 'Минимум 8 символов'), field('Роль', role)), actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Создать', kind: 'primary', onClick: async () => { await post('/api/users', { username: u.value, password: pw.value, role: role.value }); load(); } }] });
  };
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Пользователи'), store.user.role === 'admin' ? h('button', { class: 'btn sm', onclick: add }, icon('plus', 14), 'Добавить') : null), box);
}

function passwordCard() {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' }), next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  return h('section', { class: 'card stack' }, h('h3', null, 'Смена пароля'), h('div', { class: 'grid-2' }, field('Текущий', cur), field('Новый', next, 'Минимум 8 символов')),
    h('div', null, h('button', { class: 'btn', onclick: async () => { try { await post('/api/me/password', { current: cur.value, next: next.value }); toast('Пароль изменён', 'success'); cur.value = next.value = ''; } catch (e) { toast(e.message, 'error'); } } }, 'Сменить пароль')));
}

function themeCard() {
  const set = (t) => { try { t ? localStorage.setItem('ea-theme', t) : localStorage.removeItem('ea-theme'); } catch {} if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  return h('section', { class: 'card' }, h('h3', null, 'Оформление'), h('div', { class: 'inline' }, [['', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([v, l]) => h('button', { class: 'btn', onclick: () => set(v) }, l))));
}

/* ======================= Форма панели ======================= */
const COLORS = ['#7c83ff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#a855f7', '#64748b'];
export function panelForm(p) {
  const edit = !!p;
  let color = p?.color ?? COLORS[store.panels.length % COLORS.length];
  const name = h('input', { class: 'input', placeholder: 'Прод EU', value: p?.name ?? '' });
  const url = h('input', { class: 'input mono', placeholder: 'https://panel.example.com', value: p?.url ?? '' });
  const token = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: edit ? 'оставьте пустым, чтобы не менять' : 'API-токен' });
  const email = h('input', { class: 'input', placeholder: 'email администратора панели', autocomplete: 'off' });
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'пароль панели', autocomplete: 'new-password' });
  const insecure = h('input', { type: 'checkbox', checked: p?.insecureTls });
  const tags = h('input', { class: 'input', placeholder: 'prod, eu', value: p?.tags?.join(', ') ?? '' });
  const result = h('div', { class: 'test-result' });
  const swatches = h('div', { class: 'swatches' });
  const drawSw = () => clear(swatches).append(...COLORS.map((c) => h('button', { type: 'button', class: `sw ${c === color ? 'on' : ''}`, style: { background: c }, 'aria-label': c, onclick: () => { color = c; drawSw(); } })));
  drawSw();
  const tokenBox = h('div', { class: 'stack' }, field('API-токен', token, 'Easypanel → Settings → Users → Generate API Token'));
  const loginBox = h('div', { class: 'stack', hidden: true }, field('Email', email), field('Пароль', pass, 'Используется один раз для получения токена; пароль не сохраняется. Токен сессии живёт ~30 дней — для постоянного лучше API-токен.'));
  let byLogin = false;
  const mode = h('button', { type: 'button', class: 'linkbtn', onclick: () => { byLogin = !byLogin; tokenBox.hidden = byLogin; loginBox.hidden = !byLogin; mode.textContent = byLogin ? 'Использовать API-токен' : 'Нет токена? Войти по email и паролю'; } }, 'Нет токена? Войти по email и паролю');

  const resolveToken = async () => {
    if (!byLogin) return token.value.trim();
    const r = await post('/api/panels/login-probe', { url: url.value, email: email.value, password: pass.value, insecureTls: insecure.checked });
    return r.token;
  };
  const test = async () => {
    result.className = 'test-result'; result.textContent = 'Проверяю…';
    try {
      const tk = await resolveToken();
      const r = await post('/api/panels/test', { url: url.value, token: tk || undefined, id: edit && !tk ? p.id : undefined, insecureTls: insecure.checked });
      result.className = `test-result ${r.ok ? 'ok' : 'err'}`;
      result.textContent = r.ok ? `✓ Соединение установлено (${r.latencyMs} мс)` : `✗ ${r.error}`;
      return r.ok ? tk : null;
    } catch (e) { result.className = 'test-result err'; result.textContent = `✗ ${e.message}`; return null; }
  };
  const body = h('div', { class: 'stack' }, field('Название', name), field('Адрес панели', url, 'Например https://panel.example.com или http://1.2.3.4:3000'),
    tokenBox, loginBox, mode,
    h('div', { class: 'grid-2' }, field('Теги', tags, 'Через запятую'), field('Цвет', swatches)),
    h('label', { class: 'check' }, insecure, 'Не проверять TLS-сертификат (самоподписанный)'), result);
  const actions = [
    ...(edit ? [{ label: 'Удалить', kind: 'danger', close: false, onClick: async (close) => { if (await confirmDialog({ title: 'Удалить панель?', message: `«${p.name}» будет отключена от EasyAdmin. Сама панель и сервисы не затрагиваются.`, danger: true, confirmText: 'Удалить' })) { await del(`/api/panels/${p.id}`); toast('Панель удалена', 'success'); close(); go('#/'); refresh(true); } return false; } }] : []),
    { label: 'Проверить', close: false, onClick: async () => { await test(); return false; } },
    { label: edit ? 'Сохранить' : 'Подключить', kind: 'primary', onClick: async () => {
      const tk = await resolveToken();
      const payload = { name: name.value, url: url.value, token: tk || undefined, insecureTls: insecure.checked, color, tags: tags.value };
      if (edit) await put(`/api/panels/${p.id}`, payload); else await post('/api/panels', payload);
      toast(edit ? 'Сохранено' : 'Панель подключена', 'success'); refresh(true);
    } }];
  modal({ title: edit ? `Панель · ${p.name}` : 'Подключить панель Easypanel', body, actions });
}
