import { del, get, post, put } from './api.js';
import { empty, matches, meter, panelChip, serviceFilters, serviceRow, statusBadge, svcBadge, typeChip } from './components.js';
import { openService } from './drawer.js';
import { clear, confirmDialog, field, fmtTime, gb, h, host, icon, modal, pct, relTime, toast, uptime } from './dom.js';
import { allServices, can, panelById, refresh, store } from './store.js';
import { AVAILABLE_LANGS, lang, setLang, t } from './i18n.js';
import { sourcePicker } from './source-form.js';
import { installFlow } from './panel-install.js';
import { settingsTab } from './panel-settings.js';
import { sortRows, sortTh } from './sort.js';
import { loadSettingsCard, loadTab } from './load-tab.js';
import { doctorTab } from './server-doctor.js';
import { timeCard } from './time-card.js';
import { aiDoctorCard } from './ai-doctor.js';
import { actionLabel, detailLabel } from './action-names.js';
import { channelsCard, cleanAllModal } from './views2.js';

const go = (hash) => { location.hash = hash; };

/* ======================= Обзор ======================= */
let tagFilter = null;
export function dashboard() {
  const allTags = [...new Set(store.panels.flatMap((p) => p.tags ?? []))].sort();
  if (tagFilter && !allTags.includes(tagFilter)) tagFilter = null;
  const panels = tagFilter ? store.panels.filter((p) => p.tags?.includes(tagFilter)) : store.panels;
  if (!panels.length && store.loadedAt) {
    return h('div', { class: 'page' }, pageHead('Обзор'), welcome());
  }
  const svcs = allServices().filter((s) => panels.includes(s.panel));
  const online = panels.filter((p) => p.status === 'online' || p.status === 'degraded').length;
  const running = svcs.filter((s) => s.enabled).length;
  const cpus = panels.map((p) => p.stats?.cpu).filter((x) => x != null);
  const avg = cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null;
  const attention = [
    ...panels.filter((p) => !['online', 'degraded'].includes(p.status) && p.status !== 'unknown').map((p) => ({ kind: 'panel', p })),
    ...svcs.filter((s) => !s.enabled || s.health === 'failing').map((s) => ({ kind: 'svc', s })),
  ];
  return h('div', { class: 'page' },
    pageHead('Обзор', can('admin') ? h('button', { class: 'btn', onclick: cleanAllModal, title: 'Очистка Docker на нескольких панелях' }, icon('trash', 14), 'Очистка Docker') : null, can('admin') ? h('button', { class: 'btn primary', onclick: () => panelForm() }, icon('plus', 15), 'Добавить панель') : null),
    allTags.length ? h('div', { class: 'chips' }, h('button', { class: `chip-btn ${tagFilter ? '' : 'on'}`, onclick: () => { tagFilter = null; window.dispatchEvent(new Event('ea:rerender')); } }, 'Все'),
      allTags.map((t) => h('button', { class: `chip-btn ${tagFilter === t ? 'on' : ''}`, onclick: () => { tagFilter = t; window.dispatchEvent(new Event('ea:rerender')); } }, t))) : null,
    h('div', { class: 'kpis' },
      kpi('Панели', `${online}/${panels.length}`, online === panels.length ? 'Все на связи' : `${panels.length - online} недоступно`, online === panels.length ? 'ok' : 'err', 'server'),
      kpi('Проекты', panels.reduce((n, p) => n + (p.tree?.projects.length ?? 0), 0), 'на всех панелях', '', 'folder'),
      kpi('Сервисы', `${running}/${svcs.length}`, `${svcs.length - running} остановлено`, svcs.length - running ? 'warn' : 'ok', 'layers'),
      kpi('Средний CPU', pct(avg), 'по онлайн-панелям', avg > 85 ? 'err' : avg > 65 ? 'warn' : '', 'activity')),
    h('div', { class: 'panel-grid' }, panels.map(panelCard)),
    attention.length ? h('section', { class: 'card' }, h('h3', null, 'Требуют внимания'),
      h('div', { class: 'list' }, attention.slice(0, 12).map((a) => a.kind === 'panel'
        ? h('a', { class: 'list-item link', href: `#/panel/${a.p.id}` }, h('div', null, panelChip(a.p), h('div', { class: 'muted small' }, a.p.error || 'Нет связи')), statusBadge(a.p.status))
        : h('div', { class: 'list-item link', onclick: () => openService(a.s) }, h('div', null, h('b', null, `${a.s.project}/${a.s.name}`), h('div', { class: 'muted small' }, a.s.panel.name)), svcBadge(a.s.enabled, a.s.health))))) : null);
}

function welcome() {
  return h('div', { class: 'card hero' }, h('div', { class: 'hero-ic' }, icon('server', 28)), h('h2', null, 'Добавьте первую панель Easypanel'),
    h('p', { class: 'muted' }, 'Понадобится адрес панели и API-токен (Easypanel → Settings → Users → Generate API Token). Токен хранится в зашифрованном виде.'),
    can('admin') ? h('button', { class: 'btn primary lg', onclick: () => panelForm() }, icon('plus', 16), 'Подключить панель') : h('p', { class: 'muted' }, 'Администратор ещё не подключил панели или у вас нет доступа к ним.'));
}

const kpi = (label, value, sub, tone, ic) => h('div', { class: `kpi ${tone}` }, h('div', { class: 'kpi-ic' }, icon(ic, 18)), h('div', null, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-sub' }, sub)));

function panelCard(p) {
  const svcs = (p.tree?.projects ?? []).flatMap((x) => x.services);
  const stopped = svcs.filter((s) => !s.enabled).length;
  const down = !['online', 'degraded'].includes(p.status);
  return h('a', { class: `panel-card ${down ? 'down' : ''}`, href: `#/panel/${p.id}`, style: { '--pc': p.color } },
    h('div', { class: 'pc-head' }, h('div', null, h('h3', null, p.name), h('div', { class: 'muted small' }, host(p.url))), statusBadge(p.status)),
    down ? h('div', { class: 'callout err compact' }, icon('alert', 14), p.error || 'Нет данных') : h('div', { class: 'meters' }, meter('CPU', p.stats?.cpu), meter('RAM', p.stats?.memPct), meter('Диск', p.stats?.diskPct)),
    p.status === 'degraded' && p.error ? h('div', { class: 'callout warn compact' }, icon('alert', 14), p.error) : null,
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
  const tabs = [['services', 'Сервисы'], ['load', 'Нагрузка'], ...(can('admin') ? [['doctor', 'Server Doctor']] : []), ['activity', 'Активность'], ...(can('admin') ? [['settings', 'Настройки']] : [])];
  const content = h('div');
  const page = h('div', { class: 'page', style: { '--pc': p.color } },
    h('div', { class: 'page-head' },
      h('div', { class: 'ph-title' }, h('i', { class: 'swatch lg', style: { background: p.color } }), h('div', null, h('h1', null, p.name), h('a', { class: 'muted small', href: p.url, target: '_blank', rel: 'noopener' }, host(p.url), ' ', icon('external', 11)))),
      h('div', { class: 'inline' }, statusBadge(p.status),
        can('admin') ? h('button', { class: 'btn', onclick: () => newProject(p) }, icon('plus', 14), 'Проект') : null,
        can('admin') ? h('button', { class: 'btn primary', onclick: () => newService(p) }, icon('plus', 14), 'Сервис') : null,
        can('admin') ? h('button', { class: 'btn icon', title: 'Диагностика: что отвечает панель', onclick: () => diagnose(p) }, icon('activity', 16)) : null,
        can('admin') ? h('button', { class: 'btn icon', title: 'Система', onclick: () => systemMenu(p) }, icon('settings', 16)) : null,
        can('admin') ? h('button', { class: 'btn icon', title: 'Настройки панели', onclick: () => panelForm(p) }, icon('edit', 15)) : null)),
    down ? h('div', { class: 'callout err' }, icon('alert'), h('div', null, h('b', null, p.status === 'auth_error' ? 'Токен отклонён' : 'Панель недоступна'), h('p', null, p.error || ''), p.tree ? h('p', { class: 'muted' }, 'Показаны последние известные данные.') : null)) : null,
    p.status === 'degraded' ? h('div', { class: 'callout warn' }, icon('alert'), h('div', null, h('b', null, 'Часть данных недоступна'), h('p', null, p.error || 'Панель ответила не на все запросы.'),
      can('admin') ? h('button', { class: 'btn sm', onclick: () => diagnose(p) }, icon('activity', 13), 'Диагностика') : null)) : null,
    !st && p.statsError && !down ? h('div', { class: 'muted small stats-note' }, icon('activity', 13), 'Статистика нагрузки недоступна') : null,
    st ? h('div', { class: 'statstrip' },
      meter('CPU', st.cpu, `${st.cpus ?? '?'} ядер · load ${st.load?.[0] ?? '—'}`), meter('RAM', st.memPct, `${Math.round((st.memUsedMb ?? 0) / 102.4) / 10} / ${Math.round((st.memTotalMb ?? 0) / 102.4) / 10} ГБ`),
      meter('Диск', st.diskPct, `${gb(st.diskUsedGb)} / ${gb(st.diskTotalGb)}`), h('div', { class: 'meter' }, h('div', { class: 'meter-top' }, h('span', null, 'Аптайм'), h('b', null, uptime(st.uptime))), h('div', { class: 'meter-extra' }, `Сеть ↓${Math.round(st.netIn ?? 0)} ↑${Math.round(st.netOut ?? 0)} МБ`))) : null,
    h('div', { class: 'tabs page-tabs' }, tabs.map(([t, l]) => h('a', { class: `tab ${tab === t ? 'active' : ''}`, href: `#/panel/${p.id}${t === 'services' ? '' : '/' + t}` }, l))),
    content);
  if (tab === 'services') content.append(servicesTab(p));
  else if (tab === 'load') content.append(loadTab(p));
  else if (tab === 'doctor' && can('admin')) content.append(doctorTab(p));
  else if (tab === 'activity') content.append(activityTab(p));
  else content.append(settingsTab(p));
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
          can('admin') ? h('button', { class: 'btn sm ghost', onclick: () => newService(p, pr.name) }, icon('plus', 13), 'Сервис') : null,
          can('admin') ? h('button', { class: 'btn sm ghost danger-text', onclick: () => destroyProject(p, pr) }, icon('trash', 13)) : null),
        rows.length ? h('table', { class: 'tbl svc-tbl' }, h('tbody', null, rows.map((s) => serviceRow(s, { showPanel: false, openService })))) : h('div', { class: 'muted pad' }, 'В проекте нет сервисов.')));
    }
    if (!shown && (f.q || f.type !== 'all' || f.status !== 'all')) list.append(empty('Ничего не найдено', 'Измените фильтры.'));
  };
  const filters = serviceFilters(f, draw);
  draw();
  return h('div', { class: 'stack' }, filters, list);
}

function activityTab(p) {
  const box = h('div', { class: 'card' }, h('div', { class: 'skeleton', style: { height: '80px' } }));
  const detail = async (a) => {
    const id = a.id ?? a._id;
    let text;
    try { text = JSON.stringify(id ? await get(`/api/panels/${p.id}/actions/${encodeURIComponent(id)}`) : a, null, 2); } catch (e) { text = `Не удалось получить детали: ${e.message}\n\n${JSON.stringify(a, null, 2)}`; }
    modal({ title: `${a.type ?? a.name ?? 'Действие'} · ${p.name}`, wide: true, body: h('pre', { class: 'code' }, text), actions: [{ label: 'Закрыть', kind: 'primary' }] });
  };
  get(`/api/panels/${p.id}/actions`).then((r) => {
    const items = Array.isArray(r) ? r : (r?.actions ?? []);
    clear(box).append(items.length ? h('div', { class: 'list' }, items.slice(0, 50).map((a) => {
      const st = String(a.status ?? a.state ?? '');
      const kind = /fail|error/i.test(st) ? 'err' : /success|done|complete|ok/i.test(st) ? 'ok' : /run|pending|progress/i.test(st) ? 'warn' : 'muted';
      return h('div', { class: 'list-item link', onclick: () => detail(a) }, h('div', null, h('b', null, a.type ?? a.name ?? 'action'), h('div', { class: 'muted small' }, [a.projectName, a.serviceName].filter(Boolean).join('/') || '')),
        h('div', { class: 'inline' }, st ? h('span', { class: `badge ${kind}` }, st) : null, h('span', { class: 'muted small' }, a.createdAt ? relTime(new Date(a.createdAt).getTime()) : '')));
    })) : empty('История пуста', 'Здесь появятся деплои и другие операции панели. Нажмите на запись, чтобы увидеть лог.'));
  }).catch((e) => clear(box).append(h('div', { class: 'callout err' }, icon('alert'), e.message)));
  return box;
}

/** Показывает, что именно ответила панель на ключевые запросы (без секретов) — для настройки совместимости. */
export async function diagnose(p) {
  const body = h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { height: '120px' } }));
  const m = modal({ title: `Диагностика · ${p.name}`, wide: true, body, actions: [{ label: 'Копировать отчёт', close: false, onClick: () => { navigator.clipboard?.writeText(body.dataset.report ?? ''); toast('Отчёт скопирован', 'success'); return false; } }, { label: 'Закрыть', kind: 'primary' }] });
  try {
    const r = await get(`/api/panels/${p.id}/diagnose`);
    body.dataset.report = JSON.stringify(r, null, 2);
    clear(body).append(h('p', { class: 'muted small' }, 'Значения секретов скрыты. Отчёт можно отправить разработчику целиком.'),
      r.discovered?.length ? h('details', { class: 'diag' }, h('summary', null, h('b', null, 'Процедуры, найденные в интерфейсе панели'), h('span', { class: 'muted small' }, `  ${r.discovered.length}`)), h('pre', { class: 'code' }, r.discovered.join('\n'))) : null,
      ...r.results.map((x) => h('details', { class: 'diag', open: x.proc === 'projects.listProjectsAndServices' || (!x.ok && !x.replaced) },
        h('summary', null, h('span', { class: `badge ${x.ok ? 'ok' : x.replaced ? 'warn' : 'err'}` }, x.ok ? 'ок' : x.replaced ? 'заменена' : 'ошибка'), h('b', null, ` ${x.proc}`), h('span', { class: 'muted small' }, `  ${x.ms} мс`)),
        x.ok ? h('div', { class: 'stack-sm' }, h('div', { class: 'mono small' }, x.shape), x.recognized ? h('div', { class: 'small' }, `Распознано проектов: ${x.recognized.length}${x.recognized.length ? ' — ' + x.recognized.join(', ') : ''}`) : null, h('pre', { class: 'code' }, x.sample))
          : h('div', { class: 'stack-sm' }, x.replaced ? h('div', { class: 'callout compact' }, icon('activity', 14), 'В этой версии Easypanel процедура переехала в monitorOld — EasyAdmin использует новую, ошибки нет.') : h('div', { class: 'callout err compact' }, icon('alert', 14), x.error), x.body ? h('pre', { class: 'code' }, x.body) : null))));
  } catch (e) { clear(body).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
  return m;
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

/**
 * Создание сервиса. С панелью (p) — со страницы панели; без неё — со страницы «Сервисы» (панель выбирается в окне).
 * Проект можно выбрать из существующих или ввести новый — он будет создан автоматически.
 */
export function newService(p, project, { preferPanel } = {}) {
  const reachable = store.panels.filter((x) => ['online', 'degraded'].includes(x.status));
  if (!p && !reachable.length) return toast('Нет доступных панелей — сначала подключите панель', 'error');
  const initial = p ?? reachable.find((x) => String(x.id) === String(preferPanel)) ?? reachable[0];
  const panelSel = p ? null : h('select', { class: 'input', onchange: syncProjects }, reachable.map((x) => h('option', { value: x.id, selected: x.id === initial.id }, x.name)));
  const curPanel = () => (p ?? panelById(panelSel.value));
  const proj = h('input', { class: 'input', placeholder: 'my-project', list: 'ns-projects', autocomplete: 'off', value: project ?? initial.tree?.projects[0]?.name ?? '' });
  const dl = h('datalist', { id: 'ns-projects' });
  const projHint = h('span', { class: 'hint' });
  function syncProjects() {
    const names = (curPanel().tree?.projects ?? []).map((x) => x.name);
    clear(dl).append(...names.map((n) => h('option', { value: n })));
    if (!project && !names.includes(proj.value)) proj.value = names[0] ?? '';
    hint();
  }
  function hint() { const v = proj.value.trim(); projHint.textContent = v && !(curPanel().tree?.projects ?? []).some((x) => x.name === v) ? 'Новый проект будет создан автоматически' : ''; }
  proj.addEventListener('input', hint);
  const type = h('select', { class: 'input', onchange: sync }, [['app', 'Приложение (App)'], ['postgres', 'PostgreSQL'], ['mysql', 'MySQL'], ['mariadb', 'MariaDB'], ['mongo', 'MongoDB'], ['redis', 'Redis'], ['compose', 'Docker Compose']].map(([v, l]) => h('option', { value: v }, l)));
  const name = h('input', { class: 'input', placeholder: 'my-service', autocomplete: 'off' });
  const picker = sourcePicker(() => curPanel().id);
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'пусто = сгенерировать', autocomplete: 'new-password' });
  const imgF = h('div', { class: 'stack' }, h('span', { class: 'field-label' }, t('Источник')), picker.el), passF = field('Пароль БД', pass);
  function sync() { imgF.hidden = type.value !== 'app'; passF.hidden = ['app', 'compose'].includes(type.value); }
  sync(); syncProjects();
  modal({ title: p ? `Новый сервис · ${p.name}` : 'Новый сервис', wide: true, body: h('div', { class: 'stack' },
    h('div', { class: panelSel ? 'grid-2' : '' }, panelSel ? field('Панель', panelSel) : null, h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Проект')), proj, dl, projHint)),
    h('div', { class: 'grid-2' }, field('Тип', type), field('Имя', name)), imgF, passF), actions: [{ label: 'Отмена', kind: 'ghost' }, {
    label: 'Создать', kind: 'primary', onClick: async () => {
      const panel = curPanel(), pname = proj.value.trim(), sname = name.value.trim();
      if (!pname) throw new Error('Укажите проект');
      if (!sname) throw new Error('Укажите имя сервиса');
      const isApp = type.value === 'app';
      if (isApp) { const bad = picker.check(); if (bad) throw new Error(bad); }
      if (!(panel.tree?.projects ?? []).some((x) => x.name === pname)) await post(`/api/panels/${panel.id}/projects`, { name: pname });
      const r = await post(`/api/panels/${panel.id}/services`, { type: type.value, project: pname, name: sname, source: isApp ? picker.get() : undefined, password: pass.value || undefined });
      if (r.warnings?.length) toast(`Сервис создан, но: ${r.warnings.join('; ')}`, 'error', 9000); else toast('Сервис создан', 'success');
      refresh(true, { silent: true });
    } }] });
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

/* ======================= Сервисы ======================= */
const allFilter = { q: '', type: 'all', status: 'all', panel: 'all' };
const svcSort = { key: 'name', dir: 1 };
const HEALTH = { failing: 1, missing: 2 };
const SVC_SORT = { name: (s) => s.name, project: (s) => s.project, panel: (s) => s.panel.name, domain: (s) => s.domain || null, type: (s) => s.type, status: (s) => (s.enabled ? 1 + (HEALTH[s.health] ?? 0) : 0) };
export function servicesPage() {
  const wrap = h('div');
  const draw = () => {
    const rows = sortRows(allServices().filter((s) => matches(s, allFilter)), svcSort, SVC_SORT);
    clear(wrap).append(rows.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl svc-tbl' },
      h('thead', null, h('tr', null, h('th', { class: 'w-check' }, selectAll(rows)), sortTh('Сервис', 'name', svcSort, draw, 'c-name'), sortTh('Проект', 'project', svcSort, draw, 'hide-sm c-project'), sortTh('Панель', 'panel', svcSort, draw, 'hide-sm c-panel'), sortTh('Домен', 'domain', svcSort, draw, 'hide-sm c-domain'), sortTh('Тип', 'type', svcSort, draw, 'hide-sm c-type'), sortTh('Статус', 'status', svcSort, draw, 'c-status'), h('th', { class: 'w-actions' }))),
      h('tbody', null, rows.map((s) => serviceRow(s, { showPanel: true, openService }))))) : empty('Ничего не найдено', store.panels.length ? 'Измените фильтры.' : 'Подключите панель, чтобы увидеть сервисы.'));
    count.textContent = `${rows.length} из ${allServices().length}`;
  };
  const count = h('span', { class: 'muted' });
  const filters = serviceFilters(allFilter, draw, { showPanels: true });
  draw();
  return h('div', { class: 'page' }, pageHead('Сервисы', count, can('admin') ? h('button', { class: 'btn primary', onclick: () => newService(null, undefined, { preferPanel: allFilter.panel }) }, icon('plus', 15), 'Новый сервис') : null), h('div', { class: 'stack' }, filters, wrap));
}

import { toggleSelect } from './components.js';
function selectAll(rows) {
  const all = rows.length && rows.every((s) => store.selection.has([s.panelId, s.type, s.project, s.name].join('\u0000')));
  return h('input', { type: 'checkbox', checked: all, title: 'Выбрать все', onchange: (e) => { rows.forEach((s) => toggleSelect(s, e.target.checked)); e.target.closest('.page')?.querySelectorAll('tbody input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; }); } });
}

/* ======================= Журнал ======================= */
export { actionLabel };
/* ---- журнал действий: фильтры ---- */
const AUDIT_CATS = [['', 'Все действия'], ['service.,bulk.,project.', 'Сервисы и проекты'], ['panel.', 'Панели'], ['psettings.,panel.user,panel.notify,panel.2fa,panel.account,storage.,backup.,builder.,traefik.,branding.,license.,docker.,cluster.,system.,panel.install', 'Настройки Easypanel'], ['cert.', 'Сертификаты'], ['schedule.', 'Расписания'],
  ['user.,profile.,session.', 'Пользователи и профиль'], ['login,login.sso', 'Входы'], ['template.,hook.,channel.,backup.,raw.', 'Шаблоны, вебхуки, каналы, бэкап']];
const AUDIT_PERIODS = [[0, 'Всё время'], [1, 'Час'], [24, 'Сутки'], [168, '7 дней'], [720, '30 дней']];
const AUDIT_LIMIT = 500;
const auditState = { q: '', panel: '', user: '', ok: '', period: 0, cat: '' };

export function auditPage() {
  const st = auditState;
  const box = h('div', { class: 'card flush' }, h('div', { class: 'skeleton', style: { height: '160px' } }));
  const count = h('span', { class: 'muted small' });
  const q = h('input', { class: 'input search', placeholder: 'Поиск: пользователь, панель, действие, сервис…', value: st.q });
  const sel = (key, label, options) => h('select', { class: 'input', 'aria-label': label, onchange: (e) => { st[key] = e.target.value; refreshBar(); load(); } },
    options.map(([v, l]) => h('option', { value: v, selected: String(st[key]) === String(v) }, l)));
  const panelSel = sel('panel', 'Панель', [['', 'Все панели'], ...store.panels.map((p) => [p.id, p.name])]);
  const userSel = h('select', { class: 'input', 'aria-label': 'Пользователь', onchange: (e) => { st.user = e.target.value; refreshBar(); load(); } }, h('option', { value: '' }, 'Все пользователи'));
  const catSel = sel('cat', 'Категория', AUDIT_CATS);
  const seg = (key, options) => h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { type: 'button', class: `seg-btn ${String(st[key]) === String(v) ? 'active' : ''}`, onclick: () => { st[key] = v; refreshBar(); load(); } }, l)));
  const bar = h('div', { class: 'audit-bar' });
  const active = () => !!(st.q || st.panel || st.user || st.ok || st.period || st.cat);
  const reset = () => { Object.assign(st, { q: '', panel: '', user: '', ok: '', period: 0, cat: '' }); q.value = ''; refreshBar(); load(); };
  function refreshBar() {
    for (const [el, key] of [[panelSel, 'panel'], [userSel, 'user'], [catSel, 'cat']]) el.value = st[key];
    clear(bar).append(seg('period', AUDIT_PERIODS), seg('ok', [['', 'Все'], ['1', 'Успешные'], ['0', 'Ошибки']]), catSel, store.panels.length > 1 ? panelSel : null, userSel,
      active() ? h('button', { type: 'button', class: 'btn ghost sm', onclick: reset }, icon('x', 13), 'Сбросить') : null);
  }
  const params = (extra = '') => {
    const u = new URLSearchParams();
    if (st.q) u.set('q', st.q); if (st.panel) u.set('panel', st.panel); if (st.user) u.set('user', st.user); if (st.ok) u.set('ok', st.ok); if (st.cat) u.set('action', st.cat);
    if (st.period) u.set('since', String(Date.now() - st.period * 3_600_000));
    return `${u.toString()}${extra}`;
  };
  const csv = h('a', { class: 'btn', href: '#', download: '' }, icon('download', 14), 'CSV');
  const hostOf = (u) => { try { return new URL(u).host; } catch { return u ?? ''; } };
  const panelCell = (r) => {
    if (!r.panelId) return h('span', { class: 'muted' }, '—');
    const inner = [h('span', { class: 'panel-chip' }, h('i', { class: 'swatch', style: { background: r.panelColor ?? 'var(--muted)' } }), r.panelName ?? `#${r.panelId}`),
      h('div', { class: 'muted small' }, r.panelDeleted ? 'панель удалена' : hostOf(r.panelUrl))];
    return r.panelDeleted ? h('div', null, ...inner) : h('a', { class: 'audit-panel-link', href: `#/panel/${r.panelId}`, title: r.panelUrl }, ...inner);
  };
  let seq = 0;
  const load = () => {
    const my = ++seq;
    csv.href = `/api/audit?format=csv&limit=5000&${params()}`;
    return get(`/api/audit?limit=${AUDIT_LIMIT}&${params()}`).then((rows) => {
      if (my !== seq) return; // устаревший ответ
      count.textContent = rows.length ? `${rows.length >= AUDIT_LIMIT ? `Последние ${AUDIT_LIMIT}` : `Записей: ${rows.length}`}${rows.length >= AUDIT_LIMIT ? ' — уточните фильтры' : ''}` : '';
      const objectOf = (r) => (r.target && r.target !== r.panelName ? r.target : '');
      clear(box).append(rows.length ? h('table', { class: 'tbl audit-tbl' }, h('thead', null, h('tr', null, ['Время', 'Пользователь', 'Действие', 'Панель', 'Сервис / объект', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((r) => h('tr', null, h('td', { class: 'muted nowrap a-time' }, fmtTime(r.ts)), h('td', { class: 'a-user' }, r.username ?? '—'),
          h('td', { class: 'a-act' }, h('b', { class: 'a-name' }, actionLabel(r.action)), r.detail ? h('div', { class: `small audit-detail ${r.ok ? 'muted' : 'danger-text open'}`, title: r.ok ? 'Нажмите, чтобы показать целиком' : null, onclick: r.ok ? (e) => e.currentTarget.classList.toggle('open') : null }, detailLabel(r.action, r.detail)) : null),
          h('td', { class: 'a-panel' }, panelCell(r)), h('td', { class: 'mono small a-obj' }, objectOf(r) ? h('span', null, h('span', { class: 'muted a-objlbl' }, `${t('Объект')}: `), objectOf(r)) : ''),
          h('td', { class: 'a-st' }, r.ok ? h('span', { class: 'badge ok' }, 'ок') : h('span', { class: 'badge err', title: r.detail }, 'ошибка')))))) : empty('Ничего не найдено', 'Измените фильтры.'));
    }).catch((e) => { if (my === seq) clear(box).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); });
  };
  let timer;
  q.addEventListener('input', () => { st.q = q.value; clearTimeout(timer); timer = setTimeout(() => { refreshBar(); load(); }, 250); });
  get('/api/audit/facets').then((f) => { userSel.append(...f.users.map((u) => h('option', { value: u, selected: st.user === u }, u))); userSel.value = st.user; }).catch(() => {});
  refreshBar(); load();
  return h('div', { class: 'page' }, pageHead('Журнал действий', csv), h('div', { class: 'input-icon' }, icon('search', 15), q), bar, box, h('div', { class: 'audit-foot' }, count));
}

/* ======================= Настройки ======================= */
export function settingsPage() {
  const page = h('div', { class: 'page' }, pageHead('Настройки'));
  page.append(
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Панели'), can('admin') ? h('button', { class: 'btn primary sm', onclick: () => panelForm() }, icon('plus', 14), 'Добавить') : null),
      store.panels.length ? h('div', { class: 'list panels-list' }, store.panels.map((p, i) => h('div', { class: 'list-item' },
        h('div', { class: 'inline' }, h('i', { class: 'swatch lg', style: { background: p.color } }), h('div', null, h('b', null, p.name), h('div', { class: 'mono-sub' }, p.url))),
        h('div', { class: 'inline' }, statusBadge(p.status),
          h('button', { class: 'btn icon ghost sm', disabled: i === 0, title: 'Выше', onclick: () => move(i, -1) }, icon('up', 14)),
          h('button', { class: 'btn icon ghost sm', disabled: i === store.panels.length - 1, title: 'Ниже', onclick: () => move(i, 1) }, icon('down', 14)),
          h('button', { class: 'btn icon ghost sm', title: 'Изменить', onclick: () => panelForm(p) }, icon('edit', 14)))))) : h('p', { class: 'muted' }, 'Панелей пока нет.')),
    ...(can('admin') ? [timeCard(), loadSettingsCard(), aiDoctorCard(), channelsCard()] : []));
  return page;
}
async function move(i, d) {
  const a = store.panels[i], b = store.panels[i + d];
  await Promise.all([put(`/api/panels/${a.id}`, { position: i + d + 1 }), put(`/api/panels/${b.id}`, { position: i + 1 })]);
  refresh(true);
}


export function languageCard() {
  const btn = (x) => h('button', { class: `btn ${lang === x.code ? 'on' : ''}`, onclick: () => setLang(x.code) }, `${x.flag} ${x.label}`);
  return h('section', { class: 'card stack' }, h('h3', null, 'Язык интерфейса'), h('div', { class: 'inline' }, AVAILABLE_LANGS.map(btn)));
}

export function languagePickerModal() {
  const grid = h('div', { class: 'theme-grid' },
    ...AVAILABLE_LANGS.map((item) => h('button', {
      type: 'button',
      class: `theme-choice ${lang === item.code ? 'active' : ''}`,
      onclick: () => setLang(item.code)
    },
      h('span', { style: 'font-size: 20px; line-height: 1;' }, item.flag),
      h('div', { class: 'theme-info' },
        h('div', { class: 'theme-title' }, item.label),
        h('div', { class: 'theme-hint' }, item.code.toUpperCase())
      ),
      lang === item.code ? icon('check', 16) : null
    ))
  );
  return modal({
    title: t('Язык интерфейса'),
    body: h('div', { class: 'stack' }, grid),
    actions: [{ label: t('Закрыть'), kind: 'primary' }]
  });
}

export { themeCard, themePickerModal } from './theme-picker.js';

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
  let mh = null; let flow = null;
  const connectBox = h('div', { class: 'stack' }, field('Название', name), field('Адрес панели', url, 'Например https://panel.example.com или http://1.2.3.4:3000'),
    tokenBox, loginBox, mode,
    h('div', { class: 'grid-2' }, field('Теги', tags, 'Через запятую'), field('Цвет', swatches)),
    h('label', { class: 'check' }, insecure, 'Не проверять TLS-сертификат (самоподписанный)'), result);
  // новую панель можно либо подключить (есть адрес и токен), либо сначала установить на чистый сервер по SSH — форма меняется переключателем
  const installBox = h('div', { class: 'stack', hidden: true });
  const canInstall = !edit && can('admin');
  const seg = h('div', { class: 'seg seg-wide', role: 'tablist' });
  let pane = 'connect';
  const setPane = (v) => {
    pane = v;
    connectBox.hidden = v !== 'connect'; installBox.hidden = v !== 'install';
    const foot = mh?.el.querySelector('.modal-foot'); if (foot) foot.hidden = v === 'install'; // у установки свои кнопки в шагах мастера
    if (v === 'install' && !flow) flow = installFlow(installBox, { close: () => mh.close() });
    drawSeg();
  };
  const drawSeg = () => clear(seg).append(...[['connect', 'Подключить Easypanel'], ['install', 'Установить и подключить Easypanel']].map(([v, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': pane === v ? 'true' : 'false', class: `seg-btn ${pane === v ? 'active' : ''}`, onclick: () => setPane(v) }, l)));
  drawSeg();
  const body = h('div', { class: 'stack' }, canInstall ? seg : null, connectBox, installBox);
  const actions = [
    ...(edit ? [{ label: 'Удалить', kind: 'danger', close: false, onClick: async (close) => { if (await confirmDialog({ title: 'Удалить панель?', message: `«${p.name}» будет отключена от EasyAdmin. Сама панель и сервисы не затрагиваются.`, danger: true, confirmText: 'Удалить' })) { await del(`/api/panels/${p.id}`); toast('Панель удалена', 'success'); close(); go('#/'); refresh(true); } return false; } }] : []),
    { label: 'Проверить', close: false, onClick: async () => { await test(); return false; } },
    { label: edit ? 'Сохранить' : 'Подключить', kind: 'primary', onClick: async () => {
      const tk = await resolveToken();
      const payload = { name: name.value, url: url.value, token: tk || undefined, insecureTls: insecure.checked, color, tags: tags.value };
      if (edit) await put(`/api/panels/${p.id}`, payload); else await post('/api/panels', payload);
      toast(edit ? 'Сохранено' : 'Панель подключена', 'success'); refresh(true);
    } }];
  mh = modal({ title: edit ? `Панель · ${p.name}` : 'Добавить панель Easypanel', body, actions, wide: canInstall, onClose: () => flow?.dispose() });
}
