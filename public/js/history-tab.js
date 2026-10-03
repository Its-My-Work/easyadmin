import { get } from './api.js';
import { actionLabel, detailLabel } from './action-names.js';
import { empty } from './components.js';
import { clear, fmtTime, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';

const TERMINAL = /succe|done|complet|finish|\bok\b|fail|error|cancel|kill|abort|stop/i;
const isActive = (x) => !!x.status && !TERMINAL.test(x.status) && !x.finishedAt;
const tone = (st) => (/fail|error/i.test(st) ? 'err' : /succe|done|complet|finish|\bok\b/i.test(st) ? 'ok' : !st || TERMINAL.test(st) ? 'muted' : 'warn');
/** Статус действия панели по-русски (у разных версий — done/success/error/running…); незнакомое показываем как есть. */
const statusLabel = (x) => (isActive(x) ? 'Выполняется' : /fail|error/i.test(x.status) ? 'Ошибка' : /succe|done|complet|finish|\bok\b/i.test(x.status) ? 'Завершён' : /cancel|kill|abort|stop/i.test(x.status) ? 'Остановлен' : x.status);
const KIND_ICON = { deploy: 'rocket', restart: 'rotate', start: 'play', stop: 'stop' };
const kindOf = (action) => String(action).split('.').pop();
const dur = (a, b) => { if (!a || !b || b < a) return ''; const s = Math.round((b - a) / 1000); return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`; };

/** Лог одного действия панели (деплоя и т. п.). Пока действие идёт — обновляется само. */
function openLog(base, item, name) {
  let stopped = false; let timer = null;
  const pre = h('pre', { class: 'code hist-log' }, 'Загрузка…');
  const note = h('div', { class: 'muted small' });
  const load = async () => {
    try {
      const r = await get(`${base}/service/history/${encodeURIComponent(item.id)}`);
      if (stopped) return;
      const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
      pre.textContent = r.log ?? `${JSON.stringify(r.action, null, 2)}`;
      if (atEnd) pre.scrollTop = pre.scrollHeight;
      const active = isActive({ status: String(r.action?.status ?? r.action?.state ?? item.status), finishedAt: r.action?.finishedAt });
      note.textContent = r.log ? '' : 'Панель не отдала текст лога для этого действия — показаны сырые данные.';
      if (active) timer = setTimeout(load, 2500);
    } catch (e) { if (!stopped) pre.textContent = `Не удалось получить лог: ${e.message}`; }
  };
  modal({ title: `${actionLabel(`service.${item.kind}`)} · ${name}`, wide: true, body: h('div', { class: 'stack' }, note, pre),
    actions: [{ label: 'Копировать', close: false, onClick: () => { navigator.clipboard?.writeText(pre.textContent); toast('Скопировано', 'success'); return false; } }, { label: 'Закрыть', kind: 'primary' }],
    onClose: () => { stopped = true; clearTimeout(timer); } });
  load();
}

/** Вкладка «История»: все события по сервису — действия панели (с логами деплоя) и операции, сделанные через EasyAdmin. */
export function historyView({ s, ref, base, state }) {
  const list = h('div', { class: 'hist-list' }, h('div', { class: 'skeleton', style: { height: '120px' } }));
  let items = []; let actionsError = null; let timer = null; let gone = false;
  state.onLeave = () => { gone = true; clearTimeout(timer); };

  /** Запись журнала о деплое и действие панели — одно событие: склеиваем (время расходится на секунды). */
  const merge = (all) => {
    const panel = all.filter((x) => x.source === 'panel').map((x) => ({ ...x }));
    const rest = [];
    for (const x of all.filter((y) => y.source === 'easyadmin')) {
      const k = kindOf(x.action);
      const twin = ['deploy', 'restart', 'start', 'stop'].includes(k) && x.ok ? panel.find((p) => !p.user && p.kind.toLowerCase().includes(k) && Math.abs((p.ts ?? 0) - x.ts) < 90_000) : null;
      if (twin) twin.user = x.user ?? '—'; else rest.push(x);
    }
    return [...panel, ...rest].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  };

  const row = (x) => {
    if (x.source === 'panel') {
      const k = x.kind.toLowerCase();
      const ic = Object.entries(KIND_ICON).find(([key]) => k.includes(key))?.[1] ?? 'activity';
      const known = Object.keys(KIND_ICON).find((key) => k.includes(key)); // у панели деплой называется «deployment»
      const label = known ? actionLabel(`service.${known}`) : actionLabel(`service.${k}`);
      return h('div', { class: `list-item ${x.hasLog ? 'link' : ''} hist-row`, onclick: x.hasLog ? () => openLog(base, x, s.name) : null },
        h('div', { class: 'hist-main' }, icon(ic, 16), h('div', null, h('b', null, label === `service.${k}` ? x.kind : label),
          h('div', { class: 'muted small' }, [x.ts ? fmtTime(x.ts) : null, x.user, dur(x.ts, x.finishedAt)].filter(Boolean).join(' · ')))),
        h('div', { class: 'inline' }, x.status ? h('span', { class: `badge ${tone(x.status)}` }, isActive(x) ? h('i', { class: 'dot' }) : null, statusLabel(x)) : null, x.hasLog ? h('button', { class: 'btn sm ghost', type: 'button', onclick: (e) => { e.stopPropagation(); openLog(base, x, s.name); } }, icon('terminal', 13), 'Лог') : null));
    }
    return h('div', { class: 'list-item hist-row' },
      h('div', { class: 'hist-main' }, icon(String(x.action).startsWith('backup.') ? 'database' : 'edit', 16), h('div', null, h('b', null, actionLabel(x.action)), h('div', { class: 'muted small' }, [fmtTime(x.ts), x.user].filter(Boolean).join(' · ')),
        x.detail ? h('div', { class: `small hist-detail ${x.ok ? 'muted' : 'danger-text'}` }, detailLabel(x.action, x.detail)) : null)),
      h('span', { class: `badge ${x.ok ? 'ok' : 'err'}` }, x.ok ? 'ок' : 'ошибка'));
  };

  const draw = () => {
    const shown = merge(items);
    clear(list).append(...(shown.length ? shown.map(row) : [empty('Событий пока нет', 'Здесь появятся деплои, перезапуски, правки настроек и другие действия по этому сервису.')]));
    if (actionsError) list.prepend(h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, `${t('История панели недоступна')}: ${actionsError}`)));
  };

  const load = async (quiet) => {
    clearTimeout(timer);
    try {
      const r = await get(`${base}/service/history?${new URLSearchParams(ref)}`);
      if (gone) return;
      items = r.items; actionsError = r.actionsError; draw();
      if (items.some((x) => x.source === 'panel' && isActive(x))) timer = setTimeout(() => load(true), 4000); // идёт деплой — следим
    } catch (e) { if (!gone && !quiet) clear(list).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
  };
  load();
  return h('div', { class: 'stack' },
    h('div', { class: 'inline' }, h('p', { class: 'muted small' }, 'Все события сервиса. У деплоя можно открыть лог.'), h('span', { class: 'spacer' }), h('button', { class: 'btn sm ghost', onclick: () => load() }, icon('refresh', 14), 'Обновить')),
    list);
}
