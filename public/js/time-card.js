import { get, put } from './api.js';
import { clear, h, toast } from './dom.js';
import { fmtServer, serverNow, setServerTime, tzOffset } from './clock.js';

const FALLBACK = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Kyiv', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Tashkent', 'Asia/Almaty', 'Asia/Novosibirsk', 'Asia/Vladivostok', 'America/New_York', 'America/Chicago', 'America/Los_Angeles'];
const zones = (current) => {
  let list; try { list = Intl.supportedValuesOf('timeZone'); } catch { list = FALLBACK; }
  return [...new Set(['UTC', ...list, current].filter(Boolean))];
};

/** Настройки → «Время сервера»: часовой пояс, в котором живут расписания, копии и все метки времени в интерфейсе. */
export function timeCard() {
  const box = h('section', { class: 'card stack' });
  const draw = async () => {
    let s;
    try { s = await get('/api/settings'); } catch (e) { clear(box).append(h('h3', null, 'Время сервера'), h('p', { class: 'muted' }, e.message)); return; }
    const now = Date.now();
    const items = zones(s.timezone).map((tz) => ({ tz, off: tzOffset(tz, now) })).map((x) => ({ ...x, mins: offMinutes(x.off) })).sort((a, b) => a.mins - b.mins || a.tz.localeCompare(b.tz));
    const sel = h('select', { class: 'input', 'aria-label': 'Часовой пояс' }, items.map(({ tz, off }) => h('option', { value: tz, selected: tz === s.timezone }, `${off ? `(${off}) ` : ''}${tz}`)));
    const clock = h('b', { class: 'tz-now' });
    const tick = () => { if (!clock.isConnected) return clearInterval(timer); clock.textContent = fmtServer(serverNow(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); };
    const timer = setInterval(tick, 1000);
    const save = h('button', { class: 'btn primary sm', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const r = await put('/api/settings', { timezone: sel.value });
        setServerTime({ now: serverNow(), tz: r.timezone }); window.dispatchEvent(new Event('ea:timezone'));
        toast('Часовой пояс сохранён', 'success'); draw();
      } catch (x) { toast(x.message, 'error'); b.disabled = false; }
    } }, 'Сохранить');
    clear(box).append(
      h('div', { class: 'card-head' }, h('h3', null, 'Время сервера')),
      h('p', { class: 'muted small' }, 'Время в шапке, в журнале, в расписаниях и в копиях данных показывается по этому поясу. Сейчас на сервере EasyAdmin:'),
      h('div', { class: 'inline' }, clock),
      h('div', { class: 'inline' }, sel, save));
    tick();
  };
  draw();
  return box;
}

function offMinutes(off) {
  const m = /UTC([+-])(\d{2}):(\d{2})/.exec(off ?? '');
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}
