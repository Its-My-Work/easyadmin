import { get, post } from './api.js';
import { empty, panelChip, typeChip } from './components.js';
import { openService } from './drawer.js';
import { clear, fmtTime, h, icon, modal, relTime, toast } from './dom.js';
import { t } from './i18n.js';
import { allServices, can } from './store.js';
import { backupSettingsTab, dataTab, size, systemTab } from './backups-card.js';

const pad2 = (n) => String(n).padStart(2, '0');

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

const cell = (text, cls = 'muted', title) => h('span', { class: `cell-line ${cls}`, title: title ?? text }, text);
const lastBit = (last, running) => (last ? `${last.state === 'error' ? t('ошибка') : last.state === 'running' && running ? t('идёт') : t('ок')}${last.ts ? ` ${relTime(last.ts)}` : ''}` : null);
const lastTone = (last) => (last?.state === 'error' ? 'danger-text' : 'muted');
/** Ячейка «Easypanel»: расписание панели и результат последнего запуска — одной строкой. */
function easypanelCell(ep) {
  if (!ep.supported) return cell('—', 'muted', t('У этого типа сервиса нет расписаний бэкапов Easypanel'));
  if (ep.error) return cell(t('Нет данных'), 'danger-text', ep.error);
  if (!ep.schedules.length) return ep.planned ? cell(t('запланировано, ещё не создано'), 'warn-text', t('Расписание должно быть создано автоматически: проверьте хранилище панели на вкладке «Данные».')) : cell(ep.noData ? t('нет томов') : t('не настроено'));
  const on = ep.schedules.filter((x) => x.enabled); const first = on[0] ?? ep.schedules[0];
  const when = on.length ? `${t(CRON_NAMES[first.schedule] ?? first.schedule)}${on.length > 1 ? ` +${on.length - 1}` : ''}` : t('расписание выключено');
  const auto = ep.schedules.some((x) => x.managed);
  const last = ep.last ? lastBit(ep.last, true) : on.length ? t('ещё не запускалось') : null;
  return h('span', { class: 'cell-line', title: [when, auto ? t('Расписание создано и поддерживается EasyAdmin') : null, last].filter(Boolean).join(' · ') },
    when, auto ? h('span', { class: 'muted' }, ` · ${t('авто')}`) : null, last ? h('span', { class: ep.last ? lastTone(ep.last) : 'muted' }, ` · ${last}`) : null);
}
/** Ячейка «EasyAdmin»: входит ли сервис в копии данных и результат последнего запуска — одной строкой. */
function easyadminCell(ea) {
  if (!ea.covered) return cell(ea.possible ? t('не входит') : '—');
  const last = ea.last ? lastBit(ea.last) : t('ещё не запускалось');
  return h('span', { class: 'cell-line', title: ea.last?.error ?? '' }, ea.auto ? t('по расписанию') : t('вручную'), h('span', { class: ea.last ? lastTone(ea.last) : 'muted' }, ` · ${last}`));
}

const live = (panelId, project, name) => allServices().find((s) => s.panelId === panelId && s.project === project && s.name === name);
const openBackupsTab = (svc) => { try { localStorage.setItem('ea-drawer-tab', 'backups'); } catch { /* приватный режим */ } openService(svc); };

/** Защитить сервис без копий: один диалог, два способа с флажками. Расписание — общее (вкладка «Настройки»), хранилище Easypanel берётся из панели. */
async function setupModal(row, svc, reload) {
  const panelId = row.panel.panelId; let sys; let ep;
  try { [sys, ep] = await Promise.all([get('/api/backups'), get(`/api/backups/ep?panel=${panelId}`)]); } catch (e) { return toast(e.message, 'error'); }
  const s = sys.settings; const info = ep.panels[0] ?? { providers: [] };
  const epOk = row.easypanel.supported && !row.easypanel.noData && info.providers.length > 0 && !info.error; const eaOk = row.easyadmin.possible;
  const epWhy = !row.easypanel.supported ? 'У этого типа сервиса у Easypanel нет расписаний.' : row.easypanel.noData ? 'У сервиса нет томов: Easypanel копирует только тома (Volume mount), файловые и bind-монтирования не поддерживаются.' : info.error ? info.error : !info.providers.length ? 'В панели нет хранилища бэкапов.' : null;
  const cb = (checked, disabled) => h('input', { type: 'checkbox', checked: checked && !disabled, disabled });
  const useEp = cb(epOk, !epOk); const useEa = cb(!epOk && eaOk, !eaOk);
  const chosen = info.selected ?? '';
  const prov = info.providers.length > 1 ? h('select', { class: 'input' }, chosen ? null : h('option', { value: '' }, t('— выберите —')), info.providers.map((x) => h('option', { value: x.id, selected: x.id === chosen }, x.name || x.id))) : null;
  const enable = cb(!s.enabled, false);
  const option = (input, title, text, extra) => h('label', { class: 'list-item', style: { display: 'block', cursor: 'pointer' } }, h('div', { class: 'inline' }, input, h('b', null, title)), h('div', { class: 'muted small' }, text), extra ?? null);
  modal({ title: `${row.project}/${row.name}`, body: h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Выберите, чем копировать сервис. Можно включить оба способа — копии лягут в два разных места.'),
    option(useEp, 'Расписание Easypanel', 'Копии делает сама панель в её хранилище; EasyAdmin создаёт расписание и поддерживает его. Базы можно восстановить прямо из карточки сервиса.',
      epWhy ? h('div', { class: 'small danger-text' }, t(epWhy), !info.providers.length && row.easypanel.supported && !row.easypanel.noData ? [' ', h('a', { href: `#/panel/${panelId}/settings`, onclick: () => { try { localStorage.setItem('ea-pset-section', 'infra'); } catch { /* приватный режим */ } } }, t('Добавить хранилище'))] : null)
        : prov ? h('div', { class: 'small', style: { marginTop: '6px' } }, `${t('Хранилище')}: `, prov) : h('div', { class: 'small muted' }, `${t('Хранилище')}: ${info.providers[0].name || info.providers[0].id}`)),
    option(useEa, 'Копии данных EasyAdmin', 'Дамп базы или копия томов на сервере панели (или в S3), расписание и хранилище общие для всех сервисов. Восстановление — вручную по подсказке.'),
    h('div', { class: 'callout compact' }, icon('clock', 14), h('span', { class: 'small' }, `${s.every === 'weekly' ? t('Раз в неделю') : t('Каждый день')}, ${pad2(s.hour)}:00 · ${t('Расписание общее, оно меняется на вкладке «Настройки».')}`)),
    s.enabled ? null : h('label', { class: 'check' }, enable, t('Включить автоматические копии по расписанию (сейчас они выключены)'))),
  actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Включить защиту', kind: 'primary', onClick: async () => {
    const methods = { easypanel: useEp.checked, easyadmin: useEa.checked };
    if (!methods.easypanel && !methods.easyadmin) { toast(t('Отметьте хотя бы один способ'), 'error'); return false; }
    if (methods.easypanel && prov && !prov.value) { toast(t('Выберите хранилище для копий'), 'error'); return false; }
    const r = await post('/api/backups/protect', { panelId, project: row.project, service: row.name, methods, providerId: methods.easypanel && prov ? prov.value : undefined, enableSchedule: enable.checked });
    const sy = r.sync;
    if (sy?.error) toast(`${t('Расписание Easypanel не создано')}: ${sy.error}`, 'error', 9000);
    else if (sy && !(sy.created + sy.updated + sy.unchanged)) toast(`${t('Расписание Easypanel не создано')}${sy.notes[0] ? `: ${sy.notes[0]}` : ''}`, 'error', 9000);
    else if (sy?.notes.length) toast(sy.notes[0], 'error', 9000);
    else toast(t('Защита включена'), 'success');
    reload?.(true);
  } }] });
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
        .sort((a, b) => a.panel.panelName.localeCompare(b.panel.panelName) || STATUS[a.status][2] - STATUS[b.status][2] || `${a.project}/${a.name}`.localeCompare(`${b.project}/${b.name}`));
      count.textContent = `${rows.length}`;
      const grouped = new Set(rows.map((r) => r.panel.panelId)).size > 1; // заголовок панели нужен, только если их несколько
      const body = []; let prev = null;
      for (const r of rows) {
        if (grouped && r.panel.panelId !== prev) {
          prev = r.panel.panelId; const mine = rows.filter((x) => x.panel.panelId === prev); const bad = mine.filter((x) => ['none', 'error', 'stale', 'pending'].includes(x.status)).length;
          body.push(h('tr', { class: 'grp' }, h('td', { colspan: 5 }, h('div', { class: 'inline' }, panelChip({ name: r.panel.panelName, color: r.panel.color }), h('span', { class: 'muted small' }, `${mine.length}`), bad ? h('span', { class: 'badge warn' }, `${bad} ${t('требуют внимания')}`) : null))));
        }
        const svc = live(r.panel.panelId, r.project, r.name);
        const act = r.status === 'none' ? h('button', { class: 'btn sm primary', onclick: (e) => { e.stopPropagation(); setupModal(r, svc, load); } }, 'Настроить')
          : r.status === 'error' ? h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); problemModal(r, svc); } }, 'Подробнее') : null;
        body.push(h('tr', { class: 'row', tabindex: 0, onclick: () => { if (svc) (r.easypanel.supported ? openBackupsTab : openService)(svc); } },
          h('td', { class: 'svc-cell' }, h('b', null, r.name), h('span', { class: 'muted small' }, `  ${r.project}`), grouped ? null : h('span', { class: 'ml' }, panelChip({ name: r.panel.panelName, color: r.panel.color })), h('span', { class: 'ml hide-sm' }, typeChip(r.type))),
          h('td', null, easypanelCell(r.easypanel)), h('td', null, easyadminCell(r.easyadmin)), h('td', null, statusBadge(r.status)), h('td', { class: 'w-actions' }, act)));
      }
      clear(list).append(rows.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl compact' },
        h('thead', null, h('tr', null, ['Сервис', 'Easypanel', 'EasyAdmin', 'Статус', ''].map((x) => h('th', null, x)))), h('tbody', null, body)))
        : empty(sum.total ? 'Ничего не найдено' : 'Нет сервисов', sum.total ? 'Измените фильтры.' : 'Подключите панель с сервисами, чтобы увидеть, что копируется.'));
    };
    const q = h('input', { class: 'input search', placeholder: 'Поиск по сервису, проекту, панели…', value: filters.q, oninput: () => { filters.q = q.value; draw(); } });
    const panelSel = ov.panels.length > 1 ? h('select', { class: 'input', onchange: (e) => { filters.panel = e.target.value; draw(); } }, h('option', { value: 'all' }, t('Все панели')), ov.panels.map((p) => h('option', { value: p.panelId, selected: String(p.panelId) === String(filters.panel) }, p.panelName))) : null;
    const showSeg = h('div', { class: 'seg' }); const drawSeg = () => clear(showSeg).append(...SHOW.map(([v, l]) => h('button', { type: 'button', class: `seg-btn ${filters.show === v ? 'active' : ''}`, onclick: () => { filters.show = v; drawSeg(); draw(); } }, l)));
    drawSeg(); draw();
    const down = ov.panels.filter((p) => p.error);
    const sl = sys.settings.last;
    clear(root).append(
      h('div', { class: 'kpis slim' },
        kpi('Без копий', sum.none, sum.none ? 'сервисов нигде не копируются' : 'всё покрыто', sum.none ? 'err' : 'ok', 'alert'),
        kpi('Ошибки', sum.error, sum.error ? 'последний запуск не удался' : 'ошибок нет', sum.error ? 'err' : 'ok', 'activity'),
        kpi('Нет свежей копии', waiting, `${sum.stale} ${t('устарели')} · ${sum.pending} ${t('ещё не запускались')}`, waiting ? 'warn' : 'ok', 'clock'),
        kpi('В порядке', `${sum.ok}/${sum.total}`, sum.running ? `${sum.running} ${t('копируются сейчас')}` : 'сервисов', sum.ok === sum.total && sum.total ? 'ok' : '', 'check')),
      down.length ? h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, `${t('Панели недоступны, их сервисы не показаны')}: ${down.map((p) => p.panelName).join(', ')}`)) : null,
      h('div', { class: 'audit-bar' }, showSeg, panelSel, h('div', { class: 'input-icon' }, icon('search', 15), q), count, h('span', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => load(true) }, icon('refresh', 14), 'Обновить')),
      list,
      can('admin') ? h('section', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h4', null, 'Копия самого EasyAdmin'), h('a', { class: 'btn sm ghost', href: '#/backups/system' }, 'Открыть')),
        sl ? h('div', { class: `callout compact ${sl.ok ? '' : 'err'}` }, icon(sl.ok ? 'activity' : 'alert', 14), h('span', { class: 'small' }, sl.ok ? `${t('Последняя копия')}: ${fmtTime(sl.ts)} · ${size(sl.size)}` : `${t('Последняя копия не создана')}: ${sl.error}`))
          : h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, t('Копий самого EasyAdmin ещё нет. Без них восстановить настройки и список панелей после сбоя не получится.')))) : null);
  };
  load(false);
  return root;
}
