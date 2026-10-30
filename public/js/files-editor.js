import { post } from './api.js';
import { confirmDialog, h, icon, toast } from './dom.js';
import { t } from './i18n.js';
import { LIMITS, baseName, fmtSize } from './files-util.js';

const raw = (s) => document.createTextNode(s);
const sizeText = (n) => { const [v, u] = fmtSize(n); return `${v} ${t(u)}`; };
const bytesOf = (s) => new TextEncoder().encode(s).length;

/** Встроенный редактор: моноширинный текст, номера строк, строка состояния, Ctrl+S / Cmd+S. */
export function editorView({ panelId, path, data, onClose }) {
  const readOnly = data.size > LIMITS.edit;
  let saved = data.content; let saving = false;
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
  ta.addEventListener('input', refresh);
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, refresh);
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.key === 'Tab' && !readOnly && !e.shiftKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); refresh(); }
  });
  const guard = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', guard);
  const close = async () => {
    if (dirty() && !(await confirmDialog({ title: 'Закрыть без сохранения?', message: 'Несохранённые изменения будут потеряны.', confirmText: 'Закрыть', danger: true }))) return;
    window.removeEventListener('beforeunload', guard); onClose();
  };
  const view = h('div', { class: 'fm-editor card flush' },
    h('div', { class: 'fm-editor-head' },
      h('button', { class: 'btn ghost sm', onclick: close }, icon('chevron', 14), t('К списку')),
      h('div', { class: 'fm-editor-title' }, icon('fileCode', 16), h('span', { class: 'mono' }, raw(path))),
      h('div', { class: 'spacer' }), saveBtn),
    h('div', { class: 'fm-editor-body' }, gutter, ta),
    h('div', { class: 'fm-statusbar' }, stLines, stSize, stPos, h('span', { class: 'spacer' }), stSave, h('kbd', null, 'Ctrl+S')));
  refresh();
  setTimeout(() => ta.focus(), 30);
  return view;
}

/** Просмотр картинки (png, jpg, gif, webp, svg…): данные приходят как base64 и показываются через data:-адрес. */
export function imageView({ path, data, onClose, onDownload }) {
  const src = `data:${data.mime};base64,${data.content}`;
  return h('div', { class: 'fm-editor card flush' },
    h('div', { class: 'fm-editor-head' },
      h('button', { class: 'btn ghost sm', onclick: onClose }, icon('chevron', 14), t('К списку')),
      h('div', { class: 'fm-editor-title' }, icon('image', 16), h('span', { class: 'mono' }, raw(path))),
      h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: onDownload }, icon('download', 15), t('Скачать'))),
    h('div', { class: 'fm-image' }, h('img', { src, alt: baseName(path) })),
    h('div', { class: 'fm-statusbar' }, h('span', null, sizeText(data.size)), h('span', { class: 'spacer' }), h('span', { class: 'mono' }, data.mime)));
}
