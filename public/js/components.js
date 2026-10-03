import { get, post } from './api.js';
import { clear, confirmDialog, h, host, icon, modal, spinner, toast } from './dom.js';
import { STATUS, TYPE_LABEL, allServices, can, favorites, isDb, notify, patchService, refresh, store, svcKey } from './store.js';

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

/** Действия, которые выполняются прямо сейчас: svcKey → действие. По нему кнопки показывают кружок вместо значка. */
const busy = new Map();
export const busyAction = (s) => busy.get(svcKey(s));
const paintBusy = (key) => document.querySelectorAll('.qa[data-key]').forEach((el) => { if (el.dataset.key === key) el._fill?.(); });

const TERMINAL = /succe|done|complet|finish|\bok\b|fail|error|cancel|kill|abort|stop/i;
const FAILED = /fail|error/i;
const isActive = (x) => !!x.status && !TERMINAL.test(x.status) && !x.finishedAt;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const deployItems = async (s) => {
  const r = await get(`/api/panels/${s.panelId}/service/history?${new URLSearchParams({ type: s.type, project: s.project, name: s.name })}`);
  return r.items.filter((x) => x.source === 'panel' && /deploy/i.test(x.kind) && x.id);
};
/** Деплой в панели идёт в фоне: ждём, пока новое действие по сервису (его нет среди известных до запуска) не завершится. Возвращает его статус или null, если проследить не удалось. */
async function waitDeploy(s, known, { pollMs = 2000, maxMs = 600_000, giveUpPolls = 5 } = {}) {
  const t0 = Date.now(); let misses = 0;
  await wait(Math.min(1500, pollMs));
  while (Date.now() - t0 < maxMs) {
    let list; try { list = await deployItems(s); } catch { return null; }
    const fresh = list.find((x) => !known.has(x.id));
    if (fresh && !isActive(fresh)) return fresh.status || 'done';
    if (!fresh && ++misses >= giveUpPolls) return null; // панель не показала новый деплой — не гадаем
    await wait(pollMs);
  }
  return null;
}

export async function runServiceAction(s, action) {
  if (action === 'destroy') {
    const ok = await confirmDialog({
      title: 'Удалить сервис?', danger: true, confirmText: 'Удалить',
      message: `Сервис «${s.project}/${s.name}» на панели «${s.panel.name}» будет удалён вместе с данными. Это необратимо.`,
      typeToConfirm: s.name,
    });
    if (!ok) return false;
  }
  const key = svcKey(s);
  if (busy.has(key)) return false; // уже что-то выполняется
  const [ing, done] = ACTION_TEXT[action];
  toast(`${ing}: ${s.name}…`);
  busy.set(key, action); paintBusy(key);
  try {
    const known = action === 'deploy' ? await deployItems(s).then((l) => new Set(l.map((x) => x.id))).catch(() => null) : null;
    await post(`/api/panels/${s.panelId}/service/action`, { type: s.type, project: s.project, name: s.name, action });
    let tracked = null;
    if (known) {
      tracked = await waitDeploy(s, known);
      if (tracked && FAILED.test(tracked)) { busy.delete(key); paintBusy(key); toast(`${s.name}: деплой завершился с ошибкой — лог во вкладке «История»`, 'error', 9000); refresh(true, { silent: true }); return false; }
    }
    // действие выполнено: сразу снимаем «занято» и показываем новое состояние — не ждём перечитывания списка панели
    busy.delete(key); paintBusy(key);
    if (action === 'start' || action === 'restart') patchService(s, { enabled: true }); else if (action === 'stop') patchService(s, { enabled: false });
    toast(`${tracked ? 'Деплой завершён' : done}: ${s.name}`, 'success');
    refresh(true, { silent: true });
    return true;
  } catch (e) { toast(`${s.name}: ${e.message}`, 'error', 7000); return false; }
  finally { busy.delete(key); paintBusy(key); }
}

/** Компактные кнопки быстрых действий. Пока действие выполняется, его значок заменён кружком, остальные кнопки неактивны. */
export function quickActions(s) {
  if (!can('operator')) return h('span');
  const key = svcKey(s);
  const el = h('div', { class: 'qa', 'data-key': key });
  el._fill = () => {
    const running = busy.get(key);
    const btn = (action, ic, title) => {
      const on = running === action;
      return h('button', { class: `btn icon ghost sm ${on ? 'busy' : ''}`, title: on ? `${ACTION_TEXT[action][0]}…` : title, 'aria-label': title, disabled: !!running && !on,
        onclick: (e) => { e.stopPropagation(); if (!running) runServiceAction(s, action); } }, on ? spinner(15) : icon(ic, 15));
    };
    el.replaceChildren(
      isDb(s.type) ? h('span', { class: 'qa-gap' }) : btn('deploy', 'rocket', 'Деплой'),
      btn('restart', 'rotate', 'Перезапустить'),
      s.enabled ? btn('stop', 'stop', 'Остановить') : btn('start', 'play', 'Запустить'));
  };
  el._fill();
  return el;
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
  return !q || [s.name, s.project, s.domain, ...(s.domains ?? []), s.panel.name].some((x) => x && String(x).toLowerCase().includes(q));
};

export function serviceRow(s, { showPanel, openService }) {
  const cb = h('input', { type: 'checkbox', checked: store.selection.has(svcKey(s)), onclick: (e) => e.stopPropagation(), onchange: () => toggleSelect(s, cb.checked) });
  const fav = favorites().has(svcKey(s));
  return h('tr', { class: 'row', tabindex: 0, onclick: () => openService(s), onkeydown: (e) => { if (e.key === 'Enter') openService(s); } },
    h('td', { class: 'w-check' }, can('operator') ? cb : null),
    h('td', { class: 'c-name' }, h('div', { class: 'svc-name' }, h('b', null, fav ? h('span', { class: 'fav' }, icon('star', 11)) : null, s.name),
      showPanel ? h('span', { class: 'muted small svc-proj' }, s.project) : null,
      showPanel && s.panel ? h('span', { class: 'svc-panel-m' }, panelChip(s.panel)) : null)), // на узком экране колонка «Панель» скрыта — панель показывается под именем
    showPanel ? h('td', { class: 'hide-sm c-panel' }, panelChip(s.panel)) : null,
    h('td', { class: 'hide-sm c-domain' }, s.domain ? h('a', { class: 'muted small svc-domain', href: `https://${s.domain}`, target: '_blank', rel: 'noopener', title: (s.domains ?? [s.domain]).join('\n'), onclick: (e) => e.stopPropagation() }, s.domain, s.domains?.length > 1 ? ` +${s.domains.length - 1}` : '') : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'hide-sm c-type' }, typeChip(s.type)),
    h('td', { class: 'c-status' }, svcBadge(s.enabled, s.health)),
    h('td', { class: 'w-actions' }, quickActions(s)));
}

export { allServices, host };
