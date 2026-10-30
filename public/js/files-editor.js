import { post } from './api.js';
import { clear, confirmDialog, h, icon, toast } from './dom.js';
import { t } from './i18n.js';
import { KIND_ICON, LIMITS, baseName, dirOf, findAll, fmtSize, joinPath, kindOf, lineStart, pickMatch, replaceAllIn } from './files-util.js';

const raw = (s) => document.createTextNode(s);
const sizeText = (n) => { const [v, u] = fmtSize(n); return `${v} ${t(u)}`; };
const bytesOf = (s) => new TextEncoder().encode(s).length;
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } };

/** Боковая панель «IDE»: файлы и папки текущего каталога; открытый файл подсвечен. Папки раскрываются прямо в панели. */
function treeSidebar({ path, listDir, onPick }) {
  let data = null; let q = ''; let error = null;
  const list = h('div', { class: 'fm-tree-list', role: 'list' });
  const dirLabel = h('div', { class: 'fm-tree-dir mono' });
  const filter = h('input', { class: 'input', placeholder: t('Фильтр файлов…'), 'aria-label': t('Фильтр файлов…'), oninput: () => { q = filter.value.trim().toLowerCase(); paint(); } });
  const row = (ic, kind, label, active, fn, title) => h('button', { class: `fm-tree-item${active ? ' active' : ''}`, title, 'aria-current': active ? 'true' : undefined, onclick: fn },
    h('span', { class: `fm-ic fi-${kind}` }, icon(ic, 15)), h('span', { class: 'fm-fname' }, raw(label)));
  function paint() {
    clear(list); dirLabel.textContent = data?.path ?? ''; dirLabel.title = data?.path ?? '';
    if (error) return list.append(h('div', { class: 'fm-tree-msg' }, raw(error)));
    if (!data) return list.append(h('div', { class: 'skeleton', style: { height: '120px' } }));
    if (data.parent != null) list.append(row('up', 'folder', '..', false, () => load(data.parent), data.parent));
    const items = (data.items || []).filter((i) => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    for (const it of items) {
      const full = joinPath(data.path, it.name); const kind = kindOf(it);
      list.append(row(KIND_ICON[kind], kind, it.name, !it.isDir && full === path, it.isDir ? () => load(full) : () => onPick(it, full), full));
    }
    if (!items.length && !data.parent) list.append(h('div', { class: 'fm-tree-msg' }, t('Папка пуста')));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
  async function load(dir) {
    try { data = await listDir(dir); error = null; filter.value = ''; q = ''; } catch (e) { error = e.message; }
    paint();
  }
  const el = h('aside', { class: 'fm-tree', 'aria-label': t('Файлы в папке') },
    h('div', { class: 'fm-tree-head' }, icon('folder', 14), dirLabel), h('div', { class: 'fm-tree-filter' }, filter), list);
  paint(); load(dirOf(path));
  return el;
}

/** Общий каркас: шапка (слева — переключатель панели и возврат к таблице), боковое дерево, рабочая область, строка состояния. */
function ideShell({ cls = '', path, ic, listDir, onPick, onBack, actions, children, status }) {
  const collapsed = lsGet('ea-files-tree-collapsed', false);
  const tree = treeSidebar({ path, listDir, onPick });
  const view = h('div', { class: `fm-editor fm-ide card flush${collapsed ? ' tree-off' : ''} ${cls}` });
  const toggle = h('button', { class: 'btn ghost sm icon', title: t('Боковая панель'), 'aria-label': t('Боковая панель'), 'aria-pressed': String(!collapsed),
    onclick: () => { const off = view.classList.toggle('tree-off'); toggle.setAttribute('aria-pressed', String(!off)); lsSet('ea-files-tree-collapsed', off); } }, icon('sidebar', 16));
  const back = h('button', { class: 'btn ghost sm fm-back', onclick: onBack }, icon('chevron', 14), t('К таблице файлов'));
  view.append(
    h('div', { class: 'fm-editor-head' }, toggle, back, h('div', { class: 'fm-editor-title' }, icon(ic, 16), h('span', { class: 'mono' }, raw(path))), h('div', { class: 'spacer' }), actions),
    h('div', { class: 'fm-ide-body' }, tree, h('div', { class: 'fm-ide-main' }, children)),
    status);
  return view;
}

/** Встроенный редактор: дерево файлов, номера строк, поиск и замена (Ctrl+F / Ctrl+H), переход к строке (Ctrl+G), перенос строк, полный экран, Ctrl+S. */
export function editorView({ panelId, path, data, onClose, listDir, onOpen }) {
  const readOnly = data.size > LIMITS.edit;
  let saved = data.content; let saving = false; let wrap = lsGet('ea-files-wrap', false);
  const ta = h('textarea', { class: 'fm-text', spellcheck: 'false', wrap: 'off', autocapitalize: 'off', readonly: readOnly || undefined, 'aria-label': path });
  ta.value = data.content;
  const gutter = h('pre', { class: 'fm-gutter', 'aria-hidden': 'true' });
  const stLines = h('span'); const stSize = h('span'); const stPos = h('span'); const stSave = h('span', { class: 'fm-save' });
  const saveBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => save() }, icon('save', 15), t('Сохранить'));
  const dirty = () => ta.value !== saved;

  function refresh() {
    const lines = ta.value.split('\n').length;
    if (gutter.dataset.n !== String(lines)) { gutter.dataset.n = String(lines); gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n'); }
    stLines.textContent = `${t('Строк')}: ${lines}`;
    stSize.textContent = sizeText(bytesOf(ta.value));
    const before = ta.value.slice(0, ta.selectionStart).split('\n');
    stPos.textContent = `${t('Стр.')} ${before.length}, ${t('кол.')} ${before.at(-1).length + 1}`;
    const d = dirty();
    saveBtn.disabled = !d || saving || readOnly;
    stSave.className = `fm-save ${saving ? 'busy' : d ? 'warn' : 'ok'}`;
    stSave.textContent = readOnly ? t('Только чтение (файл больше 1 МБ)') : saving ? t('Сохранение…') : d ? t('Есть несохранённые изменения') : t('Сохранено');
  }
  async function save() {
    if (readOnly || saving || !dirty()) return;
    const content = ta.value; saving = true; refresh();
    try {
      await post(`/api/panels/${panelId}/files/write`, { path, content });
      saved = content; toast(`${t('Сохранено')}: ${baseName(path)}`, 'success');
    } catch (e) { toast(e.message, 'error'); } finally { saving = false; refresh(); }
  }

  /* ---------- прокрутка к позиции: «зеркало» textarea измеряет координаты с учётом переноса строк ---------- */
  function scrollToIndex(i) {
    const cs = getComputedStyle(ta); const mirror = h('div', { 'aria-hidden': 'true' });
    for (const k of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom']) mirror.style[k] = cs[k];
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '0', whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: 'break-word', boxSizing: 'content-box', width: wrap ? `${ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px` : 'auto' });
    const mark = h('span', null, '\u200b'); mirror.append(raw(ta.value.slice(0, i)), mark);
    ta.parentElement.append(mirror);
    const top = mark.offsetTop; const left = mark.offsetLeft; const lh = parseFloat(cs.lineHeight) || 20;
    mirror.remove();
    if (top < ta.scrollTop + lh || top > ta.scrollTop + ta.clientHeight - 2 * lh) ta.scrollTop = Math.max(0, top - ta.clientHeight / 2 + lh);
    if (!wrap && (left < ta.scrollLeft || left > ta.scrollLeft + ta.clientWidth - 60)) ta.scrollLeft = Math.max(0, left - ta.clientWidth / 2);
    gutter.scrollTop = ta.scrollTop;
  }

  /* ---------- поиск и замена ---------- */
  let matches = []; let cur = -1; let timer = 0;
  const findInput = h('input', { class: 'input', placeholder: t('Найти в файле…'), 'aria-label': t('Найти в файле…'), spellcheck: 'false', autocomplete: 'off', oninput: () => recompute(true) });
  const replInput = h('input', { class: 'input', placeholder: t('Заменить на…'), 'aria-label': t('Заменить на…'), spellcheck: 'false', autocomplete: 'off',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } } });
  const counter = h('span', { class: 'fm-find-count', 'aria-live': 'polite' });
  const caseBtn = h('button', { class: 'btn ghost sm icon fm-find-case', title: t('Учитывать регистр'), 'aria-label': t('Учитывать регистр'), 'aria-pressed': 'false',
    onclick: () => { caseBtn.setAttribute('aria-pressed', String(caseBtn.getAttribute('aria-pressed') !== 'true')); recompute(true); } }, 'Aa');
  const iconBtn = (ic, label, fn, extra = {}) => h('button', { class: 'btn ghost sm icon', title: label, 'aria-label': label, onclick: fn, ...extra }, icon(ic, 15));
  const replToggle = iconBtn('chevron', t('Заменить'), () => showReplace(replRow.hidden), { class: 'btn ghost sm icon fm-find-expand', 'aria-expanded': 'false' });
  const replRow = h('div', { class: 'fm-find-row', hidden: true }, replInput,
    h('button', { class: 'btn sm', onclick: () => replaceOne() }, t('Заменить')), h('button', { class: 'btn sm', onclick: () => replaceEverywhere() }, t('Все')));
  const findBar = h('div', { class: 'fm-find', hidden: true, role: 'search' },
    h('div', { class: 'fm-find-row' }, readOnly ? null : replToggle, findInput, counter, caseBtn,
      iconBtn('up', t('Предыдущее совпадение'), () => step(-1)), iconBtn('down', t('Следующее совпадение'), () => step(1)), iconBtn('x', t('Закрыть поиск'), () => closeFind())),
    readOnly ? null : replRow);
  const matchCase = () => caseBtn.getAttribute('aria-pressed') === 'true';

  function paintCount() {
    const q = findInput.value;
    counter.textContent = !q ? '' : matches.length ? t(`${cur + 1} из ${matches.length}`) : t('Не найдено');
    findInput.classList.toggle('bad', !!q && !matches.length);
  }
  function selectMatch(i) {
    cur = i; const s = matches[i]; if (s == null) return paintCount();
    ta.setSelectionRange(s, s + findInput.value.length); scrollToIndex(s); paintCount(); refresh();
  }
  /** Пересчёт совпадений; jump — сразу перейти к ближайшему от курсора. */
  function recompute(jump) {
    matches = findAll(ta.value, findInput.value, { matchCase: matchCase() });
    cur = pickMatch(matches, ta.selectionStart, 1);
    if (jump && cur >= 0) selectMatch(cur); else paintCount();
  }
  function step(dir) {
    if (findBar.hidden) return openFind();
    if (!matches.length) return recompute(false);
    // после правок курсор мог сместиться: отталкиваемся от текущего выделения
    const onCur = matches[cur] != null && ta.selectionStart === matches[cur] && ta.selectionEnd === matches[cur] + findInput.value.length;
    selectMatch(onCur ? (cur + dir + matches.length) % matches.length : pickMatch(matches, dir > 0 ? ta.selectionEnd : ta.selectionStart, dir));
  }
  function showReplace(on) {
    if (readOnly) return;
    replRow.hidden = !on; replToggle.setAttribute('aria-expanded', String(on)); findBar.classList.toggle('repl', on);
  }
  function openFind(withReplace = false) {
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes('\n') && sel.length <= 200) findInput.value = sel;
    findBar.hidden = false; if (withReplace) showReplace(true);
    recompute(!!findInput.value); (withReplace && findInput.value ? replInput : findInput).focus(); findInput.select();
  }
  function closeFind() {
    if (findBar.hidden) return;
    findBar.hidden = true; ta.focus();
  }
  function replaceOne() {
    if (readOnly || !findInput.value) return;
    const s = matches[cur]; const len = findInput.value.length;
    if (s == null || ta.selectionStart !== s || ta.selectionEnd !== s + len) return step(1); // сначала выбираем совпадение
    ta.setRangeText(replInput.value, s, s + len, 'end');
    matches = findAll(ta.value, findInput.value, { matchCase: matchCase() });
    const next = pickMatch(matches, s + replInput.value.length, 1);
    refresh(); if (next >= 0) selectMatch(next); else { cur = -1; paintCount(); }
  }
  function replaceEverywhere() {
    if (readOnly || !findInput.value) return;
    const [v, n] = replaceAllIn(ta.value, findInput.value, replInput.value, { matchCase: matchCase() });
    if (!n) return paintCount();
    ta.value = v; refresh(); recompute(false); toast(t(`Заменено: ${n}`), 'success');
  }
  findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } });

  /* ---------- переход к строке ---------- */
  const gotoInput = h('input', { class: 'input mono', type: 'number', min: '1', inputmode: 'numeric', 'aria-label': t('Перейти к строке'),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); jumpToLine(); } } });
  const gotoBar = h('div', { class: 'fm-goto', hidden: true }, gotoInput, h('button', { class: 'btn primary sm', onclick: () => jumpToLine() }, t('Перейти')), iconBtn('x', t('Закрыть'), () => closeGoto()));
  function openGoto() {
    const n = ta.value.split('\n').length; gotoInput.max = String(n); gotoInput.placeholder = t(`Строка (1–${n})`);
    gotoBar.hidden = false; gotoInput.value = ''; gotoInput.focus();
  }
  function closeGoto() { if (gotoBar.hidden) return; gotoBar.hidden = true; ta.focus(); }
  function jumpToLine() {
    const line = Number(gotoInput.value); if (!Number.isFinite(line) || line < 1) return gotoInput.focus();
    const idx = lineStart(ta.value, line); const end = ta.value.indexOf('\n', idx);
    gotoBar.hidden = true; ta.focus(); ta.setSelectionRange(idx, end === -1 ? ta.value.length : end);
    scrollToIndex(idx); refresh();
  }

  /* ---------- перенос строк и полный экран ---------- */
  const wrapBtn = h('button', { class: 'fm-status-btn', onclick: () => setWrap(!wrap) });
  function setWrap(on) {
    wrap = on; lsSet('ea-files-wrap', on); ta.setAttribute('wrap', on ? 'soft' : 'off');
    view.classList.toggle('fm-wrap', on);
    wrapBtn.replaceChildren(icon('wrapText', 13), raw(on ? t('Перенос строк: вкл') : t('Перенос строк: выкл')));
    wrapBtn.setAttribute('aria-pressed', String(on)); wrapBtn.title = t('Перенос строк');
    if (!on) ta.scrollLeft = 0;
  }
  const fsBtn = iconBtn('maximize', t('Полный экран'), () => setFullscreen(!view.classList.contains('fm-fs')));
  function setFullscreen(on) {
    view.classList.toggle('fm-fs', on); const label = on ? t('Выйти из полноэкранного режима') : t('Полный экран');
    fsBtn.replaceChildren(icon(on ? 'minimize' : 'maximize', 15)); fsBtn.title = label; fsBtn.setAttribute('aria-label', label);
  }

  ta.addEventListener('input', () => { refresh(); if (!findBar.hidden) { clearTimeout(timer); timer = setTimeout(() => recompute(false), 150); } });
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, refresh);
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !readOnly && !e.shiftKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); refresh(); }
  });
  const guard = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', guard);
  const close = async () => {
    if (dirty() && !(await confirmDialog({ title: 'Закрыть без сохранения?', message: 'Несохранённые изменения будут потеряны.', confirmText: 'Закрыть', danger: true }))) return;
    window.removeEventListener('beforeunload', guard); onClose();
  };
  /** Переключение на другой файл из дерева: при несохранённых правках — подтверждение. */
  async function pick(it, full) {
    if (full === path) return;
    if (dirty() && !(await confirmDialog({ title: 'Открыть другой файл?', message: 'Несохранённые изменения в этом файле будут потеряны.', confirmText: 'Открыть', danger: true }))) return;
    if (await onOpen(it, full)) window.removeEventListener('beforeunload', guard);
  }

  const view = ideShell({ cls: 'fm-code', path, ic: 'fileCode', listDir, onPick: pick, onBack: close,
    actions: [iconBtn('search', `${t('Найти в файле…')} (Ctrl+F)`, () => openFind()), iconBtn('hash', `${t('Перейти к строке')} (Ctrl+G)`, () => openGoto()), fsBtn, saveBtn],
    children: [findBar, gotoBar, h('div', { class: 'fm-editor-body' }, gutter, ta)],
    status: h('div', { class: 'fm-statusbar' }, stLines, stSize, stPos, h('span', { class: 'spacer' }), stSave, wrapBtn, h('kbd', null, 'Ctrl+S')) });
  view.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
    if (mod && !e.altKey && k === 's') { e.preventDefault(); save(); }
    else if (mod && !e.altKey && k === 'f') { e.preventDefault(); openFind(); }
    else if (mod && !e.altKey && k === 'h' && !readOnly) { e.preventDefault(); openFind(true); }
    else if (mod && !e.altKey && k === 'g') { e.preventDefault(); openGoto(); }
    else if (k === 'escape') {
      if (!findBar.hidden) { e.preventDefault(); closeFind(); } else if (!gotoBar.hidden) { e.preventDefault(); closeGoto(); } else if (view.classList.contains('fm-fs')) { e.preventDefault(); setFullscreen(false); }
    }
  });
  setWrap(wrap); refresh();
  setTimeout(() => ta.focus(), 30);
  return view;
}

/** Просмотр картинки (png, jpg, gif, webp, svg…): данные приходят как base64 и показываются через data:-адрес. */
export function imageView({ path, data, onClose, onDownload, listDir, onOpen }) {
  const src = `data:${data.mime};base64,${data.content}`;
  return ideShell({ cls: 'fm-imgview', path, ic: 'image', listDir, onPick: (it, full) => { if (full !== path) onOpen(it, full); }, onBack: onClose,
    actions: h('button', { class: 'btn', onclick: onDownload }, icon('download', 15), t('Скачать')),
    children: h('div', { class: 'fm-image' }, h('img', { src, alt: baseName(path) })),
    status: h('div', { class: 'fm-statusbar' }, h('span', null, sizeText(data.size)), h('span', { class: 'spacer' }), h('span', { class: 'mono' }, data.mime)) });
}
