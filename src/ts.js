/**
 * Время из ответа панели → миллисекунды. Строка без пояса («2026-10-01 22:19:50», «…T22:19:50») — это UTC: иначе Date.parse прочитает её
 * в поясе процесса EasyAdmin (он задаётся в «Настройки → Время сервера») и время уедет на смещение пояса.
 */
export function parseTs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim(); const naive = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(s);
  const n = Date.parse(naive ? `${s.replace(' ', 'T')}${s.length > 10 ? '' : 'T00:00:00'}Z` : s);
  return Number.isFinite(n) ? n : null;
}
