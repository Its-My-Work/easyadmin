import { translate } from './i18n-dict.js';

const KEY = 'ea-lang';
const LANGS = ['ru', 'en'];

function detect() {
  try { const s = localStorage.getItem(KEY); if (LANGS.includes(s)) return s; } catch { /* нет localStorage */ }
  return (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export const lang = detect();
export const t = (s) => (lang === 'en' ? translate(s) : s);
export const locale = () => (lang === 'en' ? 'en-GB' : 'ru-RU');

/** Меняет язык интерфейса и перезагружает страницу (все тексты строятся заново). */
export function setLang(l) {
  if (!LANGS.includes(l) || l === lang) return;
  try { localStorage.setItem(KEY, l); } catch { /* приватный режим */ }
  location.reload();
}

document.documentElement.lang = lang;

/**
 * Английский режим: русские строки переводятся при вставке в DOM, поэтому сообщения сервера,
 * подписи, плейсхолдеры и т. п. переводятся единообразно без правки каждого места вызова.
 */
if (lang === 'en') {
  const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  Object.defineProperty(Node.prototype, 'textContent', { ...desc, set(v) { desc.set.call(this, typeof v === 'string' ? translate(v) : v); } });
  for (const m of ['append', 'prepend', 'replaceChildren']) {
    const orig = Element.prototype[m];
    Element.prototype[m] = function patched(...nodes) { return orig.apply(this, nodes.map((n) => (typeof n === 'string' ? translate(n) : n))); };
  }
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patched(name, value) {
    return setAttr.call(this, name, ['placeholder', 'title', 'aria-label', 'alt'].includes(name) && typeof value === 'string' ? translate(value) : value);
  };
  if (document.title) document.title = translate(document.title);
}
