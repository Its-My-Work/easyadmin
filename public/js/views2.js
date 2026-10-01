import { del, get, post, put } from './api.js';
import { catalogView } from './catalog.js';
import { empty, panelChip, showResults, statusBadge, clearSelection, typeChip } from './components.js';
import { clear, confirmDialog, field, fmtTime, h, icon, modal, relTime, toast } from './dom.js';
import { locale, t } from './i18n.js';
import { TYPE_LABEL, allServices, can, isDb, panelById, refresh, store } from './store.js';

const pageHead = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'inline' }, actions));

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

let tplLoad = null;
let tplTab = 'mine';
export function templatesPage() {
  const box = h('div');
  const load = () => get('/api/templates').then((list) => {
    clear(box).append(list.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Шаблон', 'Тип', 'Образ / репозиторий', 'Env', 'Источник', ''].map((x) => h('th', null, x)))),
      h('tbody', null, list.map((t) => h('tr', null, h('td', null, h('b', null, t.name)), h('td', null, TYPE_LABEL[t.type] ?? t.type), h('td', { class: 'mono small' }, t.image ?? '—'), h('td', null, t.envLines), h('td', { class: 'muted small' }, t.origin ?? ''),
        h('td', { class: 'w-actions' }, can('admin') ? h('div', { class: 'inline' }, h('button', { class: 'btn sm primary', onclick: () => deployTemplate(t) }, icon('rocket', 13), 'Развернуть'),
          h('a', { class: 'btn icon ghost sm', href: `/api/templates/${t.id}/schema`, download: '', title: 'Скачать как схему Easypanel (Create from JSON)', 'aria-label': 'Скачать схему' }, icon('download', 14)),
          h('button', { class: 'btn icon ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: 'Удалить шаблон?', message: t.name, danger: true, confirmText: 'Удалить' })) { await del(`/api/templates/${t.id}`); load(); } } }, icon('trash', 14))) : null)))))) : empty('Шаблонов пока нет', 'Нажмите «Создать шаблон» и отметьте действующие сервисы — или откройте карточку сервиса → «Сохранить как шаблон». Затем шаблон можно развернуть на любой панели.'));
  });
  const deployTemplate = (t) => {
    const f = targetFields({ name: t.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-') });
    modal({ title: `Развернуть «${t.name}»`, body: f.el, actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Развернуть', kind: 'primary', onClick: async () => {
      const r = await post(`/api/templates/${t.id}/deploy`, { ...f.value(), deploy: f.deploy() });
      showResults(r.ok ? 'Готово' : 'Есть ошибки', r.steps, STEP_LABEL); refresh(true, { silent: true });
    } }] });
  };
  tplLoad = load; // форма — в модалке и может пережить пересборку страницы
  load();
  const mine = h('div', null, box);
  const cat = h('div');
  const actions = can('admin') ? h('div', { class: 'inline' }, h('button', { class: 'btn', onclick: importSchemaModal }, icon('upload', 15), 'Импорт схемы Easypanel'), h('button', { class: 'btn primary', onclick: () => createTemplateModal(() => tplLoad?.()) }, icon('plus', 15), 'Создать шаблон')) : null;
  const seg = h('div', { class: 'seg' });
  const show = () => {
    clear(seg).append(...[['mine', 'Мои шаблоны'], ['catalog', 'Каталог Easypanel']].map(([id, label]) => h('button', { type: 'button', class: `seg-btn ${tplTab === id ? 'active' : ''}`, onclick: () => { tplTab = id; show(); } }, label)));
    mine.hidden = tplTab !== 'mine'; cat.hidden = tplTab !== 'catalog'; if (actions) actions.hidden = tplTab !== 'mine';
    if (tplTab === 'catalog' && !cat.childElementCount) catalogView(cat);
  };
  show();
  return h('div', { class: 'page' }, pageHead('Шаблоны', actions), seg, mine, cat);
}

/** Разворачивание схемы шаблона Easypanel ({services:[{type,data}]}) — то же, что «Create from JSON» в панели. */
function importSchemaModal() {
  const reachable = store.panels.filter((x) => ['online', 'degraded'].includes(x.status));
  if (!reachable.length) return toast('Нет доступных панелей', 'error');
  const panelSel = h('select', { class: 'input', onchange: syncProjects }, reachable.map((x) => h('option', { value: x.id }, x.name)));
  const proj = h('input', { class: 'input', placeholder: 'my-project', list: 'imp-projects', autocomplete: 'off' });
  const dl = h('datalist', { id: 'imp-projects' });
  const text = h('textarea', { class: 'input mono', rows: 12, spellcheck: 'false', placeholder: '{\n  "services": [\n    { "type": "app", "data": { "serviceName": "web", "source": { "type": "image", "image": "nginx:latest" } } }\n  ]\n}' });
  const file = h('input', { type: 'file', accept: '.json,application/json', class: 'input' });
  const preview = h('div', { class: 'muted small' });
  const TYPES = ['app', 'compose', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
  const parse = () => {
    const raw = text.value.trim(); if (!raw) return { empty: true };
    let sc; try { sc = JSON.parse(raw); } catch (e) { return { error: `Некорректный JSON: ${e.message}` }; }
    if (!sc || !Array.isArray(sc.services) || !sc.services.length) return { error: 'В схеме нет списка services' };
    const bad = sc.services.find((x) => !x || !TYPES.includes(x.type) || typeof x.data?.serviceName !== 'string');
    if (bad) return { error: 'У каждого сервиса нужны type (app, compose, postgres…) и data.serviceName' };
    return { schema: sc };
  };
  function showPreview() {
    const r = parse();
    clear(preview);
    if (r.empty) return;
    if (r.error) return preview.append(h('span', { class: 'danger-text' }, r.error));
    preview.append(h('b', null, `Сервисов в схеме: ${r.schema.services.length}`), h('ul', { class: 'result-list' }, r.schema.services.map((x) => h('li', null, typeChip(x.type), h('b', null, x.data.serviceName), x.data.source?.image ? h('span', { class: 'muted small mono' }, x.data.source.image) : null))));
  }
  function syncProjects() {
    const p = panelById(panelSel.value);
    clear(dl).append(...(p?.tree?.projects ?? []).map((x) => h('option', { value: x.name })));
  }
  text.addEventListener('input', showPreview);
  file.addEventListener('change', async () => { const f = file.files[0]; if (!f) return; if (f.size > 1_000_000) return toast('Файл слишком большой', 'error'); text.value = await f.text(); showPreview(); });
  syncProjects();
  modal({ title: 'Импорт схемы шаблона Easypanel', wide: true, body: h('div', { class: 'stack' },
    h('div', { class: 'grid-2' }, field('Панель', panelSel), h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Проект')), proj, dl)),
    field('Схема (JSON)', text, 'Тот же формат, что у «Create from JSON» в Easypanel и у шаблонов из github.com/easypanel-io/templates (результат generate). Значения вида $(PROJECT_NAME) подставит сама панель.'),
    field('…или файл', file), preview),
  actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Развернуть', kind: 'primary', onClick: async () => {
    const r = parse();
    if (r.empty) throw new Error('Вставьте схему или выберите файл');
    if (r.error) throw new Error(r.error);
    if (!proj.value.trim()) throw new Error('Укажите проект');
    const res = await post(`/api/panels/${panelSel.value}/templates/import`, { project: proj.value.trim(), schema: r.schema });
    toast(`Развёрнуто сервисов: ${res.services}`, 'success'); refresh(true, { silent: true });
  } }] });
}

/** Создание шаблонов прямо на странице «Шаблоны»: отмечаем действующие сервисы (любых панелей) — по одному шаблону на сервис. */
function createTemplateModal(onSaved) {
  const svcs = allServices().filter((s) => s.panel && ['app', 'compose', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis'].includes(s.type));
  if (!svcs.length) return toast('Нет сервисов, из которых можно создать шаблон', 'error');
  const boxes = svcs.map((s) => ({ s, cb: h('input', { type: 'checkbox' }) }));
  const filter = h('input', { class: 'input search', placeholder: 'Фильтр по сервису, проекту, панели…' });
  const name = h('input', { class: 'input', placeholder: 'название шаблона' });
  const nameF = field('Название шаблона', name, 'Если отмечен один сервис — можно задать своё название, иначе шаблоны назовутся по сервисам.');
  const count = h('span', { class: 'muted small' });
  const rows = boxes.map(({ s, cb }) => h('label', { class: 'pick-row' }, cb, panelChip(s.panel), h('b', null, s.name), h('span', { class: 'muted small' }, s.project), h('span', { class: 'spacer' }), typeChip(s.type)));
  const sync = () => {
    const n = boxes.filter((b) => b.cb.checked).length;
    count.textContent = n ? `Выбрано: ${n}` : 'Отметьте сервисы';
    nameF.hidden = n !== 1;
    if (n === 1 && !name.value) name.value = boxes.find((b) => b.cb.checked).s.name;
  };
  boxes.forEach(({ cb }) => cb.addEventListener('change', sync));
  filter.addEventListener('input', () => { const q = filter.value.trim().toLowerCase(); boxes.forEach(({ s }, i) => { rows[i].hidden = !!q && ![s.name, s.project, s.panel.name, s.type].some((x) => String(x).toLowerCase().includes(q)); }); });
  sync();
  modal({ title: 'Создать шаблон из сервисов', wide: true, body: h('div', { class: 'stack' }, filter, h('div', { class: 'pick-list' }, ...rows), count, nameF),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Создать', kind: 'primary', onClick: async () => {
      const chosen = boxes.filter((b) => b.cb.checked).map((b) => b.s);
      if (!chosen.length) throw new Error('Отметьте хотя бы один сервис');
      const results = [];
      for (const s of chosen) {
        try { await post('/api/templates', { panelId: s.panelId, type: s.type, project: s.project, name: s.name, templateName: chosen.length === 1 && name.value.trim() ? name.value.trim() : s.name }); results.push({ ok: true, project: s.project, name: s.name }); }
        catch (e) { results.push({ ok: false, project: s.project, name: s.name, error: e.message }); }
      }
      onSaved();
      const bad = results.filter((r) => !r.ok);
      if (bad.length) showResults(`Создано ${results.length - bad.length}, с ошибкой ${bad.length}`, results); else toast(`Шаблонов создано: ${results.length}`, 'success');
    } }] });
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
  const HINTS = { cleanupImages: 'Безопасно для работающих сервисов: удаляются только образы, которые не использует ни один контейнер. Образы остановленных сервисов и для отката придётся скачать или собрать заново — следующий деплой будет дольше.',
    prune: 'Агрессивнее: удаляет остановленные контейнеры, неиспользуемые сети и образы. Работающие сервисы не затрагиваются, но всё, что сейчас остановлено вручную или вне панели, исчезнет. Точный набор (в том числе тома) определяет панель — перед запуском убедитесь, что нужные данные лежат в томах работающих сервисов.' };
  const hint = h('div', { class: 'callout warn compact' }, icon('alert', 14), '');
  const syncHint = () => { hint.lastChild.textContent = t(HINTS[op.value]); hint.className = `callout compact ${op.value === 'prune' ? 'err' : 'warn'}`; };
  op.addEventListener('change', syncHint); syncHint();
  modal({ title: 'Очистка Docker на нескольких панелях', body: h('div', { class: 'stack' }, field('Операция', op), hint, h('div', { class: 'checklist' }, boxes.map(({ p, cb }) => h('label', null, cb, panelChip(p))))),
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
const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']; // индекс = getDay(): 0 — воскресенье
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // порядок показа: неделя начинается с понедельника
const ACTION_RU = { deploy: 'Деплой', restart: 'Перезапуск', start: 'Запуск', stop: 'Остановка', cleanupImages: 'Очистка образов', prune: 'Docker prune' };
const when = (s) => (s.mode === 'interval' ? `каждые ${s.intervalMin >= 60 && s.intervalMin % 60 === 0 ? `${s.intervalMin / 60} ч` : `${s.intervalMin} мин`}` : `в ${s.time}${s.days.length ? ` (${[...s.days].sort((a, b) => WEEK.indexOf(a) - WEEK.indexOf(b)).map((d) => DAYS[d]).join(', ')})` : ' ежедневно'}`);

let schedLoad = null;
export function schedulesPage() {
  const box = h('div');
  const load = () => get('/api/schedules').then((list) => {
    clear(box).append(list.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, list.map((s) => {
      const n = s.target.kind === 'system' ? `${s.target.panelIds.length} панел(ей)` : `${s.target.items.length} сервис(ов)`;
      return h('div', { class: 'list-item' },
        h('div', { class: 'inline' }, can('admin') ? h('button', { class: `toggle ${s.enabled ? 'on' : ''}`, title: s.enabled ? 'Отключить' : 'Включить', 'aria-label': 'Вкл/выкл', onclick: async () => { await put(`/api/schedules/${s.id}`, { enabled: !s.enabled }); load(); } }) : null,
          h('div', null, h('b', null, s.name), h('div', { class: 'muted small' }, `${ACTION_RU[s.action] ?? s.action} · ${n} · ${when(s)}`),
            h('div', { class: 'small' }, s.running ? h('span', { class: 'muted' }, 'Выполняется…') : s.lastRun ? h('span', { class: s.lastStatus === 'ок' ? 'muted' : 'danger-text' }, `Последний запуск ${relTime(s.lastRun)}: ${s.lastStatus ?? '—'}`) : h('span', { class: 'muted' }, 'Ещё не запускалось')))),
        can('admin') ? h('div', { class: 'inline' }, h('button', { class: 'btn sm', onclick: async (e) => { e.currentTarget.disabled = true; try { const r = await post(`/api/schedules/${s.id}/run`); toast(r.ok ? 'Выполнено' : `Ошибки: ${r.errors[0]}`, r.ok ? 'success' : 'error'); } catch (x) { toast(x.message, 'error'); } load(); } }, icon('play', 13), 'Запустить сейчас'),
          h('button', { class: 'btn icon ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: 'Удалить расписание?', message: s.name, danger: true, confirmText: 'Удалить' })) { await del(`/api/schedules/${s.id}`); load(); } } }, icon('trash', 14))) : null);
    }))) : empty('Расписаний пока нет', 'Например: ночной перезапуск сервисов или еженедельная очистка Docker на всех панелях.'));
  });
  schedLoad = load; // форма живёт в модалке и может пережить пересборку страницы — обновляем актуальный список
  load();
  return h('div', { class: 'page' }, pageHead('Расписания', can('admin') ? h('button', { class: 'btn primary', onclick: () => scheduleForm(() => schedLoad?.()) }, icon('plus', 15), 'Новое расписание') : null),
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
  const dayBoxes = WEEK.map((i) => ({ i, cb: h('input', { type: 'checkbox' }), d: DAYS[i] }));
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
      clear(table).append(rows.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Сервис', 'Тип', 'Панель', 'Источник'].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((i) => h('tr', null, h('td', null, h('b', null, i.name), h('span', { class: 'muted small' }, `  ${i.project}`)), h('td', null, i.kind ? typeChip(i.kind) : null), h('td', null, panelChip({ name: i.panelName, color: i.color })), h('td', { class: 'mono small', title: i.repoUrl ?? '' }, i.image ?? i.repo ?? h('span', { class: 'muted' }, i.type))))))) : empty('Ничего не найдено'));
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
        r.renewed ? h('div', { class: 'callout' }, icon('check'), 'Новый сертификат уже выдан.') : !r.resaved ? h('div', { class: 'callout warn' }, icon('alert'), `Сертификат удалён, но домен не найден среди сервисов${r.resaveError ? ` (${r.resaveError})` : ''} — выпуск не запущен. Откройте сервис → «Домены» → изменить → сохранить, либо нажмите «Деплой».`) : h('div', { class: 'callout warn' }, icon('alert'), 'Старый сертификат удалён, но новый пока не виден. Панель может выпускать его до минуты — обновите страницу позже. Если срок не изменится, проверьте, что домен указывает на сервер и порты 80/443 открыты.')),
      actions: [{ label: 'Закрыть', kind: 'primary' }] });
    reload();
  } catch (e) { toast(e.message, 'error', 8000); }
}

/** Удаление без запроса нового: например, сертификат домена, которого больше нет. */
async function deleteCert(p, c, reload) {
  const domain = c.domain.split(', ')[0];
  if (!await confirmDialog({ title: 'Удалить сертификат?', confirmText: 'Удалить', danger: true,
    message: `Сертификат ${domain} на панели «${p.panelName}» будет удалён. Если домен всё ещё привязан к сервису, HTTPS для него перестанет работать, пока панель не выпустит новый.` })) return;
  try { await post(`/api/panels/${p.panelId}/certs/delete`, { domain }); toast(`Сертификат удалён: ${domain}`, 'success'); reload(); } catch (e) { toast(e.message, 'error', 8000); }
}

async function certsView(body) {
  try {
    const data = await get('/api/certs');
    clear(body).append(...data.map((p) => h('section', { class: 'card' }, h('div', { class: 'card-head' }, panelChip({ name: p.panelName, color: p.color })),
      p.error ? h('div', { class: 'callout warn' }, icon('alert'), p.error) : p.certs.length ? h('table', { class: 'tbl' }, h('tbody', null, p.certs.sort((a, b) => (a.expiresAt ?? 9e15) - (b.expiresAt ?? 9e15)).map((c) => {
        const days = c.expiresAt ? Math.floor((c.expiresAt - Date.now()) / 86_400_000) : null;
        return h('tr', null, h('td', null, h('b', null, c.domain), c.sans?.length ? h('div', { class: 'muted small' }, c.sans.join(', ')) : null), h('td', { class: 'muted', title: c.source === 'tls' ? 'Срок получен по TLS-соединению с доменом' : null }, c.expiresAt ? new Date(c.expiresAt).toLocaleDateString(locale()) : '—'),
          h('td', { class: 'w-actions' }, days == null ? h('span', { class: 'badge muted' }, 'срок неизвестен') : h('span', { class: `badge ${days < 7 ? 'err' : days < 30 ? 'warn' : 'ok'}` }, days < 0 ? 'истёк' : `${days} дн.`)),
          can('admin') ? h('td', { class: 'w-actions' }, h('div', { class: 'inline nowrap' },
            h('button', { class: 'btn icon sm', title: 'Перевыпустить: удалить сертификат и запросить новый', 'aria-label': 'Перевыпустить', onclick: () => reissueCert(p, c, () => certsView(body)) }, icon('refresh', 14)),
            h('button', { class: 'btn icon sm danger-text', title: 'Удалить сертификат', 'aria-label': 'Удалить сертификат', onclick: () => deleteCert(p, c, () => certsView(body)) }, icon('trash', 14)))) : null);
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
  load(); // список каналов и перечень событий для формы (без этого вызова «События» в окне создания были пустыми)
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


export function hooksCard() {
  const box = h('div', { class: 'list' });
  const load = () => get('/api/hooks').then((list) => clear(box).append(...(list.length ? list.map((x) => h('div', { class: 'list-item' },
    h('div', null, h('b', null, x.label), h('div', { class: 'muted small' }, `${ACTION_RU[x.action]} · ${x.panelName} · ${x.project}/${x.name}${x.lastUsed ? ` · вызван ${relTime(x.lastUsed)}` : ' · не вызывался'}`)),
    h('button', { class: 'btn icon ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: 'Удалить вебхук?', message: 'Ссылка перестанет работать.', danger: true, confirmText: 'Удалить' })) { await del(`/api/hooks/${x.id}`); load(); } } }, icon('trash', 14)))) : [h('p', { class: 'muted' }, 'Вебхуков нет. Создайте его в карточке сервиса → «Автоматизация».')]))).catch(() => {});
  load();
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Вебхуки для CI/CD')), box);
}

export { statusBadge };
