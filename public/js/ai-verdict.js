// Чистая функция без DOM: общая логика разбора ответа AI (используется окном AI Doctor и тестами).
/** Делит текст на разделы WHAT / CAUSE / FIX / ACTION (так же, как сервер) — работает и на неполном тексте. */
export function splitVerdict(text) {
  const out = { what: '', cause: '', fix: '', action: 'none' };
  const parts = String(text ?? '').split(/^\s*#{1,3}\s*(WHAT|CAUSE|FIX|ACTION)\b[^\n]*$/gim);
  for (let i = 1; i < parts.length; i += 2) {
    const k = parts[i].toLowerCase(); const body = (parts[i + 1] ?? '').trim();
    if (k === 'action') { const w = /\b(restart|start)\b/i.exec(body)?.[1]?.toLowerCase(); out.action = w ?? 'none'; } else out[k] = body;
  }
  if (!parts[1] && text) out.what = String(text).trim();
  return out;
}
