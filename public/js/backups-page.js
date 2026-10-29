import { get, post } from './api.js';
import { empty, panelChip, typeChip } from './components.js';
import { clear, fmtTime, h, icon, relTime, toast } from './dom.js';
import { t } from './i18n.js';
import { can } from './store.js';
import { restoresModal } from './restore-wizard.js';
import { migrationModal } from './migration-modal.js';
import { STATUS, copiesModal, inclusionPatch, logModal, partTitle, runCopy, saveSettings, settingsModal, size, switchBtn, systemCopiesModal } from './backups-modals.js';

/* ======================= Раздел «Бэкапы»: одна страница ======================= */
const filters = { q: '', show: 'all' };
const SHOW = [['all', 'Все'], ['on', 'Копируются'], ['off', 'Не копируются'], ['bad', 'Проблемы']];
const BAD = ['error', 'stale', 'pending'];
const ORDER = { error: 0, running: 1, queued: 2, stale: 3, pending: 4, ok: 5, empty: 6, off: 7 };
const pad2 = (n) => String(n).padStart(2, '0');

const kpi = (label, value, tone, ic) => h('div', { class: `kpi ${tone}` }, h('div', { class: 'kpi-ic' }, icon(ic, 18)), h('div', null, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value)));
const badge = (st) => { const [label, cls] = STATUS[st] ?? ['—', 'muted']; return h('span', { class: `badge ${cls}` }, st === 'running' ? h('span', { class: 'spinner', style: { width: '10px', height: '10px' } }) : h('i', { class: 'dot' }), label); };

/** Последняя копия сервиса одной строкой: когда и размер, либо текст ошибки. */
function lastCell(r) {
  if (r.live?.state === 'running') return h('span', { class: 'cell-line', title: r.live.part ?? '' }, t('копируется'), r.live.part ? `: ${partTitle(r.live.part)}` : '…');
  if (r.live?.state === 'queued') return h('span', { class: 'muted' }, t('ждёт своей очереди'));
  if (!r.included && !r.last) return h('span', { class: 'muted' }, '—');
  if (r.last?.ok === false) return h('span', { class: 'cell-line danger-text', title: r.last.error }, relTime(r.last.ts), ' · ', r.last.error);
  if (r.last?.empty) return h('span', { class: 'muted' }, t('нет томов и баз'));
  if (r.last) return h('span', { class: 'cell-line', title: fmtTime(r.last.ts) }, relTime(r.last.ts), r.last.size ? h('span', { class: 'muted' }, ` · ${size(r.last.size)}`) : null);
  return h('span', { class: 'muted' }, t('ещё не копировался'));
}

export function backupsPage() {
  const body = h('div', { class: 'stack' }); let timer = null;
  const page = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Бэкапы'), h('div', { class: 'inline' }, can('admin') ? [
    h('button', { class: 'btn', onclick: () => logModal() }, icon('activity', 15), 'Журнал копий'),
    h('button', { class: 'btn', onclick: () => restoresModal() }, icon('rotate', 15), 'Восстановления'),
    h('button', { class: 'btn', onclick: () => migrationModal() }, icon('server', 15), 'Переезд на новый сервер'),
    h('button', { class: 'btn', onclick: () => settingsModal(() => load(true)) }, icon('settings', 15), 'Настройки'),
    h('button', { class: 'btn primary', onclick: () => startAll() }, icon('database', 15), 'Копировать сейчас')] : null)), body);

  async function startAll() { if (await runCopy()) load(true); }
  async function include(ov, r, on) {
    if (on && !ov.system.hasPassword) { toast(t('Сначала задайте пароль копий'), 'error'); return settingsModal(() => load(true), { focusPassword: true }); }
    const allKeys = ov.panels.flatMap((p) => p.rows.map((x) => x.key));
    const keys = ov.panels.flatMap((p) => p.rows.filter((x) => x.included).map((x) => x.key));
    if (await saveSettings(inclusionPatch({ mode: ov.mode, keys, allKeys }, r.key, on))) load(true);
  }
  async function includeAll(ov, on) {
    if (on && !ov.system.hasPassword) { toast(t('Сначала задайте пароль копий'), 'error'); return settingsModal(() => load(true), { focusPassword: true }); }
    const keys = ov.panels.flatMap((p) => p.rows.filter((x) => x.included).map((x) => x.key));
    if (await saveSettings({ data: on ? { mode: 'all' } : { mode: keys.length ? 'selected' : 'none', ...(keys.length ? { keys } : {}) } })) load(true);
  }
  async function toggleSystem(ov, on) {
    if (on && !ov.system.hasPassword) { toast(t('Сначала задайте пароль копий'), 'error'); return settingsModal(() => load(true), { focusPassword: true }); }
    if (await saveSettings({ system: on, panels: on ? 'all' : 'none' })) load(true);
  }

  async function load(quiet) {
    clearTimeout(timer);
    if (!quiet) clear(body).append(h('div', { class: 'skeleton', style: { height: '200px' } }));
    let ov, sys;
    try { [ov, sys] = await Promise.all([get('/api/backups/overview'), get('/api/backups')]); } catch (e) { return clear(body).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
    const sum = ov.summary; const s = sys.settings; const sysOn = ov.system.system || ov.system.panels !== 'none'; const admin = can('admin');
    const list = h('div');
    const draw = () => {
      const q = filters.q.trim().toLowerCase();
      const rows = ov.panels.flatMap((p) => p.rows.map((r) => ({ ...r, panel: p })))
        .filter((r) => (filters.show === 'all' || (filters.show === 'on' ? r.included : filters.show === 'off' ? !r.included : BAD.includes(r.status))) && (!q || `${r.name} ${r.project} ${r.panel.panelName}`.toLowerCase().includes(q)))
        .sort((a, b) => a.panel.panelName.localeCompare(b.panel.panelName) || ORDER[a.status] - ORDER[b.status] || `${a.project}/${a.name}`.localeCompare(`${b.project}/${b.name}`));
      const grouped = ov.panels.filter((p) => p.rows.length).length > 1; const out = []; let prev = null;
      for (const r of rows) {
        if (grouped && r.panel.panelId !== prev) { prev = r.panel.panelId; out.push(h('tr', { class: 'grp' }, h('td', { colspan: 5 }, h('div', { class: 'inline' }, panelChip({ name: r.panel.panelName, color: r.panel.color }), h('span', { class: 'muted small' }, `${rows.filter((x) => x.panel.panelId === prev).length}`))))); }
        const svc = { panelId: r.panel.panelId, project: r.project, name: r.name, type: r.type, panelName: r.panel.panelName };
        out.push(h('tr', { class: `row ${r.included ? '' : 'dim'}`, tabindex: 0, onclick: () => copiesModal(svc) },
          h('td', { class: 'w-check bk-sw', onclick: (e) => e.stopPropagation() }, admin ? switchBtn(r.included || ov.mode === 'all', r.included ? t('Не копировать этот сервис') : t('Копировать этот сервис'), () => include(ov, r, !r.included), ov.mode === 'all') : null),
          h('td', { class: 'svc-cell bk-name' }, h('b', null, r.name), h('span', { class: 'muted small' }, `  ${r.project}`), grouped ? null : h('span', { class: 'ml' }, panelChip({ name: r.panel.panelName, color: r.panel.color })), h('span', { class: 'ml hide-sm' }, typeChip(r.type))),
          h('td', { class: 'bk-last' }, lastCell(r)), h('td', { class: 'bk-status' }, badge(r.status)),
          h('td', { class: 'w-actions bk-act', onclick: (e) => e.stopPropagation() }, admin ? h('div', { class: 'inline nowrap' },
            h('button', { class: 'btn icon sm', title: t('Копировать этот сервис сейчас'), 'aria-label': t('Копировать этот сервис сейчас'), disabled: !r.included || ov.running, onclick: async () => { if (await runCopy(svc)) load(true); } }, icon('play', 13)),
            h('button', { class: 'btn icon sm', title: t('Копии и восстановление'), 'aria-label': t('Копии и восстановление'), onclick: () => copiesModal(svc) }, icon('clock', 14))) : null)));
      }
      clear(list).append(rows.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, ['', 'Сервис', 'Последняя копия', 'Статус', ''].map((x) => h('th', null, x)))), h('tbody', null, out)))
        : empty(sum.total ? 'Ничего не найдено' : 'Нет сервисов', sum.total ? 'Измените фильтры.' : 'Подключите панель с сервисами, чтобы настроить копирование.'));
    };
    const search = h('input', { class: 'input search', placeholder: 'Поиск по сервису, проекту, панели…', value: filters.q, oninput: () => { filters.q = search.value; draw(); } });
    const showSeg = h('div', { class: 'seg' }); const drawSeg = () => clear(showSeg).append(...SHOW.map(([v, l]) => h('button', { type: 'button', class: `seg-btn ${filters.show === v ? 'active' : ''}`, onclick: () => { filters.show = v; drawSeg(); draw(); } }, l)));
    drawSeg(); draw();
    const down = ov.panels.filter((p) => p.error);
    const sl = ov.system.last;
    clear(body).append(
      // строка состояния: пароль, расписание, куда; всё меняется в одном окне «Настройки»
      !s.hasPassword ? h('div', { class: 'callout warn compact' }, icon('key', 14), h('span', { class: 'small' }, t('Не задан пароль копий — без него ничего не копируется. ')), admin ? h('button', { class: 'btn sm', onclick: () => settingsModal(() => load(true), { focusPassword: true }) }, 'Задать пароль') : null)
        : h('div', { class: 'callout compact' }, icon('clock', 14), h('span', { class: 'small' }, s.enabled ? [s.every === 'weekly' ? 'Раз в неделю' : 'Каждый день', `, ${pad2(s.hour)}:00`] : 'Автоматические копии выключены', ' · ', s.where === 's3' ? 'в S3' : 'на сервере', ' · ', 'хранится копий', `: ${s.data.keep} · `, 'копии зашифрованы паролем')),
      h('div', { class: 'kpis slim' }, kpi('Копируются', `${sum.included}/${sum.total}`, sum.included ? 'ok' : 'warn', 'database'), kpi('В порядке', sum.ok, sum.ok ? 'ok' : '', 'check'),
        kpi('Ошибки', sum.error, sum.error ? 'err' : 'ok', 'alert'), kpi('Нет свежей копии', sum.stale + sum.pending, sum.stale + sum.pending ? 'warn' : 'ok', 'clock')),
      ov.running ? h('div', { class: 'callout compact' }, h('span', { class: 'spinner' }), h('span', { class: 'small' }, t('Идёт копирование… страница обновится сама'))) : null,
      down.length ? h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, `${t('Панели недоступны, их сервисы не показаны')}: ${down.map((p) => p.panelName).join(', ')}`)) : null,
      h('div', { class: 'audit-bar' }, showSeg, h('div', { class: 'input-icon' }, icon('search', 15), search), h('span', { class: 'spacer' }),
        admin ? h('label', { class: 'check', title: t('Включено: копируются все сервисы, в том числе созданные позже. Выключено: копируются только отмеченные галочкой в списке.') }, switchBtn(ov.mode === 'all', t('Копировать все сервисы, включая новые'), () => includeAll(ov, ov.mode !== 'all')), h('span', { class: 'small' }, t('Копировать все, включая новые'))) : null),
      admin ? h('p', { class: 'muted small' }, ov.mode === 'all' ? t('Копируются все сервисы, в том числе те, что появятся позже: отдельные галочки не нужны. Выключите переключатель, чтобы выбирать сервисы вручную.') : t('Копируются только сервисы, отмеченные галочкой. Включите «Копировать все, включая новые» — тогда в копии попадёт каждый сервис, и новые тоже, без ручной настройки.')) : null,
      list,
      // копия самого EasyAdmin — отдельной строкой под таблицей
      h('section', { class: 'card stack' }, h('div', { class: 'card-head' }, h('div', { class: 'inline' }, admin ? switchBtn(sysOn, t('Копировать настройки EasyAdmin и конфигурации панелей'), () => toggleSystem(ov, !sysOn)) : null, h('div', null, h('h4', null, 'Сам EasyAdmin'),
        h('div', { class: 'muted small' }, 'Панели, пользователи, настройки, шаблоны и конфигурации сервисов всех панелей (проекты, env, источники) — одним файлом.'))),
        admin ? h('div', { class: 'inline' }, h('button', { class: 'btn sm', disabled: !sysOn, onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { const r = await post('/api/backups/run'); toast(`${t('Копия создана')}: ${size(r.size)}`, 'success'); } catch (er) { toast(er.message, 'error', 9000); } load(true); } }, icon('database', 13), 'Создать копию'),
          h('button', { class: 'btn sm', onclick: () => systemCopiesModal(sys.files, () => load(true)) }, icon('clock', 13), `${t('Копии')} (${sys.files.length})`)) : null),
        sl ? h('div', { class: `callout compact ${sl.ok ? '' : 'err'}` }, icon(sl.ok ? 'activity' : 'alert', 14), h('span', { class: 'small' }, sl.ok ? `${t('Последняя копия')}: ${fmtTime(sl.ts)} · ${size(sl.size)}` : `${t('Последняя копия не создана')}: ${sl.error}`))
          : h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, t('Копий самого EasyAdmin ещё нет. Без них настройки и список панелей после сбоя не вернуть.')))));
    if (ov.running) timer = setTimeout(() => { if (body.isConnected) load(true); }, 3000);
  }
  load(false);
  const stopWhenGone = setInterval(() => { if (!page.isConnected) { clearTimeout(timer); clearInterval(stopWhenGone); } }, 5000);
  return page;
}
