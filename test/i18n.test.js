import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { EN, translate } from '../public/js/i18n-dict.js';

const CY = /[А-Яа-яЁё]/;
const root = path.join(import.meta.dirname, '..');

/** Достаёт строковые литералы с кириллицей из JS (пропуская комментарии); ${…} → {0}, {1}… */
function literals(src) {
  const out = []; let i = 0; const n = src.length;
  const readStr = (i, q) => {
    let buf = ''; let ph = 0; i++;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { buf += src.slice(i, i + 2); i += 2; continue; }
      if (q === '`' && c === '$' && src[i + 1] === '{') {
        let depth = 1, j = i + 2;
        while (j < n && depth) {
          if (src[j] === '{') depth++; else if (src[j] === '}') depth--;
          else if ('\'"`'.includes(src[j])) { j = readStr(j, src[j]).next; continue; }
          j++;
        }
        buf += `{${ph++}}`; i = j; continue;
      }
      if (c === q) return { text: buf, next: i + 1 };
      buf += c; i++;
    }
    return { text: buf, next: i };
  };
  // «/» начинает регулярное выражение, если перед ним оператор, скобка или return/typeof (а не идентификатор/число/закрывающая скобка)
  const regexAllowed = (at) => {
    let k = at - 1; while (k >= 0 && /[ \t]/.test(src[k])) k--;
    if (k < 0 || '(,=:[!&|?{};\n+-*%<>~^'.includes(src[k])) return true;
    const word = /(\w+)$/.exec(src.slice(Math.max(0, k - 9), k + 1))?.[1];
    return ['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'yield'].includes(word);
  };
  const skipRegex = (at) => {
    let k = at + 1; let cls = false;
    while (k < n) {
      const ch = src[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '\n') break;
      if (cls) { if (ch === ']') cls = false; } else if (ch === '[') cls = true; else if (ch === '/') { k++; break; }
      k++;
    }
    while (k < n && /[a-z]/.test(src[k])) k++;
    return k;
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; }
    else if (c === '/' && src[i + 1] === '*') i = src.indexOf('*/', i + 2) + 2;
    else if (c === '/' && regexAllowed(i)) i = skipRegex(i);
    else if ('\'"`'.includes(c)) { const r = readStr(i, c); i = r.next; if (CY.test(r.text)) out.push(r.text); }
    else i++;
  }
  return out;
}
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');

// намеренно не переводятся: названия языков и двуязычная подсказка
const SKIP = new Set(['Русский', 'Language / Язык']);

describe('локализация', () => {
  test('каждая русская строка интерфейса и сервера есть в словаре', () => {
    const files = [
      ...fs.readdirSync(path.join(root, 'public/js')).filter((f) => f.endsWith('.js') && !['i18n-dict.js', 'theme.js'].includes(f)).map((f) => `public/js/${f}`),
      ...fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
    ];
    const missing = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/'\/g/g, '/Q/g');
      for (const raw of literals(src)) {
        const lit = unescape(raw);
        if (SKIP.has(lit)) continue;
        const sample = lit.replace(/\{\d+\}/g, '1');
        if (translate(sample) === sample) missing.push(`${f}: ${JSON.stringify(lit)}`);
      }
    }
    assert.deepEqual(missing, [], `нет перевода для:\n${missing.join('\n')}`);
  });

  test('словарь согласован: одинаковые подстановки, нет русского в английских значениях, нет конфликтов', () => {
    const seen = new Map();
    for (const [ru, en] of EN) {
      const ph = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
      assert.equal(ph(ru), ph(en), `подстановки не совпадают: ${ru} → ${en}`);
      assert.ok(!CY.test(en), `в английском значении осталась кириллица: ${en}`);
      const k = ru.trim();
      if (seen.has(k)) assert.equal(seen.get(k), en.trim(), `конфликт переводов для «${k}»`);
      seen.set(k, en.trim());
    }
  });

  test('translate: точные строки, шаблоны, вложенные подстановки, пробелы, чужие данные', () => {
    assert.equal(translate('Деплой'), 'Deploy');
    assert.equal(translate(' — ок'), ' — ok');
    assert.equal(translate('Панель «Прод» недоступна: Соединение отклонено'), 'Panel “Прод” is unavailable: Connection refused');
    assert.equal(translate('Массово: Деплой'), 'Bulk: Deploy');
    assert.equal(translate('Ошибок: 2 — Панель удалена'), 'Errors: 2 — Panel deleted');
    assert.equal(translate('5 мин назад'), '5 min ago');
    assert.equal(translate('Client Acme'), 'Client Acme');
    assert.equal(translate('Неизвестная русская фраза'), 'Неизвестная русская фраза');
    assert.equal(translate(42), 42);
  });
});
