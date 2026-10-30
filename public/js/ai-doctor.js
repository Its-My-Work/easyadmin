import { get, post } from './api.js';
import { clear, confirmDialog, field, h, icon, modal, spinner, toast } from './dom.js';
import { lang, t } from './i18n.js';
import { runServiceAction } from './components.js';
import { can } from './store.js';
import { splitVerdict } from './ai-verdict.js';

/**
 * AI Doctor: модальное окно с потоковым разбором сбоя сервиса (SSE через fetch + ReadableStream),
 * структурированный вердикт и кнопка применения решения; карточка настроек AI-провайдера.
 */

const SECTIONS = [['what', 'Что случилось', 'activity'], ['cause', 'Причина', 'alert'], ['fix', 'Решение', 'check']];
const ACTION_LABEL = { restart: 'Перезапустить сервис', start: 'Запустить сервис' };

/* ---------- безопасный мини-markdown на h(): без innerHTML, ссылки не кликабельны ---------- */
function inline(text) {
  const out = [];
  for (const part of String(text).split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (!part) continue;
    if (part.startsWith('`') && part.length > 2) out.push(h('code', null, part.slice(1, -1)));
    else if (part.startsWith('**') && part.length > 4) out.push(h('b', null, part.slice(2, -2)));
    else out.push(part);
  }
  return out;
}

export function renderMarkdown(src) {
  const root = h('div', { class: 'ai-md' });
  let list = null, code = null;
  for (const line of String(src ?? '').split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) { root.append(h('pre', { class: 'ai-code' }, code.join('\n'))); code = null; } else { code = []; list = null; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const li = /^\s*(?:(\d+)[.)]|[-*•])\s+(.*)$/.exec(line);
    if (li) {
      const tag = li[1] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag, null); root.append(list); }
      list.append(h('li', null, ...inline(li[2])));
    } else if (line.trim()) { list = null; root.append(h('p', null, ...inline(line))); } else list = null;
  }
  if (code) root.append(h('pre', { class: 'ai-code' }, code.join('\n')));
  return root;
}

/* ---------- разбор SSE-потока ---------- */
export async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      let event = 'message'; const data = [];
      for (const l of block.split(/\r?\n/)) {
        if (l.startsWith('event:')) event = l.slice(6).trim(); else if (l.startsWith('data:')) data.push(l.slice(5).trim());
      }
      if (data.length) { try { onEvent(event, JSON.parse(data.join('\n'))); } catch { /* битый кадр */ } }
    }
  }
}

function serviceRef(s) {
  return { panelId: s.panelId ?? s.panel?.id, project: s.project, name: s.name, type: s.type, panel: s.panel };
}

/** Открывает окно диагностики сервиса. `s` — как в drawer: { panel, panelId, project, name, type }. */
export function openAiDoctor(s) {
  const ref = serviceRef(s);
  const status = h('div', { class: 'ai-status' });
  const facts = h('div', { class: 'ai-facts' });
  const typed = h('div', { class: 'ai-typed', 'aria-live': 'polite' });
  const verdictBox = h('div', { class: 'ai-verdict stack' });
  const actionBox = h('div', { class: 'ai-actions' });
  const body = h('div', { class: 'stack ai-doctor' }, status, facts, typed, verdictBox, actionBox);
  let abort = null, closed = false;

  const m = modal({
    title: `AI Doctor · ${ref.project}/${ref.name}`, body, wide: true, onClose: () => { closed = true; abort?.abort(); },
    actions: [
      { label: 'Диагностировать заново', kind: 'ghost', close: false, onClick: () => { run(true); return false; } },
      { label: 'Закрыть', kind: 'primary' },
    ],
  });

  const showStatus = (kind, text, spin) => clear(status).append(h('div', { class: `ai-pill ${kind}` }, spin ? spinner(13) : icon(kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : 'activity', 14), text));

  function drawFacts(meta) {
    const c = meta.containers[0];
    clear(facts).append(
      h('span', { class: 'chip' }, `${t('Контейнеры')}: ${meta.containers.length}`),
      c ? h('span', { class: `chip ${c.state === 'running' ? '' : 'bad'}` }, `${t('Состояние')}: ${c.state}`) : null,
      c?.exitCode != null ? h('span', { class: `chip ${c.exitCode ? 'bad' : ''}` }, `${t('Код выхода')}: ${c.exitCode}`) : null,
      meta.metrics?.mem != null ? h('span', { class: 'chip' }, `RAM: ${Math.round(meta.metrics.mem)} MB`) : null,
      meta.metrics?.cpu != null ? h('span', { class: 'chip' }, `CPU: ${Math.round(meta.metrics.cpu * 10) / 10}%`) : null,
      h('span', { class: 'chip' }, `${t('Строк лога')}: ${meta.logLines}`));
  }

  function drawVerdict(v) {
    clear(verdictBox).append(...SECTIONS.filter(([k]) => v[k]).map(([k, label, ic]) => h('section', { class: `ai-sec ai-${k}` },
      h('h4', null, icon(ic, 15), label), renderMarkdown(v[k]))));
    clear(actionBox);
    if (v.action !== 'none' && ACTION_LABEL[v.action] && can('operator')) {
      actionBox.append(h('button', { class: 'btn primary', onclick: async () => {
        const ok = await confirmDialog({ title: ACTION_LABEL[v.action], message: `${t('Предложено AI. Действие будет выполнено для сервиса')} «${ref.project}/${ref.name}».`, confirmText: 'Применить' });
        if (!ok) return;
        const done = await runServiceAction(ref, v.action);
        if (done) { toast('Готово', 'success'); m.close(); }
      } }, icon(v.action === 'restart' ? 'rotate' : 'play', 14), ACTION_LABEL[v.action]));
    }
  }

  async function run(refresh = false) {
    abort?.abort(); abort = new AbortController();
    const ctl = abort;
    clear(facts); clear(typed); clear(verdictBox); clear(actionBox);
    showStatus('', 'Собираем логи и состояние контейнера…', true);
    let text = '', cached = false, finished = false, pending = false;
    // вывод батчится по кадрам: модель присылает токены чаще, чем браузер успевает перерисовывать
    const paint = () => {
      pending = false;
      const v = splitVerdict(text);
      const structured = !!(v.what || v.cause || v.fix) && /^\s*#/m.test(text);
      typed.hidden = structured; // пока модель не начала первый раздел — показываем сырой поток
      if (structured) drawVerdict({ ...v, action: 'none' }); else typed.textContent = text;
      verdictBox.classList.toggle('streaming', !finished);
    };
    try {
      const q = new URLSearchParams({ panelId: ref.panelId, project: ref.project, service: ref.name, lang, ...(refresh ? { refresh: '1' } : {}) });
      const res = await fetch(`/api/doctor/diagnose?${q}`, { headers: { 'X-Requested-With': 'easyadmin', 'X-Lang': lang }, credentials: 'same-origin', signal: ctl.signal });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        const err = new Error(j.error || `Ошибка ${res.status}`); err.needSetup = !!j.needSetup; throw err;
      }
      await readSse(res, (event, d) => {
        if (closed || ctl !== abort) return;
        if (event === 'meta') { drawFacts(d); showStatus('', d.failing ? 'AI анализирует сбой…' : 'Явных признаков сбоя нет — AI анализирует логи…', true); }
        else if (event === 'cached') { cached = true; }
        else if (event === 'delta') { text += d.text; if (!pending) { pending = true; requestAnimationFrame(paint); } }
        else if (event === 'done') {
          finished = true; paint(); drawVerdict(d.verdict.what || d.verdict.cause || d.verdict.fix ? d.verdict : { ...splitVerdict(text), action: 'none' });
          showStatus('ok', cached ? 'Готово (из кэша, не старше часа)' : 'Готово');
        } else if (event === 'error') throw new Error(d.message);
      });
      if (!finished && !closed && ctl === abort) { finished = true; paint(); showStatus('err', 'Соединение прервано'); }
    } catch (e) {
      if (e.name === 'AbortError' || closed) return;
      showStatus('err', e.message);
      if (e.needSetup) actionBox.append(h('a', { class: 'btn', href: '#/settings', onclick: () => m.close() }, icon('settings', 14), 'Открыть настройки'));
    }
  }
  run();
  return m;
}

/* ---------- карточка настроек ---------- */
const PRESETS = [
  ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
  ['DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
  ['Groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
  ['Ollama', 'http://localhost:11434/v1', 'llama3.1:8b'],
  ['OmniRoute', 'http://localhost:20128/v1', ''],
];

export function aiDoctorCard() {
  const box = h('section', { class: 'card stack ai-settings' });
  const draw = async () => {
    let s;
    try { s = await get('/api/doctor/settings'); } catch (e) { clear(box).append(h('h3', null, 'AI Doctor'), h('p', { class: 'muted' }, e.message)); return; }
    const endpoint = h('input', { class: 'input mono', value: s.endpoint, placeholder: 'https://api.openai.com/v1', autocomplete: 'off', spellcheck: 'false' });
    const model = h('input', { class: 'input mono', value: s.model, placeholder: 'gpt-4o-mini', autocomplete: 'off', spellcheck: 'false' });
    const key = h('input', { class: 'input mono', type: 'password', placeholder: s.hasKey ? '••••••••' : 'sk-…', autocomplete: 'new-password' });
    const presets = h('div', { class: 'chips' }, PRESETS.map(([name, url, mdl]) => h('button', { class: 'chip-btn', type: 'button', onclick: () => { endpoint.value = url; if (mdl) model.value = mdl; } }, name)));
    const save = async (e, clearKey = false) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const body = { endpoint: endpoint.value.trim(), model: model.value.trim() };
        if (clearKey) body.apiKey = ''; else if (key.value) body.apiKey = key.value;
        await post('/api/doctor/settings', body);
        toast('Сохранено', 'success'); draw();
      } catch (x) { toast(x.message, 'error'); b.disabled = false; }
    };
    clear(box).append(
      h('div', { class: 'card-head' }, h('h3', { class: 'inline' }, icon('stethoscope', 16), 'AI Doctor'),
        h('span', { class: `badge ${s.endpoint && s.model ? 'ok' : ''}` }, s.endpoint && s.model ? 'Настроен' : 'Не настроен')),
      h('p', { class: 'muted small' }, 'Диагностика сбоев сервисов через любой OpenAI-совместимый API. Перед отправкой из логов вырезаются токены, пароли, ключи, значения .env и IP-адреса, но сами строки логов уходят провайдеру — для локальных данных используйте Ollama.'),
      s.enabled ? null : h('div', { class: 'callout err' }, icon('alert'), h('div', null, 'AI Doctor отключён переменной EASYADMIN_AI=off')),
      presets,
      h('div', { class: 'grid-2' },
        field('Адрес API', endpoint, 'Без /chat/completions'),
        field('Модель', model)),
      field('API-ключ', key, s.hasKey ? 'Ключ сохранён в зашифрованном виде. Оставьте пустым, чтобы не менять.' : 'Для Ollama можно оставить пустым'),
      h('div', { class: 'inline' },
        h('button', { class: 'btn primary sm', onclick: save }, 'Сохранить'),
        s.hasKey ? h('button', { class: 'btn sm ghost danger-text', onclick: (e) => save(e, true) }, icon('trash', 13), 'Удалить ключ') : null));
  };
  draw();
  return box;
}
