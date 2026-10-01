import { get } from './api.js';
import { empty, panelChip, typeChip } from './components.js';
import { openService } from './drawer.js';
import { clear, fmtTime, h, icon, modal, relTime } from './dom.js';
import { t } from './i18n.js';
import { allServices, can } from './store.js';
import { backupSettingsTab, dataTab, size, systemTab } from './backups-card.js';

/* ======================= Раздел «Бэкапы» ======================= */
const TABS = [['overview', 'Обзор'], ['data', 'Данные'], ['system', 'Система'], ['settings', 'Настройки']];

export function backupsPage(tab) {
  const cur = TABS.some(([id]) => id === tab) ? tab : 'overview';
  const body = h('div');
  body.append(cur === 'overview' ? overviewTab() : cur === 'data' ? dataTab() : cur === 'system' ? systemTab() : backupSettingsTab());
  return h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Бэкапы')),
    h('div', { class: 'tabs page-tabs' }, TABS.map(([id, label]) => h('a', { class: `tab ${cur === id ? 'active' : ''}`, href: id === 'overview' ? '#/backups' : `#/backups/${id}` }, label))), body);
}

/* ---------------- обзор ---------------- */
const STATUS = {
  none: ['Не настроено', 'err', 0], error: ['Последний запуск с ошибкой', 'err', 1], stale: ['Давно не было копии', 'warn', 2], pending: ['Ещё не запускалось', 'warn', 3],
  running: ['Идёт копирование', 'muted', 4], ok: ['Всё в порядке', 'ok', 5],
};
const CRON_NAMES = { '0 * * * *': 'каждый час', '0 2 * * *': 'каждый день в 02:00', '0 3 * * 1': 'каждый понедельник в 03:00', '0 3 1 * *': '1-го числа в 03:00' };
const filters = { q: '', panel: 'all', show: 'all' };
const SHOW = [['all', 'Все'], ['attention', 'Требуют внимания'], ['none', 'Не настроено'], ['error', 'Ошибки']];

const kpi = (label, value, sub, tone, ic) => h('div', { class: `kpi ${tone}` }, h('div', { class: 'kpi-ic' }, icon(ic, 18)), h('div', null, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-sub' }, sub)));
const statusBadge = (st) => { const [label, cls] = STATUS[st] ?? ['—', 'muted']; return h('span', { class: `badge ${cls}` }, h('i', { class: 'dot' }), label); };

/** Ячейка «Easypanel»: расписания самой панели и результат последнего запуска. */
function easypanelCell(ep) {
  if (!ep.supported) return h('span', { class: 'muted', title: t('У этого типа сервиса нет расписаний бэкапов Easypanel') }, '—');
  if (ep.error) return h('span', { class: 'danger-text small', title: ep.error }, t('Нет данных'));
  if (!ep.schedules.length) return h('span', { class: 'muted' }, ep.noData ? t('нет томов') : t('не настроено'));
  const on = ep.schedules.filter((x) => x.enabled);
  const first = on[0] ?? ep.schedules[0];
  return h('div', null,
    h('div', { class: 'small' }, on.length ? `${t(CRON_NAMES[first.schedule] ?? first.schedule)}${on.length > 1 ? ` +${on.length - 1}` : ''}` : t('расписание выключено')),
    ep.last ? h('div', { class: `small ${ep.last.state === 'error' ? 'danger-text' : 'muted'}` }, `${ep.last.state === 'error' ? t('ошибка') : ep.last.state === 'running' ? t('идёт') : t('ок')}${ep.last.ts ? ` · ${relTime(ep.last.ts)}` : ''}`) : on.length ? h('div', { class: 'small muted' }, t('ещё не запускалось')) : null);
}
/** Ячейка «EasyAdmin»: входит ли сервис в копии данных и чем закончился последний запуск. */
function easyadminCell(ea) {
  if (!ea.covered) return h('span', { class: 'muted' }, ea.possible ? t('не входит') : '—');
  return h('div', null, h('div', { class: 'small' }, ea.auto ? t('по расписанию') : t('вручную')),
    ea.last ? h('div', { class: `small ${ea.last.state === 'error' ? 'danger-text' : 'muted'}`, title: ea.last.error ?? '' }, `${ea.last.state === 'error' ? t('ошибка') : t('ок')} · ${relTime(ea.last.ts)}`) : h('div', { class: 'small muted' }, t('ещё не запускалось')));
}

const live = (panelId, project, name) => allServices().find((s) => s.panelId === panelId && s.project === project && s.name === name);
const openBackupsTab = (svc) => { try { localStorage.setItem('ea-drawer-tab', 'backups'); } catch { /* приватный режим */ } openService(svc); };

/** Что делать с сервисом без копий: два пути — расписание Easypanel (в карточке сервиса) или копии данных EasyAdmin. */
function setupModal(row, svc) {
  const choice = (title, text, onclick, disabled) => h('button', { class: 'list-item link btn-row', disabled, onclick: () => { m.close(); onclick(); } }, h('div', null, h('b', null, title), h('div', { class: 'muted small' }, text)), icon('chevron', 16));
  const m = modal({ title: `${row.project}/${row.name}`, body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Сервис нигде не копируется. Выберите, как его защитить:'), h('div', { class: 'list' },
    choice('Расписание Easypanel', 'Копии делает сама панель в её хранилище; для баз можно восстановить прямо из карточки сервиса. Открывается вкладка «Бэкапы» сервиса.', () => openBackupsTab(svc), !row.easypanel.supported || !svc),
    choice('Копии данных EasyAdmin', 'Дамп или копия томов на сервере панели, расписание и хранилище общие для всех сервисов. Откроется вкладка «Данные».', () => { location.hash = '#/backups/data'; }, !row.easyadmin.possible))), actions: [{ label: 'Закрыть', kind: 'ghost' }] });
}

function problemModal(row, svc) {
  const lines = [];
  if (row.easypanel.last?.state === 'error') lines.push(h('div', null, h('b', null, 'Easypanel'), h('div', { class: 'small danger-text' }, `${row.easypanel.last.status}${row.easypanel.last.ts ? ` · ${fmtTime(row.easypanel.last.ts)}` : ''}`), row.easypanel.last.description ? h('div', { class: 'small muted' }, row.easypanel.last.description) : null));
  if (row.easyadmin.last?.state === 'error') lines.push(h('div', null, h('b', null, 'EasyAdmin'), h('div', { class: 'small danger-text' }, row.easyadmin.last.error ?? 'ошибка'), h('div', { class: 'small muted' }, fmtTime(row.easyadmin.last.ts))));
  modal({ title: `${row.project}/${row.name}`, body: h('div', { class: 'stack' }, ...lines, h('p', { class: 'muted small' }, 'Подробности и повтор запуска: у Easypanel — во вкладке «Бэкапы» сервиса, у EasyAdmin — на вкладке «Данные».')),
    actions: [{ label: 'Вкладка «Данные»', close: true, onClick: () => { location.hash = '#/backups/data'; } }, ...(svc && row.easypanel.supported ? [{ label: 'Открыть сервис', kind: 'primary', onClick: () => openBackupsTab(svc) }] : []), { label: 'Закрыть', kind: 'ghost' }] });
}

function overviewTab() {
  const root = h('div', { class: 'stack' });
  const load = async (force) => {
    clear(root).append(h('div', { class: 'skeleton', style: { height: '160px' } }));
    let ov, sys;
    try { [ov, sys] = await Promise.all([get(`/api/backups/overview${force ? '?force=1' : ''}`), get('/api/backups')]); } catch (e) { return clear(root).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
    const sum = ov.summary; const waiting = sum.stale + sum.pending;
    const list = h('div'); const count = h('span', { class: 'muted small' });
    const draw = () => {
      const q = filters.q.trim().toLowerCase();
      const rows = ov.panels.filter((p) => filters.panel === 'all' || String(p.panelId) === String(filters.panel))
        .flatMap((p) => p.rows.map((r) => ({ ...r, panel: p })))
        .filter((r) => (filters.show === 'all' || (filters.show === 'attention' ? ['none', 'error', 'stale', 'pending'].includes(r.status) : r.status === filters.show)) && (!q || `${r.name} ${r.project} ${r.panel.panelName}`.toLowerCase().includes(q)))
        .sort((a, b) => STATUS[a.status][2] - STATUS[b.status][2] || a.panel.panelName.localeCompare(b.panel.panelName) || `${a.project}/${a.name}`.localeCompare(`${b.project}/${b.name}`));
      count.textContent = `${rows.length}`;
      clear(list).append(rows.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Сервис', 'Тип', 'Easypanel', 'EasyAdmin', 'Статус', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((r) => {
          const svc = live(r.panel.panelId, r.project, r.name);
          const act = r.status === 'none' ? h('button', { class: 'btn sm primary', onclick: (e) => { e.stopPropagation(); setupModal(r, svc); } }, 'Настроить')
            : r.status === 'error' ? h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); problemModal(r, svc); } }, 'Подробнее') : null;
          return h('tr', { class: 'row', tabindex: 0, onclick: () => { if (svc) (r.easypanel.supported ? openBackupsTab : openService)(svc); } },
            h('td', null, h('b', null, r.name), h('span', { class: 'muted small' }, `  ${r.project}`), h('div', null, panelChip({ name: r.panel.panelName, color: r.panel.color }))),
            h('td', { class: 'hide-sm' }, typeChip(r.type)), h('td', null, easypanelCell(r.easypanel)), h('td', null, easyadminCell(r.easyadmin)), h('td', null, statusBadge(r.status)), h('td', { class: 'w-actions' }, act));
        })))) : empty(sum.total ? 'Ничего не найдено' : 'Нет сервисов', sum.total ? 'Измените фильтры.' : 'Подключите панель с сервисами, чтобы увидеть, что копируется.'));
    };
    const q = h('input', { class: 'input search', placeholder: 'Поиск по сервису, проекту, панели…', value: filters.q, oninput: () => { filters.q = q.value; draw(); } });
    const panelSel = ov.panels.length > 1 ? h('select', { class: 'input', onchange: (e) => { filters.panel = e.target.value; draw(); } }, h('option', { value: 'all' }, t('Все панели')), ov.panels.map((p) => h('option', { value: p.panelId, selected: String(p.panelId) === String(filters.panel) }, p.panelName))) : null;
    const showSeg = h('div', { class: 'seg' }); const drawSeg = () => clear(showSeg).append(...SHOW.map(([v, l]) => h('button', { type: 'button', class: `seg-btn ${filters.show === v ? 'active' : ''}`, onclick: () => { filters.show = v; drawSeg(); draw(); } }, l)));
    drawSeg(); draw();
    const down = ov.panels.filter((p) => p.error);
    const sl = sys.settings.last;
    clear(root).append(
      h('div', { class: 'kpis' },
        kpi('Без копий', sum.none, sum.none ? 'сервисов нигде не копируются' : 'всё покрыто', sum.none ? 'err' : 'ok', 'alert'),
        kpi('Ошибки', sum.error, sum.error ? 'последний запуск не удался' : 'ошибок нет', sum.error ? 'err' : 'ok', 'activity'),
        kpi('Нет свежей копии', waiting, `${sum.stale} ${t('устарели')} · ${sum.pending} ${t('ещё не запускались')}`, waiting ? 'warn' : 'ok', 'clock'),
        kpi('В порядке', `${sum.ok}/${sum.total}`, sum.running ? `${sum.running} ${t('копируются сейчас')}` : 'сервисов', sum.ok === sum.total && sum.total ? 'ok' : '', 'check')),
      down.length ? h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, `${t('Панели недоступны, их сервисы не показаны')}: ${down.map((p) => p.panelName).join(', ')}`)) : null,
      h('div', { class: 'audit-bar' }, showSeg, panelSel, h('div', { class: 'input-icon' }, icon('search', 15), q), count, h('span', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => load(true) }, icon('refresh', 14), 'Обновить')),
      h('p', { class: 'muted small' }, 'Показаны оба способа: расписания самой Easypanel (вкладка «Бэкапы» в сервисе) и копии данных EasyAdmin (вкладка «Данные»). «Не настроено» — сервис не копируется ни одним из них.'),
      list,
      can('admin') ? h('section', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h4', null, 'Копия самого EasyAdmin'), h('a', { class: 'btn sm ghost', href: '#/backups/system' }, 'Открыть')),
        sl ? h('div', { class: `callout compact ${sl.ok ? '' : 'err'}` }, icon(sl.ok ? 'activity' : 'alert', 14), h('span', { class: 'small' }, sl.ok ? `${t('Последняя копия')}: ${fmtTime(sl.ts)} · ${size(sl.size)}` : `${t('Последняя копия не создана')}: ${sl.error}`))
          : h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, t('Копий самого EasyAdmin ещё нет. Без них восстановить настройки и список панелей после сбоя не получится.')))) : null);
  };
  load(false);
  return root;
}
