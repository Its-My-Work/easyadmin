import { get, put } from './api.js';
import { clear, confirmDialog, h, icon, toast } from './dom.js';
import { t } from './i18n.js';

/** Схема настроек панели с сервера (реестр полей, подсказок и опасных операций) — запрашивается один раз. */
let schemaPromise = null;
export const loadSchema = () => (schemaPromise ??= get('/api/psettings/schema').catch((e) => { schemaPromise = null; throw e; }));

/** Элемент ввода по описанию поля. Возвращает { el, get, set }. */
export function control(f, value, onInput) {
  const wrap = (input, read, write) => ({ el: input, get: read, set: write });
  const fire = () => onInput?.();
  if (f.type === 'bool') {
    const cb = h('input', { type: 'checkbox', checked: !!value, onchange: fire });
    return { el: h('label', { class: 'check psf-check' }, cb, h('span', null, t(f.label)), f.hint ? h('span', { class: 'hint' }, t(f.hint)) : null), get: () => cb.checked, set: (v) => { cb.checked = !!v; } };
  }
  const label = (input) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, t(f.label)), input, f.hint ? h('span', { class: 'hint' }, t(f.hint)) : null);
  if (f.type === 'select') {
    const sel = h('select', { class: 'input', onchange: fire }, f.options.map(([v, l]) => h('option', { value: v, selected: v === value }, t(l))));
    return { el: label(sel), get: () => sel.value, set: (v) => { sel.value = v; } };
  }
  if (f.type === 'textarea') {
    const ta = h('textarea', { class: `input ${f.mono ? 'mono' : ''}`, rows: 8, spellcheck: 'false', oninput: fire }, value ?? '');
    return { el: label(ta), get: () => ta.value, set: (v) => { ta.value = v ?? ''; } };
  }
  if (f.type === 'color') {
    const txt = h('input', { class: 'input mono', value: value ?? '', placeholder: '#6366f1', maxlength: 7, oninput: () => { if (/^#[0-9a-fA-F]{6}$/.test(txt.value)) pick.value = txt.value; fire(); } });
    const pick = h('input', { type: 'color', class: 'psf-color', value: /^#[0-9a-fA-F]{6}$/.test(value ?? '') ? value : '#6366f1', oninput: () => { txt.value = pick.value; fire(); } });
    return { el: label(h('div', { class: 'inline' }, pick, txt)), get: () => txt.value.trim(), set: (v) => { txt.value = v ?? ''; if (/^#[0-9a-fA-F]{6}$/.test(v ?? '')) pick.value = v; } };
  }
  const isNum = f.type === 'int' || f.type === 'number';
  const inp = h('input', {
    class: `input ${f.type === 'domain' ? 'mono' : ''}`, type: isNum ? 'number' : f.type === 'secret' ? 'password' : f.type === 'email' ? 'email' : 'text', value: value ?? '',
    placeholder: f.placeholder, autocomplete: f.type === 'secret' ? 'new-password' : 'off', spellcheck: 'false', min: f.min, max: isNum ? f.max : undefined, maxlength: isNum ? undefined : f.max,
    'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true', oninput: fire,
  });
  return wrap(label(inp), () => (isNum ? (inp.value === '' ? '' : Number(inp.value)) : inp.value), (v) => { inp.value = v ?? ''; });
}

/**
 * Карточка одной настройки: поля по схеме, «Сохранить» активна только при изменениях, опасные настройки — с подтверждением.
 * entry.dirty — число несохранённых карточек (чтобы страница не пересоздавалась и не стирала ввод).
 */
export function settingCard(p, def, initial, entry) {
  let saved = structuredClone(initial ?? {});
  let wasDirty = false;
  const info = saved._info ?? {};
  const inputs = def.fields.map((f) => ({ f, c: control(f, saved[f.name], () => refreshState()) }));
  const read = () => Object.fromEntries(inputs.map(({ f, c }) => [f.name, c.get()]));
  const changed = () => def.fields.some((f) => JSON.stringify(read()[f.name]) !== JSON.stringify(saved[f.name] ?? (f.type === 'bool' ? false : '')));
  const status = h('span', { class: 'small muted' });
  const saveBtn = h('button', { class: 'btn primary sm', disabled: true, onclick: () => save() }, icon('check', 13), 'Сохранить');
  const resetBtn = h('button', { class: 'btn ghost sm', hidden: true, onclick: () => { for (const { f, c } of inputs) c.set(saved[f.name] ?? (f.type === 'bool' ? false : '')); status.textContent = ''; refreshState(); } }, 'Сбросить');
  function refreshState() {
    const d = changed();
    saveBtn.disabled = !d; resetBtn.hidden = !d;
    if (d !== wasDirty) { entry.dirty += d ? 1 : -1; wasDirty = d; }
    if (d) { status.textContent = t('Есть несохранённые изменения'); status.className = 'small warn-text'; }
  }
  async function save() {
    const value = read();
    if (def.danger) {
      const ok = await confirmDialog({ title: t(def.title), message: `${t(def.hint)} ${t('Панель')}: «${p.name}».`, danger: true, confirmText: 'Сохранить', typeToConfirm: def.key === 'panelDomain' ? p.name : undefined });
      if (!ok) return;
    }
    saveBtn.disabled = true; status.textContent = t('Сохраняем…'); status.className = 'small muted';
    try {
      const r = await put(`/api/panels/${p.id}/psettings/${def.key}`, { value });
      saved = structuredClone(r.value ?? value);
      for (const { f, c } of inputs) c.set(saved[f.name] ?? (f.type === 'bool' ? false : ''));
      refreshState(); status.textContent = `✓ ${t('Сохранено')}`; status.className = 'small ok-text';
      toast(`${t(def.title)}: ${t('сохранено')}`, 'success');
    } catch (e) { status.textContent = e.message; status.className = 'small danger-text'; saveBtn.disabled = false; }
  }
  const extra = [];
  if (info.defaultPanelDomain) extra.push(h('div', { class: 'hint' }, `${t('Сгенерированный домен')}: `, h('code', null, info.defaultPanelDomain)));
  if (info.defaultServiceDomain) extra.push(h('div', { class: 'hint' }, `${t('Сгенерированный домен')}: `, h('code', null, info.defaultServiceDomain)));
  if (def.key === 'githubToken') extra.push(h('div', { class: `small ${info.hasToken ? 'ok-text' : 'muted'}` }, info.hasToken ? `● ${t('Токен сохранён')}` : t('Токен не задан')));
  const simple = inputs.every(({ f }) => f.type !== 'textarea');
  return h('div', { class: 'card psf' },
    h('div', { class: 'card-head' }, h('h4', null, t(def.title)), def.danger ? h('span', { class: 'badge warn' }, t('осторожно')) : null),
    def.hint ? h('p', { class: 'muted small psf-hint' }, t(def.hint)) : null,
    ...extra,
    h('div', { class: simple && inputs.filter(({ f }) => f.type !== 'bool').length > 1 ? 'grid-2 psf-fields' : 'stack-sm psf-fields' }, inputs.map(({ c }) => c.el)),
    h('div', { class: 'inline psf-foot' }, saveBtn, resetBtn, h('span', { class: 'spacer' }), status));
}

/** Карточки всех настроек раздела: значения читаются одним запросом, ошибки отдельных настроек показываются в своей карточке. */
export async function settingsGroup(p, section, entry) {
  const [schema, r] = await Promise.all([loadSchema(), get(`/api/panels/${p.id}/psettings?section=${section}`)]);
  return schema.settings.filter((s) => s.section === section).map((def) => (r.errors[def.key]
    ? h('div', { class: 'card psf' }, h('div', { class: 'card-head' }, h('h4', null, t(def.title))), h('div', { class: 'callout warn compact' }, icon('alert', 14), h('div', null, h('b', null, t('Не удалось прочитать настройку')), h('div', { class: 'small muted' }, r.errors[def.key]))))
    : settingCard(p, def, r.values[def.key], entry)));
}

export { clear };
