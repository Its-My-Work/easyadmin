import { api, get, post } from './api.js';
import { empty } from './components.js';
import { fmtServer } from './clock.js';
import { clear, confirmDialog, field, h, icon, modal, spinner, toast } from './dom.js';
import { editorView, imageView } from './files-editor.js';
import { DEFAULT_PATH, KIND_ICON, LIMITS, QUICK_JUMPS, baseName, bytesToB64, crumbs, fmtSize, isImage, joinPath, kindOf, rwx } from './files-util.js';
import { t } from './i18n.js';
import { store } from './store.js';

/* Файловый менеджер хоста панели. Состояние живёт на уровне модуля: страница перерисовывается при смене маршрута, а панель и папка помнятся. */
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } };
const S = { panelId: lsGet('ea-files-panel', null), paths: lsGet('ea-files-paths', {}), data: null, error: null, loading: false, filter: '', busy: null, seq: 0 };

const raw = (s) => document.createTextNode(s); // имена файлов не переводятся
const sizeText = (n) => { const [v, u] = fmtSize(n); return `${v} ${t(u)}`; };
const url = (suffix, id = S.panelId) => `/api/panels/${id}/files${suffix}`;
const qp = (p, extra = '') => `?path=${encodeURIComponent(p)}${extra}`;
/** Палитра команд: открыть файлы на нужной панели и каталоге (страница подхватит состояние при построении). */
export function jumpFiles(panelId, path) {
  S.panelId = panelId; lsSet('ea-files-panel', panelId); S.data = null; S.filter = '';
  if (path) { S.paths[panelId] = path; lsSet('ea-files-paths', S.paths); }
}
const curPath = () => S.data?.path ?? S.paths[S.panelId] ?? DEFAULT_PATH;
const fmtDate = (ts) => (ts ? fmtServer(ts, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

/** Короткий диалог с одним полем; null — отмена. */
function ask({ title, label, value = '', confirmText = 'Создать', hint }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input mono', value, spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Enter') m.el.querySelector('.modal-foot .btn:last-child').click(); } });
    const m = modal({ title, compact: true, body: field(label, input, hint), onClose: () => resolve(null),
      actions: [{ label: 'Отмена', kind: 'ghost' }, { label: confirmText, kind: 'primary', onClick: () => { const v = input.value.trim(); if (!v) return false; resolve(v); } }] });
    setTimeout(() => { input.focus(); input.setSelectionRange(0, value.includes('.') ? value.lastIndexOf('.') : value.length); }, 40);
  });
}

function chmodModal(path, it, done) {
  const input = h('input', { class: 'input mono', value: it.mode.slice(-4).replace(/^0+(?=\d{3})/, ''), maxlength: 4, spellcheck: 'false' });
  const preview = h('code', { class: 'fm-rwx' }); const rec = it.isDir ? h('input', { type: 'checkbox' }) : null;
  const upd = () => { preview.textContent = /^[0-7]{3,4}$/.test(input.value) ? rwx(input.value) : '—'; };
  input.addEventListener('input', upd); upd();
  modal({ title: 'Права доступа', compact: true,
    body: h('div', { class: 'stack' }, h('div', { class: 'mono' }, raw(path)), field('Права (восьмеричные)', input, 'Например 644 для файла, 755 для папки.'), h('div', { class: 'inline' }, h('span', { class: 'muted' }, t('Вид') + ':'), preview),
      rec ? h('label', { class: 'inline' }, rec, t('Применить ко всему содержимому папки')) : null),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Применить', kind: 'primary', onClick: async () => {
      if (!/^[0-7]{3,4}$/.test(input.value)) { toast(t('Права: 3–4 восьмеричные цифры, например 644'), 'error'); return false; }
      await post(url('/chmod'), { path, mode: input.value, recursive: !!rec?.checked }); toast(t('Права изменены'), 'success'); done();
    } }] });
}

export function filesPage() {
  const panels = store.panels;
  if (!panels.some((p) => p.id === S.panelId)) S.panelId = panels[0]?.id ?? null;
  const swatch = h('i', { class: 'swatch lg' });
  const select = h('select', { class: 'input fm-panel-select', 'aria-label': 'Панель', onchange: () => switchPanel(Number(select.value)) }, panels.map((p) => h('option', { value: p.id, selected: p.id === S.panelId }, raw(p.name))));
  const crumbBar = h('div', { class: 'fm-crumbs' }); const listBox = h('div'); const statusLine = h('div', { class: 'fm-info muted small' });
  const filterInput = h('input', { class: 'input', placeholder: 'Фильтр в этой папке…', 'aria-label': 'Фильтр', value: S.filter, oninput: () => { S.filter = filterInput.value; renderList(); } });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { uploadFiles([...fileInput.files]); fileInput.value = ''; } });
  const browser = h('div', { class: 'stack' });
  const page = h('div', { class: 'page fm' });

  const btn = (ic, label, fn, cls = '') => h('button', { class: `btn sm ${cls}`, onclick: fn, title: label }, icon(ic, 14), h('span', { class: 'fm-btn-t' }, label));
  const quick = h('div', { class: 'chips fm-quick' }, QUICK_JUMPS.map(([label, p, ic]) => h('button', { class: `chip-btn ${curPath() === p ? 'on' : ''}`, onclick: () => go(p) }, icon(ic, 13), ' ', label)));
  const toolbar = h('div', { class: 'fm-toolbar' },
    btn('filePlus', 'Новый файл', newFile), btn('folderPlus', 'Новая папка', newFolder), btn('upload', 'Загрузить', () => fileInput.click()),
    btn('archive', 'Скачать архивом (tar.gz)', () => download(curPath(), true)), btn('refresh', 'Обновить', () => load()), fileInput);

  function paintHead() {
    const p = panels.find((x) => x.id === S.panelId); swatch.style.background = p?.color ?? 'transparent';
    clear(crumbBar).append(...crumbs(curPath()).flatMap((c, i, a) => [i ? h('span', { class: 'fm-sep' }, '/') : null,
      h('button', { class: `fm-crumb ${i === a.length - 1 ? 'last' : ''}`, onclick: () => go(c.path), title: c.path }, i === 0 ? icon('home', 14) : raw(c.name))]),
    h('button', { class: 'btn icon ghost sm fm-edit-path', title: 'Ввести путь вручную', 'aria-label': 'Ввести путь вручную', onclick: typePath }, icon('edit', 14)));
    quick.querySelectorAll('.chip-btn').forEach((b, i) => b.classList.toggle('on', QUICK_JUMPS[i][1] === curPath()));
  }
  function typePath() {
    const input = h('input', { class: 'input mono', value: curPath(), spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Enter') go(input.value.trim() || '/'); if (e.key === 'Escape') paintHead(); } });
    clear(crumbBar).append(input, h('button', { class: 'btn primary sm', onclick: () => go(input.value.trim() || '/') }, t('Перейти')), h('button', { class: 'btn ghost sm', onclick: paintHead }, t('Отмена')));
    input.focus(); input.select();
  }

  async function load(path = curPath()) {
    if (S.panelId == null) return;
    const seq = ++S.seq; S.loading = true; S.error = null; renderList(); paintHead();
    try {
      const d = await get(url(`/list${qp(path)}`));
      if (seq !== S.seq) return;
      S.data = d; S.paths[S.panelId] = d.path; lsSet('ea-files-paths', S.paths);
    } catch (e) { if (seq !== S.seq) return; S.error = e.message; S.data = null; S.paths[S.panelId] = path; }
    finally { if (seq === S.seq) { S.loading = false; renderList(); paintHead(); } }
  }
  const go = (p) => { S.filter = ''; filterInput.value = ''; S.paths[S.panelId] = p.startsWith('/') ? p : `/${p}`; S.data = null; return load(S.paths[S.panelId]); };
  function switchPanel(id) {
    S.panelId = id; lsSet('ea-files-panel', id); S.data = null; S.filter = ''; filterInput.value = '';
    load(S.paths[id] ?? DEFAULT_PATH);
  }

  function actionBtn(ic, label, fn, danger) { return h('button', { class: `btn icon ghost sm ${danger ? 'fm-danger' : ''}`, title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic, 14)); }
  function rowFor(it) {
    const full = joinPath(S.data.path, it.name); const kind = kindOf(it);
    const open = () => (it.isDir ? go(full) : openFile(it, full));
    return h('tr', { class: 'row fm-row' },
      h('td', { class: 'fm-name' }, h('button', { class: 'fm-link', onclick: open, title: full }, h('span', { class: `fm-ic fi-${kind}` }, icon(KIND_ICON[kind], 17)), h('span', { class: 'fm-fname' }, raw(it.name)), it.isLink ? h('span', { class: 'chip fm-chip' }, '→') : null)),
      h('td', { class: 'fm-size nowrap' }, it.isDir ? '—' : sizeText(it.size)),
      h('td', { class: 'fm-mode' }, h('code', { title: rwx(it.mode) }, it.mode)),
      h('td', { class: 'fm-date nowrap muted' }, fmtDate(it.mtime)),
      h('td', { class: 'fm-actions' },
        it.isDir ? null : actionBtn(isImage(it.name) ? 'eye' : 'edit', isImage(it.name) ? 'Открыть' : 'Редактировать', open),
        actionBtn('download', it.isDir ? 'Скачать архивом (tar.gz)' : 'Скачать', () => download(full, it.isDir)),
        actionBtn('rename', 'Переименовать', () => rename(it, full)), actionBtn('lock', 'Права доступа', () => chmodModal(full, it, () => load())),
        actionBtn('trash', 'Удалить', () => remove(it, full), true)));
  }
  function renderList() {
    clear(listBox);
    if (S.panelId == null) return listBox.append(empty('Нет панелей', 'Добавьте панель Easypanel, чтобы работать с файлами её сервера.'));
    if (S.loading && !S.data) return listBox.append(h('div', { class: 'skeleton card', style: { height: '220px' } }));
    if (S.error) return listBox.append(h('div', { class: 'callout err' }, icon('alert'), raw(S.error), h('button', { class: 'btn sm', onclick: () => load() }, t('Повторить'))));
    const q = S.filter.trim().toLowerCase(); const items = S.data.items.filter((i) => !q || i.name.toLowerCase().includes(q));
    statusLine.textContent = `${t('Папок')}: ${S.data.items.filter((i) => i.isDir).length} · ${t('Файлов')}: ${S.data.items.filter((i) => !i.isDir).length}${S.data.truncated ? ` · ${t('показаны не все элементы')}` : ''}${S.busy ? ` · ${S.busy}` : ''}`;
    const up = S.data.parent == null ? null : h('tr', { class: 'row fm-row' }, h('td', { class: 'fm-name', colspan: 5 }, h('button', { class: 'fm-link', onclick: () => go(S.data.parent) }, h('span', { class: 'fm-ic fi-folder' }, icon('up', 17)), h('span', { class: 'fm-fname' }, '..'))));
    listBox.append(h('div', { class: 'fm-table-wrap' }, h('table', { class: 'tbl fm-table' },
      h('thead', null, h('tr', null, ['Название', 'Размер', 'Права', 'Изменён', ''].map((c, i) => h('th', { class: `fm-th-${i}` }, c)))),
      h('tbody', null, up, items.map(rowFor)))), items.length || up ? null : empty(q ? 'Ничего не найдено' : 'Папка пуста', q ? 'Измените фильтр.' : 'Создайте файл или перетащите сюда файлы для загрузки.'));
    if (S.loading) listBox.classList.add('fm-loading'); else listBox.classList.remove('fm-loading');
  }

  /* ---------- действия ---------- */
  const fail = (e) => toast(e.message, 'error');
  async function newFile() {
    const name = await ask({ title: 'Новый файл', label: 'Имя файла', confirmText: 'Создать' }); if (!name) return;
    try { const r = await post(url('/touch'), { path: curPath(), name }); await load(); openFile({ name, size: 0 }, r.path); } catch (e) { fail(e); }
  }
  async function newFolder() {
    const name = await ask({ title: 'Новая папка', label: 'Имя папки', confirmText: 'Создать' }); if (!name) return;
    try { await post(url('/mkdir'), { path: curPath(), name }); toast(t('Папка создана'), 'success'); load(); } catch (e) { fail(e); }
  }
  async function rename(it, full) {
    const name = await ask({ title: 'Переименовать', label: 'Новое имя', value: it.name, confirmText: 'Переименовать', hint: 'Можно указать полный путь, чтобы переместить.' }); if (!name || name === it.name) return;
    try { await post(url('/rename'), { oldPath: full, newPath: name.startsWith('/') ? name : joinPath(curPath(), name) }); toast(t('Переименовано'), 'success'); load(); } catch (e) { fail(e); }
  }
  async function remove(it, full) {
    if (!(await confirmDialog({ title: it.isDir ? 'Удалить папку?' : 'Удалить файл?', message: h('span', null, t('Будет удалено безвозвратно:'), ' ', h('code', null, raw(full))), confirmText: 'Удалить', danger: true }))) return;
    try { await api('DELETE', url(''), { path: full }); toast(t('Удалено'), 'success'); load(); } catch (e) { fail(e); }
  }
  async function download(p, archive) {
    toast(t('Готовим скачивание…'));
    try {
      const res = await fetch(url(`/download${qp(p, archive ? '&archive=1' : '')}`), { credentials: 'same-origin' });
      if (!res.ok) { let msg = `Ошибка ${res.status}`; try { msg = (await res.json()).error || msg; } catch { /* не JSON */ } throw new Error(msg); }
      const blob = await res.blob(); const a = h('a', { href: URL.createObjectURL(blob), download: archive ? `${baseName(p)}.tar.gz` : baseName(p) });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) { fail(e); }
  }
  async function openFile(it, full) {
    if (it.size > LIMITS.edit * 5) return toast(t('Файл слишком большой для просмотра — скачайте его'), 'error');
    S.busy = t('Открываем файл…'); renderList();
    try {
      const d = await get(url(`/read${qp(full)}`));
      if (d.mime && d.binary) showView(imageView({ path: full, data: d, onClose: closeView, onDownload: () => download(full, false) }));
      else if (d.binary) toast(t('Бинарный файл нельзя открыть в редакторе — скачайте его'), 'error');
      else showView(editorView({ panelId: S.panelId, path: full, data: d, onClose: () => { closeView(); load(); } }));
    } catch (e) { fail(e); } finally { S.busy = null; if (S.data) renderList(); }
  }
  const showView = (node) => { browser.hidden = true; page.append(node); node.dataset.view = '1'; window.scrollTo(0, 0); };
  const closeView = () => { page.querySelector('[data-view]')?.remove(); browser.hidden = false; };

  async function uploadFiles(files) {
    if (!files.length || S.panelId == null) return;
    for (const f of files) {
      if (f.size > LIMITS.upload) { toast(`${f.name}: ${t('файл больше 4 МБ — загрузите его другим способом')}`, 'error'); continue; }
      S.busy = `${t('Загрузка')}: ${f.name}`; renderList();
      try {
        const content = bytesToB64(new Uint8Array(await f.arrayBuffer())); const body = { path: curPath(), name: f.name, content };
        try { await post(url('/upload'), body); }
        catch (e) {
          if (e.status !== 409) throw e;
          if (!(await confirmDialog({ title: 'Файл уже существует', message: h('span', null, t('Заменить файл'), ' ', h('code', null, raw(f.name)), '?'), confirmText: 'Заменить', danger: true }))) continue;
          await post(url('/upload'), { ...body, overwrite: true });
        }
        toast(`${t('Загружено')}: ${f.name}`, 'success');
      } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); }
    }
    S.busy = null; load();
  }

  // drag-and-drop
  let depth = 0;
  const drop = h('div', { class: 'fm-drop' }, icon('upload', 28), h('div', null, t('Отпустите файлы, чтобы загрузить в эту папку')));
  const zone = h('div', { class: 'fm-zone',
    ondragenter: (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; zone.classList.add('over'); } },
    ondragleave: () => { if (--depth <= 0) { depth = 0; zone.classList.remove('over'); } },
    ondragover: (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); },
    ondrop: (e) => { e.preventDefault(); depth = 0; zone.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); } },
  listBox, drop);

  browser.append(
    h('div', { class: 'card fm-head' }, h('div', { class: 'fm-panelpick' }, swatch, select), quick),
    h('div', { class: 'card fm-main' }, crumbBar, h('div', { class: 'fm-bar' }, h('div', { class: 'input-icon' }, icon('search', 15), filterInput), toolbar), zone, statusLine));
  page.append(h('div', { class: 'page-head' }, h('h1', null, 'Файлы')), browser);
  paintHead(); renderList(); load();
  return page;
}
