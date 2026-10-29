import { h } from './dom.js';

/** Сортировка таблиц по клику на заголовок. state = { key, dir } (dir: 1 — ▲, -1 — ▼); пустые значения (null) всегда в конце. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortRows(rows, state, getters) {
  const get = getters[state.key]; if (!get) return rows;
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return (typeof x === 'string' ? collator.compare(x, y) : x - y) * state.dir;
  });
}

/** Заголовок <th> с кнопкой сортировки; onSort() вызывается после смены state. */
export function sortTh(label, key, state, onSort, cls = '') {
  const on = state.key === key;
  return h('th', { class: `sortable ${cls}`.trim(), 'aria-sort': on ? (state.dir > 0 ? 'ascending' : 'descending') : 'none' },
    h('button', { type: 'button', class: 'th-sort', onclick: () => { state.dir = on ? -state.dir : 1; state.key = key; onSort(); } }, label, h('span', { class: 'sort-mark' }, on ? (state.dir > 0 ? ' ▲' : ' ▼') : '')));
}
