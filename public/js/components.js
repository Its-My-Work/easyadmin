import { get, post } from './api.js';
import { clear, confirmDialog, h, host, icon, modal, toast } from './dom.js';
import { STATUS, TYPE_LABEL, allServices, can, favorites, isDb, notify, refresh, store, svcKey } from './store.js';

export const statusBadge = (status) => {
  const [label, kind] = STATUS[status] || STATUS.unknown;
  const hint = status === 'degraded' ? 'Панель отвечает, но часть данных получить не удалось — причина указана на карточке и странице панели' : null;
  return h('span', { class: `badge ${kind}`, title: hint }, h('i', { class: 'dot' }), label);
};

export const svcBadge = (enabled, health) => {
  if (enabled && health === 'failing') return h('span', { class: 'badge err', title: 'Сервис включён, но контейнер не запущен' }, h('i', { class: 'dot' }), 'Сбой');
  if (enabled && health === 'missing') return h('span', { class: 'badge warn', title: 'Сервис включён, но контейнер не найден' }, h('i', { class: 'dot' }), 'Нет контейнера');
  return h('span', { class: `badge ${enabled ? 'ok' : 'muted'}` }, h('i', { class: 'dot' }), enabled ? 'Работает' : 'Остановлен');
};

export const typeChip = (type) => h('span', { class: `chip type-${type}` }, icon(isDb(type) ? 'database' : type === 'compose' ? 'layers' : 'box', 12), TYPE_LABEL[type] || type);

export const panelChip = (p) => h('span', { class: 'panel-chip' }, h('i', { class: 'swatch', style: { background: p.color } }), p.name);

export function meter(label, value, extra) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  const level = v == null ? '' : v >= 85 ? 'err' : v >= 65 ? 'warn' : 'ok';
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-top' }, h('span', null, label), h('b', null, v == null ? '—' : `${Math.round(v)}%`)),
    h('div', { class: `bar ${level}` }, h('i', { style: { width: `${v ?? 0}%` } })),
    extra ? h('div', { class: 'meter-extra' }, extra) : null);
}

export const empty = (title, text, action) => h('div', { class: 'empty' }, icon('folder', 32), h('h4', null, title), text ? h('p', null, text) : null, action);

/* ---------------- действия над сервисами ---------------- */
const ACTION_TEXT = {
  deploy: ['Деплой', 'Деплой запущен'], start: ['Запуск', 'Сервис запущен'], stop: ['Остановка', 'Сервис остановлен'],
  restart: ['Перезапуск', 'Сервис перезапущен'], destroy: ['Удаление', 'Сервис удалён'],
};

export async function runServiceAction(s, action) {
  if (action === 'destroy') {
    const ok = await confirmDialog({
      title: 'Удалить сервис?', danger: true, confirmText: 'Удалить',
      message: `Сервис «${s.project}/${s.name}» на панели «${s.panel.name}» будет удалён вместе с данными. Это необратимо.`,
      typeToConfirm: s.name,
    });
    if (!ok) return false;
  }
  const [ing, done] = ACTION_TEXT[action];
  toast(`${ing}: ${s.name}…`);
  try {
    await post(`/api/panels/${s.panelId}/service/action`, { type: s.type, project: s.project, name: s.name, action });
    toast(`${done}: ${s.name}`, 'success');
    refresh(true, { silent: true });
    return true;
  } catch (e) { toast(`${s.name}: ${e.message}`, 'error', 7000); return false; }
}

/** Компактные кнопки быстрых действий. */
export function quickActions(s) {
  if (!can('operator')) return h('span');
  const btn = (action, ic, title, cls = '') => h('button', {
    class: `btn icon ghost sm ${cls}`, title, 'aria-label': title,
    onclick: (e) => { e.stopPropagation(); runServiceAction(s, action); },
  }, icon(ic, 15));
  return h('div', { class: 'qa' },
    isDb(s.type) ? h('span', { class: 'qa-gap' }) : btn('deploy', 'rocket', 'Деплой'),
    btn('restart', 'rotate', 'Перезапустить'),
    s.enabled ? btn('stop', 'stop', 'Остановить') : btn('start', 'play', 'Запустить'));
}

/* ---------------- выбор и массовые действия ---------------- */
/** Итоги массовой операции: список по каждой цели. */
export function showResults(title, results, label = (x) => `${x.project}/${x.name}`) {
  modal({ title, body: h('ul', { class: 'result-list' }, results.map((x) => h('li', { class: x.ok ? 'ok' : 'err' }, icon(x.ok ? 'check' : 'alert', 14), h('b', null, label(x)), x.ok ? ' — ок' : ` — ${x.error}`))), actions: [{ label: 'Закрыть', kind: 'primary' }] });
}

export function toggleSelect(s, on) {
  if (on) store.selection.set(svcKey(s), { panelId: s.panelId, type: s.type, project: s.project, name: s.name, label: `${s.panel.name} · ${s.project}/${s.name}` });
  else store.selection.delete(svcKey(s));
  renderBulkBar();
}

export function clearSelection() { store.selection.clear(); renderBulkBar(); notify(); }

export async function runBulk(action) {
  let targets = [...store.selection.values()];
  if (action === 'deploy') targets = targets.filter((t) => !isDb(t.type));
  if (!targets.length) return toast('Нет подходящих сервисов для этого действия', 'error');
  const panels = new Set(targets.map((t) => t.panelId)).size;
  const ok = await confirmDialog({
    title: `${ACTION_TEXT[action][0]}: ${targets.length} шт.`, confirmText: 'Выполнить',
    message: `Действие затронет ${targets.length} сервис(ов) на ${panels} панел(ях).`,
  });
  if (!ok) return;
  toast(`${ACTION_TEXT[action][0]} ${targets.length} сервис(ов)…`);
  try {
    const r = await post('/api/bulk', { action, targets });
    await refresh(true, { silent: true });
    if (r.failCount === 0) { toast(`Готово: ${r.okCount} из ${targets.length}`, 'success'); clearSelection(); return; }
    modal({
      title: `Выполнено ${r.okCount}, с ошибкой ${r.failCount}`,
      body: h('ul', { class: 'result-list' }, r.results.map((x) => h('li', { class: x.ok ? 'ok' : 'err' }, icon(x.ok ? 'check' : 'alert', 14), h('b', null, `${x.project}/${x.name}`), x.ok ? ' — ок' : ` — ${x.error}`))),
      actions: [{ label: 'Закрыть', kind: 'primary' }],
    });
    // оставляем в выборке только неудавшиеся — удобно повторить
    const failed = new Set(r.results.filter((x) => !x.ok).map((x) => `${x.panelId}|${x.project}|${x.name}`));
    for (const [k, v] of [...store.selection]) if (!failed.has(`${v.panelId}|${v.project}|${v.name}`)) store.selection.delete(k);
    renderBulkBar(); notify();
  } catch (e) { toast(e.message, 'error'); }
}

let bar;
export function renderBulkBar() {
  const n = store.selection.size;
  if (!bar) { bar = h('div', { class: 'bulkbar', hidden: true }); document.body.append(bar); }
  bar.hidden = n === 0;
  if (!n) return;
  clear(bar).append(
    h('span', { class: 'bulk-count' }, `${n} выбрано`),
    h('button', { class: 'btn sm', onclick: () => runBulk('deploy') }, icon('rocket', 14), 'Деплой'),
    h('button', { class: 'btn sm', onclick: () => runBulk('restart') }, icon('rotate', 14), 'Перезапуск'),
    h('button', { class: 'btn sm', onclick: () => runBulk('start') }, icon('play', 14), 'Запуск'),
    h('button', { class: 'btn sm', onclick: () => runBulk('stop') }, icon('stop', 14), 'Стоп'),
    h('span', { class: 'bulk-sep' }),
    h('button', { class: 'btn sm', title: 'Изменить переменные окружения у выбранных', onclick: () => window.dispatchEvent(new CustomEvent('ea:bulk-op', { detail: 'env' })) }, 'Env…'),
    h('button', { class: 'btn sm', title: 'Сменить образ у выбранных App', onclick: () => window.dispatchEvent(new CustomEvent('ea:bulk-op', { detail: 'image' })) }, 'Образ…'),
    h('button', { class: 'btn sm ghost', onclick: clearSelection }, 'Снять выбор'));
}

/* ---------------- таблица сервисов ---------------- */
export function serviceFilters(state, onChange, { showPanels = false } = {}) {
  const types = ['all', 'app', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'compose'];
  const q = h('input', { class: 'input search', placeholder: 'Поиск по имени, проекту, домену…', value: state.q, oninput: () => { state.q = q.value; onChange(); } });
  return h('div', { class: 'filters' },
    h('div', { class: 'input-icon' }, icon('search', 15), q),
    showPanels ? h('select', { class: 'input', onchange: (e) => { state.panel = e.target.value; onChange(); } },
      h('option', { value: 'all' }, 'Все панели'), store.panels.map((p) => h('option', { value: p.id, selected: String(p.id) === String(state.panel) }, p.name))) : null,
    h('select', { class: 'input', onchange: (e) => { state.type = e.target.value; onChange(); } },
      types.map((t) => h('option', { value: t, selected: state.type === t }, t === 'all' ? 'Все типы' : TYPE_LABEL[t]))),
    h('select', { class: 'input', onchange: (e) => { state.status = e.target.value; onChange(); } },
      [['all', 'Любой статус'], ['on', 'Работают'], ['off', 'Остановлены']].map(([v, l]) => h('option', { value: v, selected: state.status === v }, l))));
}

export const matches = (s, f) => {
  if (f.type !== 'all' && s.type !== f.type) return false;
  if (f.status === 'on' && !s.enabled) return false;
  if (f.status === 'off' && s.enabled) return false;
  if (f.panel && f.panel !== 'all' && String(s.panelId) !== String(f.panel)) return false;
  const q = f.q.trim().toLowerCase();
  return !q || [s.name, s.project, s.domain, s.panel.name].some((x) => x && String(x).toLowerCase().includes(q));
};

export function serviceRow(s, { showPanel, openService }) {
  const cb = h('input', { type: 'checkbox', checked: store.selection.has(svcKey(s)), onclick: (e) => e.stopPropagation(), onchange: () => toggleSelect(s, cb.checked) });
  const fav = favorites().has(svcKey(s));
  return h('tr', { class: 'row', tabindex: 0, onclick: () => openService(s), onkeydown: (e) => { if (e.key === 'Enter') openService(s); } },
    h('td', { class: 'w-check' }, can('operator') ? cb : null),
    h('td', null, h('div', { class: 'svc-name' }, h('b', null, fav ? h('span', { class: 'fav' }, icon('star', 11)) : null, s.name), s.domain ? h('a', { class: 'muted small', href: `https://${s.domain}`, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, s.domain) : null)),
    h('td', { class: 'hide-sm' }, showPanel ? h('div', { class: 'stack-sm' }, panelChip(s.panel), h('span', { class: 'muted small' }, s.project)) : typeChip(s.type)),
    showPanel ? h('td', { class: 'hide-sm' }, typeChip(s.type)) : null,
    h('td', null, svcBadge(s.enabled, s.health)),
    h('td', { class: 'w-actions' }, quickActions(s)));
}

export { allServices, host };
