import { h } from './dom.js';
import { locale } from './i18n.js';

/** Область-график на SVG: несколько рядов (в стопке или отдельно), подсказка по наведению, без зависимостей. */
const SVG = 'http://www.w3.org/2000/svg';
const W = 640, H = 150;
const el = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const clock = (ts, long) => new Date(ts).toLocaleString(locale(), long ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

/** series: [{ key, label, color }]; stacked — ряды складываются; fmt — формат значения; max — потолок оси (иначе по данным). */
export function areaChart({ points, series, stacked = false, max, fmt = (v) => String(v), height = H, range }) {
  const wrap = h('div', { class: 'chart' });
  const legend = h('div', { class: 'chart-legend' }, series.map((s) => h('span', null, h('i', { style: { background: s.color } }), s.label)));
  if (!points.length) return h('div', { class: 'chart-wrap' }, h('div', { class: 'chart-empty muted small' }, 'Данных пока нет — график начнёт строиться через несколько минут.'));
  const total = (p) => (stacked ? series.reduce((a, s) => a + (p[s.key] ?? 0), 0) : Math.max(...series.map((s) => p[s.key] ?? 0)));
  const top = max ?? Math.max(1, ...points.map(total)) * 1.1;
  const t0 = points[0].t, t1 = points.at(-1).t; const span = t1 - t0 || 1;
  const x = (p) => (points.length === 1 ? W / 2 : ((p.t - t0) / span) * W);
  const y = (v) => height - 2 - (Math.min(v, top) / top) * (height - 6);
  const svg = el('svg', { viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', class: 'chart-svg', role: 'img' });
  for (const f of [0.25, 0.5, 0.75]) svg.append(el('line', { x1: 0, x2: W, y1: height * f, y2: height * f, class: 'chart-grid' }));
  const base = points.map(() => 0);
  series.forEach((s) => {
    const lows = stacked ? [...base] : points.map(() => 0);
    const highs = points.map((p, i) => (stacked ? base[i] : 0) + (p[s.key] ?? 0));
    if (stacked) highs.forEach((v, i) => { base[i] = v; });
    const up = points.map((p, i) => `${x(p).toFixed(1)},${y(highs[i]).toFixed(1)}`);
    const down = points.map((p, i) => `${x(p).toFixed(1)},${y(lows[i]).toFixed(1)}`).reverse();
    svg.append(el('polygon', { points: [...up, ...down].join(' '), fill: s.color, opacity: stacked ? '.85' : '.18' }));
    if (!stacked) svg.append(el('polyline', { points: up.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' }));
  });
  const cursor = el('line', { x1: 0, x2: 0, y1: 0, y2: height, class: 'chart-cursor', visibility: 'hidden' });
  svg.append(cursor);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const move = (ev) => {
    const r = svg.getBoundingClientRect(); const fx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const target = t0 + fx * span; let best = points[0];
    for (const p of points) if (Math.abs(p.t - target) < Math.abs(best.t - target)) best = p;
    cursor.setAttribute('x1', x(best)); cursor.setAttribute('x2', x(best)); cursor.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.style.left = `${Math.min(Math.max((x(best) / W) * 100, 12), 88)}%`;
    tip.replaceChildren(h('b', null, clock(best.t, span > 86400e3)), ...series.map((s) => h('div', null, h('i', { style: { background: s.color } }), `${s.label}: `, h('b', null, best[s.key] == null ? '—' : fmt(best[s.key])))));
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); });
  const mid = fmt(top / 2), hi = fmt(top);
  wrap.append(svg, tip, h('span', { class: 'chart-y hi' }, hi), h('span', { class: 'chart-y mid' }, mid),
    h('div', { class: 'chart-x' }, h('span', null, clock(t0, span > 86400e3)), h('span', null, clock(t1, span > 86400e3))));
  void range;
  return h('div', { class: 'chart-wrap' }, wrap, legend);
}

export const fmtPct = (v) => `${Math.round(v * 10) / 10}%`;
export function fmtBytes(v) {
  if (v == null) return '—';
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(1)} ГБ`;
  if (v >= 1048576) return `${Math.round(v / 1048576)} МБ`;
  return `${Math.round(v / 1024)} КБ`;
}
export const fmtRate = (v) => (v == null ? '—' : v >= 1048576 ? `${(v / 1048576).toFixed(1)} МБ/с` : `${Math.round(v / 1024)} КБ/с`);
