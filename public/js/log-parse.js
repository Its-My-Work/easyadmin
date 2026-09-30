/** Разбор строки `docker compose logs`: «n8n-app-1  | текст» → { tag: 'n8n-app-1', text }. Строки без префикса остаются как есть. */
const PREFIX = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,62}-\d+)\s+\|\s?([\s\S]*)$/;

export function parseLogLine(line) {
  const m = PREFIX.exec(line);
  return m ? { tag: m[1], text: m[2] } : { tag: null, text: line };
}

/** Стабильный номер цвета 0..7 для имени контейнера — у одного контейнера всегда один цвет. */
export function tagHue(tag) {
  let n = 0;
  for (let i = 0; i < tag.length; i++) n = (n * 31 + tag.charCodeAt(i)) >>> 0;
  return n % 8;
}
