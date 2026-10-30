import { del, get, post, put } from './api.js';
import { areaChart, fmtBytes, fmtPct, fmtRate } from './charts.js';
import { clear, confirmDialog, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { can } from './store.js';

/** Нагрузка сервера: собственная история EasyAdmin (CPU/память всего сервера, из них сервисы и «система»), таблица сервисов и «Что грузит сервер?». */
const RANGES = [['1h', '1 ч'], ['6h', '6 ч'], ['24h', '24 ч'], ['7d', '7 дн'], ['30d', '30 дн']];
const COLORS = { svc: 'var(--accent)', other: 'var(--warn)' };
const rangeFor = new Map();
// столбцы таблицы сервисов, по которым можно сортировать; null в данных («сервис остановлен») всегда в конце
const COLS = [['name', 'Сервис', (s) => `${s.project}/${s.service}`.toLowerCase()], ['cpu', 'CPU сейчас', (s) => s.cpu], ['cpuAvg', 'CPU средн.', (s) => s.cpuAvg], ['mem', 'RAM сейчас', (s) => s.mem], ['memMax', 'RAM пик', (s) => s.memMax], ['net', 'Сеть ↓ / ↑', (s) => (s.rx == null ? null : (s.rx ?? 0) + (s.tx ?? 0))]];
const sortBy = { key: 'cpuAvg', dir: -1 };
const sortRows = (rows) => {
  const get = COLS.find(([k]) => k === sortBy.key)[2];
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sortBy.dir;
  });
};
const isSystem = (s) => s.project === 'easypanel';
const lazyBox = async (box, fn) => {
  clear(box).append(h('div', { class: 'skeleton', style: { height: '140px' } }));
  try { clear(box).append(...[await fn()].flat()); } catch (e) { clear(box).append(h('div', { class: 'callout err' }, icon('alert'), h('div', null, e.message))); }
};
const chips = (cur, onPick) => h('div', { class: 'seg' }, RANGES.map(([v, l]) => h('button', { type: 'button', class: `seg-btn ${cur === v ? 'active' : ''}`, onclick: () => onPick(v) }, l)));

/* ---------- «Что грузит сервер?» ---------- */
const ownerTag = (o) => (o ? h('span', { class: 'chip' }, o.service ? `${o.project}/${o.service}` : t('контейнер {0}').replace('{0}', o.container)) : h('span', { class: 'chip muted' }, 'система'));
export async function snapshotModal(p) {
  const body = h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { height: '160px' } }), h('p', { class: 'muted small' }, 'Снимок делается на самом сервере, это занимает около 5 секунд…'));
  modal({ title: `${t('Что грузит сервер?')} — ${p.name}`, wide: true, body, actions: [{ label: 'Закрыть', kind: 'ghost' }] });
  try {
    const s = await post(`/api/panels/${p.id}/snapshot`, {});
    const m = s.memory ?? {};
    const stat = (label, val, sub) => h('div', { class: 'meter' }, h('div', { class: 'meter-top' }, h('span', null, label), h('b', null, val)), sub ? h('div', { class: 'meter-extra' }, sub) : null);
    clear(body).append(
      h('div', { class: 'statstrip' },
        stat('Нагрузка (load)', [s.load.m1, s.load.m5, s.load.m15].map((v) => v ?? '—').join(' / '), '1 / 5 / 15 мин'),
        stat('CPU', s.cpu.idle == null ? '—' : fmtPct(100 - s.cpu.idle), `${t('пользователи')} ${s.cpu.user ?? '—'}% · ${t('система')} ${s.cpu.system ?? '—'}% · ${t('ожидание диска')} ${s.cpu.iowait ?? '—'}%${s.cpu.steal ? ` · steal ${s.cpu.steal}%` : ''}`),
        stat('RAM', m.total ? `${fmtBytes(m.used)} / ${fmtBytes(m.total)}` : '—', m.swapUsed ? `swap ${fmtBytes(m.swapUsed)}` : null),
        stat('Диск', s.disk ? `${s.disk.pct}%` : '—', s.disk ? `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}` : null)),
      s.cpu.iowait >= 20 ? h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, 'Высокое ожидание диска: сервер тормозит из-за дисковых операций, а не из-за процессора.')) : null,
      h('h4', null, 'Процессы по CPU'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['PID', 'Процесс', 'Сервис', 'CPU', 'RAM'].map((c) => h('th', null, c)))),
        h('tbody', null, s.processes.slice(0, 10).map((r) => h('tr', null, h('td', { class: 'mono' }, r.pid), h('td', { class: 'mono ellipsis', title: r.command }, r.command), h('td', null, ownerTag(r.owner)), h('td', null, `${r.cpu}%`), h('td', null, `${r.memPct ?? '—'}%`)))))),
      h('h4', null, 'Процессы по памяти'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['PID', 'Процесс', 'Сервис', 'RAM'].map((c) => h('th', null, c)))),
        h('tbody', null, s.memoryTop.slice(0, 8).map((r) => h('tr', null, h('td', { class: 'mono' }, r.pid), h('td', { class: 'mono ellipsis', title: r.command }, r.command), h('td', null, ownerTag(r.owner)), h('td', null, fmtBytes(r.rss))))))));
  } catch (e) { clear(body).append(h('div', { class: 'callout err' }, icon('alert'), h('div', null, e.message))); }
}

/* ---------- вкладка панели ---------- */
export function loadTab(p) {
  const box = h('div', { class: 'stack' });
  let range = rangeFor.get(p.id) ?? '24h'; let showSystem = false;
  const draw = () => lazyBox(box, async () => {
    const d = await get(`/api/panels/${p.id}/load?range=${range}`);
    const bar = h('div', { class: 'load-bar' }, chips(range, (v) => { range = v; rangeFor.set(p.id, v); draw(); }), h('span', { class: 'spacer' }),
      can('admin') ? h('button', { class: 'btn', disabled: !['online', 'degraded'].includes(p.status), onclick: () => snapshotModal(p) }, icon('activity', 14), 'Что грузит сервер?') : null);
    if (!d.enabled) return [bar, h('div', { class: 'callout' }, icon('alert'), h('div', null, h('b', null, 'Мониторинг нагрузки выключен'), h('p', null, 'История не собирается. Включить можно в Настройках EasyAdmin → «Мониторинг нагрузки».'), h('a', { class: 'btn sm', href: '#/settings' }, 'Открыть настройки')))];
    const last = d.points.at(-1);
    const cpuCard = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h4', null, 'CPU сервера'), last ? h('b', null, fmtPct(last.cpu)) : null),
      areaChart({ points: d.points, stacked: true, max: 100, fmt: fmtPct, series: [{ key: 'svcCpu', label: 'Сервисы', color: COLORS.svc }, { key: 'otherCpu', label: 'Система и прочее', color: COLORS.other }] }));
    const ramCard = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h4', null, 'Память сервера'), last ? h('b', null, `${fmtBytes(last.mem)}${d.memTotal ? ` / ${fmtBytes(d.memTotal)}` : ''}`) : null),
      areaChart({ points: d.points, stacked: true, max: d.memTotal ?? undefined, fmt: fmtBytes, series: [{ key: 'svcMem', label: 'Сервисы', color: COLORS.svc }, { key: 'otherMem', label: 'Система и прочее', color: COLORS.other }] }));
    const tableBox = h('div');
    const drawTable = () => {
      const rows = sortRows(d.services.filter((s) => showSystem || !isSystem(s)));
      clear(tableBox).append(rows.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, COLS.map(([k, label]) => h('th', { class: 'sortable', 'aria-sort': sortBy.key === k ? (sortBy.dir > 0 ? 'ascending' : 'descending') : 'none' },
          h('button', { type: 'button', class: 'th-sort', onclick: () => { sortBy.dir = sortBy.key === k ? -sortBy.dir : (k === 'name' ? 1 : -1); sortBy.key = k; drawTable(); } }, label, h('span', { class: 'sort-mark' }, sortBy.key === k ? (sortBy.dir > 0 ? ' ▲' : ' ▼') : '')))))),
        h('tbody', null, rows.map((s) => h('tr', { class: s.running ? '' : 'muted' },
          h('td', null, s.service === 'unknown' ? [h('b', null, 'Прочие контейнеры'), ' ', h('span', { class: 'muted small', title: 'Контейнеры, которые Easypanel не смог сопоставить с сервисом: чаще всего сборка при деплое или временная задача.' }, 'сборки, временные')] : [h('b', null, s.service), ' ', h('span', { class: 'muted small' }, s.project)], s.running ? null : h('span', { class: 'badge' }, 'не запущен')),
          h('td', null, s.cpu == null ? '—' : fmtPct(s.cpu)), h('td', null, fmtPct(s.cpuAvg)), h('td', null, s.mem == null ? '—' : fmtBytes(s.mem)), h('td', null, fmtBytes(s.memMax)),
          h('td', null, s.rx == null ? '—' : [fmtRate(s.rx), ' / ', fmtRate(s.tx)])))))) : h('p', { class: 'muted small' }, 'Сервисов с данными пока нет.'));
    };
    drawTable();
    const sysCount = d.services.filter(isSystem).length;
    const svcCard = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h4', null, 'Сервисы по нагрузке'),
      sysCount ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', onchange: (e) => { showSystem = e.target.checked; drawTable(); } }), 'Показать системные') : null), tableBox,
      h('p', { class: 'muted small' }, 'CPU показан как доля всего сервера. «Система и прочее» — всё, что не принадлежит сервисам: Docker, ядро, процессы хоста.'));
    return [bar, d.points.length < 2 ? h('div', { class: 'callout compact' }, icon('activity', 14), h('span', { class: 'small' }, 'История начала собираться недавно — графики наполнятся в течение нескольких минут.')) : null, h('div', { class: 'grid-2 load-grid' }, cpuCard, ramCard), svcCard];
  });
  draw();
  return box;
}

/* ---------- история сервиса (вкладка «Ресурсы» в карточке сервиса) ---------- */
export function serviceLoad(panelId, project, name) {
  const box = h('div', { class: 'stack' }); let range = '24h';
  const draw = () => lazyBox(box, async () => {
    const d = await get(`/api/panels/${panelId}/load?range=${range}&project=${encodeURIComponent(project)}&service=${encodeURIComponent(name)}`);
    const last = d.points.at(-1);
    return [h('div', { class: 'card-head' }, h('h4', null, 'История нагрузки'), chips(range, (v) => { range = v; draw(); })),
      !d.enabled ? h('p', { class: 'muted small' }, 'Мониторинг нагрузки выключен.') : h('div', { class: 'grid-2 load-grid' },
        h('div', null, h('div', { class: 'small muted' }, 'CPU (доля сервера)', last ? h('b', null, ` ${fmtPct(last.cpu)}`) : null), areaChart({ points: d.points, fmt: fmtPct, series: [{ key: 'cpu', label: 'CPU', color: COLORS.svc }], height: 110 })),
        h('div', null, h('div', { class: 'small muted' }, 'Память', last ? h('b', null, ` ${fmtBytes(last.mem)}`) : null), areaChart({ points: d.points, fmt: fmtBytes, series: [{ key: 'mem', label: 'Память', color: COLORS.other }], height: 110 })))];
  });
  draw();
  return h('section', { class: 'card' }, box);
}

/* ---------- настройки EasyAdmin ---------- */
export function loadSettingsCard() {
  const box = h('section', { class: 'card stack' });
  const draw = async () => {
    let s;
    try { s = await get('/api/load/settings'); } catch (e) { clear(box).append(h('h3', null, 'Мониторинг нагрузки'), h('p', { class: 'muted' }, e.message)); return; }
    const save = async (patch) => { try { await put('/api/load/settings', patch); draw(); } catch (e) { toast(e.message, 'error'); } };
    const seg = (key, options) => h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { type: 'button', class: `seg-btn ${s[key] === v ? 'active' : ''}`, onclick: () => save({ [key]: v }) }, l)));
    const a = s.presets.alerts;
    clear(box).append(
      h('div', { class: 'card-head' }, h('h3', null, 'Мониторинг нагрузки'), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => save({ enabled: e.target.checked }) }), 'Включён')),
      h('p', { class: 'muted small' }, 'EasyAdmin регулярно сохраняет нагрузку сервера и сервисов (данные берутся из панелей бесплатно) и рисует графики на вкладке «Нагрузка».'),
      s.enabled ? h('div', { class: 'stack' },
        h('div', { class: 'setting-box' }, h('div', { class: 'setting-title' }, 'Как часто замерять'), seg('interval', s.presets.intervals.map((m) => [m, m === 1 ? '1 мин' : `${m} мин`])),
          h('div', { class: 'setting-hint' }, 'Чаще — подробнее графики, но больше записей в базе и запросов к панелям. Применяется сразу; уже собранные данные не меняются.')),
        h('div', { class: 'setting-box' }, h('div', { class: 'setting-title' }, 'Сколько хранить'), seg('retention', [['short', '3 дня'], ['standard', '30 дней'], ['long', '90 дней']]),
          h('div', { class: 'setting-hint' }, 'Минутные данные — сутки, дальше история уплотняется до 5 минут и до часа.')),
        h('div', { class: 'setting-box' }, h('div', { class: 'setting-title' }, 'Уведомлять о перегрузке'), seg('alerts', [['off', 'Выкл'], ['normal', 'Обычные'], ['sensitive', 'Чувствительные']]),
          h('div', { class: 'setting-hint' }, s.alerts === 'off' ? 'Уведомления не отправляются.' : `${t('Сообщим, если CPU')} ≥ ${a[s.alerts].cpu}% ${t('или память')} ≥ ${a[s.alerts].mem}% ${t('держатся дольше')} ${a[s.alerts].minutes} ${t('мин')}. ${t('Куда слать — в разделе «Каналы уведомлений», событие «Перегрузка сервера».')}`),
          s.alerts !== 'off' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.snapshot, onchange: (e) => save({ snapshot: e.target.checked }) }), 'Прикладывать к уведомлению «что грузит сервер» (топ процессов)') : null)) : null,
      h('div', { class: 'inline' }, h('span', { class: 'muted small' }, `${t('В базе')}: ${s.rows.toLocaleString()} ${t('записей')} · ~${s.approxMb} ${t('МБ')}`), h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm ghost danger-text', disabled: !s.rows, onclick: async () => {
          if (!await confirmDialog({ title: 'Очистить историю нагрузки?', message: 'Графики начнут строиться заново. Настройки сохранятся.', confirmText: 'Очистить', danger: true })) return;
          try { await del('/api/load/data'); toast(t('История очищена'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); }
        } }, icon('trash', 13), 'Очистить историю')));
  };
  draw();
  return box;
}
