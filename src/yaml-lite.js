/**
 * Мини-разборщик YAML — ровно то подмножество, которое используют meta.yaml шаблонов Easypanel:
 * блочные словари и списки, простые/кавычные скаляры (в том числе многострочные), блочные скаляры (| и >),
 * однострочные списки [a, b]. Якорей, тегов и flow-словарей нет — на них разбор честно падает.
 * Нужен, чтобы не тянуть зависимости (проект без npm-пакетов).
 */
export class YamlError extends Error {}

const BLANK = /^\s*(#.*)?$/;

function plainScalar(s) {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^-?(0|[1-9]\d*)$/.test(t)) return Number(t);
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(t)) return Number(t);
  return t;
}

function unquoteDouble(body) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, c) => {
    if (c[0] === 'u' || c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' })[c] ?? c;
  });
}

function stripComment(s) {
  // комментарий начинается с « #» вне кавычек
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q && s[i - 1] !== '\\') q = null; } else if (ch === '"' || ch === "'") { if (i === 0 || /[\s[,]/.test(s[i - 1])) q = ch; } else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

function splitFlow(inner) {
  const out = []; let cur = ''; let q = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (q) { cur += ch; if (ch === q && inner[i - 1] !== '\\') q = null; } else if (ch === '"' || ch === "'") { q = ch; cur += ch; } else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function inlineValue(s) {
  const t = s.trim();
  if (t.startsWith('[') && t.endsWith(']')) return splitFlow(t.slice(1, -1)).map(inlineValue);
  if (/^\{\s*\}$/.test(t)) return {};
  if (t.startsWith('{')) throw new YamlError('flow-словари не поддерживаются');
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) throw new YamlError('якоря, алиасы и теги не поддерживаются');
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return unquoteDouble(t.slice(1, -1));
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return plainScalar(t);
}

export function parseYaml(text) {
  const lines = String(text).replace(/\r/g, '').replace(/\t/g, '  ').split('\n');
  let pos = 0;

  const indentOf = (l) => l.length - l.trimStart().length;
  const skip = () => { while (pos < lines.length && BLANK.test(lines[pos])) pos++; };
  const peek = () => {
    skip();
    while (pos < lines.length && /^(---|\.\.\.)\s*$/.test(lines[pos])) { pos++; skip(); }
    if (pos >= lines.length) return null;
    return { indent: indentOf(lines[pos]), text: lines[pos].trim() };
  };
  const KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s#'"[\]{},&*!|>%@`-][^:#]*?|-[^\s:][^:#]*?)\s*:(?:\s+(.*))?$/;

  function blockScalar(header, parentIndent) {
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const folded = header[0] === '>';
    const body = [];
    let blockIndent = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.trim() === '') { body.push(''); pos++; continue; }
      const ind = indentOf(l);
      if (ind <= parentIndent) break;
      blockIndent ??= ind;
      if (ind < blockIndent) break;
      body.push(l.slice(blockIndent)); pos++;
    }
    let trailing = 0; while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
    let out;
    if (!folded) out = body.join('\n');
    else {
      out = ''; let prevBlank = false;
      body.forEach((ln, i) => {
        if (i === 0) out = ln;
        else if (ln === '') { out += '\n'; prevBlank = true; } else if (prevBlank) { out += ln; prevBlank = false; } else out += ` ${ln}`;
      });
    }
    if (chomp === 'clip') return out === '' ? '' : `${out}\n`;
    if (chomp === 'keep') return `${out}${'\n'.repeat(trailing + 1)}`;
    return out;
  }

  // скаляр, который может продолжаться на следующих строках (простой — сворачивается, кавычный — до закрывающей кавычки)
  function scalarFrom(first, parentIndent) {
    const t = first.trim();
    if (t.startsWith('"') || t.startsWith("'")) {
      const q = t[0];
      let acc = t;
      const closed = (s) => { let i = 1; while (i < s.length) { if (s[i] === '\\' && q === '"') { i += 2; continue; } if (s[i] === q) { if (q === "'" && s[i + 1] === "'") { i += 2; continue; } return i; } i++; } return -1; };
      while (closed(acc) < 0 && pos < lines.length) { acc += ` ${lines[pos].trim()}`; pos++; }
      const end = closed(acc);
      if (end < 0) throw new YamlError('незакрытая кавычка');
      return inlineValue(acc.slice(0, end + 1));
    }
    if (t.startsWith('[') && !t.includes(']')) {
      let acc = t;
      while (!acc.includes(']') && pos < lines.length) { acc += ` ${lines[pos].trim()}`; pos++; }
      return inlineValue(stripComment(acc));
    }
    let acc = stripComment(t);
    while (pos < lines.length) {
      const l = lines[pos];
      if (BLANK.test(l)) { // пустая строка внутри простого скаляра — перевод строки, если дальше идёт продолжение
        let k = pos; while (k < lines.length && BLANK.test(lines[k])) k++;
        if (k < lines.length && indentOf(lines[k]) > parentIndent && !/^\s*#/.test(l)) { acc += '\n'; pos = k; continue; }
        break;
      }
      if (indentOf(l) <= parentIndent) break;
      acc += (acc.endsWith('\n') ? '' : ' ') + stripComment(l.trim()); pos++;
    }
    return inlineValue(acc);
  }

  function parseNode(minIndent) {
    const p = peek();
    if (!p || p.indent < minIndent) return null;
    if (p.text === '-' || p.text.startsWith('- ')) return parseSeq(p.indent);
    if (KEY.test(p.text)) return parseMap(p.indent);
    pos++;
    return scalarFrom(p.text, p.indent - 1);
  }

  function parseMap(indent) {
    const map = {};
    for (;;) {
      const p = peek();
      if (!p || p.indent !== indent) break;
      const m = KEY.exec(p.text);
      if (!m) throw new YamlError(`строка ${pos + 1}: ожидался «ключ: значение»`);
      let key = m[1];
      if (key[0] === '"') key = unquoteDouble(key.slice(1, -1)); else if (key[0] === "'") key = key.slice(1, -1);
      pos++;
      const rest = m[2] === undefined ? '' : stripComment(m[2]);
      let value;
      if (rest === '') {
        const nx = peek();
        if (nx && (nx.indent > indent || (nx.indent === indent && (nx.text === '-' || nx.text.startsWith('- '))))) value = parseNode(nx.indent);
        else value = null;
      } else if (/^[|>][-+0-9]*$/.test(rest)) value = blockScalar(rest, indent);
      else value = scalarFrom(m[2], indent);
      Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return map;
  }

  function parseSeq(indent) {
    const arr = [];
    for (;;) {
      const p = peek();
      if (!p || p.indent !== indent || !(p.text === '-' || p.text.startsWith('- '))) break;
      const after = p.text === '-' ? '' : p.text.slice(2).trimStart();
      const offset = p.text === '-' ? 2 : p.text.length - after.length;
      if (after === '' || after.startsWith('#')) { pos++; const nx = peek(); arr.push(nx && nx.indent > indent ? parseNode(nx.indent) : null); continue; }
      if (KEY.test(after) && !after.startsWith('[') && !/^["'].*["']$/.test(after)) { // «- key: value» — словарь с ключами на колонке offset
        lines[pos] = ' '.repeat(indent + offset) + after;
        arr.push(parseMap(indent + offset));
        continue;
      }
      pos++;
      if (/^[|>][-+0-9]*$/.test(after)) arr.push(blockScalar(after, indent)); else arr.push(scalarFrom(after, indent));
    }
    return arr;
  }

  const result = parseNode(0);
  const rest = peek();
  if (rest) throw new YamlError(`строка ${pos + 1}: неожиданное содержимое`);
  return result;
}
