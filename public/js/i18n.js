import { translate } from './i18n-dict.js';

const KEY = 'ea-lang';
export const AVAILABLE_LANGS = [
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'zh', label: '简体中文', flag: '🇨🇳' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'pt', label: 'Português', flag: '🇵🇹' },
];
const LANGS = AVAILABLE_LANGS.map((x) => x.code);

function detect() {
  try { const s = localStorage.getItem(KEY); if (LANGS.includes(s)) return s; } catch { /* нет localStorage */ }
  const n = (navigator.language || 'ru').toLowerCase();
  if (n.startsWith('ru')) return 'ru';
  if (n.startsWith('zh')) return 'zh';
  if (n.startsWith('de')) return 'de';
  if (n.startsWith('es')) return 'es';
  if (n.startsWith('pt')) return 'pt';
  return 'en';
}

export const lang = detect();
export const t = (s) => (lang === 'ru' ? s : translate(s, lang));
export const locale = () => {
  switch (lang) {
    case 'en': return 'en-GB';
    case 'zh': return 'zh-CN';
    case 'de': return 'de-DE';
    case 'es': return 'es-ES';
    case 'pt': return 'pt-BR';
    default: return 'ru-RU';
  }
};

/** Меняет язык интерфейса и перезагружает страницу (все тексты строятся заново). */
export function setLang(l) {
  if (!LANGS.includes(l) || l === lang) return;
  try { localStorage.setItem(KEY, l); } catch { /* приватный режим */ }
  location.reload();
}

document.documentElement.lang = lang;

/**
 * Мультиязычный режим: русские строки переводятся при вставке в DOM, поэтому сообщения сервера,
 * подписи, плейсхолдеры и т. п. переводятся единообразно без правки каждого места вызова.
 */
if (lang !== 'ru') {
  const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  Object.defineProperty(Node.prototype, 'textContent', { ...desc, set(v) { desc.set.call(this, typeof v === 'string' ? translate(v, lang) : v); } });
  for (const m of ['append', 'prepend', 'replaceChildren']) {
    const orig = Element.prototype[m];
    Element.prototype[m] = function patched(...nodes) { return orig.apply(this, nodes.map((n) => (typeof n === 'string' ? translate(n, lang) : n))); };
  }
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patched(name, value) {
    return setAttr.call(this, name, ['placeholder', 'title', 'aria-label', 'alt'].includes(name) && typeof value === 'string' ? translate(value, lang) : value);
  };
  if (document.title) document.title = translate(document.title, lang);
}
