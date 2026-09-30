import { get } from './api.js';
import { clear, h, icon, toast } from './dom.js';
import { createTerminal } from './term-core.js';

/**
 * «Логи и консоль»: один поток. Сверху логи сервиса (SSE ← WebSocket панели), в тот же список попадают команды и их вывод
 * из терминала контейнера (SSE + POST ↔ WebSocket панели). Терминал подключается лениво — при первой команде.
 */
const MAX = 3000;
const QUICK = ['ls -la', 'pwd', 'env | sort', 'ps aux', 'df -h', 'free -m', 'cat /etc/os-release', 'uname -a'];

export function logsConsole({ s, ref, base, state, admin }) {
  const view = h('div', { class: 'logview', tabindex: 0 });
  const logStatus = h('span', { class: 'muted small' }, 'Подключение…');
  const termStatus = h('span', { class: 'muted small' });
  const count = h('span', { class: 'muted small' });
  const els = new WeakMap();
  let es = null, paused = false, follow = true, filter = '', buffer = [], all = [];
  let tpartial = null, pendingEcho = null, hist = [], hi = -1;

  const cls = (l) => (/\b(error|fatal|panic|exception|fail(ed)?)\b/i.test(l) ? 'err' : /\bwarn(ing)?\b/i.test(l) ? 'warn' : '');
  const shown = (it) => it.k !== 'log' || !filter || it.text.toLowerCase().includes(filter);
  const row = (it) => { const el = h('div', { class: `ll ${it.k === 'log' ? cls(it.text) : it.k}` }, it.k === 'cmd' ? `$ ${it.text}` : it.text); els.set(it, el); return el; };
  const stick = () => { if (follow) view.scrollTop = view.scrollHeight; };
  const push = (it) => {
    all.push(it);
    if (all.length > MAX) { const old = all.shift(); els.get(old)?.remove(); }
    if (paused) { buffer.push(it); count.textContent = `на паузе, накоплено ${buffer.length}`; return; }
    if (shown(it)) view.append(row(it));
    count.textContent = `${all.length} строк`; stick();
  };
  const redraw = () => { clear(view).append(...all.filter(shown).map(row)); stick(); };
  view.addEventListener('scroll', () => { follow = view.scrollTop + view.clientHeight >= view.scrollHeight - 24; followBtn.classList.toggle('on', follow); });

  /* ---- логи ---- */
  const connectLogs = () => {
    es?.close();
    logStatus.textContent = 'Подключение…'; logStatus.className = 'muted small';
    es = new EventSource(`${base}/logs?${new URLSearchParams(ref)}`);
    es.addEventListener('line', (e) => push({ k: 'log', text: JSON.parse(e.data) }));
    es.addEventListener('status', (e) => {
      const st = JSON.parse(e.data);
      if (st.state === 'connected') { logStatus.textContent = '● Онлайн'; logStatus.className = 'small ok-text'; }
      else { logStatus.textContent = st.state === 'closed' ? 'Поток завершён' : st.message; logStatus.className = `small ${st.state === 'closed' ? 'muted' : 'danger-text'}`; es.close(); }
    });
    es.onerror = () => { logStatus.textContent = 'Соединение потеряно — переподключение…'; logStatus.className = 'small warn-text'; };
  };

  /* ---- терминал ---- */
  const setTerm = (on, msg, c = 'muted') => {
    if (!admin) return;
    input.disabled = false; // вводить можно и без подключения — первая команда подключит терминал
    termBtn.replaceChildren(icon(on ? 'x' : 'terminal', 13), on ? 'Отключить терминал' : 'Подключить терминал');
    termBtn.dataset.on = on ? '1' : '';
    ctrlC.disabled = !on; quick.disabled = !on;
    termStatus.textContent = msg; termStatus.className = `small ${c}`;
  };
  const termOut = (raw) => {
    let chunk = raw;
    if (pendingEcho != null) { // терминал обычно повторяет набранное — строку с командой мы уже показали сами
      const t = chunk.replace(/^\n/, '');
      if (t.startsWith(pendingEcho)) { chunk = t.slice(pendingEcho.length).replace(/^\n/, ''); pendingEcho = null; } else if (chunk.trim()) pendingEcho = null;
    }
    if (!chunk) return;
    chunk.split('\n').forEach((part, i, arr) => {
      if (!tpartial) { tpartial = { k: 'out', text: '' }; push(tpartial); }
      tpartial.text += part;
      const el = els.get(tpartial); if (el) el.textContent = tpartial.text;
      if (i < arr.length - 1) tpartial = null;
    });
    stick();
  };
  const errorCallout = (st) => h('div', { class: 'callout err compact' }, icon('alert', 14), h('div', null, h('b', null, st.message), st.attempts?.length ? h('ul', { class: 'result-list' }, st.attempts.map((a) => h('li', { class: 'err mono small' }, a))) : null,
    h('p', { class: 'muted small' }, 'Терминал Easypanel работает по WebSocket; версия панели может не поддерживать консоль или её адрес изменился.')));
  const term = createTerminal({ panelId: () => s.panelId, onOut: termOut, onState: (st) => {
    if (st.state === 'connecting') { clear(info); setTerm(false, 'Терминал: подключение…'); termBtn.disabled = true; return; }
    termBtn.disabled = false;
    if (st.state === 'on') {
      tpartial = null;
      setTerm(true, `Терминал подключён · ${st.container ? `${st.container} · ` : ''}${st.path} · ${st.detected ? st.framing : 'формат не определён'}`, st.detected ? 'ok-text' : 'warn-text');
      if (!st.detected) info.append(h('div', { class: 'callout warn compact' }, icon('alert', 14), h('div', null, 'Соединение есть, но панель не ответила на пробную команду. Введите команду и посмотрите, отвечает ли терминал; если нет — переподключитесь.', st.transcript?.length ? h('details', { class: 'more-plain' }, h('summary', null, 'Первые сообщения панели'), h('pre', { class: 'code' }, st.transcript.join('\n'))) : null)));
    } else if (st.state === 'off') setTerm(false, st.message || 'Терминал отключён', st.failed ? 'danger-text' : 'muted');
    else { setTerm(false, 'Не удалось подключиться', 'danger-text'); info.append(errorCallout(st)); }
  } });
  const connectTerm = () => term.connect({ ...ref, container: contSel.value || undefined });
  const send = async (data) => { const r = await term.send(data); if (typeof r === 'string') toast(r, 'error'); return r === true; };
  const run = async (cmd) => {
    if (!term.connected) await connectTerm();
    if (!term.connected) return;
    push({ k: 'cmd', text: cmd }); pendingEcho = cmd;
    follow = true; stick();
    await send(`${cmd}\n`);
  };

  /* ---- элементы ---- */
  const pauseBtn = h('button', { class: 'btn sm', onclick: () => {
    paused = !paused; pauseBtn.replaceChildren(icon(paused ? 'play' : 'stop', 13), paused ? 'Продолжить' : 'Пауза');
    if (!paused) { const b = buffer; buffer = []; b.forEach((it) => shown(it) && view.append(row(it))); count.textContent = `${all.length} строк`; stick(); }
  } }, icon('stop', 13), 'Пауза');
  const followBtn = h('button', { class: 'btn sm on', title: 'Прокручивать к новым строкам', onclick: () => { follow = !follow; followBtn.classList.toggle('on', follow); stick(); } }, icon('down', 13), 'Следить');
  const q = h('input', { class: 'input', placeholder: 'Фильтр логов…', oninput: () => { filter = q.value.toLowerCase(); redraw(); } });
  const dl = h('button', { class: 'btn sm ghost', title: 'Скачать', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([all.map((it) => (it.k === 'cmd' ? `$ ${it.text}` : it.text)).join('\n')], { type: 'text/plain' })), download: `${s.name}.log` }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 13));
  const clr = h('button', { class: 'btn sm ghost', onclick: () => { all = []; buffer = []; tpartial = null; clear(view); count.textContent = ''; } }, icon('trash', 13), 'Очистить');
  const re = h('button', { class: 'btn sm ghost', onclick: connectLogs }, icon('refresh', 13), 'Переподключить');

  // у compose-сервиса несколько контейнеров: выбор, в каком открыть терминал (у одного контейнера список скрыт)
  const contSel = h('select', { class: 'input', 'aria-label': 'Контейнер', hidden: true });
  const loadContainers = async () => {
    try {
      const r = await get(`/api/panels/${s.panelId}/console/containers?${new URLSearchParams(ref)}`);
      contSel.replaceChildren(...r.containers.map((c) => h('option', { value: c.id }, c.name)));
      contSel.hidden = r.containers.length < 2;
    } catch { /* панель без списка контейнеров — терминал возьмёт первый */ }
  };
  const input = h('input', { class: 'input mono term-input', placeholder: 'команда и Enter — подключит терминал · ↑↓ история', autocomplete: 'off', spellcheck: 'false', 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
  const info = h('div', { class: 'stack-sm' });
  const termBtn = h('button', { class: 'btn sm', onclick: async () => { if (termBtn.dataset.on) { await term.stop(); setTerm(false, 'Терминал отключён'); } else connectTerm(); } });
  const ctrlC = h('button', { class: 'btn sm', disabled: true, title: 'Прервать текущую команду (Ctrl+C)', onclick: () => send('\x03') }, 'Ctrl+C');
  const quick = h('select', { class: 'input term-quick', disabled: true, onchange: (e) => { if (e.target.value) { input.value = e.target.value; input.focus(); } e.target.value = ''; } }, h('option', { value: '' }, 'Быстрые команды…'), QUICK.map((c) => h('option', { value: c }, c)));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = input.value; if (!v.trim()) return; hist.push(v); hi = hist.length; input.value = ''; run(v); }
    else if (e.key === 'ArrowUp') { if (hist.length) { hi = Math.max(0, hi - 1); input.value = hist[hi]; e.preventDefault(); } }
    else if (e.key === 'ArrowDown') { if (hist.length) { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] ?? ''; e.preventDefault(); } }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) { send('\x03'); e.preventDefault(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'd') { send('\x04'); e.preventDefault(); }
  });

  state.onLeave = () => { es?.close(); term.stop(); };
  connectLogs();
  if (admin) { setTerm(false, 'Терминал не подключён'); loadContainers(); }
  return h('div', { class: 'stack' },
    h('div', { class: 'inline' }, q, pauseBtn, followBtn, dl, clr, re),
    h('div', { class: 'inline' }, logStatus, admin ? h('span', { class: 'muted small' }, '·') : null, admin ? termStatus : null, h('span', { class: 'spacer' }), count),
    view,
    admin ? h('div', { class: 'stack-sm' },
      h('div', { class: 'term-bar' }, h('span', { class: 'term-prompt' }, '$'), input),
      h('div', { class: 'inline' }, termBtn, contSel, ctrlC, quick, h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, 'В журнал попадают открытие и закрытие сеанса и число команд, сами команды не сохраняются.')),
      info) : null);
}
