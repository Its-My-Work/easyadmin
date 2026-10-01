import { del, get, post } from './api.js';
import { clear, confirmDialog, field, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { refresh } from './store.js';

/* Мастер «Установить новую панель»: SSH-доступ → отпечаток сервера → проверка → параметры → установка с ходом выполнения. */
const COLORS = ['#7c83ff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#a855f7', '#64748b'];
const ICON = { ok: '✓', warn: '⚠', error: '✕', pending: '•', running: '…' };
const CLS = { ok: 'ok-text', warn: 'warn-text', error: 'danger-text', pending: 'muted', running: 'muted' };

export function installWizard() {
  const box = h('div', { class: 'stack' });
  let handle = null; let ticket = null; let pollTimer = null; let closed = false;
  const S = { host: '', port: '22', user: 'root', mode: 'password', password: '', key: '', passphrase: '', fp: '', keys: [], color: COLORS[0] };
  const close = () => { closed = true; clearTimeout(pollTimer); if (ticket) { del(`/api/installs/ticket/${ticket}`).catch(() => {}); ticket = null; } handle?.close(); };
  const err = h('div', { class: 'danger-text small' });
  const btn = (label, kind, onclick) => h('button', { class: `btn ${kind ?? ''}`, onclick: async (e) => { const b = e.currentTarget; b.disabled = true; err.textContent = ''; try { await onclick(); } catch (x) { err.textContent = x.message; } finally { b.disabled = false; } } }, label);
  const view = (...nodes) => clear(box).append(...nodes, err);

  /* 1. сервер */
  const stepServer = () => {
    const host = h('input', { class: 'input mono', placeholder: '203.0.113.10', value: S.host, autocomplete: 'off' });
    const port = h('input', { class: 'input', type: 'number', min: 1, max: 65535, value: S.port });
    const user = h('input', { class: 'input', value: S.user, autocomplete: 'off' });
    const mode = h('select', { class: 'input', onchange: () => draw() }, [['password', 'Пароль'], ['key', 'Приватный ключ']].map(([v, l]) => h('option', { value: v, selected: v === S.mode }, t(l))));
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', value: S.password, 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
    const key = h('textarea', { class: 'input mono', rows: 6, spellcheck: 'false', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----', autocomplete: 'off' }, S.key);
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'off', value: S.passphrase, 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
    const auth = h('div', { class: 'stack' });
    const draw = () => { S.mode = mode.value; clear(auth).append(S.mode === 'password' ? field('Пароль', pw) : h('div', { class: 'stack' }, field('Приватный ключ', key), field('Фраза ключа', pass, 'Если ключ защищён фразой'))); };
    draw();
    view(h('p', { class: 'muted small' }, 'EasyAdmin подключится к новому серверу по SSH и установит Easypanel. Доступ используется только на время установки и нигде не сохраняется.'),
      h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, 'Подходит только чистый сервер с Ubuntu 22.04+ или Debian 11+ (от 2 ГБ памяти). Скрипт Easypanel не предназначен для серверов с уже работающим Docker Swarm.')),
      h('div', { class: 'grid-2' }, field('Адрес сервера', host), field('Порт SSH', port)), field('Пользователь', user, 'root или пользователь с sudo без пароля'), field('Вход', mode), auth,
      h('div', { class: 'inline' }, btn('Отмена', 'ghost', close), h('span', { class: 'spacer' }), btn('Далее: ключ сервера', 'primary', async () => {
        Object.assign(S, { host: host.value.trim(), port: port.value, user: user.value.trim(), password: pw.value, key: key.value, passphrase: pass.value });
        if (!S.host) throw new Error(t('Укажите адрес сервера'));
        if (S.mode === 'password' ? !S.password : !S.key.trim()) throw new Error(t(S.mode === 'password' ? 'Введите пароль' : 'Вставьте приватный ключ'));
        const r = await post('/api/installs/scan', { host: S.host, port: Number(S.port) }); S.keys = r.keys; stepFingerprint();
      })));
  };

  /* 2. отпечаток */
  const stepFingerprint = () => {
    const pref = S.keys.find((k) => k.type === 'ssh-ed25519') ?? S.keys[0]; S.fp = pref.fingerprint;
    const ok = h('input', { type: 'checkbox' });
    view(h('p', null, t('Сервер представился ключом со следующим отпечатком. Сверьте его с тем, что показывает ваш хостинг, или выполните на сервере:')), h('pre', { class: 'code' }, 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'),
      h('div', null, h('div', { class: 'field-label' }, pref.type), h('pre', { class: 'code' }, pref.fingerprint)),
      h('p', { class: 'muted small' }, 'Если отпечатки не совпадают, кто-то может подменять сервер — не продолжайте.'),
      h('label', { class: 'check' }, ok, 'Отпечаток совпадает, продолжить'),
      h('div', { class: 'inline' }, btn('Назад', 'ghost', stepServer), h('span', { class: 'spacer' }), btn('Проверить сервер', 'primary', async () => { if (!ok.checked) throw new Error(t('Подтвердите отпечаток')); await runCheck(); })));
  };

  /* 3. проверка */
  const runCheck = async () => {
    view(h('div', { class: 'skeleton', style: { height: '120px' } }), h('p', { class: 'muted small' }, 'Проверяем сервер…'));
    let r;
    try { r = await post('/api/installs/check', { host: S.host, port: Number(S.port), user: S.user, fingerprint: S.fp, auth: S.mode === 'password' ? { password: S.password } : { privateKey: S.key, passphrase: S.passphrase || undefined } }); }
    catch (e) { stepFingerprint(); err.textContent = e.message; return; }
    ticket = r.ticket ?? null;
    view(h('div', { class: 'list' }, r.checks.map((c) => h('div', { class: 'list-item' }, h('div', null, h('b', null, c.label), h('div', { class: `small ${CLS[c.level]}` }, c.detail)), h('b', { class: CLS[c.level] }, ICON[c.level])))),
      r.ok ? h('p', { class: 'ok-text small' }, '✓ Сервер подходит для установки.') : h('p', { class: 'danger-text small' }, 'Сервер не подходит: исправьте отмеченное красным и проверьте снова.'),
      h('div', { class: 'inline' }, btn('Назад', 'ghost', stepServer), h('span', { class: 'spacer' }), r.ok ? btn('Далее: параметры', 'primary', stepParams) : btn('Проверить снова', 'primary', runCheck)));
  };

  /* 4. параметры */
  const stepParams = () => {
    const name = h('input', { class: 'input', placeholder: 'Прод EU', value: S.name ?? '' });
    const tags = h('input', { class: 'input', placeholder: 'prod, eu', value: S.tags ?? '' });
    const email = h('input', { class: 'input', type: 'email', placeholder: 'admin@example.com', value: S.email ?? '', autocomplete: 'off' });
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'оставьте пустым — сгенерируем и покажем один раз', autocomplete: 'new-password', 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
    const domain = h('input', { class: 'input mono', placeholder: 'panel.example.com (необязательно)', value: S.domain ?? '', autocomplete: 'off' });
    const terms = h('input', { type: 'checkbox' }); const sub = h('input', { type: 'checkbox' });
    const sw = h('div', { class: 'swatches' }); const drawSw = () => clear(sw).append(...COLORS.map((c) => h('button', { type: 'button', class: `sw ${c === S.color ? 'on' : ''}`, style: { background: c }, 'aria-label': c, onclick: () => { S.color = c; drawSw(); } }))); drawSw();
    view(field('Название панели', name), h('div', { class: 'grid-2' }, field('Теги', tags, 'Через запятую'), field('Цвет', sw)),
      h('div', { class: 'callout compact' }, icon('alert', 14), h('span', { class: 'small' }, 'Администратор Easypanel создаётся с этими данными. E-mail передаётся Easypanel при первоначальной настройке — так работает сама панель.')),
      field('E-mail администратора', email), field('Пароль администратора', pw, 'Не короче 8 символов'),
      field('Домен панели', domain, 'Свой домен панели доступен и на бесплатном тарифе: создайте A-запись на IP сервера до установки. Без домена панель получит адрес *.easypanel.host с HTTPS. (Базовый домен сервисов — платная функция Easypanel.)'),
      h('label', { class: 'check' }, terms, h('span', null, `${t('Я принимаю условия использования Easypanel')} (`, h('a', { href: 'https://easypanel.io', target: '_blank', rel: 'noopener' }, 'easypanel.io'), ')')),
      h('label', { class: 'check' }, sub, 'Подписаться на рассылку Easypanel'),
      h('div', { class: 'inline' }, btn('Назад', 'ghost', runCheck), h('span', { class: 'spacer' }), btn('Установить Easypanel', 'primary', async () => {
        Object.assign(S, { name: name.value.trim(), tags: tags.value, email: email.value.trim(), domain: domain.value.trim() });
        if (!terms.checked) throw new Error(t('Нужно принять условия использования Easypanel'));
        if (!(await confirmDialog({ title: 'Установить Easypanel?', message: `${t('На сервере')} ${S.host} ${t('будут установлены Docker (если его нет) и Easypanel. Это займёт 5–10 минут.')}`, confirmText: 'Установить' }))) return;
        const r = await post('/api/installs', { ticket, panel: { name: S.name, color: S.color, tags: S.tags }, admin: { email: S.email, password: pw.value || undefined }, domain: S.domain || undefined, terms: true, subscribe: sub.checked });
        ticket = null; stepProgress(r.id);
      })));
  };

  /* 5. ход установки */
  const stepProgress = (id) => {
    const steps = h('div', { class: 'list' }); const logEl = h('pre', { class: 'code', style: { maxHeight: '240px' } }); const foot = h('div', { class: 'inline' }); const note = h('div', { class: 'stack-sm' });
    view(steps, note, logEl, foot);
    const stop = btn('Остановить', 'ghost', async () => { if (await confirmDialog({ title: 'Остановить установку?', message: 'EasyAdmin перестанет следить за установкой, но уже запущенная на сервере установка может продолжиться.', danger: true, confirmText: 'Остановить' })) await del(`/api/installs/${id}`); });
    clear(foot).append(stop);
    const tick = async () => {
      if (closed) return;
      let r; try { r = await get(`/api/installs/${id}`); } catch { pollTimer = setTimeout(tick, 4000); return; }
      clear(steps).append(...r.steps.map((s) => h('div', { class: 'list-item' }, h('div', null, h('b', null, t(s.label ?? s.id)), s.detail ? h('div', { class: `small ${CLS[s.status]}` }, s.detail) : null), h('b', { class: CLS[s.status] }, ICON[s.status]))));
      logEl.textContent = r.log.join('\n'); logEl.scrollTop = logEl.scrollHeight;
      clear(note).append(...r.warnings.map((w) => h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, w))));
      if (r.status === 'running') { pollTimer = setTimeout(tick, 2500); return; }
      if (r.status === 'done') {
        refresh(true);
        clear(note).append(h('div', { class: 'callout compact' }, icon('check', 14), h('span', null, `${t('Панель добавлена')}: ${r.url}`)),
          ...r.warnings.map((w) => h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, w))),
          h('div', null, h('div', { class: 'field-label' }, t('Администратор Easypanel')), h('div', { class: 'mono' }, r.adminEmail), r.adminPassword ? h('div', { class: 'stack-sm' }, h('pre', { class: 'code' }, r.adminPassword), h('p', { class: 'warn-text small' }, 'Пароль показывается один раз и нигде не сохраняется — запишите его сейчас.'), h('button', { class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(r.adminPassword); toast(t('Скопировано'), 'success'); } catch { toast(t('Выделите текст и скопируйте вручную'), 'error'); } } }, icon('copy', 13), 'Копировать пароль')) : null));
        toast(t('Easypanel установлена и добавлена'), 'success', 6000);
      } else { clear(note).append(h('div', { class: 'callout err' }, icon('alert'), h('div', null, h('b', null, t('Установка не завершена')), h('p', null, r.error ?? '')))); }
      clear(foot).append(btn('Закрыть', 'primary', close));
    };
    tick();
  };

  handle = modal({ title: 'Установить новую панель Easypanel', body: box, actions: [], wide: true, onClose: () => { closed = true; clearTimeout(pollTimer); if (ticket) del(`/api/installs/ticket/${ticket}`).catch(() => {}); } });
  stepServer();
}
