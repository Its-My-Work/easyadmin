import { post } from './api.js';
import { h } from './dom.js';
import { t } from './i18n.js';

/**
 * Полноценный терминал (xterm.js): посимвольный ввод, стрелки, Tab, Ctrl+…, вставка нескольких строк, nano/vim/htop.
 * Сам xterm — в public/vendor (без CDN: CSP разрешает только свои скрипты). Экземпляр хранится в переданном объекте `keep`
 * и переносится между перерисовками страницы, поэтому вывод и сеанс не пропадают при навигации.
 */
let lib = null;
const addTag = (tag, attrs) => new Promise((resolve, reject) => { const el = document.createElement(tag); Object.assign(el, attrs); el.onload = resolve; el.onerror = () => reject(new Error('Не удалось загрузить терминал')); document.head.append(el); });
const loadLib = () => (lib ??= Promise.all([
  addTag('link', { rel: 'stylesheet', href: '/vendor/xterm.css' }),
  addTag('script', { src: '/vendor/xterm.js' }).then(() => addTag('script', { src: '/vendor/addon-fit.js' })),
]).catch((e) => { lib = null; throw e; }));

const THEME = { background: '#0b0e14', foreground: '#d6deeb', cursor: '#7c83ff', selectionBackground: '#3b4261' };
const CHUNK = 8000; // сервер принимает ввод до 16 КБ за раз

/** Создаёт (или возвращает сохранённый) терминал. keep: { xt, fit, host, sink, onSize } — состояние, живущее дольше страницы. */
export async function ensureTerminal(keep) {
  await loadLib();
  if (keep.xt) return keep;
  keep.xt = new window.Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scrollback: 5000, theme: THEME, allowProposedApi: true });
  keep.fit = new window.FitAddon.FitAddon();
  keep.xt.loadAddon(keep.fit);
  keep.host = h('div', { class: 'xterm-host' });
  keep.xt.open(keep.host);
  keep.xt.onData((d) => keep.sink?.(d));
  keep.xt.onResize(({ cols, rows }) => keep.onSize?.(cols, rows));
  return keep;
}

/** Ввод идёт по порядку и пачками: пока уходит предыдущий запрос, новые нажатия копятся и отправляются одним. */
export function inputQueue(term, onError) {
  let buf = ''; let busy = false;
  const pump = async () => {
    if (busy) return; busy = true;
    while (buf) {
      const part = buf.slice(0, CHUNK); buf = buf.slice(CHUNK);
      const r = await term.send(part);
      if (r !== true) { buf = ''; if (typeof r === 'string') onError?.(r); }
    }
    busy = false;
  };
  return (d) => { buf += d; pump(); };
}

/** Размер терминала → панели (формат {"resize":[колонки, строки]}). */
export const sendSize = (cid, cols, rows) => post(`/api/console/${cid}/resize`, { cols, rows }).catch(() => {});

/** Текст буфера терминала (для скачивания). */
export function bufferText(xt) {
  const b = xt.buffer.active; const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  while (out.length && !out.at(-1)) out.pop();
  return out.join('\n');
}

/** Контейнер для терминала: подставляет xterm-элемент и подгоняет размер под блок. */
export function mountTerminal(keep) {
  const wrap = h('div', { class: 'xterm-wrap', onclick: () => keep.xt.focus() });
  wrap.append(keep.host);
  const fit = () => { if (wrap.isConnected && wrap.clientWidth > 40) { try { keep.fit.fit(); } catch { /* ещё не показан */ } } };
  const ro = new ResizeObserver(fit); ro.observe(wrap);
  requestAnimationFrame(fit);
  const hint = h('div', { class: 'xterm-hint small muted' }, t('Нажмите на терминал и печатайте как в обычной консоли: работают Tab, стрелки, Ctrl+C, nano, vim, вставка нескольких строк.'));
  return { el: h('div', { class: 'stack-sm' }, wrap, hint), fit, stop: () => ro.disconnect() };
}
