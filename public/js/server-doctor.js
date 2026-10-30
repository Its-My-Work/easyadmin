import { get, post } from './api.js';
import { fmtBytes } from './charts.js';
import { clear, confirmDialog, h, icon, toast } from './dom.js';
import { t } from './i18n.js';

/** Server Doctor: оценка здоровья сервера A–F, находки по важности и безопасные исправления в 1 клик. */
const SEV = [['crit', 'Критично', 'alert'], ['warn', 'Предупреждения', 'alert'], ['info', 'Информация', 'activity']];
const fill = (s, args = []) => t(s).replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? '');
const errBox = (e) => h('div', { class: 'callout err' }, icon('alert'), h('div', null, e.message));

function topList(top) {
  return h('div', { class: 'dr-top' }, top.map((r) => h('div', { class: 'dr-top-row' }, h('span', { class: 'mono' }, r.path), h('b', null, fmtBytes(r.size)))));
}

function fixButtons(f, data, rerun, busy) {
  return f.fixIds.map((id) => {
    const r = data.recipes[id]; if (!r) return null;
    const run = async () => {
      const params = {};
      if (id === 'swap.add') params.size = f.size ?? '2G';
      const ok = await confirmDialog({ title: r.title, message: `${t('Будет выполнено на сервере')}: ${t(r.title)}`, confirmText: 'Исправить', danger: r.risk !== 'low' });
      if (!ok) return;
      busy(true);
      try {
        const res = await post(`/api/panels/${data.panelId}/doctor/fix`, { fixId: id, params });
        toast(res.ok ? 'Готово' : 'Есть ошибки', res.ok ? 'success' : 'error');
        await rerun();
      } catch (e) { toast(e.message, 'error'); busy(false); }
    };
    if (id === 'swap.add') {
      const sel = h('select', { class: 'input sm', 'aria-label': 'Размер' }, ['1G', '2G', '4G'].map((s) => h('option', { value: s, selected: s === '2G' }, s)));
      sel.addEventListener('change', () => { f.size = sel.value; });
      return h('span', { class: 'inline' }, sel, h('button', { class: 'btn sm primary', onclick: run }, icon('check', 13), 'Исправить в 1 клик'));
    }
    return h('button', { class: 'btn sm primary', title: r.title, onclick: run }, icon('check', 13), 'Исправить в 1 клик');
  });
}

function findingRow(f, data, rerun, busy) {
  return h('div', { class: `dr-finding ${f.severity}` },
    h('div', { class: 'dr-ic' }, icon(f.severity === 'info' ? 'activity' : 'alert', 16)),
    h('div', { class: 'dr-body' },
      h('b', null, fill(f.title, f.args)),
      f.details ? h('div', { class: 'muted small' }, f.details) : null,
      f.id === 'disk.top' ? topList(f.metrics.top ?? []) : null,
      f.id === 'docker.logs' ? topList(f.metrics.files ?? []) : null),
    f.fixIds.length ? h('div', { class: 'dr-fix' }, fixButtons(f, data, rerun, busy)) : null);
}

export function doctorTab(p) {
  const box = h('div', { class: 'stack' });
  const draw = (data) => {
    const body = h('div', { class: 'stack' });
    const busy = (on) => { box.classList.toggle('dr-busy', on); };
    data.panelId = p.id;
    const groups = SEV.map(([sev, label]) => [sev, label, data.findings.filter((f) => f.severity === sev)]).filter(([, , l]) => l.length);
    body.append(
      h('div', { class: 'card dr-head' },
        h('div', { class: `dr-grade g-${data.grade}`, 'aria-label': `${t('Оценка')} ${data.grade}` }, data.grade),
        h('div', { class: 'dr-sum' }, h('h3', { class: 'inline' }, icon('stethoscope', 16), 'Здоровье сервера'), h('div', { class: 'muted' }, `${data.score} / 100`),
          h('div', { class: 'muted small' }, `${t('Транспорт')}: ${t('консоль хоста Easypanel')}`)),
        h('button', { class: 'btn', onclick: () => load() }, icon('refresh', 14), 'Проверить заново')),
      groups.length ? groups.map(([sev, label, list]) => h('section', { class: 'card' }, h('h3', { class: `dr-title ${sev}` }, `${t(label)} · ${list.length}`), h('div', { class: 'dr-list' }, list.map((f) => findingRow(f, data, load, busy)))))
        : h('div', { class: 'callout' }, icon('check'), h('div', null, 'Проблем не найдено')));
    clear(box).append(body);
  };
  async function load() {
    clear(box).append(h('div', { class: 'skeleton', style: { height: '160px' } }), h('p', { class: 'muted small' }, 'Проверка выполняется на самом сервере, это занимает до минуты…'));
    try { draw(await get(`/api/panels/${p.id}/doctor`)); } catch (e) { clear(box).append(errBox(e), h('button', { class: 'btn', onclick: () => load() }, 'Повторить')); }
  }
  load();
  return box;
}
