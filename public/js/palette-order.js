/**
 * Порядок и поиск в палитре команд (Ctrl+K). Чистые функции — без DOM, покрыты тестами.
 *
 * Пустой запрос — разделы в фиксированном порядке:
 *   Избранные → Недавние (свежие выше) → Панели → Страницы (как в меню) → Команды → Остальные сервисы (панель / проект / имя).
 * Есть запрос — единый список по релевантности: точное совпадение имени > начало имени > начало слова >
 * вхождение > домен/панель/проект > нечёткое совпадение; при равенстве: избранное, недавние, панели, страницы, команды, сервисы.
 */
export const GROUP_ORDER = ['fav', 'recent', 'panel', 'page', 'cmd', 'service'];
export const GROUP_LABEL = { fav: 'Избранные', recent: 'Недавние', panel: 'Панели', page: 'Страницы', cmd: 'Команды', service: 'Сервисы' };
const EMPTY_LIMIT = { service: 40, recent: 8 };
const RESULT_LIMIT = 40;

const norm = (s) => String(s ?? '').toLowerCase().replace(/\u0451/g, '\u0435');
const words = (s) => norm(s).split(/[^a-zа-я0-9]+/).filter(Boolean);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Символы токена встречаются в строке по порядку («nkg» → «kilo-gateway»)? */
function subsequence(token, text) {
  let i = 0;
  for (const ch of text) if (ch === token[i] && ++i === token.length) return true;
  return false;
}

/** Оценка одного токена запроса для элемента; 0 — не подходит. */
function tokenScore(token, titles, extra, hint) {
  let best = 0;
  for (const title of titles) {
    if (title === token) best = Math.max(best, 100);
    else if (title.startsWith(token)) best = Math.max(best, 80);
    else if (words(title).some((w) => w.startsWith(token))) best = Math.max(best, 60);
    else if (title.includes(token)) best = Math.max(best, 40);
    else if (token.length >= 3 && subsequence(token, title)) best = Math.max(best, 8);
  }
  if (extra.includes(token)) best = Math.max(best, 25);
  if (hint.includes(token)) best = Math.max(best, 15);
  return best;
}

/**
 * @param items  [{ title, shown?, hint?, extra?, group: 'fav'|'recent'|'panel'|'page'|'cmd'|'service', order? , recentIndex? }]
 *               shown — заголовок в текущем языке (ищем и по нему, и по исходному); order — порядок внутри раздела
 * @returns      [{ section?: 'fav'…, item }] — section есть у первого элемента каждого раздела при пустом запросе
 */
export function orderItems(items, query) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    const out = [];
    for (const g of GROUP_ORDER) {
      let part = items.filter((x) => x.group === g);
      if (g === 'recent') part.sort((a, b) => (a.recentIndex ?? 99) - (b.recentIndex ?? 99));
      else if (g === 'fav' || g === 'service') part.sort((a, b) => collator.compare(a.sortKey ?? a.title, b.sortKey ?? b.title));
      else part.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      part = part.slice(0, EMPTY_LIMIT[g] ?? part.length);
      part.forEach((item, i) => out.push(i === 0 ? { section: g, item } : { item }));
    }
    return out;
  }
  const scored = [];
  for (const item of items) {
    const titles = [...new Set([norm(item.shown ?? item.title), norm(item.title)])];
    const extra = norm(item.extra), hint = norm(`${item.hint ?? ''} ${item.hintShown ?? ''}`);
    let total = 0, ok = true;
    for (const t of tokens) { const s = tokenScore(t, titles, extra, hint); if (!s) { ok = false; break; } total += s; }
    if (!ok) continue;
    if (item.group === 'fav') total += 12; else if (item.group === 'recent') total += Math.max(2, 8 - (item.recentIndex ?? 0));
    scored.push({ item, total });
  }
  scored.sort((a, b) => b.total - a.total
    || GROUP_ORDER.indexOf(a.item.group) - GROUP_ORDER.indexOf(b.item.group)
    || collator.compare(a.item.shown ?? a.item.title, b.item.shown ?? b.item.title));
  return scored.slice(0, RESULT_LIMIT).map(({ item }) => ({ item }));
}

/** Разбивает заголовок на части для подсветки первого подходящего токена: [{ text, match }]. */
export function highlight(title, query) {
  const t = String(title);
  const low = norm(t);
  for (const token of norm(query).split(/\s+/).filter(Boolean)) {
    const i = low.indexOf(token);
    if (i >= 0) return [{ text: t.slice(0, i) }, { text: t.slice(i, i + token.length), match: true }, { text: t.slice(i + token.length) }].filter((p) => p.text);
  }
  return [{ text: t }];
}
