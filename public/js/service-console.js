import { get } from './api.js';
import { clear, h, icon, toast } from './dom.js';
import { t } from './i18n.js';
import { createTerminal } from './term-core.js';
import { bufferText, ensureTerminal, inputQueue, mountTerminal, sendSize } from './xterm-pane.js';

/**
 * Вкладка «Консоль»: терминал в контейнере сервиса (SSE + POST ↔ WebSocket панели), полноценный (xterm.js): nano, vim, Tab, стрелки,
 * вставка нескольких строк. Один сеанс за раз; у compose-сервиса контейнер выбирается в списке. Экран терминала живёт в
 * state.console — при переключении вкладок вывод не пропадает (сам сеанс при уходе с вкладки закрывается).
 */
const QUICK = ['ls -la', 'pwd', 'env | sort', 'ps aux', 'df -h', 'free -m', 'cat /etc/os-release', 'uname -a'];

export function consoleView({ s, ref, state }) {
  const C = state.console ??= { keep: {}, container: '' };
  const keep = C.keep; let on = false; let cid = null; let mounted = null;
  const status = h('span', { class: 'small muted' }, 'Не подключено');
  const info = h('div', { class: 'stack-sm' });
  const pane = h('div');

  const setState = (isOn, msg, cls = 'muted') => {
    on = isOn;
    status.textContent = msg; status.className = `small ${cls}`;
    connectBtn.replaceChildren(icon(on ? 'x' : 'terminal', 14), on ? 'Отключить' : 'Подключить терминал');
    connectBtn.classList.toggle('primary', !on);
    ctrlC.disabled = !on; quick.disabled = !on;
  };
  const errorCallout = (st) => h('div', { class: 'callout err compact' }, icon('alert', 14), h('div', null, h('b', null, st.message), st.attempts?.length ? h('ul', { class: 'result-list' }, st.attempts.map((a) => h('li', { class: 'err mono small' }, a))) : null,
    h('p', { class: 'muted small' }, 'Терминал Easypanel работает по WebSocket; версия панели может не поддерживать консоль или её адрес изменился.')));
  const term = createTerminal({ panelId: () => s.panelId, onOut: (_clean, raw) => keep.xt?.write(raw), onState: (st) => {
    clear(info);
    if (st.state === 'connecting') { connectBtn.disabled = true; setState(false, 'Подключение…'); return; }
    connectBtn.disabled = false;
    if (st.state === 'on') {
      cid = st.id;
      setState(true, st.container ? `● Подключено · ${st.container}` : '● Подключено', st.detected ? 'ok-text' : 'warn-text');
      if (keep.xt) { sendSize(cid, keep.xt.cols, keep.xt.rows); keep.xt.focus(); }
      if (!st.detected) info.append(h('div', { class: 'callout warn compact' }, icon('alert', 14), h('div', null, 'Соединение есть, но панель не ответила на пробную команду. Введите команду и посмотрите, отвечает ли терминал; если нет — переподключитесь.', st.transcript?.length ? h('details', { class: 'more-plain' }, h('summary', null, 'Первые сообщения панели'), h('pre', { class: 'code' }, st.transcript.join('\n'))) : null)));
    } else if (st.state === 'off') { cid = null; setState(false, st.message || 'Отключено', st.failed ? 'danger-text' : 'muted'); }
    else { setState(false, 'Не удалось подключиться', 'danger-text'); info.append(errorCallout(st)); }
  } });
  const send = inputQueue(term, (m) => toast(m, 'error'));
  const connect = async () => {
    connectBtn.disabled = true;
    try { await ensureTerminal(keep); } catch (e) { connectBtn.disabled = false; return toast(e.message, 'error'); }
    if (!mounted) mountNow();
    keep.xt.writeln(`\x1b[2m— ${t('подключение')} —\x1b[0m`);
    await term.connect({ ...ref, container: contSel.value || undefined });
  };

  // у compose-сервиса несколько контейнеров: в каком из них терминал (у одного контейнера список скрыт)
  const contSel = h('select', { class: 'input', 'aria-label': 'Контейнер', hidden: true, onchange: () => { C.container = contSel.value; if (term.connected) connect(); } });
  const loadContainers = async () => {
    try {
      const r = await get(`/api/panels/${s.panelId}/console/containers?${new URLSearchParams(ref)}`);
      contSel.replaceChildren(...r.containers.map((c) => h('option', { value: c.id }, c.tag ?? c.name)));
      const keepSel = r.containers.some((c) => c.id === C.container) ? C.container : r.selected; // по умолчанию — контейнер, названный как сервис
      if (keepSel) contSel.value = keepSel;
      contSel.hidden = r.containers.length < 2;
    } catch { /* панель без списка контейнеров — терминал возьмёт первый */ }
  };

  const connectBtn = h('button', { class: 'btn', onclick: async () => { if (on) { await term.stop(); setState(false, 'Терминал отключён'); } else connect(); } });
  const ctrlC = h('button', { class: 'btn sm', disabled: true, title: 'Прервать текущую команду (Ctrl+C)', onclick: () => { send('\x03'); keep.xt?.focus(); } }, 'Ctrl+C');
  const quick = h('select', { class: 'input term-quick', disabled: true, onchange: (e) => { if (e.target.value) { send(`${e.target.value}\r`); keep.xt?.focus(); } e.target.value = ''; } }, h('option', { value: '' }, 'Быстрые команды…'), QUICK.map((c) => h('option', { value: c }, c)));
  const clr = h('button', { class: 'btn sm ghost', onclick: () => keep.xt?.clear() }, icon('trash', 13), 'Очистить');
  const dl = h('button', { class: 'btn sm ghost', title: 'Скачать вывод', onclick: () => { if (!keep.xt) return; const a = h('a', { href: URL.createObjectURL(new Blob([bufferText(keep.xt)], { type: 'text/plain' })), download: `${s.name}-console.txt` }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 13));

  function mountNow() {
    keep.sink = send; keep.onSize = (c, r) => { if (cid) sendSize(cid, c, r); };
    mounted = mountTerminal(keep); clear(pane).append(mounted.el);
  }
  state.onLeave = () => { term.stop(); keep.sink = null; keep.onSize = null; mounted?.stop(); };
  setState(false, 'Не подключено');
  loadContainers();
  ensureTerminal(keep).then(() => { if (pane.isConnected !== false) mountNow(); }).catch((e) => pane.append(h('div', { class: 'callout err compact' }, icon('alert', 14), e.message)));
  return h('div', { class: 'stack' },
    h('div', { class: 'inline' }, connectBtn, contSel, ctrlC, quick, clr, dl, h('span', { class: 'spacer' }), status),
    info, pane,
    h('p', { class: 'muted small' }, 'В журнал попадают открытие и закрытие сеанса и число нажатий Enter, сами команды не сохраняются.'));
}
