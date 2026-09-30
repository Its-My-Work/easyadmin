import { get } from './api.js';
import { clear, h, icon, toast } from './dom.js';
import { createTerminal } from './term-core.js';

/**
 * Вкладка «Консоль»: терминал в контейнере сервиса (SSE + POST ↔ WebSocket панели). Один сеанс за раз; у compose-сервиса
 * контейнер выбирается в списке. Вывод и история команд живут в state.console — при переключении вкладок не пропадают
 * (сам сеанс при уходе с вкладки закрывается).
 */
const MAX = 200_000;
const QUICK = ['ls -la', 'pwd', 'env | sort', 'ps aux', 'df -h', 'free -m', 'cat /etc/os-release', 'uname -a'];

export function consoleView({ s, ref, state }) {
  const C = state.console ??= { text: '', hist: [], hi: -1, container: '' };
  let pendingEcho = null, follow = true, on = false;
  const termEl = h('pre', { class: 'term term-big', tabindex: 0 });
  const status = h('span', { class: 'small muted' }, 'Не подключено');
  const info = h('div', { class: 'stack-sm' });
  const promptEl = h('span', { class: 'term-prompt' }, '$');

  const paint = () => { termEl.textContent = C.text; if (follow) termEl.scrollTop = termEl.scrollHeight; };
  termEl.addEventListener('scroll', () => { follow = termEl.scrollTop + termEl.clientHeight >= termEl.scrollHeight - 24; });
  const addOut = (raw) => {
    let chunk = raw;
    if (pendingEcho != null) { // терминал обычно повторяет набранное — строку с командой мы уже показали сами
      const t = chunk.replace(/^\n/, '');
      if (t.startsWith(pendingEcho)) { chunk = t.slice(pendingEcho.length).replace(/^\n/, ''); pendingEcho = null; } else if (chunk.trim()) pendingEcho = null;
    }
    C.text = (C.text + chunk).slice(-MAX); paint();
  };

  const setState = (isOn, msg, cls = 'muted') => {
    on = isOn;
    status.textContent = msg; status.className = `small ${cls}`;
    connectBtn.replaceChildren(icon(on ? 'x' : 'terminal', 14), on ? 'Отключить' : 'Подключить терминал');
    connectBtn.classList.toggle('primary', !on);
    ctrlC.disabled = !on; quick.disabled = !on;
  };
  const errorCallout = (st) => h('div', { class: 'callout err compact' }, icon('alert', 14), h('div', null, h('b', null, st.message), st.attempts?.length ? h('ul', { class: 'result-list' }, st.attempts.map((a) => h('li', { class: 'err mono small' }, a))) : null,
    h('p', { class: 'muted small' }, 'Терминал Easypanel работает по WebSocket; версия панели может не поддерживать консоль или её адрес изменился.')));
  const term = createTerminal({ panelId: () => s.panelId, onOut: addOut, onState: (st) => {
    clear(info);
    if (st.state === 'connecting') { connectBtn.disabled = true; setState(false, 'Подключение…'); return; }
    connectBtn.disabled = false;
    if (st.state === 'on') {
      promptEl.textContent = st.tag ? `${st.tag} $` : '$';
      setState(true, st.container ? `● Подключено · ${st.container}` : '● Подключено', st.detected ? 'ok-text' : 'warn-text');
      if (!st.detected) info.append(h('div', { class: 'callout warn compact' }, icon('alert', 14), h('div', null, 'Соединение есть, но панель не ответила на пробную команду. Введите команду и посмотрите, отвечает ли терминал; если нет — переподключитесь.', st.transcript?.length ? h('details', { class: 'more-plain' }, h('summary', null, 'Первые сообщения панели'), h('pre', { class: 'code' }, st.transcript.join('\n'))) : null)));
    } else if (st.state === 'off') setState(false, st.message || 'Отключено', st.failed ? 'danger-text' : 'muted');
    else { setState(false, 'Не удалось подключиться', 'danger-text'); info.append(errorCallout(st)); }
  } });
  const connect = () => term.connect({ ...ref, container: contSel.value || undefined });
  const send = async (data) => { const r = await term.send(data); if (typeof r === 'string') toast(r, 'error'); return r === true; };
  const run = async (cmd) => {
    if (!term.connected) await connect();
    if (!term.connected) return;
    C.text = `${C.text}${C.text && !C.text.endsWith('\n') ? '\n' : ''}${promptEl.textContent} ${cmd}\n`; pendingEcho = cmd; follow = true; paint();
    await send(`${cmd}\n`);
  };

  // у compose-сервиса несколько контейнеров: в каком из них терминал (у одного контейнера список скрыт)
  const contSel = h('select', { class: 'input', 'aria-label': 'Контейнер', hidden: true, onchange: () => { C.container = contSel.value; if (term.connected) connect(); } });
  const loadContainers = async () => {
    try {
      const r = await get(`/api/panels/${s.panelId}/console/containers?${new URLSearchParams(ref)}`);
      contSel.replaceChildren(...r.containers.map((c) => h('option', { value: c.id }, c.tag ?? c.name)));
      const keep = r.containers.some((c) => c.id === C.container) ? C.container : r.selected; // по умолчанию — контейнер, названный как сервис
      if (keep) contSel.value = keep;
      contSel.hidden = r.containers.length < 2;
    } catch { /* панель без списка контейнеров — терминал возьмёт первый */ }
  };

  const connectBtn = h('button', { class: 'btn', onclick: async () => { if (on) { await term.stop(); setState(false, 'Терминал отключён'); } else connect(); } });
  const ctrlC = h('button', { class: 'btn sm', disabled: true, title: 'Прервать текущую команду (Ctrl+C)', onclick: () => send('\x03') }, 'Ctrl+C');
  const input = h('input', { class: 'input mono term-input', placeholder: 'команда и Enter — подключит терминал · ↑↓ история', autocomplete: 'off', spellcheck: 'false', 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
  const quick = h('select', { class: 'input term-quick', disabled: true, onchange: (e) => { if (e.target.value) { input.value = e.target.value; input.focus(); } e.target.value = ''; } }, h('option', { value: '' }, 'Быстрые команды…'), QUICK.map((c) => h('option', { value: c }, c)));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = input.value; if (!v.trim()) return; C.hist.push(v); C.hi = C.hist.length; input.value = ''; run(v); }
    else if (e.key === 'ArrowUp') { if (C.hist.length) { C.hi = Math.max(0, C.hi - 1); input.value = C.hist[C.hi]; e.preventDefault(); } }
    else if (e.key === 'ArrowDown') { if (C.hist.length) { C.hi = Math.min(C.hist.length, C.hi + 1); input.value = C.hist[C.hi] ?? ''; e.preventDefault(); } }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) { send('\x03'); e.preventDefault(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'd') { send('\x04'); e.preventDefault(); }
  });
  const clr = h('button', { class: 'btn sm ghost', onclick: () => { C.text = ''; paint(); } }, icon('trash', 13), 'Очистить');
  const dl = h('button', { class: 'btn sm ghost', title: 'Скачать вывод', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([C.text], { type: 'text/plain' })), download: `${s.name}-console.txt` }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 13));

  state.onLeave = () => { term.stop(); };
  setState(false, 'Не подключено');
  loadContainers(); paint();
  return h('div', { class: 'stack' },
    h('div', { class: 'inline' }, connectBtn, contSel, ctrlC, quick, clr, dl, h('span', { class: 'spacer' }), status),
    info, termEl,
    h('div', { class: 'term-bar' }, promptEl, input),
    h('p', { class: 'muted small' }, 'В журнал попадают открытие и закрытие сеанса и число команд, сами команды не сохраняются.'));
}
