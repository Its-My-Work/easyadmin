import { del, get, post } from './api.js';
import { clear, field, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { store } from './store.js';

/* Переезд на новый сервер: две вкладки — «По SSH на чистый сервер» и «Одной командой». Ход берём опросом GET /api/migration/:id. */
const MARK = { ok: '✓', error: '✕', running: '…', pending: '•', skipped: '–' };
const CLS = { ok: 'ok-text', error: 'danger-text', running: '', pending: 'muted', skipped: 'muted' };
const TITLE = { snapshot: 'Делаю слепок…', ready: 'Слепок готов', running: 'Идёт переезд…', done: 'Готово', error: 'Ошибка', aborted: 'Остановлено', interrupted: 'Прервано', expired: 'Срок ссылки истёк' };
const FINAL = ['done', 'error', 'aborted', 'interrupted', 'expired'];

/** Общая часть вкладок: выбор панели-источника и параметры слепка. */
function sourceFields(S, defaults) {
  const panel = h('select', { class: 'input', onchange: () => { S.panelId = panel.value; } }, store.panels.map((p) => h('option', { value: p.id, selected: String(p.id) === String(S.panelId) }, p.name)));
  S.panelId ||= panel.value;
  const base = h('input', { class: 'input mono', placeholder: 'https://admin.example.com', value: S.baseUrl, oninput: () => { S.baseUrl = base.value.trim(); } });
  const data = h('input', { type: 'checkbox', checked: S.includeData, onchange: () => { S.includeData = data.checked; } });
  const pause = h('input', { type: 'checkbox', checked: S.consistency === 'pause', onchange: () => { S.consistency = pause.checked ? 'pause' : 'none'; } });
  return [field('Панель, которую переносим', panel),
    field('Адрес EasyAdmin для серверов', base, defaults?.baseUrl ? null : 'Внешний адрес, по которому EasyAdmin виден и старому, и новому серверу (не localhost)'),
    h('label', { class: 'check' }, data, 'Переносить тома и базы данных'),
    h('label', { class: 'check', title: t('Сервисы на время копирования приостанавливаются') }, pause, 'Согласованная копия (кратко приостановить сервисы)'),
    defaults?.encrypted ? h('p', { class: 'muted small' }, icon('key', 13), ' ', t('Слепок будет зашифрован паролем резервных копий.')) : h('p', { class: 'muted small' }, t('Пароль копий не задан — слепок не шифруется.'))];
}

/** Шаги, предупреждения и журнал одного задания; poll() обновляет их из ответа API. */
function progress() {
  const steps = h('ul', { class: 'mig-steps' }); const status = h('div', { class: 'callout compact' }); const warns = h('div', { class: 'stack' });
  const logBox = h('pre', { class: 'code mig-log' });
  const el = h('div', { class: 'stack' }, status, steps, warns, logBox);
  const draw = (j) => {
    clear(status).append(...(FINAL.includes(j.status) ? [icon(j.status === 'done' ? 'check' : 'alert', 14)] : [h('span', { class: 'spinner' })]), h('span', { class: 'small' }, t(TITLE[j.status] ?? j.status), j.error ? `: ${j.error}` : ''));
    status.className = `callout compact ${j.status === 'error' ? 'err' : ''}`;
    clear(steps).append(...j.steps.map((s) => h('li', { class: CLS[s.status] }, h('b', null, MARK[s.status] ?? '•'), ' ', t(s.label), s.detail ? h('span', { class: 'muted small' }, ` — ${s.detail}`) : null)));
    clear(warns).append(...(j.warnings ?? []).map((w) => h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, w))));
    const stick = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 8;
    logBox.textContent = j.log.join('\n'); logBox.hidden = !j.log.length; if (stick) logBox.scrollTop = logBox.scrollHeight;
  };
  return { el, draw };
}

/** Опрос задания до конца; возвращает stop(). */
function watch(id, onData, ms = 2000) {
  let stopped = false; let timer;
  const tick = async () => {
    if (stopped) return;
    try { const j = await get(`/api/migration/${id}`); if (stopped) return; onData(j); if (FINAL.includes(j.status)) return; } catch (e) { if (e.status === 404) return; }
    timer = setTimeout(tick, ms);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

/* ---------- вкладка 1: по SSH ---------- */
function sshTab(defaults, track) {
  const S = { host: '', port: '22', user: 'root', mode: 'password', password: '', key: '', passphrase: '', panelId: '', baseUrl: defaults?.baseUrl ?? '', includeData: true, consistency: 'none', addPanel: true };
  const box = h('div', { class: 'stack' }); const err = h('div', { class: 'danger-text small' });
  const run = (label, kind, fn) => h('button', { class: `btn ${kind}`, onclick: async (e) => { const b = e.currentTarget; b.disabled = true; err.textContent = ''; try { await fn(); } catch (x) { err.textContent = x.message; } finally { b.disabled = false; } } }, label);

  const form = () => {
    const host = h('input', { class: 'input mono', placeholder: '203.0.113.10', value: S.host, autocomplete: 'off' });
    const port = h('input', { class: 'input', type: 'number', min: 1, max: 65535, value: S.port });
    const user = h('input', { class: 'input', value: S.user, autocomplete: 'off' });
    const mode = h('select', { class: 'input', onchange: () => drawAuth() }, [['password', 'Пароль'], ['key', 'Приватный ключ']].map(([v, l]) => h('option', { value: v, selected: v === S.mode }, t(l))));
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', value: S.password, 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
    const key = h('textarea', { class: 'input mono', rows: 5, spellcheck: 'false', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' }, S.key);
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'off', value: S.passphrase, 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
    const auth = h('div', { class: 'stack' });
    const drawAuth = () => { S.mode = mode.value; clear(auth).append(S.mode === 'password' ? field('Пароль', pw) : h('div', { class: 'stack' }, field('Приватный ключ', key), field('Фраза ключа', pass, 'Если ключ защищён фразой'))); };
    drawAuth();
    const add = h('input', { type: 'checkbox', checked: S.addPanel, onchange: () => { S.addPanel = add.checked; } });
    clear(box).append(
      h('p', { class: 'muted small' }, 'EasyAdmin подключится к чистому серверу по SSH, поставит Docker, перенесёт слепок системы и запустит Easypanel. Доступ нигде не сохраняется.'),
      h('div', { class: 'grid-2' }, field('Адрес нового сервера', host), field('Порт SSH', port)), field('Пользователь', user), field('Вход', mode), auth,
      ...sourceFields(S, defaults), h('label', { class: 'check' }, add, 'Добавить новую панель в EasyAdmin после переезда'), err,
      h('div', { class: 'inline' }, h('span', { class: 'spacer' }), run('Далее: ключ сервера', 'primary', async () => {
        Object.assign(S, { host: host.value.trim(), port: port.value, user: user.value.trim(), password: pw.value, key: key.value, passphrase: pass.value });
        if (!S.host) throw new Error(t('Укажите адрес сервера'));
        if (S.mode === 'password' ? !S.password : !S.key.trim()) throw new Error(t(S.mode === 'password' ? 'Введите пароль' : 'Вставьте приватный ключ'));
        if (!S.panelId) throw new Error(t('Выберите панель — источник переезда'));
        const r = await post('/api/migration/ssh/scan', { host: S.host, port: Number(S.port) }); fingerprint(r.keys);
      })));
  };

  const fingerprint = (keys) => {
    const pref = keys.find((k) => k.type === 'ssh-ed25519') ?? keys[0]; const ok = h('input', { type: 'checkbox' });
    clear(box).append(h('p', null, t('Сервер представился ключом со следующим отпечатком. Сверьте его с тем, что показывает ваш хостинг:')),
      h('div', null, h('div', { class: 'field-label' }, pref.type), h('pre', { class: 'code' }, pref.fingerprint)),
      h('label', { class: 'check' }, ok, 'Отпечаток совпадает, продолжить'), err,
      h('div', { class: 'inline' }, h('button', { class: 'btn ghost', onclick: form }, 'Назад'), h('span', { class: 'spacer' }), run('Запустить переезд', 'primary', async () => {
        if (!ok.checked) throw new Error(t('Подтвердите отпечаток'));
        const auth = S.mode === 'password' ? { password: S.password } : { privateKey: S.key, passphrase: S.passphrase || undefined };
        const r = await post('/api/migration/ssh', { host: S.host, port: Number(S.port), user: S.user, auth, fingerprint: pref.fingerprint, panelId: Number(S.panelId), baseUrl: S.baseUrl || undefined, includeData: S.includeData, consistency: S.consistency, addPanel: S.addPanel });
        S.password = ''; S.key = ''; S.passphrase = ''; running(r.id);
      })));
  };

  const running = (id) => {
    const p = progress(); let cancel = null; const stop = h('button', { class: 'btn danger', onclick: async (e) => { e.currentTarget.disabled = true; try { await del(`/api/migration/${id}`); } catch (x) { toast(x.message, 'error'); } } }, 'Остановить');
    clear(box).append(p.el, h('div', { class: 'inline' }, stop));
    cancel = watch(id, (j) => { p.draw(j); if (FINAL.includes(j.status)) { stop.remove(); if (j.status === 'done') toast(t('Переезд завершён'), 'success'); } });
    track(() => cancel?.());
  };
  form();
  return box;
}

/* ---------- вкладка 2: одной командой ---------- */
function commandTab(defaults, track) {
  const S = { panelId: '', baseUrl: defaults?.baseUrl ?? '', includeData: true, consistency: 'none' };
  const box = h('div', { class: 'stack' }); const err = h('div', { class: 'danger-text small' });

  const form = () => clear(box).append(
    h('p', { class: 'muted small' }, 'EasyAdmin сделает слепок системы на старом сервере и выдаст одну команду. Выполните её от root на чистом сервере (Ubuntu/Debian) — он сам поставит Docker, скачает слепок и запустит Easypanel.'),
    ...sourceFields(S, defaults), err,
    h('div', { class: 'inline' }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true; err.textContent = '';
      try {
        if (!S.panelId) throw new Error(t('Выберите панель — источник переезда'));
        const r = await post('/api/migration/snapshot', { panelId: Number(S.panelId), baseUrl: S.baseUrl || undefined, includeData: S.includeData, consistency: S.consistency });
        running(r.id);
      } catch (x) { err.textContent = x.message; b.disabled = false; }
    } }, icon('database', 14), 'Создать слепок')));

  const running = (id) => {
    const p = progress(); const cmdBox = h('div', { class: 'stack' }); let shown = null;
    const stop = h('button', { class: 'btn danger', onclick: async (e) => { e.currentTarget.disabled = true; try { await del(`/api/migration/${id}`); } catch (x) { toast(x.message, 'error'); } } }, 'Удалить слепок и остановить');
    clear(box).append(p.el, cmdBox, h('div', { class: 'inline' }, stop));
    const cancel = watch(id, (j) => {
      p.draw(j);
      if (j.command && j.command !== shown) {
        shown = j.command; const pre = h('pre', { class: 'code mig-cmd' }, j.command);
        const copy = h('button', { class: 'btn primary', onclick: async () => { try { await navigator.clipboard.writeText(j.command); } catch { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy'); } toast(t('Команда скопирована'), 'success'); } }, icon('copy', 14), 'Копировать');
        clear(cmdBox).append(h('div', { class: 'callout compact' }, icon('key', 14), h('span', { class: 'small' }, t('Команда одноразовая: после переезда ссылка перестаёт работать. Не публикуйте её.'))), pre, h('div', { class: 'inline' }, copy, h('span', { class: 'muted small' }, `${t('Действует до')} ${new Date(j.expiresAt).toLocaleString()}`)));
      }
      if (FINAL.includes(j.status)) { stop.remove(); if (j.status !== 'done') clear(cmdBox); else toast(t('Переезд завершён'), 'success'); }
    });
    track(cancel);
  };
  form();
  return box;
}

export async function migrationModal() {
  let defaults = null; try { defaults = (await get('/api/migration')).defaults; } catch (e) { toast(e.message, 'error'); return; }
  const stops = []; const track = (fn) => stops.push(fn);
  const tabs = [['ssh', 'По SSH на чистый сервер', () => sshTab(defaults, track)], ['cmd', 'Одной командой', () => commandTab(defaults, track)]];
  const body = h('div', { class: 'stack' }); const bar = h('div', { class: 'tabs' }); let cur = 'ssh';
  const show = (id) => { cur = id; stops.splice(0).forEach((f) => f()); clear(bar).append(...tabs.map(([k, l]) => h('button', { class: `tab ${k === cur ? 'active' : ''}`, onclick: () => show(k) }, t(l)))); clear(body).append(tabs.find(([k]) => k === id)[2]()); };
  show('ssh');
  return modal({ title: t('Переезд на новый сервер'), wide: true, body: h('div', { class: 'stack' }, bar, body), onClose: () => stops.forEach((f) => f()) });
}
