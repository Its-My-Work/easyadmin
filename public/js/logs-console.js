import { clear, h, icon } from './dom.js';
import { parseLogLine, tagHue } from './log-parse.js';

/**
 * Вкладка «Логи»: поток логов сервиса (SSE ← WebSocket панели). У compose-сервиса строки подписаны контейнером
 * («n8n-app-1 | …») — показываем тег и фильтр по контейнеру. Терминал вынесен на отдельную вкладку «Консоль» (service-console.js).
 */
const MAX = 3000;

export function logsView({ s, ref, base, state }) {
  const view = h('div', { class: 'logview', tabindex: 0 });
  const logStatus = h('span', { class: 'muted small' }, 'Подключение…');
  const count = h('span', { class: 'muted small' });
  let es = null, follow = true, filter = '', all = [];
  let tagFilter = null; const tags = new Set();
  const tagBar = h('div', { class: 'chips', hidden: true });

  const cls = (l) => (/\b(error|fatal|panic|exception|fail(ed)?)\b/i.test(l) ? 'err' : /\bwarn(ing)?\b/i.test(l) ? 'warn' : '');
  const shown = (it) => (!tagFilter || it.tag === tagFilter) && (!filter || it.text.toLowerCase().includes(filter));
  const row = (it) => h('div', { class: `ll ${cls(it.text)}` }, it.tag ? h('span', { class: `ltag h${tagHue(it.tag)}` }, it.tag) : null, it.text);
  const renderTags = () => {
    tagBar.hidden = tags.size < 2;
    tagBar.replaceChildren(h('button', { class: `chip-btn ${tagFilter ? '' : 'on'}`, onclick: () => { tagFilter = null; renderTags(); redraw(); } }, 'Все'),
      ...[...tags].sort().map((t) => h('button', { class: `chip-btn ${tagFilter === t ? 'on' : ''}`, onclick: () => { tagFilter = t; renderTags(); redraw(); } }, t)));
  };
  const stick = () => { if (follow) view.scrollTop = view.scrollHeight; };
  const push = (it) => {
    if (it.tag && !tags.has(it.tag)) { tags.add(it.tag); renderTags(); }
    all.push(it);
    if (all.length > MAX) { all.shift(); view.firstChild?.remove(); }
    if (shown(it)) view.append(row(it));
    count.textContent = `${all.length} строк`; stick();
  };
  const redraw = () => { clear(view).append(...all.filter(shown).map(row)); stick(); };
  view.addEventListener('scroll', () => { follow = view.scrollTop + view.clientHeight >= view.scrollHeight - 24; followBtn.classList.toggle('on', follow); });

  // поток сам переподключается (обрыв, перезапуск сервиса, деплой) с нарастающей паузой; после повторного подключения панель
  // присылает хвост лога заново — первые секунды строки, которые уже есть на экране, пропускаем
  let retry = 0, retryTimer = null, leaving = false, replaySeen = null;
  const connectLogs = () => {
    clearTimeout(retryTimer); es?.close();
    logStatus.textContent = retry ? 'Переподключение…' : 'Подключение…'; logStatus.className = 'muted small';
    const stream = es = new EventSource(`${base}/logs?${new URLSearchParams(ref)}`);
    const again = (msg) => {
      if (leaving || es !== stream) return;
      stream.close();
      const wait = Math.min(30, 2 ** Math.min(retry, 5)); retry++;
      logStatus.textContent = `${msg} — повтор через ${wait} с`; logStatus.className = 'small warn-text';
      retryTimer = setTimeout(connectLogs, wait * 1000);
    };
    stream.addEventListener('line', (e) => {
      const raw = JSON.parse(e.data);
      if (replaySeen) { const n = replaySeen.get(raw); if (n) { replaySeen.set(raw, n - 1); return; } }
      push({ raw, ...parseLogLine(raw) });
    });
    stream.addEventListener('status', (e) => {
      const st = JSON.parse(e.data);
      if (st.state === 'connected') {
        logStatus.textContent = '● Онлайн'; logStatus.className = 'small ok-text';
        if (retry) { // это повторное подключение: запоминаем уже показанные строки на время «воспроизведения» хвоста
          replaySeen = new Map(); for (const it of all.slice(-300)) replaySeen.set(it.raw, (replaySeen.get(it.raw) ?? 0) + 1);
          setTimeout(() => { replaySeen = null; }, 2500);
        }
        retry = 0;
      } else again(st.state === 'closed' ? 'Поток завершён' : st.message);
    });
    stream.onerror = () => again('Соединение потеряно');
  };

  // «Обновить»: строки стираются и читаются заново (свежий хвост)
  const refreshBtn = h('button', { class: 'btn sm', title: 'Перечитать логи сервиса', onclick: () => { all = []; redraw(); count.textContent = ''; retry = 0; replaySeen = null; connectLogs(); } }, icon('refresh', 13), 'Обновить');
  const followBtn = h('button', { class: 'btn sm on', title: 'Прокручивать к новым строкам', onclick: () => { follow = !follow; followBtn.classList.toggle('on', follow); stick(); } }, icon('down', 13), 'Следить');
  const q = h('input', { class: 'input', placeholder: 'Фильтр логов…', oninput: () => { filter = q.value.toLowerCase(); redraw(); } });
  const dl = h('button', { class: 'btn sm ghost', title: 'Скачать', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([all.map((it) => `${it.tag ? `${it.tag} | ` : ''}${it.text}`).join('\n')], { type: 'text/plain' })), download: `${s.name}.log` }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 13));
  const clr = h('button', { class: 'btn sm ghost', onclick: () => { all = []; clear(view); count.textContent = ''; } }, icon('trash', 13), 'Очистить');

  state.onLeave = () => { leaving = true; clearTimeout(retryTimer); es?.close(); };
  connectLogs();
  return h('div', { class: 'stack' },
    h('div', { class: 'inline' }, q, refreshBtn, followBtn, dl, clr),
    tagBar,
    h('div', { class: 'inline' }, logStatus, h('span', { class: 'spacer' }), count),
    view);
}
