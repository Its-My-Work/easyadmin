import { clear, h, icon, toast } from './dom.js';
import { createTerminal } from './term-core.js';
import { store } from './store.js';

/* Консоль самого сервера (хоста): встроенный терминал Easypanel (Настройки → Сервер → Консоль) через WebSocket панели.
   SSH и пароли не нужны. Состояние живёт на уровне модуля: страница перерисовывается при обновлении данных, а сеанс и вывод остаются. */
const MAX = 200_000;
const QUICK = ['uptime', 'df -h', 'free -m', 'docker ps', 'docker stats --no-stream', 'docker system df', 'journalctl -n 50 --no-pager', 'ss -tulpn', 'top -bn1 | head -20', 'uname -a'];
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };

const S = { panelId: null, text: '', on: false, msg: 'Не подключено', cls: 'muted', err: null, warn: null, hist: [], hi: -1, pendingEcho: null, term: null, follow: true };
let ui = null; // элементы текущей отрисовки страницы

const paint = () => { if (!ui) return; ui.term.textContent = S.text; if (S.follow) ui.term.scrollTop = ui.term.scrollHeight; };
const addOut = (raw) => {
  let chunk = raw;
  if (S.pendingEcho != null) { // терминал обычно повторяет набранное — строку с командой мы уже показали сами
    const t = chunk.replace(/^\n/, '');
    if (t.startsWith(S.pendingEcho)) { chunk = t.slice(S.pendingEcho.length).replace(/^\n/, ''); S.pendingEcho = null; } else if (chunk.trim()) S.pendingEcho = null;
  }
  S.text = (S.text + chunk).slice(-MAX); paint();
};
const ensureTerm = () => {
  if (S.term) return S.term;
  S.term = createTerminal({ panelId: () => S.panelId, onOut: addOut, onState: (st) => {
    if (st.state === 'connecting') { S.on = false; S.msg = 'Подключение…'; S.cls = 'muted'; S.err = S.warn = null; }
    else if (st.state === 'on') { S.on = true; S.msg = `● Подключено · ${st.path} · ${st.detected ? st.framing : 'формат не определён'}`; S.cls = st.detected ? 'ok-text' : 'warn-text'; S.warn = st.detected ? null : st; S.err = null; }
    else if (st.state === 'off') { S.on = false; S.msg = st.message || 'Отключено'; S.cls = st.failed ? 'danger-text' : 'muted'; }
    else { S.on = false; S.msg = 'Не удалось подключиться'; S.cls = 'danger-text'; S.err = st; }
    apply();
  } });
  return S.term;
};

function apply() {
  if (!ui) return;
  ui.status.textContent = S.msg; ui.status.className = `small ${S.cls}`;
  ui.connect.hidden = S.on; ui.disconnect.hidden = !S.on; ui.ctrlC.disabled = !S.on; ui.quick.disabled = !S.on;
  ui.panelSel.disabled = S.on;
  clear(ui.info);
  if (S.warn) ui.info.append(h('div', { class: 'callout warn compact' }, icon('alert', 14), h('div', null, 'Соединение есть, но панель не ответила на пробную команду. Введите команду и посмотрите, отвечает ли терминал; если нет — переподключитесь.',
    S.warn.transcript?.length ? h('details', { class: 'more-plain' }, h('summary', null, 'Первые сообщения панели'), h('pre', { class: 'code' }, S.warn.transcript.join('\n'))) : null)));
  if (S.err) {
    ui.info.append(h('div', { class: 'callout err compact' }, icon('alert', 14), h('div', null, h('b', null, S.err.message), S.err.attempts?.length ? h('ul', { class: 'result-list' }, S.err.attempts.map((a) => h('li', { class: 'err mono small' }, a))) : null,
      h('p', { class: 'muted small' }, 'Терминал Easypanel работает по WebSocket; версия панели может не поддерживать консоль или её адрес изменился.'))));
  }
}

export function consolePage() {
  const reachable = store.panels.filter((x) => ['online', 'degraded'].includes(x.status));
  if (!reachable.length) return h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', null, 'Консоль сервера')), h('div', { class: 'callout warn' }, icon('alert'), 'Нет доступных панелей'));
  if (!reachable.some((x) => String(x.id) === String(S.panelId))) S.panelId = reachable.find((x) => String(x.id) === lsGet('ea-console-panel'))?.id ?? reachable[0].id;
  const term = ensureTerm();

  const panelSel = h('select', { class: 'input', 'aria-label': 'Панель', onchange: async (e) => { await term.stop(); S.panelId = Number(e.target.value); lsSet('ea-console-panel', String(S.panelId)); S.text = ''; S.on = false; S.msg = 'Не подключено'; S.cls = 'muted'; S.err = S.warn = null; paint(); apply(); } },
    reachable.map((x) => h('option', { value: x.id, selected: String(x.id) === String(S.panelId) }, x.name)));
  const termEl = h('pre', { class: 'term term-big', tabindex: 0 });
  termEl.addEventListener('scroll', () => { S.follow = termEl.scrollTop + termEl.clientHeight >= termEl.scrollHeight - 24; });
  const input = h('input', { class: 'input mono term-input', placeholder: 'команда и Enter — подключит терминал · ↑↓ история', autocomplete: 'off', spellcheck: 'false', 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
  const status = h('span', { class: 'small muted' });
  const info = h('div', { class: 'stack-sm' });
  const connect = h('button', { class: 'btn primary', onclick: () => term.connect({ server: true, }) }, icon('terminal', 14), 'Подключить терминал');
  const disconnect = h('button', { class: 'btn', hidden: true, onclick: async () => { await term.stop(); S.on = false; S.msg = 'Терминал отключён'; S.cls = 'muted'; apply(); } }, icon('x', 14), 'Отключить терминал');
  const send = async (data) => { const r = await term.send(data); if (typeof r === 'string') toast(r, 'error'); return r === true; };
  const ctrlC = h('button', { class: 'btn sm', disabled: true, title: 'Прервать текущую команду (Ctrl+C)', onclick: () => send('\x03') }, 'Ctrl+C');
  const quick = h('select', { class: 'input term-quick', disabled: true, onchange: (e) => { if (e.target.value) { input.value = e.target.value; input.focus(); } e.target.value = ''; } }, h('option', { value: '' }, 'Быстрые команды…'), QUICK.map((c) => h('option', { value: c }, c)));
  const run = async (cmd) => {
    if (!term.connected) await term.connect({ server: true, });
    if (!term.connected) return;
    S.text = `${S.text}${S.text && !S.text.endsWith('\n') ? '\n' : ''}$ ${cmd}\n`; S.pendingEcho = cmd; S.follow = true; paint();
    await send(`${cmd}\n`);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = input.value; if (!v.trim()) return; S.hist.push(v); S.hi = S.hist.length; input.value = ''; run(v); }
    else if (e.key === 'ArrowUp') { if (S.hist.length) { S.hi = Math.max(0, S.hi - 1); input.value = S.hist[S.hi]; e.preventDefault(); } }
    else if (e.key === 'ArrowDown') { if (S.hist.length) { S.hi = Math.min(S.hist.length, S.hi + 1); input.value = S.hist[S.hi] ?? ''; e.preventDefault(); } }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) { send('\x03'); e.preventDefault(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'd') { send('\x04'); e.preventDefault(); }
  });
  const clearBtn = h('button', { class: 'btn sm ghost', onclick: () => { S.text = ''; paint(); } }, icon('trash', 13), 'Очистить');
  const dl = h('button', { class: 'btn sm ghost', title: 'Скачать вывод', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([S.text], { type: 'text/plain' })), download: 'server-console.txt' }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 13));

  ui = { term: termEl, status, connect, disconnect, ctrlC, quick, panelSel, info };
  apply(); paint();
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Консоль сервера'), h('div', { class: 'inline' }, panelSel)),
    h('div', { class: 'callout compact' }, icon('alert', 14), h('span', { class: 'small' }, 'Терминал хоста через встроенную консоль Easypanel (Настройки → Сервер → Консоль): SSH и пароли не нужны. Команды выполняются на самом сервере с правами, которые даёт панель. В журнал попадают открытие и закрытие сеанса и число команд, сами команды не сохраняются.')),
    h('div', { class: 'inline' }, connect, disconnect, ctrlC, quick, clearBtn, dl, h('span', { class: 'spacer' }), status),
    info, termEl,
    h('div', { class: 'term-bar' }, h('span', { class: 'term-prompt' }, '#'), input));
}
