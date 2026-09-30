import { get, post } from './api.js';
import { clear, confirmDialog, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { control, loadSchema } from './psettings-forms.js';

/* Сравнение настроек всех панелей в одной таблице и массовое применение одной настройки к выбранным панелям. */
let onlyDiff = false;

const fmt = (def, v, err) => {
  if (err) return h('span', { class: 'danger-text small', title: err }, '⚠');
  if (!v) return '—';
  const one = (f) => (f.type === 'bool' ? (v[f.name] ? '✓' : '✕') : v[f.name] === '' || v[f.name] == null ? '—' : String(v[f.name]));
  return def.fields.length === 1 ? one(def.fields[0]) : def.fields.map((f) => `${t(f.label)}: ${one(f)}`).join(' · ');
};
const plain = (def, v) => JSON.stringify(def.fields.map((f) => v?.[f.name] ?? null));

function applyModal(def, cmp, reload) {
  // значение по умолчанию — у первой панели, где оно прочиталось
  const first = cmp.panels.find((p) => p.values[def.key])?.values[def.key] ?? {};
  const inputs = def.fields.map((f) => ({ f, c: control(f, first[f.name], undefined) }));
  const picks = cmp.panels.map((p) => ({ p, locked: !!p.locks?.[def.key], cb: h('input', { type: 'checkbox', checked: ['online', 'degraded'].includes(p.status) && !p.locks?.[def.key], disabled: !!p.locks?.[def.key] }) }));
  const result = h('div', { class: 'stack-sm' });
  modal({ title: `${t('Применить ко всем')}: ${t(def.title)}`, wide: true,
    body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, def.hint ? t(def.hint) : ''), h('div', { class: 'stack-sm' }, inputs.map(({ c }) => c.el)),
      h('div', null, h('div', { class: 'field-label' }, 'Панели'), h('div', { class: 'stack-sm' }, picks.map(({ p, cb, locked }) => h('label', { class: 'check' }, cb, p.name, p.version ? h('span', { class: 'muted small' }, ` · ${p.version}`) : null, locked ? h('span', { class: 'badge warn ml' }, icon('key', 11), t('нужна лицензия')) : null)))), result),
    actions: [{ label: 'Закрыть', kind: 'ghost' }, { label: 'Применить', kind: 'primary', close: false, onClick: async () => {
      const ids = picks.filter(({ cb }) => cb.checked).map(({ p }) => p.id);
      if (!ids.length) throw new Error(t('Выберите хотя бы одну панель'));
      if (def.danger && !await confirmDialog({ title: t(def.title), message: `${t(def.hint)} ${t('Будет применено к панелям')}: ${ids.length}.`, danger: true, confirmText: 'Применить' })) return false;
      const value = Object.fromEntries(inputs.map(({ f, c }) => [f.name, c.get()]));
      const r = await post('/api/psettings/apply', { key: def.key, value, panelIds: ids });
      clear(result).append(...r.results.map((x) => h('div', { class: `small ${x.ok ? 'ok-text' : 'danger-text'}` }, `${x.ok ? '✓' : '✕'} ${x.name}${x.ok ? '' : ` — ${x.error}`}`)));
      toast(r.ok ? t('Применено ко всем выбранным панелям') : t('Часть панелей отклонила изменение'), r.ok ? 'success' : 'error', 6000);
      reload();
      return false;
    } }] });
}

export function comparePage() {
  const page = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  const draw = async () => {
    clear(body).append(h('div', { class: 'skeleton', style: { height: '180px' } }));
    try {
      const [schema, cmp] = await Promise.all([loadSchema(), get('/api/psettings/compare')]);
      const defs = cmp.keys.map((k) => schema.settings.find((s) => s.key === k)).filter(Boolean);
      // панели, которые не ответили, в сравнении не участвуют
      const rows = defs.map((def) => { const vals = cmp.panels.filter((p) => p.values[def.key]).map((p) => plain(def, p.values[def.key])); return { def, differs: new Set(vals).size > 1 }; });
      const vers = new Set(cmp.panels.map((p) => p.version).filter(Boolean));
      const diffOnly = h('input', { type: 'checkbox', checked: onlyDiff, onchange: () => { onlyDiff = diffOnly.checked; draw(); } });
      const shown = rows.filter((r) => !onlyDiff || r.differs);
      clear(body).append(
        h('div', { class: 'inline' }, h('label', { class: 'check' }, diffOnly, 'Только различия'), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, `${rows.filter((r) => r.differs).length} ${t('из')} ${rows.length} ${t('различаются')}`), h('button', { class: 'btn sm', onclick: draw }, icon('refresh', 13), 'Обновить')),
        h('div', { class: 'card flush cmp-wrap' }, h('table', { class: 'tbl cmp-tbl' },
          h('thead', null, h('tr', null, h('th', null, 'Настройка'), cmp.panels.map((p) => h('th', null, h('a', { href: `#/panel/${p.id}/settings` }, p.name))), h('th', { class: 'w-actions' }))),
          h('tbody', null,
            h('tr', { class: vers.size > 1 ? 'cmp-diff' : '' }, h('td', null, h('b', null, 'Версия Easypanel')), cmp.panels.map((p) => h('td', { class: 'mono small' }, p.version ?? '—')), h('td')),
            shown.map(({ def, differs }) => h('tr', { class: differs ? 'cmp-diff' : '' },
              h('td', null, h('b', null, t(def.title)), differs ? h('span', { class: 'badge warn ml' }, 'различается') : null),
              cmp.panels.map((p) => h('td', { class: 'small' }, p.locks?.[def.key] ? h('span', { class: 'muted', title: t('нужна лицензия') }, icon('key', 12), ' ') : null, fmt(def, p.values[def.key], p.errors[def.key]))),
              h('td', { class: 'w-actions' }, def.bulk ? h('button', { class: 'btn sm', onclick: () => applyModal(def, cmp, draw) }, 'Применить…') : null)))))),
        shown.length ? null : h('div', { class: 'muted pad' }, 'Различий нет — настройки всех панелей совпадают.'),
        h('p', { class: 'muted small' }, 'Домены, токены и другие настройки, которые у каждой панели свои, показаны только для сравнения и массово не меняются.'));
    } catch (e) { clear(body).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
  };
  page.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Сравнение настроек панелей'), h('div', { class: 'muted small' }, 'Что настроено одинаково, а что различается. Общие настройки можно применить сразу к нескольким панелям.'))), body);
  draw();
  return page;
}
