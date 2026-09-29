import { SYSTEM_OPS, runAction } from './easypanel.js';

const pad = (n) => String(n).padStart(2, '0');

/** Пора ли запускать задание (сервер работает по локальному времени процесса — переменная TZ). */
export function isDue(s, now = new Date()) {
  const last = s.last_run ?? 0;
  if (s.mode === 'interval') return now.getTime() - last >= (s.interval_min || 60) * 60_000;
  if (s.mode === 'daily') {
    if (`${pad(now.getHours())}:${pad(now.getMinutes())}` !== s.time) return false;
    const days = s.days ? s.days.split(',').map(Number) : [];
    if (days.length && !days.includes(now.getDay())) return false;
    return now.getTime() - last > 90_000;
  }
  return false;
}

export function createScheduler({ db, manager, alerts, audit, tickMs = 30_000 }) {
  let timer;
  const row = (id) => db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);

  async function run(s) {
    const target = JSON.parse(s.target);
    const ctx = { user: { username: `расписание: ${s.name}` } };
    const errors = [];
    const exec = async (panelId, label, fn, action) => {
      const p = manager.getRow(panelId);
      if (!p) { errors.push(`${label}: панель удалена`); return; }
      try { alerts.expect(panelId, label); await fn(manager.clientFor(p)); audit(ctx, { action: `schedule.${action}`, panel: p, target: label }); }
      catch (e) { errors.push(`${label}: ${e.message}`); audit(ctx, { action: `schedule.${action}`, panel: p, target: label, ok: false, detail: e.message }); }
      finally { manager.invalidate(panelId); }
    };
    if (target.kind === 'system') {
      for (const id of target.panelIds ?? []) await exec(id, manager.getRow(id)?.name ?? String(id), (c) => SYSTEM_OPS[s.action](c), s.action);
    } else {
      for (const t of target.items ?? []) await exec(t.panelId, `${t.project}/${t.name}`, (c) => runAction(c, { ...t, action: s.action }), s.action);
    }
    const status = errors.length ? `Ошибок: ${errors.length} — ${errors[0]}` : 'ок';
    db.prepare('UPDATE schedules SET last_run = ?, last_status = ? WHERE id = ?').run(Date.now(), status, s.id);
    if (errors.length) alerts.emit({ type: 'schedule_failed', icon: '⏱️', text: `Расписание «${s.name}»: ${errors.slice(0, 3).join('; ')}` });
    return { ok: !errors.length, errors };
  }

  function tick() {
    for (const s of db.prepare('SELECT * FROM schedules WHERE enabled = 1').all()) {
      if (isDue(s)) {
        db.prepare('UPDATE schedules SET last_run = ? WHERE id = ?').run(Date.now(), s.id); // защита от повторного запуска
        run(s).catch((e) => console.error('[scheduler]', e.message));
      }
    }
  }
  return { run, row, tick, start() { timer = setInterval(tick, tickMs); timer.unref(); }, stop() { clearInterval(timer); } };
}
