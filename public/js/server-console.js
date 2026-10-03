import { clear, h, icon, toast } from './dom.js';
import { t } from './i18n.js';
import { createTerminal } from './term-core.js';
import { store } from './store.js';
import { bufferText, ensureTerminal, inputQueue, mountTerminal, sendSize } from './xterm-pane.js';

/* Консоль самого сервера (хоста): встроенный терминал Easypanel (Настройки → Сервер → Консоль) через WebSocket панели.
   SSH и пароли не нужны. Полноценный терминал (xterm.js): nano, vim, htop, Tab, стрелки, вставка нескольких строк.
   Состояние живёт на уровне модуля: страница перерисовывается при обновлении данных, а сеанс и вывод остаются. */
const QUICK = ['uptime', 'df -h', 'free -m', 'docker ps', 'docker stats --no-stream', 'docker system df', 'journalctl -n 50 --no-pager', 'ss -tulpn', 'top -bn1 | head -20', 'uname -a'];
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };

const S = { panelId: null, on: false, cid: null, msg: 'Не подключено', cls: 'muted', err: null, warn: null, term: null, keep: {}, send: null };
let ui = null; // элементы текущей отрисовки страницы

const ensureTerm = () => {
  if (S.term) return S.term;
  S.term = createTerminal({ panelId: () => S.panelId, onOut: (_clean, raw) => S.keep.xt?.write(raw), onState: (st) => {
    if (st.state === 'connecting') { S.on = false; S.msg = 'Подключение…'; S.cls = 'muted'; S.err = S.warn = null; }
    else if (st.state === 'on') {
      S.on = true; S.cid = st.id; S.msg = '● Подключено'; S.cls = st.detected ? 'ok-text' : 'warn-text'; S.warn = st.detected ? null : st; S.err = null;
      if (S.keep.xt) { sendSize(S.cid, S.keep.xt.cols, S.keep.xt.rows); S.keep.xt.focus(); }
    }
    else if (st.state === 'off') { S.on = false; S.cid = null; S.msg = st.message || 'Отключено'; S.cls = st.failed ? 'danger-text' : 'muted'; }
    else { S.on = false; S.msg = 'Не удалось подключиться'; S.cls = 'danger-text'; S.err = st; }
    apply();
  } });
  S.send = inputQueue(S.term, (m) => toast(m, 'error'));
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

  const panelSel = h('select', { class: 'input', 'aria-label': 'Панель', onchange: async (e) => { await term.stop(); S.panelId = Number(e.target.value); lsSet('ea-console-panel', String(S.panelId)); S.keep.xt?.reset(); S.on = false; S.msg = 'Не подключено'; S.cls = 'muted'; S.err = S.warn = null; apply(); } },
    reachable.map((x) => h('option', { value: x.id, selected: String(x.id) === String(S.panelId) }, x.name)));
  const pane = h('div');
  const status = h('span', { class: 'small muted' });
  const info = h('div', { class: 'stack-sm' });
  const connect = h('button', { class: 'btn primary', onclick: async () => {
    try { await ensureTerminal(S.keep); } catch (e) { return toast(e.message, 'error'); }
    if (!pane.firstChild) mountNow();
    S.keep.xt.writeln(`\x1b[2m— ${t('подключение')} —\x1b[0m`);
    await term.connect({ server: true });
  } }, icon('terminal', 14), 'Подключить терминал');
  const disconnect = h('button', { class: 'btn', hidden: true, onclick: async () => { await term.stop(); S.on = false; S.msg = 'Терминал отключён'; S.cls = 'muted'; apply(); } }, icon('x', 14), 'Отключить терминал');
  const ctrlC = h('button', { class: 'btn sm', disabled: true, title: 'Прервать текущую команду (Ctrl+C)', onclick: () => { S.send('\x03'); S.keep.xt?.focus(); } }, 'Ctrl+C');
  const quick = h('select', { class: 'input term-quick', disabled: true, onchange: (e) => { if (e.target.value) { S.send(`${e.target.value}\r`); S.keep.xt?.focus(); } e.target.value = ''; } }, h('option', { value: '' }, 'Быстрые команды…'), QUICK.map((c) => h('option', { value: c }, c)));
  const clearBtn = h('button', { class: 'btn sm ghost', onclick: () => S.keep.xt?.clear() }, icon('trash', 13), 'Очистить');
  const dl = h('button', { class: 'btn sm ghost', title: 'Скачать вывод', onclick: () => { if (!S.keep.xt) return; const a = h('a', { href: URL.createObjectURL(new Blob([bufferText(S.keep.xt)], { type: 'text/plain' })), download: 'server-console.txt' }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 13));

  let mounted = null;
  function mountNow() {
    S.keep.sink = S.send; S.keep.onSize = (c, r) => { if (S.cid) sendSize(S.cid, c, r); };
    mounted?.stop(); mounted = mountTerminal(S.keep); clear(pane).append(mounted.el);
  }
  // экран терминала создаётся заранее, чтобы после перехода по страницам вывод сеанса сразу был на месте
  if (S.keep.xt) mountNow(); else ensureTerminal(S.keep).then(mountNow).catch((e) => pane.append(h('div', { class: 'callout err compact' }, icon('alert', 14), e.message)));

  ui = { status, connect, disconnect, ctrlC, quick, panelSel, info };
  apply();
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Консоль сервера'), h('div', { class: 'inline' }, panelSel)),
    h('div', { class: 'inline' }, connect, disconnect, ctrlC, quick, clearBtn, dl, h('span', { class: 'spacer' }), status),
    info, pane);
}
