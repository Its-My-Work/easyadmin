/** Часовой пояс сервера EasyAdmin: настройка в БД, применяется к процессу целиком (расписания, копии, время в интерфейсе). */
export const validTz = (tz) => {
  if (typeof tz !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
};

/** Node пересчитывает локальное время при присвоении process.env.TZ — отдельный перезапуск не нужен. */
export function applyTimezone(tz) {
  if (!validTz(tz)) return false;
  process.env.TZ = tz;
  return true;
}

export const currentTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const getSavedTimezone = (db) => db.prepare("SELECT v FROM settings WHERE k = 'timezone'").get()?.v ?? null;
export const saveTimezone = (db, tz) => db.prepare("INSERT INTO settings (k, v) VALUES ('timezone', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(tz);
