import { del, get, post, put } from './api.js';
import { empty, panelChip, showResults, statusBadge, clearSelection } from './components.js';
import { clear, confirmDialog, field, fmtTime, h, icon, modal, relTime, toast } from './dom.js';
import { locale } from './i18n.js';
import { TYPE_LABEL, allServices, can, isDb, panelById, refresh, store } from './store.js';

const pageHead = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'inline' }, actions));
const SVG = 'http://www.w3.org/2000/svg';

/* ======================= графики нагрузки ======================= */
export function sparkline(points, key, { color = 'var(--accent)', label }) {
  const vals = points.map((p) => p[key]).filter((v) => v != null);
  const last = vals.at(-1);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 200 44'); svg.setAttribute('preserveAspectRatio', 'none');
  if (points.length > 1) {
    const t0 = points[0].ts, t1 = points.at(-1).ts || t0 + 1;
    const xy = points.filter((p) => p[key] != null).map((p) => [((p.ts - t0) / (t1 - t0 || 1)) * 200, 42 - (Math.min(100, p[key]) / 100) * 40]);
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('points', xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
    line.setAttribute('fill', 'none'); line.setAttribute('stroke', color); line.setAttribute('stroke-width', '1.6'); line.setAttribute('vector-effect', 'non-scaling-stroke');
    const area = document.createElementNS(SVG, 'polygon');
    area.setAttribute('points', `0,44 ${xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} 200,44`);
    area.setAttribute('fill', color); area.setAttribute('opacity', '.12');
    svg.append(area, line);
  }
  return h('div', { class: 'spark' }, h('div', { class: 'spark-top' }, h('span', null, label), h('b', null, last == null ? '—' : `${Math.round(last)}%`, vals.length ? h('span', { class: 'muted' }, `  макс ${Math.round(Math.max(...vals))}%`) : null)), svg);
}

export function historyCard(panel) {
  let hours = 24;
  const body = h('div', { class: 'sparks' });
  const draw = async () => {
    try {
      const pts = await get(`/api/panels/${panel.id}/history?hours=${hours}`);
      clear(body).append(...(pts.length > 1
        ? [sparkline(pts, 'cpu', { label: 'CPU', color: 'var(--accent)' }), sparkline(pts, 'mem', { label: 'RAM', color: 'var(--ok)' }), sparkline(pts, 'disk', { label: 'Диск', color: 'var(--warn)' })]
        : [h('p', { class: 'muted' }, 'История копится — данные появятся через несколько минут работы.')]));
    } catch (e) { clear(body).append(h('p', { class: 'muted' }, e.message)); }
  };
  const seg = h('div', { class: 'seg' }, [[6, '6 ч'], [24, '24 ч'], [168, '7 дн']].map(([v, l]) => h('button', { class: v === hours ? 'on' : '', onclick: (e) => { hours = v; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); draw(); } }, l)));
  draw();
  return h('section', { class: 'card stack' }, h('div', { class: 'card-head', style: { margin: 0 } }, h('h3', null, 'Нагрузка'), seg), body);
}

/* ======================= клонирование и шаблоны ======================= */
const STEP_LABEL = (x) => x.step;
function targetFields(initial = {}) {
  const panelSel = h('select', { class: 'input' }, store.panels.map((p) => h('option', { value: p.id, selected: p.id === initial.panelId }, p.name)));
  const project = h('input', { class: 'input', placeholder: 'проект (существующий или новый)', list: 'proj-list', value: initial.project ?? '' });
  const dl = h('datalist', { id: 'proj-list' });
  const name = h('input', { class: 'input', placeholder: 'имя сервиса', value: initial.name ?? '' });
  const sync = () => { const p = panelById(panelSel.value); clear(dl).append(...(p?.tree?.projects ?? []).map((x) => h('option', { value: x.name }))); };
  panelSel.addEventListener('change', sync); sync();
  const deploy = h('input', { type: 'checkbox', checked: true });
  const el = h('div', { class: 'stack' }, field('Панель назначения', panelSel), h('div', { class: 'grid-2' }, field('Проект', project), field('Имя сервиса', name)), dl,
    h('label', { class: 'check' }, deploy, 'Сразу задеплоить'));
  return { el, value: () => ({ panelId: Number(panelSel.value), project: project.value.trim(), name: name.value.trim() }), deploy: () => deploy.checked };
}

export function cloneModal(s) {
  const t = targetFields({ panelId: s.panelId, project: s.project, name: `${s.name}-copy` });
  modal({ title: `Клонировать ${s.project}/${s.name}`, body: h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Переносятся переменные окружения, источник (образ или репозиторий) и лимиты ресурсов. Домены, порты и тома не копируются — они привязаны к серверу.'), t.el),
  actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Клонировать', kind: 'primary', onClick: async () => {
    const r = await post('/api/clone', { from: { panelId: s.panelId, type: s.type, project: s.project, name: s.name }, to: t.value(), deploy: t.deploy() });
    showResults(r.ok ? 'Клонирование завершено' : 'Клонирование с ошибками', r.steps.map((x) => ({ ...x, ok: x.ok })), STEP_LABEL);
    refresh(true, { silent: true });
  } }] });
}

export function saveTemplateModal(s) {
  const name = h('input', { class: 'input', value: `${s.name}` });
  modal({ title: 'Сохранить как шаблон', body: h('div', { class: 'stack' }, field('Название шаблона', name), h('p', { class: 'muted small' }, 'В шаблон попадут env, источник и ресурсы. Он хранится в зашифрованном виде.')),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Сохранить', kind: 'primary', onClick: async () => { await post('/api/templates', { panelId: s.panelId, type: s.type, project: s.project, name: s.name, templateName: name.value }); toast('Шаблон сохранён', 'success'); } }] });
}

export function templatesPage() {
  const box = h('div');
  const load = () => get('/api/templates').then((list) => {
    clear(box).append(list.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Шаблон', 'Тип', 'Образ / репозиторий', 'Env', 'Источник', ''].map((x) => h('th', null, x)))),
      h('tbody', null, list.map((t) => h('tr', null, h('td', null, h('b', null, t.name)), h('td', null, TYPE_LABEL[t.type] ?? t.type), h('td', { class: 'mono small' }, t.image ?? '—'), h('td', null, t.envLines), h('td', { class: 'muted small' }, t.origin ?? ''),
        h('td', { class: 'w-actions' }, can('admin') ? h('div', { class: 'inline' }, h('button', { class: 'btn sm primary', onclick: () => deployTemplate(t) }, icon('rocket', 13), 'Развернуть'),
          h('button', { class: 'btn icon ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: 'Удалить шаблон?', message: t.name, danger: true, confirmText: 'Удалить' })) { await del(`/api/templates/${t.id}`); load(); } } }, icon('trash', 14))) : null)))))) : empty('Шаблонов пока нет', 'Откройте карточку любого сервиса → «Сохранить как шаблон». Затем его можно развернуть на любой панели.'));
  });
  const deployTemplate = (t) => {
    const f = targetFields({ name: t.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-') });
    modal({ title: `Развернуть «${t.name}»`, body: f.el, actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Развернуть', kind: 'primary', onClick: async () => {
      const r = await post(`/api/templates/${t.id}/deploy`, { ...f.value(), deploy: f.deploy() });
      showResults(r.ok ? 'Готово' : 'Есть ошибки', r.steps, STEP_LABEL); refresh(true, { silent: true });
    } }] });
  };
  load();
  return h('div', { class: 'page' }, pageHead('Шаблоны'), box);
}

/* ======================= массовые изменения ======================= */
export function bulkOpModal(op) {
  const all = [...store.selection.values()];
  const targets = op === 'image' ? all.filter((t) => t.type === 'app') : all.filter((t) => t.type === 'app' || t.type === 'compose');
  if (!targets.length) return toast(op === 'image' ? 'Среди выбранных нет App-сервисов' : 'Среди выбранных нет App/Compose сервисов', 'error');
  const skipped = all.length - targets.length;
  const deploy = h('input', { type: 'checkbox', checked: true });
  let body;
  const set = h('textarea', { class: 'input mono', rows: 5, placeholder: 'NODE_ENV=production\nLOG_LEVEL=info' });
  const remove = h('input', { class: 'input mono', placeholder: 'OLD_KEY, ANOTHER_KEY' });
  const image = h('input', { class: 'input mono', placeholder: 'registry/app:1.2.3' });
  if (op === 'env') body = [field('Установить или изменить (KEY=value, по строке)', set), field('Удалить ключи (через запятую)', remove)];
  else body = [field('Новый образ', image, 'Будет применён ко всем выбранным App-сервисам')];
  modal({ title: op === 'env' ? `Изменить env: ${targets.length} сервис(ов)` : `Сменить образ: ${targets.length} сервис(ов)`,
    body: h('div', { class: 'stack' }, ...body, h('label', { class: 'check' }, deploy, 'Задеплоить после изменения'),
      skipped ? h('p', { class: 'muted small' }, `Пропущено ${skipped} несовместимых с этой операцией.`) : null,
      h('p', { class: 'muted small' }, 'Остальные переменные и комментарии в env сохраняются.')),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Применить', kind: 'primary', onClick: async () => {
      const r = await post('/api/bulk/op', { op, targets, deploy: deploy.checked, params: op === 'env' ? { set: set.value, remove: remove.value } : { image: image.value } });
      await refresh(true, { silent: true });
      showResults(`Успешно ${r.okCount}, с ошибкой ${r.failCount}`, r.results);
      if (!r.failCount) clearSelection();
    } }] });
}

export function cleanAllModal() {
  const op = h('select', { class: 'input' }, h('option', { value: 'cleanupImages' }, 'Очистить неиспользуемые образы'), h('option', { value: 'prune' }, 'Docker system prune (всё неиспользуемое)'));
  const boxes = store.panels.map((p) => ({ p, cb: h('input', { type: 'checkbox', checked: ['online', 'degraded'].includes(p.status) }) }));
  modal({ title: 'Очистка Docker на нескольких панелях', body: h('div', { class: 'stack' }, field('Операция', op), h('div', { class: 'checklist' }, boxes.map(({ p, cb }) => h('label', null, cb, panelChip(p))))),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Выполнить', kind: 'primary', onClick: async () => {
      const ids = boxes.filter((b) => b.cb.checked).map((b) => b.p.id);
      if (!ids.length) throw new Error('Выберите панели');
      if (!await confirmDialog({ title: 'Подтвердите', message: `Операция затронет ${ids.length} панел(ей).`, danger: op.value === 'prune', confirmText: 'Выполнить' })) return false;
      const r = await post('/api/bulk/system', { op: op.value, panelIds: ids });
      showResults(`Успешно ${r.okCount}, с ошибкой ${r.failCount}`, r.results, (x) => x.name ?? `панель ${x.panelId}`);
      refresh(true, { silent: true });
    } }] });
}

/* ======================= расписания ======================= */
const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const ACTION_RU = { deploy: 'Деплой', restart: 'Перезапуск', start: 'Запуск', stop: 'Остановка', cleanupImages: 'Очистка образов', prune: 'Docker prune' };
const when = (s) => (s.mode === 'interval' ? `каждые ${s.intervalMin >= 60 && s.intervalMin % 60 === 0 ? `${s.intervalMin / 60} ч` : `${s.intervalMin} мин`}` : `в ${s.time}${s.days.length ? ` (${s.days.map((d) => DAYS[d]).join(', ')})` : ' ежедневно'}`);

export function schedulesPage() {
  const box = h('div');
  const load = () => get('/api/schedules').then((list) => {
    clear(box).append(list.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, list.map((s) => {
      const n = s.target.kind === 'system' ? `${s.target.panelIds.length} панел(ей)` : `${s.target.items.length} сервис(ов)`;
      return h('div', { class: 'list-item' },
        h('div', { class: 'inline' }, can('admin') ? h('button', { class: `toggle ${s.enabled ? 'on' : ''}`, title: s.enabled ? 'Отключить' : 'Включить', 'aria-label': 'Вкл/выкл', onclick: async () => { await put(`/api/schedules/${s.id}`, { enabled: !s.enabled }); load(); } }) : null,
          h('div', null, h('b', null, s.name), h('div', { class: 'muted small' }, `${ACTION_RU[s.action] ?? s.action} · ${n} · ${when(s)}`),
            h('div', { class: 'small' }, s.lastRun ? h('span', { class: s.lastStatus === 'ок' ? 'muted' : 'danger-text' }, `Последний запуск ${relTime(s.lastRun)}: ${s.lastStatus ?? '—'}`) : h('span', { class: 'muted' }, 'Ещё не запускалось')))),
        can('admin') ? h('div', { class: 'inline' }, h('button', { class: 'btn sm', onclick: async (e) => { e.currentTarget.disabled = true; try { const r = await post(`/api/schedules/${s.id}/run`); toast(r.ok ? 'Выполнено' : `Ошибки: ${r.errors[0]}`, r.ok ? 'success' : 'error'); } catch (x) { toast(x.message, 'error'); } load(); } }, icon('play', 13), 'Запустить сейчас'),
          h('button', { class: 'btn icon ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: 'Удалить расписание?', message: s.name, danger: true, confirmText: 'Удалить' })) { await del(`/api/schedules/${s.id}`); load(); } } }, icon('trash', 14))) : null);
    }))) : empty('Расписаний пока нет', 'Например: ночной перезапуск сервисов или еженедельная очистка Docker на всех панелях.'));
  });
  load();
  return h('div', { class: 'page' }, pageHead('Расписания', can('admin') ? h('button', { class: 'btn primary', onclick: () => scheduleForm(load) }, icon('plus', 15), 'Новое расписание') : null),
    h('p', { class: 'muted' }, 'Время указывается по часовому поясу сервера EasyAdmin. Ошибки заданий приходят в уведомления.'), box);
}

function scheduleForm(onSaved) {
  const name = h('input', { class: 'input', placeholder: 'Ночной рестарт' });
  const kind = h('select', { class: 'input', onchange: sync }, h('option', { value: 'services' }, 'Сервисы'), h('option', { value: 'system' }, 'Система (очистка Docker)'));
  const action = h('select', { class: 'input' });
  const svcs = allServices().filter((s) => s.panel);
  const sBoxes = svcs.map((s) => ({ s, cb: h('input', { type: 'checkbox' }) }));
  const pBoxes = store.panels.map((p) => ({ p, cb: h('input', { type: 'checkbox' }) }));
  const filter = h('input', { class: 'input', placeholder: 'Фильтр…', oninput: () => { const q = filter.value.toLowerCase(); listEl.querySelectorAll('label').forEach((l) => { l.hidden = !!q && !l.textContent.toLowerCase().includes(q); }); } });
  const listEl = h('div', { class: 'checklist' });
  const drawList = () => {
    clear(listEl);
    if (kind.value === 'services') { let g = ''; for (const { s, cb } of sBoxes) { const key = `${s.panel.name} / ${s.project}`; if (key !== g) { g = key; listEl.append(h('div', { class: 'grp' }, g)); } listEl.append(h('label', null, cb, s.name, h('span', { class: 'muted small' }, TYPE_LABEL[s.type]))); } }
    else listEl.append(...pBoxes.map(({ p, cb }) => h('label', null, cb, panelChip(p))));
  };
  function sync() {
    clear(action).append(...(kind.value === 'services' ? [['restart', 'Перезапуск'], ['deploy', 'Деплой'], ['start', 'Запуск'], ['stop', 'Остановка']] : [['cleanupImages', 'Очистка образов'], ['prune', 'Docker system prune']]).map(([v, l]) => h('option', { value: v }, l)));
    drawList(); filter.hidden = kind.value !== 'services';
  }
  const mode = h('select', { class: 'input', onchange: () => { dailyBox.hidden = mode.value !== 'daily'; intBox.hidden = mode.value !== 'interval'; } }, h('option', { value: 'daily' }, 'Раз в день'), h('option', { value: 'interval' }, 'Через интервал'));
  const time = h('input', { class: 'input', type: 'time', value: '03:00' });
  const dayBoxes = DAYS.map((d, i) => ({ i, cb: h('input', { type: 'checkbox' }), d }));
  const dailyBox = h('div', { class: 'stack' }, field('Время (по времени сервера)', time), h('div', null, h('div', { class: 'field-label' }, 'Дни недели (пусто = ежедневно)'), h('div', { class: 'days' }, dayBoxes.map(({ cb, d }) => h('label', null, cb, d)))));
  const interval = h('input', { class: 'input', type: 'number', min: 5, value: 60 });
  const intBox = h('div', { hidden: true }, field('Интервал, минут (от 5)', interval));
  sync();
  modal({ title: 'Новое расписание', wide: true, body: h('div', { class: 'stack' }, h('div', { class: 'grid-2' }, field('Название', name), field('Что делаем', kind)), field('Действие', action), filter, listEl, h('div', { class: 'grid-2' }, field('Когда', mode), h('div')), dailyBox, intBox),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Создать', kind: 'primary', onClick: async () => {
      const target = kind.value === 'services'
        ? { kind: 'services', items: sBoxes.filter((b) => b.cb.checked).map(({ s }) => ({ panelId: s.panelId, type: s.type, project: s.project, name: s.name })) }
        : { kind: 'system', panelIds: pBoxes.filter((b) => b.cb.checked).map(({ p }) => p.id) };
      await post('/api/schedules', { name: name.value, action: action.value, mode: mode.value, time: time.value, intervalMin: interval.value, days: dayBoxes.filter((d) => d.cb.checked).map((d) => d.i), target });
      toast('Расписание создано', 'success'); onSaved();
    } }] });
}

/* ======================= инвентарь ======================= */
let invTab = 'images';
export function inventoryPage() {
  const body = h('div', { class: 'stack' });
  const seg = h('div', { class: 'seg' });
  const draw = () => {
    clear(seg).append(...[['images', 'Образы'], ['certs', 'Сертификаты']].map(([v, l]) => h('button', { class: invTab === v ? 'on' : '', onclick: () => { invTab = v; draw(); } }, l)));
    clear(body).append(h('div', { class: 'skeleton', style: { height: '140px' } }));
    (invTab === 'images' ? imagesView : certsView)(body);
  };
  draw();
  return h('div', { class: 'page' }, pageHead('Инвентарь', seg), body);
}

async function imagesView(body, force = false) {
  try {
    const items = await get(`/api/images${force ? '?force=1' : ''}`);
    const ok = items.filter((i) => i.type !== 'error');
    const groups = new Map();
    for (const i of ok) { const k = `${i.project}/${i.name}`; groups.set(k, [...(groups.get(k) ?? []), i]); }
    const diffs = [...groups.entries()].filter(([, l]) => l.length > 1 && new Set(l.map((x) => x.image ?? x.repo)).size > 1);
    const q = h('input', { class: 'input search', placeholder: 'Фильтр по сервису, образу, панели…' });
    const table = h('div');
    const drawT = () => {
      const f = q.value.toLowerCase();
      const rows = ok.filter((i) => !f || [i.project, i.name, i.image, i.repo, i.panelName].some((x) => x && x.toLowerCase().includes(f)));
      clear(table).append(rows.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Сервис', 'Панель', 'Источник'].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((i) => h('tr', null, h('td', null, h('b', null, i.name), h('span', { class: 'muted small' }, `  ${i.project}`)), h('td', null, panelChip({ name: i.panelName, color: i.color })), h('td', { class: 'mono small' }, i.image ?? i.repo ?? h('span', { class: 'muted' }, i.type))))))) : empty('Ничего не найдено'));
    };
    q.addEventListener('input', drawT); drawT();
    clear(body).append(
      h('div', { class: 'inline' }, h('div', { class: 'input-icon' }, icon('search', 15), q), h('button', { class: 'btn', onclick: () => { clear(body).append(h('div', { class: 'skeleton', style: { height: '140px' } })); imagesView(body, true); } }, icon('refresh', 14), 'Обновить')),
      diffs.length ? h('section', { class: 'card' }, h('h3', null, `Расхождения версий (${diffs.length})`), h('p', { class: 'muted small' }, 'Одноимённые сервисы с разными образами на разных панелях.'),
        diffs.map(([k, l]) => h('div', { class: 'diff-row' }, h('b', null, k), l.map((x) => h('span', { class: 'inline' }, panelChip({ name: x.panelName, color: x.color }), h('span', { class: 'tagp' }, x.image ?? x.repo)))))) : (ok.length ? h('div', { class: 'callout' }, icon('check'), 'Расхождений версий между панелями нет.') : null),
      items.filter((i) => i.type === 'error').length ? h('div', { class: 'callout warn' }, icon('alert'), `Не удалось получить данные: ${[...new Set(items.filter((i) => i.type === 'error').map((i) => `${i.panelName}: ${i.error}`))].slice(0, 3).join('; ')}`) : null, table);
  } catch (e) { clear(body).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
}

/** Перевыпуск: панель выпускает сертификаты автоматически, поэтому удаляем текущий и проверяем, что появился новый. */
async function reissueCert(p, c, reload) {
  const domain = c.domain.split(', ')[0];
  if (!await confirmDialog({ title: 'Перевыпустить сертификат?', confirmText: 'Перевыпустить', danger: true,
    message: `Сертификат ${domain} на панели «${p.panelName}» будет удалён, и панель запросит новый (Let’s Encrypt). Пока новый не выпущен, HTTPS для этого домена может быть недоступен. У Let’s Encrypt есть лимиты на выпуск — не повторяйте без необходимости.` })) return;
  toast(`Перевыпуск: ${domain}…`);
  try {
    const r = await post(`/api/panels/${p.panelId}/certs/reissue`, { domain });
    const fmt = (t) => (t ? new Date(t).toLocaleDateString(locale()) : '—');
    modal({ title: r.renewed ? 'Сертификат перевыпущен' : 'Запрос на перевыпуск отправлен',
      body: h('div', { class: 'stack' }, h('div', { class: 'card flat' }, h('div', { class: 'kv' }, h('span', null, 'Домен'), h('b', null, domain)), h('div', { class: 'kv' }, h('span', null, 'Было до'), h('b', null, fmt(r.before))), h('div', { class: 'kv' }, h('span', null, 'Стало до'), h('b', null, r.after ? fmt(r.after) : '—'))),
        r.renewed ? h('div', { class: 'callout' }, icon('check'), 'Новый сертификат уже выдан.') : h('div', { class: 'callout warn' }, icon('alert'), 'Старый сертификат удалён, но новый пока не виден. Панель может выпускать его до минуты — обновите страницу позже. Если срок не изменится, проверьте, что домен указывает на сервер и порты 80/443 открыты.')),
      actions: [{ label: 'Закрыть', kind: 'primary' }] });
    reload();
  } catch (e) { toast(e.message, 'error', 8000); }
}

async function certsView(body) {
  try {
    const data = await get('/api/certs');
    clear(body).append(...data.map((p) => h('section', { class: 'card' }, h('div', { class: 'card-head' }, panelChip({ name: p.panelName, color: p.color })),
      p.error ? h('div', { class: 'callout warn' }, icon('alert'), p.error) : p.certs.length ? h('table', { class: 'tbl' }, h('tbody', null, p.certs.sort((a, b) => (a.expiresAt ?? 9e15) - (b.expiresAt ?? 9e15)).map((c) => {
        const days = c.expiresAt ? Math.floor((c.expiresAt - Date.now()) / 86_400_000) : null;
        return h('tr', null, h('td', null, h('b', null, c.domain), c.sans?.length ? h('div', { class: 'muted small' }, c.sans.join(', ')) : null), h('td', { class: 'muted', title: c.source === 'tls' ? 'Срок получен по TLS-соединению с доменом' : null }, c.expiresAt ? new Date(c.expiresAt).toLocaleDateString(locale()) : '—'),
          h('td', { class: 'w-actions' }, days == null ? h('span', { class: 'badge muted' }, 'срок неизвестен') : h('span', { class: `badge ${days < 7 ? 'err' : days < 30 ? 'warn' : 'ok'}` }, days < 0 ? 'истёк' : `${days} дн.`)),
          can('admin') ? h('td', { class: 'w-actions' }, h('button', { class: 'btn sm', title: 'Удалить сертификат и запросить новый', onclick: () => reissueCert(p, c, () => certsView(body)) }, icon('refresh', 13), 'Перевыпустить')) : null);
      }))) : h('p', { class: 'muted' }, 'Сертификатов нет.'))));
    if (!data.length) body.append(empty('Нет панелей'));
  } catch (e) { clear(body).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
}

/* ======================= настройки: уведомления, 2FA, бэкап, вебхуки, пользователи ======================= */
export function channelsCard() {
  const box = h('div', { class: 'list' });
  let types = {};
  const load = () => get('/api/channels').then(({ channels, eventTypes }) => {
    types = eventTypes;
    clear(box).append(...(channels.length ? channels.map((c) => h('div', { class: 'list-item' },
      h('div', { class: 'inline' }, h('button', { class: `toggle ${c.enabled ? 'on' : ''}`, 'aria-label': 'Вкл/выкл', onclick: async () => { await put(`/api/channels/${c.id}`, { enabled: !c.enabled, name: c.name }); load(); } }),
        h('div', null, h('b', null, c.name), h('div', { class: 'muted small' }, `${({ telegram: 'Telegram', webhook: 'Webhook', email: 'Email' })[c.type]} · ${c.summary} · событий: ${c.events.length}`))),
      h('div', { class: 'inline' }, h('button', { class: 'btn sm', onclick: async (e) => { e.currentTarget.disabled = true; try { await post(`/api/channels/${c.id}/test`); toast('Тестовое уведомление отправлено', 'success'); } catch (x) { toast(x.message, 'error'); } e.currentTarget.disabled = false; } }, 'Тест'),
        h('button', { class: 'btn icon ghost sm', onclick: () => form(c) }, icon('edit', 14)),
        h('button', { class: 'btn icon ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: 'Удалить канал?', message: c.name, danger: true, confirmText: 'Удалить' })) { await del(`/api/channels/${c.id}`); load(); } } }, icon('trash', 14))))) : [h('p', { class: 'muted' }, 'Каналов пока нет. Добавьте Telegram или webhook, чтобы узнавать о сбоях сразу.')]));
  }).catch(() => clear(box).append(h('p', { class: 'muted' }, 'Доступно только администратору.')));
  const form = (c) => {
    const edit = !!c;
    const type = h('select', { class: 'input', disabled: edit, onchange: sync }, h('option', { value: 'telegram' }, 'Telegram'), h('option', { value: 'webhook' }, 'Webhook (JSON POST)'), h('option', { value: 'email' }, 'Email (SMTP)'));
    if (edit) type.value = c.type;
    const name = h('input', { class: 'input', value: c?.name ?? '', placeholder: 'Команда DevOps' });
    const bot = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: edit ? 'без изменений' : '123456:ABC…' });
    const chat = h('input', { class: 'input mono', placeholder: edit ? 'без изменений' : '-1001234567890' });
    const url = h('input', { class: 'input mono', placeholder: edit ? 'без изменений' : 'https://example.com/hook' });
    const secret = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: 'необязательно (заголовок X-EasyAdmin-Secret)' });
    const tg = h('div', { class: 'stack' }, field('Токен бота', bot, 'Создайте бота у @BotFather'), field('Chat ID', chat, 'Личный чат, группа или канал (бот должен быть добавлен)'));
    const wh = h('div', { class: 'stack' }, field('URL', url), field('Секрет', secret));
    const smtpHost = h('input', { class: 'input', placeholder: edit ? 'без изменений' : 'smtp.example.com' });
    const smtpPort = h('input', { class: 'input', type: 'number', placeholder: '587' });
    const smtpSec = h('select', { class: 'input' }, [['starttls', 'STARTTLS (порт 587)'], ['tls', 'SSL/TLS (порт 465)'], ['none', 'Без шифрования']].map(([v, l]) => h('option', { value: v }, l)));
    const smtpUser = h('input', { class: 'input', autocomplete: 'off', placeholder: 'логин (необязательно)' });
    const smtpPass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: edit ? 'без изменений' : 'пароль' });
    const smtpFrom = h('input', { class: 'input', placeholder: edit ? 'без изменений' : 'EasyAdmin <alerts@example.com>' });
    const smtpTo = h('input', { class: 'input', placeholder: edit ? 'без изменений' : 'ops@example.com, cto@example.com' });
    const mail = h('div', { class: 'stack' }, h('div', { class: 'grid-2' }, field('SMTP-сервер', smtpHost), field('Порт', smtpPort)), field('Шифрование', smtpSec),
      h('div', { class: 'grid-2' }, field('Логин', smtpUser), field('Пароль', smtpPass)), field('От кого', smtpFrom), field('Кому (через запятую)', smtpTo));
    const evs = Object.entries(types).map(([k, l]) => ({ k, l, cb: h('input', { type: 'checkbox', checked: edit ? c.events.includes(k) : true }) }));
    function sync() { tg.hidden = type.value !== 'telegram'; wh.hidden = type.value !== 'webhook'; mail.hidden = type.value !== 'email'; }
    sync();
    modal({ title: edit ? `Канал · ${c.name}` : 'Новый канал уведомлений', body: h('div', { class: 'stack' }, field('Тип', type), field('Название', name), tg, wh, mail, h('div', null, h('div', { class: 'field-label' }, 'События'), h('div', { class: 'checklist' }, evs.map(({ l, cb }) => h('label', null, cb, l))))),
      actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Сохранить', kind: 'primary', onClick: async () => {
        const payload = { type: type.value, name: name.value, botToken: bot.value || undefined, chatId: chat.value || undefined, url: url.value || undefined, secret: secret.value || undefined, host: smtpHost.value || undefined, port: smtpPort.value || undefined, security: type.value === 'email' ? smtpSec.value : undefined, user: smtpUser.value || undefined, pass: smtpPass.value || undefined, from: smtpFrom.value || undefined, to: smtpTo.value || undefined, events: evs.filter((x) => x.cb.checked).map((x) => x.k) };
        if (edit) await put(`/api/channels/${c.id}`, payload); else await post('/api/channels', payload);
        load();
      } }] });
  };
  const langSel = h('select', { class: 'input', style: { width: 'auto' }, onchange: async () => { try { await put('/api/settings', { notifyLang: langSel.value }); toast('Язык уведомлений сохранён', 'success'); } catch (e) { toast(e.message, 'error'); } } },
    h('option', { value: 'ru' }, 'Русский'), h('option', { value: 'en' }, 'English'));
  get('/api/settings').then((r) => { langSel.value = r.notifyLang; }).catch(() => { langSel.hidden = true; });
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Уведомления'), h('div', { class: 'inline' }, h('span', { class: 'muted small' }, 'Язык уведомлений'), langSel, h('button', { class: 'btn sm', onclick: () => form() }, icon('plus', 14), 'Добавить канал'))), box,
    h('p', { class: 'muted small', style: { marginTop: '10px' } }, 'Уведомления о падении панели приходят после двух неудачных проверок подряд. Остановки сервисов, сделанные через EasyAdmin, не считаются сбоем.'));
}

export function twoFaCard() {
  const box = h('div');
  const draw = () => {
    const on = store.user.totpEnabled;
    clear(box).append(h('div', { class: 'inline' }, h('span', { class: `badge ${on ? 'ok' : 'muted'}` }, on ? 'Включена' : 'Выключена'),
      on ? h('button', { class: 'btn sm', onclick: disable }, 'Отключить') : h('button', { class: 'btn sm primary', onclick: enable }, 'Включить 2FA')));
  };
  const enable = async () => {
    const { secret, url } = await post('/api/me/2fa/setup');
    const code = h('input', { class: 'input', inputmode: 'numeric', maxlength: 7, placeholder: '123456', autocomplete: 'one-time-code' });
    modal({ title: 'Двухфакторная аутентификация', body: h('div', { class: 'stack' },
      h('p', null, 'Добавьте ключ в приложение-аутентификатор (Google Authenticator, Aegis, 1Password и др.):'), h('div', { class: 'secret' }, secret),
      h('a', { class: 'link-row', href: url }, icon('link', 14), 'Открыть в приложении (otpauth)'), field('Код из приложения', code, 'Введите текущий 6-значный код для подтверждения')),
      actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Включить', kind: 'primary', onClick: async () => { await post('/api/me/2fa/enable', { code: code.value }); store.user.totpEnabled = true; toast('2FA включена', 'success'); draw(); } }] });
  };
  const disable = () => {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' }), code = h('input', { class: 'input', inputmode: 'numeric', maxlength: 7 });
    modal({ title: 'Отключить 2FA', body: h('div', { class: 'stack' }, field('Пароль', pw), field('Код из приложения', code)),
      actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Отключить', kind: 'danger', onClick: async () => { await post('/api/me/2fa/disable', { password: pw.value, code: code.value }); store.user.totpEnabled = false; toast('2FA отключена', 'success'); draw(); } }] });
  };
  draw();
  return h('section', { class: 'card stack' }, h('h3', null, 'Двухфакторная аутентификация'), h('p', { class: 'muted small' }, 'Код из приложения при входе. Рекомендуем включить: EasyAdmin даёт доступ ко всем вашим серверам.'), box);
}

export function backupCard() {
  const withKey = h('input', { type: 'checkbox' });
  const btn = h('button', { class: 'btn', onclick: async () => {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/backup${withKey.checked ? '?withKey=1' : ''}`, { headers: { 'X-Requested-With': 'easyadmin' } });
      if (!res.ok) throw new Error((await res.json()).error);
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: `easyadmin-backup-${new Date().toISOString().slice(0, 10)}.json` }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast('Бэкап скачан', 'success');
    } catch (e) { toast(e.message, 'error'); } btn.disabled = false;
  } }, icon('download', 14), 'Скачать бэкап');
  return h('section', { class: 'card stack' }, h('h3', null, 'Резервная копия'),
    h('p', { class: 'muted small' }, 'База EasyAdmin (панели, пользователи, журнал, шаблоны). Токены панелей зашифрованы — без ключа шифрования их не восстановить: либо храните EASYADMIN_SECRET, либо включите ключ в бэкап (тогда файл нужно беречь как секрет). Восстановление: ', h('code', null, 'node scripts/restore.js backup.json')),
    h('label', { class: 'check' }, withKey, 'Включить ключ шифрования в файл'), h('div', null, btn));
}

export function hooksCard() {
  const box = h('div', { class: 'list' });
  const load = () => get('/api/hooks').then((list) => clear(box).append(...(list.length ? list.map((x) => h('div', { class: 'list-item' },
    h('div', null, h('b', null, x.label), h('div', { class: 'muted small' }, `${ACTION_RU[x.action]} · ${x.panelName} · ${x.project}/${x.name}${x.lastUsed ? ` · вызван ${relTime(x.lastUsed)}` : ' · не вызывался'}`)),
    h('button', { class: 'btn icon ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: 'Удалить вебхук?', message: 'Ссылка перестанет работать.', danger: true, confirmText: 'Удалить' })) { await del(`/api/hooks/${x.id}`); load(); } } }, icon('trash', 14)))) : [h('p', { class: 'muted' }, 'Вебхуков нет. Создайте его в карточке сервиса → «Автоматизация».')]))).catch(() => {});
  load();
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Вебхуки для CI/CD')), box);
}

export { statusBadge };
