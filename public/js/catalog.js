import { get, post } from './api.js';
import { clear, field, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { can, refresh, store } from './store.js';

/* Каталог шаблонов Easypanel: карточки, поиск, теги, форма шаблона и развёртывание на выбранной панели. */
const PAGE = 48;
let data = null; // { items, tags, fetchedAt }
const view = { q: '', tag: '', shown: PAGE };

const logoEl = (it, size = 44) => {
  const box = h('span', { class: 'cat-logo', style: { width: `${size}px`, height: `${size}px` } });
  const letter = () => { box.textContent = (it.name || '?')[0].toUpperCase(); };
  if (!it.logo) { letter(); return box; }
  const img = h('img', { src: `/api/catalog/logo/${encodeURIComponent(it.slug)}`, alt: '', loading: 'lazy', onerror: () => { img.remove(); letter(); } });
  box.append(img);
  return box;
};

export function catalogView(box) {
  const grid = h('div', { class: 'cat-grid' });
  const more = h('div', { class: 'cat-more' });
  const count = h('span', { class: 'muted small' });
  const q = h('input', { class: 'input search', placeholder: 'Поиск по названию, описанию, тегам…', value: view.q, oninput: () => { view.q = q.value; view.shown = PAGE; draw(); } });
  const tagSel = h('select', { class: 'input cat-tag', 'aria-label': 'Тег', onchange: (e) => { view.tag = e.target.value; view.shown = PAGE; draw(); } });
  const reload = h('button', { class: 'btn icon', title: 'Обновить каталог', 'aria-label': 'Обновить каталог', onclick: () => load(true) }, icon('refresh', 15));
  const bar = h('div', { class: 'filters cat-bar' }, h('div', { class: 'input-icon' }, icon('search', 15), q), tagSel, can('admin') ? reload : null);
  const body = h('div', { class: 'stack' }, bar, count, grid, more);
  clear(box).append(body);

  function draw() {
    if (!data) return;
    const qn = view.q.trim().toLowerCase();
    const list = data.items.filter((it) => (!view.tag || it.tags.includes(view.tag)) && (!qn || [it.name, it.slug, it.description, ...it.tags].some((x) => String(x).toLowerCase().includes(qn))));
    clear(tagSel).append(h('option', { value: '' }, `${t('Все теги')} (${data.tags.length})`), ...data.tags.map((x) => h('option', { value: x.name, selected: x.name === view.tag }, `${x.name} · ${x.count}`)));
    count.textContent = `${t('Найдено')}: ${list.length} ${t('из')} ${data.items.length}`;
    clear(grid).append(...list.slice(0, view.shown).map((it) => h('button', { class: 'cat-card', type: 'button', onclick: () => openTemplate(it.slug) },
      logoEl(it), h('div', { class: 'cat-body' }, h('b', null, it.name), h('p', { class: 'muted small clamp' }, it.description),
        it.tags.length ? h('div', { class: 'cat-tags' }, it.tags.slice(0, 3).map((x) => h('span', { class: 'chip' }, x))) : null))));
    if (!list.length) grid.append(h('div', { class: 'muted pad' }, 'Ничего не найдено'));
    clear(more).append(list.length > view.shown ? h('button', { class: 'btn', onclick: () => { view.shown += PAGE; draw(); } }, `${t('Показать ещё')} (${list.length - view.shown})`) : null);
  }

  async function load(force = false) {
    if (force || !data) clear(grid).append(...[1, 2, 3, 4, 5, 6].map(() => h('div', { class: 'skeleton', style: { height: '110px' } })));
    try {
      data = await get(`/api/catalog${force ? '?refresh=1' : ''}`);
      draw();
    } catch (e) {
      clear(grid); clear(more); count.textContent = '';
      grid.append(h('div', { class: 'callout err', style: { gridColumn: '1 / -1' } }, icon('alert'), h('div', null, h('b', null, 'Каталог недоступен'), h('p', null, e.message),
        h('button', { class: 'btn sm', onclick: () => load(true) }, 'Повторить'))));
    }
  }
  if (data) draw(); else load();
}

/* ---- карточка шаблона ---- */
async function openTemplate(slug) {
  let d;
  try { d = await get(`/api/catalog/${encodeURIComponent(slug)}`); } catch (e) { return toast(e.message, 'error', 7000); }
  const reachable = store.panels.filter((x) => ['online', 'degraded'].includes(x.status));
  const panelSel = h('select', { class: 'input', onchange: syncProjects }, reachable.map((x) => h('option', { value: x.id }, x.name)));
  const proj = h('input', { class: 'input', placeholder: 'my-project', list: 'cat-projects', autocomplete: 'off' });
  const dl = h('datalist', { id: 'cat-projects' });
  function syncProjects() {
    const p = store.panels.find((x) => String(x.id) === String(panelSel.value));
    const names = (p?.tree?.projects ?? []).map((x) => x.name);
    clear(dl).append(...names.map((n) => h('option', { value: n })));
    if (!proj.value || !names.includes(proj.value)) proj.value = names.includes('main') ? 'main' : (names[0] ?? 'main');
  }

  // поля формы: тип → элемент; showIf прячет зависимые поля
  const controls = new Map(); const wrappers = new Map();
  const val = (name) => { const c = controls.get(name); return c ? (c.type === 'checkbox' ? c.checked : c.value) : undefined; };
  const fieldEls = d.fields.map((f) => {
    let el;
    if (f.type === 'boolean') el = h('input', { type: 'checkbox', checked: f.default === true });
    else if (f.options) el = h('select', { class: 'input' }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.default }, o.label)));
    else if (f.type === 'number' || f.type === 'integer') el = h('input', { class: 'input', type: 'number', step: f.type === 'integer' ? 1 : 'any', min: f.min ?? undefined, max: f.max ?? undefined, value: f.default ?? '' });
    else el = h('input', { class: 'input', type: f.secret ? 'password' : 'text', value: f.default ?? '', autocomplete: 'off', 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true', placeholder: f.required && (f.default == null || f.default === '') ? 'обязательное поле' : '' });
    el.addEventListener('input', applyShowIf); el.addEventListener('change', applyShowIf);
    controls.set(f.name, el);
    const label = `${f.title}${f.required ? ' *' : ''}`;
    const wrap = f.type === 'boolean' ? h('label', { class: 'check' }, el, label) : field(label, el, f.description ?? undefined);
    wrappers.set(f.name, wrap);
    return wrap;
  });
  function applyShowIf() { for (const f of d.fields) if (f.showIf) wrappers.get(f.name).hidden = String(val(f.showIf.field)) !== String(f.showIf.is); }
  const values = () => Object.fromEntries(d.fields.map((f) => [f.name, val(f.name)]));

  const head = h('div', { class: 'cat-head' }, logoEl(d, 56), h('div', null, h('h3', null, d.name), d.tags.length ? h('div', { class: 'cat-tags' }, d.tags.map((x) => h('span', { class: 'chip' }, x))) : null));
  const body = h('div', { class: 'stack' }, head, h('p', { class: 'cat-desc' }, d.description),
    d.links.length ? h('div', { class: 'inline' }, d.links.map((l) => h('a', { class: 'link-row', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label, icon('external', 12)))) : null,
    d.instructions ? h('div', { class: 'callout' }, icon('check'), h('div', null, h('b', null, 'После установки'), h('p', { class: 'muted small' }, d.instructions))) : null,
    !d.supported ? h('div', { class: 'callout warn' }, icon('alert'), h('div', null, h('b', null, 'Этот шаблон нельзя развернуть отсюда'), h('p', null, d.reason), h('p', { class: 'muted small' }, 'Разверните его в самой панели: Проект → Шаблоны.'))) : null,
    d.supported && can('admin') ? h('div', { class: 'stack' },
      h('div', { class: 'grid-2' }, field('Панель', panelSel), h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Проект')), proj, dl)),
      d.fields.length ? h('div', { class: 'more-plain stack' }, h('h4', null, 'Параметры'), ...fieldEls) : null) : null);
  if (d.supported && can('admin')) { if (!reachable.length) return toast('Нет доступных панелей', 'error'); syncProjects(); applyShowIf(); }

  const actions = [{ label: 'Закрыть', kind: 'ghost' }];
  if (d.supported && can('admin')) {
    actions.push({ label: 'Показать схему', onClick: async () => {
      const r = await post(`/api/catalog/${encodeURIComponent(d.slug)}/schema`, { values: values() });
      const text = JSON.stringify(r.schema, null, 2);
      modal({ title: `${d.name}: схема Easypanel`, wide: true, body: h('pre', { class: 'code' }, text), actions: [{ label: 'Закрыть', kind: 'ghost' },
        { label: 'Копировать', kind: 'primary', onClick: async () => { try { await navigator.clipboard.writeText(text); toast('Скопировано', 'success'); } catch { toast('Выделите текст и скопируйте вручную', 'error'); } return false; } }] });
      return false;
    } });
    actions.push({ label: 'Развернуть', kind: 'primary', onClick: async () => {
      if (!proj.value.trim()) throw new Error('Укажите проект');
      const r = await post(`/api/panels/${panelSel.value}/catalog/${encodeURIComponent(d.slug)}/deploy`, { project: proj.value.trim(), values: values() });
      toast(`${d.name}: ${t('развёрнуто сервисов')} ${r.services}`, 'success', 6000);
      refresh(true, { silent: true });
    } });
  }
  modal({ title: 'Шаблон Easypanel', wide: true, body, actions });
}
