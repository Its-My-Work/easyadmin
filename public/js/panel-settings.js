import { get, post } from './api.js';
import { clear, confirmDialog, field, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';

/* Настройки самой панели Easypanel: процедуры ищутся в интерфейсе панели (settings.*, branding.*, users.* …).
   Чтение безопасно. Запись отправляет JSON процедуре панели как есть — формат данных проверяет сама панель. */
const SECRET = /pass|secret|token|key|credential|private/i;
const mask = (v, reveal) => {
  if (reveal) return v;
  if (Array.isArray(v)) return v.map((x) => mask(x, reveal));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) && typeof x === 'string' && x ? '••••••' : mask(x, reveal)]));
  return v;
};
const call = (p, kind, procedure, input) => post(`/api/panels/${p.id}/trpc`, { kind, procedure, input }).then((r) => r.result);

function showResult(p, proc, result) {
  let reveal = false;
  const pre = h('pre', { class: 'code' });
  const hasSecrets = JSON.stringify(result ?? null).match(/"[^"]*(pass|secret|token|key|credential|private)[^"]*":/i);
  const cb = h('input', { type: 'checkbox', onchange: () => { reveal = cb.checked; draw(); } });
  const draw = () => { pre.textContent = JSON.stringify(mask(result, reveal), null, 2) ?? 'null'; };
  draw();
  modal({ title: proc, wide: true, body: h('div', { class: 'stack' }, hasSecrets ? h('label', { class: 'check' }, cb, 'Показать секреты') : null, pre),
    actions: [{ label: 'Закрыть', kind: 'ghost' }, { label: 'Копировать', kind: 'primary', onClick: async () => { try { await navigator.clipboard.writeText(JSON.stringify(mask(result, reveal), null, 2)); toast('Скопировано', 'success'); } catch { toast('Выделите текст и скопируйте вручную', 'error'); } return false; } }] });
}

async function editModal(p, item, reload) {
  let current = null;
  if (item.getter) { try { current = await call(p, 'query', item.getter); } catch { /* формат придётся ввести вручную */ } }
  const text = h('textarea', { class: 'input mono', rows: 12, spellcheck: 'false' }, current != null ? JSON.stringify(current, null, 2) : '{}');
  const err = h('div', { class: 'danger-text small' });
  const valid = () => { try { return { value: JSON.parse(text.value || '{}') }; } catch (e) { return { error: e.message }; } };
  text.addEventListener('input', () => { err.textContent = valid().error ? `${t('Некорректный JSON')}: ${valid().error}` : ''; });
  modal({ title: item.name, wide: true, body: h('div', { class: 'stack' },
    h('div', { class: 'callout compact' }, icon('alert', 14), h('span', { class: 'small' }, current != null ? `${t('Текущие значения получены из')} ${item.getter}. ${t('Формат данных проверяет сама панель: при ошибке она вернёт причину.')}` : 'Формат данных неизвестен — панель проверит JSON и вернёт причину, если он неверный. Подсказку можно получить, вызвав связанную процедуру чтения.')),
    field('Данные (JSON)', text), err),
  actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Отправить в панель', kind: 'primary', onClick: async () => {
    const v = valid(); if (v.error) throw new Error(`${t('Некорректный JSON')}: ${v.error}`);
    const ok = await confirmDialog({ title: `${item.name}?`, message: `Панель «${p.name}» получит эти данные. Это изменит настройки панели.`, danger: item.danger, confirmText: 'Отправить', typeToConfirm: item.danger ? item.name.split('.')[1] : undefined });
    if (!ok) return false;
    const r = await call(p, 'mutation', item.name, v.value);
    toast(`${item.name}: ${t('выполнено')}`, 'success');
    if (r != null && typeof r === 'object') showResult(p, `${item.name} → ${t('ответ панели')}`, r);
    reload();
  } }] });
}

export function settingsTab(p) {
  const box = h('div', { class: 'stack' });
  const q = h('input', { class: 'input search', placeholder: 'Фильтр по названию процедуры…' });
  const list = h('div', { class: 'stack' });
  let items = [];
  const draw = () => {
    const f = q.value.trim().toLowerCase();
    const groups = new Map();
    for (const it of items.filter((x) => !f || x.name.toLowerCase().includes(f))) { if (!groups.has(it.ns)) groups.set(it.ns, []); groups.get(it.ns).push(it); }
    clear(list).append(...(groups.size ? [...groups].map(([ns, arr]) => h('details', { class: 'card flat set-group', open: !!f || ns === 'settings' },
      h('summary', null, h('h4', null, ns), h('span', { class: 'muted small' }, `${arr.length}`)),
      h('div', { class: 'list' }, arr.map((it) => h('div', { class: 'list-item' },
        h('div', null, h('b', { class: 'mono' }, it.name.split('.')[1]), h('div', { class: 'muted small' }, it.kind === 'read' ? 'чтение' : it.danger ? 'изменение · осторожно' : 'изменение')),
        h('div', { class: 'inline' },
          it.kind === 'read'
            ? h('button', { class: 'btn sm', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { showResult(p, it.name, await call(p, 'query', it.name)); } catch (er) { toast(`${it.name}: ${er.message}`, 'error', 8000); } finally { b.disabled = false; } } }, icon('eye', 13), 'Прочитать')
            : h('button', { class: `btn sm ${it.danger ? 'danger-text' : ''}`, onclick: () => editModal(p, it, draw) }, icon('edit', 13), 'Изменить…')))))))
      : [h('div', { class: 'muted pad' }, 'Ничего не найдено')]));
  };
  q.addEventListener('input', draw);
  clear(box).append(h('div', { class: 'skeleton', style: { height: '120px' } }));
  get(`/api/panels/${p.id}/settings/procedures`).then((r) => {
    items = r.items;
    clear(box).append(
      h('div', { class: 'callout compact' }, icon('activity', 14), h('div', { class: 'small' }, `${t('Список составлен по интерфейсу вашей панели')} (${r.discovered} ${t('процедур найдено')}). ${t('Чтение безопасно. Запись отправляет JSON процедуре панели как есть — формат данных проверяет сама панель, а действия пишутся в журнал.')}`)),
      q, list);
    draw();
  }).catch((e) => clear(box).append(h('div', { class: 'callout err' }, icon('alert'), e.message)));
  return box;
}
