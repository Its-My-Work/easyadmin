import { locale } from './i18n.js';

/* Время сервера EasyAdmin: часовой пояс выбирается в Настройках → «Время сервера». Все метки времени показываем в нём. */
const state = { offset: 0, tz: null };

export const setServerTime = ({ now, tz }) => { state.offset = now - Date.now(); state.tz = tz || state.tz; };
export const serverNow = () => Date.now() + state.offset;
export const serverTz = () => state.tz;

const safeTz = () => { try { if (state.tz) { new Intl.DateTimeFormat('en', { timeZone: state.tz }); return state.tz; } } catch { /* неизвестная зона — берём пояс браузера */ } return undefined; };

/** Дата и время в поясе сервера; opts — параметры Intl.DateTimeFormat. */
export const fmtServer = (ts, opts) => new Intl.DateTimeFormat(locale(), { timeZone: safeTz(), ...opts }).format(ts);

/** Смещение пояса вида «UTC+03:00» на момент ts. */
export function tzOffset(tz, ts = Date.now()) {
  try {
    const part = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(ts).find((x) => x.type === 'timeZoneName')?.value ?? '';
    return part === 'GMT' ? 'UTC' : part.replace('GMT', 'UTC');
  } catch { return ''; }
}
