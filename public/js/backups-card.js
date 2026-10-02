import { del, get, post, put } from './api.js';
import { clear, confirmDialog, field, fmtTime, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { store } from './store.js';

/** Вкладки раздела «Бэкапы» (система, данные, настройки). Прежде это была одна карточка в «Настройках». Резервные копии EasyAdmin: что копировать (система, панели — все или выбранные), расписание, хранилище, пароль, список копий, проверка и восстановление. */
export const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
export const seg = (cur, options, onPick) => h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { type: 'button', class: `seg-btn ${cur === v ? 'active' : ''}`, onclick: () => onPick(v) }, l)));
export const iconBtn = (title, ic, onclick, cls = '') => h('button', { class: `btn sm icon ghost ${cls}`, title, 'aria-label': title, onclick }, icon(ic, 14));
export const copyText = (text) => { navigator.clipboard?.writeText(text); toast(t('Скопировано'), 'success'); };
export const download = (name, blob) => { const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url); };

const askPassword = (text) => new Promise((resolve) => {
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: t('Оставьте пустым — использовать пароль из настроек') });
  modal({ title: 'Пароль копии', body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, text), input), actions: [{ label: 'Отмена', kind: 'ghost', onClick: () => resolve(null) }, { label: 'Продолжить', kind: 'primary', onClick: () => resolve(input.value) }], onClose: () => resolve(null) });
});

async function verifyModal(name) {
  const pw = await askPassword('Если копия создана на другом сервере, введите её пароль.'); if (pw == null) return;
  try {
    const v = await post('/api/backups/verify', { name, password: pw || undefined });
    modal({ title: 'Копия в порядке', body: h('div', { class: 'stack' },
      h('div', { class: 'small muted' }, `${t('Создана')}: ${fmtTime(v.createdAt)}`),
      v.hasSystem ? h('div', null, h('b', null, 'Система EasyAdmin'), h('div', { class: 'small' }, `${t('Панелей')}: ${v.dbPanels}`)) : h('div', { class: 'muted small' }, 'Системы EasyAdmin в копии нет — только конфигурации панелей.'),
      v.hasSystem ? h('div', { class: 'small' }, `${t('Пользователей')}: ${v.users} · ${t('каналов')}: ${v.channels} · ${t('шаблонов')}: ${v.templates}`) : null,
      v.hasSystem ? h('div', { class: `callout compact ${v.keyMatches === false ? 'warn' : ''}` }, icon(v.keyMatches === false ? 'alert' : 'activity', 14), h('span', { class: 'small' }, v.keyMatches === false ? 'Ключ шифрования в копии отличается от текущего: при восстановлении он будет заменён (если ключ задан через EASYADMIN_SECRET — верните прежнее значение).' : 'Ключ шифрования совпадает с текущим.')) : null,
      v.panels.length ? h('div', null, h('b', null, 'Конфигурации панелей'), v.panels.map((p) => h('div', { class: 'small' }, `${p.name}: ${p.projects} ${t('проектов')}, ${p.services} ${t('сервисов')}`, p.errors.length ? h('span', { class: 'danger-text' }, ` · ${p.errors.length} ${t('ошибок')}`) : null))) : null),
    actions: [{ label: 'Закрыть', kind: 'ghost' }] });
  } catch (e) { toast(e.message, 'error', 8000); }
}

async function restoreSystem(name) {
  const pw = await askPassword('Введите пароль копии (или оставьте пустым, чтобы взять сохранённый).'); if (pw == null) return;
  if (!await confirmDialog({ title: 'Восстановить систему из копии?', danger: true, confirmText: 'Восстановить и перезапустить', typeToConfirm: 'EasyAdmin',
    message: 'Текущие панели, пользователи и настройки будут заменены данными из копии. EasyAdmin перезапустится на несколько секунд, прежняя база сохранится в папке before-restore рядом с данными. Войти придётся с учётными данными из копии.' })) return;
  try {
    const r = await post('/api/backups/restore', { name, password: pw || undefined, confirm: true });
    if (r.warn) toast(r.warn, 'error', 12000);
    toast(t('Восстановление запущено, страница обновится'), 'success'); setTimeout(() => location.reload(), 6000);
  } catch (e) { toast(e.message, 'error', 8000); }
}

async function panelsModal(name, files) {
  const pw = await askPassword('Введите пароль копии (или оставьте пустым, чтобы взять сохранённый).'); if (pw == null) return;
  let v; try { v = await post('/api/backups/verify', { name, password: pw || undefined }); } catch (e) { return toast(e.message, 'error', 8000); }
  void files;
  if (!v.panels.length) return toast(t('В этой копии нет конфигураций панелей'), 'error');
  const box = h('div', { class: 'stack' });
  for (const pn of v.panels) {
    box.append(h('div', { class: 'list-item' }, h('div', null, h('b', null, pn.name), h('div', { class: 'small muted' }, `${pn.projects} ${t('проектов')}, ${pn.services} ${t('сервисов')}${pn.errors.length ? ` · ${pn.errors.length} ${t('ошибок')}` : ''}`)),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => serviceRestoreModal(name, pw, pn) }, icon('rotate', 13), 'Вернуть сервис'),
      h('button', { class: 'btn sm ghost', onclick: async () => { try { const c = await post('/api/backups/panel-config', { name, password: pw || undefined, panel: pn.id }); download(`${pn.name}-config.json`, new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' })); } catch (e) { toast(e.message, 'error'); } } }, icon('download', 13), 'JSON')));
  }
  modal({ title: 'Панели в копии', wide: true, body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Хранится конфигурация: проекты, сервисы, переменные окружения, источники, домены, порты и тома. Данные баз и томов в копию не входят — их защищают бэкапы самой Easypanel.'), box), actions: [{ label: 'Закрыть', kind: 'ghost' }] });
}

async function serviceRestoreModal(name, pw, pn) {
  let cfg; try { cfg = await post('/api/backups/panel-config', { name, password: pw || undefined, panel: pn.id }); } catch (e) { return toast(e.message, 'error'); }
  const items = cfg.projects.flatMap((p) => p.services.map((s) => ({ project: p.name, service: s.name, type: s.type })));
  if (!items.length) return toast(t('В копии у этой панели нет сервисов'), 'error');
  const which = h('select', { class: 'input' }, items.map((x, i) => h('option', { value: i }, `${x.project} / ${x.service} (${x.type})`)));
  const target = h('select', { class: 'input' }, store.panels.map((p) => h('option', { value: p.id, selected: p.name === pn.name }, p.name)));
  const proj = h('input', { class: 'input mono', placeholder: t('как в копии') }); const nm = h('input', { class: 'input mono', placeholder: t('как в копии') });
  modal({ title: `${t('Вернуть сервис')} · ${pn.name}`, body: h('div', { class: 'stack' }, field('Сервис из копии', which), field('На панель', target),
    h('div', { class: 'grid-2' }, field('Проект', proj), field('Имя сервиса', nm)),
    h('p', { class: 'muted small' }, 'Создаётся новый сервис: переменные окружения, источник, способ сборки и ресурсы. Домены, порты и тома добавьте вручную (см. JSON конфигурации). Существующие сервисы не перезаписываются.')),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Вернуть', kind: 'primary', onClick: async () => {
      const x = items[Number(which.value)];
      const r = await post('/api/backups/restore-service', { name, password: pw || undefined, panel: pn.id, project: x.project, service: x.service, targetPanelId: Number(target.value), targetProject: proj.value.trim() || undefined, targetName: nm.value.trim() || undefined });
      toast(r.ok ? t('Сервис создан') : `${t('Частично')}: ${r.steps.filter((s) => !s.ok).map((s) => s.step).join(', ')}`, r.ok ? 'success' : 'error', 8000);
    } }] });
}

const STATUS = { wait: 'ждёт', prepare: 'готовится', running: 'идёт', done: 'готово', partial: 'есть ошибки', error: 'ошибка', ok: 'готово', fail: 'ошибка' };

/** Ход копирования данных: опрашивает сервер, пока идёт запуск. */
export function dataProgress(onDone) {
  const box = h('div', { class: 'stack-sm' }); let stop = false;
  const draw = async () => {
    if (stop || !box.isConnected && box.dataset.mounted) return;
    try {
      const st = await get('/api/backups/data/status'); box.dataset.mounted = '1';
      clear(box);
      if (st.panels?.length) box.append(h('h4', null, st.running ? 'Идёт копирование данных…' : 'Результат последнего запуска'), ...st.panels.map((p) => h('div', { class: 'list-item', style: { display: 'block' } },
        h('div', { class: 'inline' }, h('b', null, p.name), h('span', { class: `badge ${p.status === 'done' ? 'ok' : p.status === 'error' || p.status === 'partial' ? 'err' : ''}` }, STATUS[p.status] ?? p.status)),
        p.error ? h('div', { class: 'small danger-text' }, p.error) : null, p.note ? h('div', { class: 'small muted' }, p.note) : null,
        (p.items ?? []).map((x) => h('div', { class: 'small' }, `${x.status === 'ok' ? '✓' : x.status === 'fail' ? '✗' : '…'} ${x.label}`, x.size ? h('span', { class: 'muted' }, ` · ${size(x.size)}`) : null, x.error ? h('span', { class: 'danger-text' }, ` — ${x.error}`) : null, x.note ? h('span', { class: 'warn-text' }, ` — ${t('пропущено')}: ${x.note}`) : null)))));
      if (st.running) setTimeout(draw, 3000); else { stop = true; onDone?.(); }
    } catch { setTimeout(draw, 5000); }
  };
  draw(); return box;
}


/* ---------------- общие кирпичики вкладок ---------------- */
const pad2 = (n) => String(n).padStart(2, '0');
const s3Ready = (s) => !!(s.s3.endpoint && s.s3.bucket && s.s3.accessKey && s.s3.hasSecret);
const saveSettings = async (patch, then) => { try { await put('/api/backups/settings', patch); toast(t('Сохранено'), 'success'); await then?.(); return true; } catch (e) { toast(e.message, 'error', 8000); return false; } };
const warn = (text, ...extra) => h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, text, ...extra));
const lastLine = (last, okText, failText) => (last ? h('div', { class: `callout compact ${last.ok ? '' : 'err'}` }, icon(last.ok ? 'activity' : 'alert', 14), h('span', { class: 'small' }, last.ok ? okText(last) : `${t(failText)}: ${last.error}`)) : null);
/** Строка о расписании: оно общее для обеих вкладок и меняется на вкладке «Настройки». */
const scheduleNote = (s) => h('div', { class: 'callout compact' }, icon('clock', 14), h('span', { class: 'small' },
  s.enabled ? `${t('Копии делаются по расписанию')}: ${s.every === 'weekly' ? t('раз в неделю') : t('каждый день')}, ${pad2(s.hour)}:00 (${s.serverTime.tz}). ` : `${t('Автоматические копии выключены — только вручную.')} `,
  h('a', { href: '#/backups/settings' }, t('Изменить расписание'))));

/** Каркас вкладки: загружает настройки, строит содержимое и умеет перерисоваться после сохранения. */
function tabShell(build) {
  const box = h('div', { class: 'stack' });
  const draw = async () => {
    let d; try { d = await get('/api/backups'); } catch (e) { clear(box).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); return; }
    clear(box).append(...[].concat(build(d, draw)));
  };
  draw();
  return box;
}

/* ---------------- вкладка «Система» ---------------- */
export function systemTab() {
  return tabShell((d, reload) => {
    const s = d.settings; const f = { system: s.system, panels: s.panels, panelIds: [...s.panelIds], storage: s.storage, keep: s.keep };
    const view = h('div', { class: 'stack' });
    const paint = () => {
      clear(view).append(
        h('p', { class: 'muted small' }, 'Зашифрованный паролем файл: настройки EasyAdmin и конфигурации панелей. Нужен, чтобы восстановить сам EasyAdmin или заново собрать сервисы на чистой панели. Содержимое баз и томов сюда не входит — для него вкладка «Данные». История нагрузки в копию не входит.'),
        scheduleNote(s),
        s.hasPassword ? null : warn(t('Не задан пароль копии — без него копии не создаются. Задайте его на вкладке «Настройки».')),
        lastLine(s.last, (l) => `${t('Последняя копия')}: ${fmtTime(l.ts)} · ${size(l.size)}`, 'Последняя копия не создана'),
        h('div', null, h('div', { class: 'small muted' }, 'Что копировать'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.system, onchange: (e) => { f.system = e.target.checked; } }), 'Система EasyAdmin (панели, пользователи, настройки, шаблоны)'),
          h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Конфигурации панелей Easypanel'),
          seg(f.panels, [['none', 'Не копировать'], ['all', 'Все панели'], ['selected', 'Выбранные']], (v) => { f.panels = v; paint(); }),
          f.panels === 'selected' ? h('div', { class: 'chips', style: { marginTop: '8px' } }, store.panels.map((p) => h('label', { class: 'chip clickable' }, h('input', { type: 'checkbox', checked: f.panelIds.includes(p.id), onchange: (e) => { f.panelIds = e.target.checked ? [...f.panelIds, p.id] : f.panelIds.filter((x) => x !== p.id); } }), ` ${p.name}`))) : null),
        h('div', null, h('div', { class: 'small muted' }, 'Где хранить'), seg(f.storage, [['local', 'На этом сервере'], ['s3', 'S3-хранилище']], (v) => { f.storage = v; paint(); }),
          f.storage === 'local' ? h('div', { class: 'small muted' }, 'Папка data/backups. Защищает от ошибок, но не от потери сервера — лучше S3 или регулярно скачивайте копии.')
            : s3Ready(s) ? h('div', { class: 'small muted' }, `${t('S3')}: ${s.s3.bucket} / ${s.s3.prefix}`) : warn(t('Хранилище S3 не настроено. Заполните его на вкладке «Настройки».'))),
        field('Сколько копий хранить', h('input', { class: 'input', type: 'number', min: 1, max: 60, value: f.keep, oninput: (e) => { f.keep = Number(e.target.value); } })),
        h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: () => saveSettings({ system: f.system, panels: f.panels, panelIds: f.panelIds, storage: f.storage, keep: f.keep }, reload) }, 'Сохранить'),
          h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; if (await saveSettings({ system: f.system, panels: f.panels, panelIds: f.panelIds, storage: f.storage, keep: f.keep })) { try { const r = await post('/api/backups/run'); toast(`${t('Копия создана')}: ${size(r.size)}`, 'success'); } catch (er) { toast(er.message, 'error', 9000); } } b.disabled = false; reload(); } }, icon('database', 14), 'Создать копию сейчас')),
        h('h4', null, 'Копии'), d.filesError ? h('div', { class: 'callout err compact' }, icon('alert', 14), d.filesError) : null,
        d.files.length ? h('div', { class: 'stack-sm' }, d.files.map((x) => h('div', { class: 'list-item' }, h('div', null, h('b', { class: 'mono small' }, x.name), h('div', { class: 'small muted' }, `${fmtTime(x.ts)} · ${size(x.size)}`)), h('span', { class: 'spacer' }),
          iconBtn('Скачать', 'download', async () => { try { const res = await fetch(`/api/backups/download?name=${encodeURIComponent(x.name)}`, { headers: { 'X-Requested-With': 'easyadmin' } }); if (!res.ok) throw new Error((await res.json()).error); download(x.name, await res.blob()); } catch (e) { toast(e.message, 'error'); } }),
          iconBtn('Проверить копию', 'shield', () => verifyModal(x.name)), iconBtn('Панели в копии', 'layers', () => panelsModal(x.name, d.files)), iconBtn('Восстановить систему', 'rotate', () => restoreSystem(x.name)),
          iconBtn('Удалить', 'trash', async () => { if (!await confirmDialog({ title: 'Удалить копию?', message: x.name, confirmText: 'Удалить', danger: true })) return; try { await del(`/api/backups?name=${encodeURIComponent(x.name)}`); reload(); } catch (e) { toast(e.message, 'error'); } }, 'danger-text')))) : h('p', { class: 'muted small' }, 'Копий пока нет.'));
    };
    paint();
    return view;
  });
}

/* ---------------- вкладка «Данные» ---------------- */
const scopeIds = (f) => (f.mode === 'all' ? store.panels.map((p) => p.id) : [...new Set(f.keys.map((k) => Number(k.split('|')[0])))]);
const openPanelStorage = () => { try { localStorage.setItem('ea-pset-section', 'infra'); } catch { /* приватный режим */ } };
const methodCard = (title, text, on, onToggle, body) => h('section', { class: 'card stack' },
  h('div', { class: 'card-head' }, h('h4', null, title), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => onToggle(e.target.checked) }), 'Включено')),
  h('p', { class: 'muted small' }, text), on ? body : null);

/** Итог последней сверки расписаний Easypanel с политикой: по каждой панели, что создано, обновлено, удалено и что не вышло. */
export function epReport(last) {
  if (!last) return h('div', { class: 'muted small' }, 'Расписания в панелях ещё не создавались.');
  const bad = last.panels.filter((p) => p.error).length;
  return h('div', { class: 'stack-sm' },
    h('div', { class: `callout compact ${bad ? 'err' : ''}` }, icon(bad ? 'alert' : 'activity', 14), h('span', { class: 'small' }, `${t('Последняя сверка')}: ${fmtTime(last.ts)}${bad ? ` · ${t('панелей с ошибкой')}: ${bad}` : ''}`)),
    ...last.panels.map((p) => h('div', { class: 'small' }, h('b', null, p.name), ` — ${t('создано')} ${p.created}, ${t('обновлено')} ${p.updated}, ${t('удалено')} ${p.removed}`,
      p.error ? h('div', { class: 'danger-text' }, p.error) : null, ...p.notes.map((n) => h('div', { class: 'muted' }, n)))));
}

/** Хранилище копий в каждой панели: единственное берётся само, из нескольких нужно выбрать, без хранилищ — сначала добавить его в панели. */
function storageRows(info, f) {
  if (!info) return h('div', { class: 'skeleton', style: { height: '40px' } });
  if (!info.length) return h('div', { class: 'muted small' }, 'Выберите сервисы выше — для их панелей появится выбор хранилища.');
  return h('div', { class: 'stack-sm' }, h('div', { class: 'small muted' }, 'Куда панели складывают копии'), ...info.map((p) => {
    if (p.error) return warn(`${p.name}: ${p.error}`);
    if (!p.providers.length) return warn(`${p.name}: ${t('в панели нет хранилища бэкапов')}. `, h('a', { href: `#/panel/${p.panelId}/settings`, onclick: openPanelStorage }, t('Добавить хранилище')));
    const cur = f.providers[p.panelId] ?? (p.providers.length === 1 ? p.providers[0].id : '');
    return h('div', { class: 'list-item' }, h('b', null, p.name), h('span', { class: 'spacer' }),
      p.providers.length === 1 ? h('span', { class: 'muted small' }, p.providers[0].name || p.providers[0].id)
        : h('select', { class: 'input', onchange: (e) => { f.providers[p.panelId] = e.target.value; } }, cur ? null : h('option', { value: '' }, t('— выберите —')), p.providers.map((x) => h('option', { value: x.id, selected: x.id === cur }, x.name || x.id))));
  }));
}

export function dataTab() {
  return tabShell((d, reload) => {
    const s = d.settings; const f = { ...s.data, keys: [...s.data.keys], methods: { ...s.data.methods }, providers: { ...s.data.providers } };
    const view = h('div', { class: 'stack' });
    const progress = h('div'); progress.append(dataProgress());
    const filesBox = h('div', { class: 'stack-sm' });
    const epBox = h('div', { class: 'stack-sm' }); let epKey = null;
    const patch = () => ({ data: { mode: f.mode, keys: f.keys, dest: f.dest, dir: f.dir, keep: f.keep, minFreeMb: f.minFreeMb, consistency: f.consistency, methods: f.methods, providers: Object.fromEntries(Object.entries(f.providers).filter(([, v]) => v)) } });
    /** Список хранилищ панелей из охвата и итог последней сверки; перечитывается, когда охват изменился. */
    const drawEp = async (force) => {
      if (!f.methods.easypanel || f.mode === 'none') return;
      const ids = scopeIds(f); const key = ids.join(','); if (!force && key === epKey) return; epKey = key;
      clear(epBox).append(storageRows(null, f));
      try { const r = await get(`/api/backups/ep${ids.length ? `?panel=${ids.join(',')}` : ''}`); clear(epBox).append(storageRows(r.panels, f), r.managed || r.last ? epReport(r.last) : null); }
      catch (e) { clear(epBox).append(h('div', { class: 'callout err compact' }, icon('alert', 14), e.message)); }
    };
    /** Приводит расписания в панелях к настройкам; вызывается после сохранения и по кнопке. */
    const syncEp = async () => {
      try {
        const r = await post('/api/backups/ep/sync'); const sum = r.panels.reduce((a, p) => ({ c: a.c + p.created, u: a.u + p.updated, d: a.d + p.removed }), { c: 0, u: 0, d: 0 });
        toast(`${t('Расписания Easypanel')}: ${t('создано')} ${sum.c}, ${t('обновлено')} ${sum.u}, ${t('удалено')} ${sum.d}`, r.ok ? 'success' : 'error', r.ok ? 4000 : 9000);
      } catch (e) { toast(e.message, 'error', 9000); }
    };
    const apply = async () => { if (await saveSettings(patch())) { if (f.methods.easypanel || s.data.methods.easypanel) await syncEp(); reload(); } };
    const showFiles = async () => {
      clear(filesBox).append(h('div', { class: 'skeleton', style: { height: '60px' } }));
      try {
        const { files } = await get('/api/backups/data/files'); clear(filesBox);
        if (!files.length) return filesBox.append(h('p', { class: 'muted small' }, 'Копий данных пока нет.'));
        filesBox.append(...files.map((x) => x.error ? h('div', { class: 'callout err compact' }, icon('alert', 14), `${x.panel}: ${x.error}`)
          : h('div', { class: 'list-item' }, h('div', null, h('b', { class: 'mono small' }, x.name), h('div', { class: 'small muted' }, `${x.panel} · ${fmtTime(x.ts)} · ${size(x.size)}`)), h('span', { class: 'spacer' }),
            h('button', { class: 'btn sm', onclick: async () => { try { const hint = await post('/api/backups/data/hint', { panelId: x.panelId, name: x.name }); modal({ title: 'Как восстановить', wide: true, body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Выполните на сервере панели.'), ...hint.notes.map((n) => h('div', { class: 'callout compact' }, icon('alert', 14), h('span', { class: 'small' }, n))), h('pre', { class: 'code' }, hint.text)), actions: [{ label: 'Копировать', close: false, onClick: () => { copyText(hint.text); return false; } }, { label: 'Закрыть', kind: 'ghost' }] }); } catch (e) { toast(e.message, 'error'); } } }, icon('rotate', 13), 'Как восстановить'))));
      } catch (e) { clear(filesBox).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
    };
    const paint = () => {
      const both = f.methods.easyadmin && f.methods.easypanel;
      clear(view).append(
        h('p', { class: 'muted small' }, 'Защита баз и томов в одном месте: выберите сервисы и включите один или оба способа. Расписание и число копий общие — меняйте их здесь и на вкладке «Настройки», EasyAdmin сам приведёт к ним расписания в панелях.'),
        scheduleNote(s),
        h('div', null, h('div', { class: 'small muted' }, 'Что копировать'),
          seg(f.mode, [['none', 'Не копировать'], ['all', 'Все сервисы'], ['selected', 'Выбранные']], (v) => { f.mode = v; paint(); drawEp(); })),
        f.mode === 'selected' ? h('div', { class: 'stack-sm' }, store.panels.map((p) => h('details', { class: 'diag', open: f.keys.some((k) => k.startsWith(`${p.id}|`)) }, h('summary', null, h('b', null, p.name)),
          h('div', { class: 'chips', style: { marginTop: '6px' } }, (p.tree?.projects ?? []).flatMap((pr) => pr.services.filter((sv) => sv.type !== 'compose' || f.methods.easyadmin).map((sv) => { const k = `${p.id}|${pr.name}|${sv.name}`; return h('label', { class: 'chip clickable' }, h('input', { type: 'checkbox', checked: f.keys.includes(k), onchange: (e) => { f.keys = e.target.checked ? [...f.keys, k] : f.keys.filter((x) => x !== k); drawEp(); } }), ` ${pr.name}/${sv.name}`); })))))) : null,
        f.mode === 'none' ? null : h('div', { class: 'stack' },
          methodCard('Расписание Easypanel', 'EasyAdmin создаёт расписания в самих панелях — так же, как если бы вы настроили их вручную во вкладке «Бэкапы» сервиса. Копии делает и хранит панель; базы восстанавливаются из карточки сервиса. Подходит для баз Postgres, MySQL, MariaDB, Mongo и для приложений с томами. Свои расписания в панелях EasyAdmin не трогает.', f.methods.easypanel, (v) => { f.methods.easypanel = v; epKey = null; paint(); drawEp(true); }, h('div', { class: 'stack-sm' },
            epBox, h('div', null, h('button', { class: 'btn sm', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; if (await saveSettings(patch())) { await syncEp(); drawEp(true); } b.disabled = false; } }, icon('refresh', 13), 'Сохранить и сверить расписания')),
            h('div', { class: 'small muted' }, 'Время запуска — по часам сервера той панели. Расписания, созданные EasyAdmin, при сверке приводятся к этим настройкам: правьте их здесь, а не в панели.'))),
          methodCard('Копии данных EasyAdmin', 'Дамп базы (Postgres, MySQL, MariaDB, Mongo, Redis) или копия томов снимается прямо на сервере панели и не проходит через EasyAdmin. Базы и тома внутри compose-стеков тоже копируются; тома самих баз не копируются — для них есть дамп. Восстанавливают вручную по подсказке.', f.methods.easyadmin, (v) => { f.methods.easyadmin = v; paint(); }, h('div', { class: 'stack' },
            h('div', null, h('div', { class: 'small muted' }, 'Куда сохранять данные'), seg(f.dest, [['host', 'На сервер панели'], ['s3', 'В S3']], (v) => { f.dest = v; paint(); }),
              h('div', { class: 'small muted' }, f.dest === 'host' ? 'Файлы остаются на сервере каждой панели. Это не спасает от потери самого сервера.' : 'Сервер панели загружает файл сам по временным ссылкам; ключи S3 на него не передаются. Большие тома загружаются частями.'),
              f.dest === 's3' && !s3Ready(s) ? warn(t('Хранилище S3 не настроено. Заполните его на вкладке «Настройки».')) : null),
            f.dest === 'host' ? field('Папка на сервере панели', h('input', { class: 'input mono', value: f.dir, oninput: (e) => { f.dir = e.target.value; } })) : null,
            field('Свободного места не меньше, МБ', h('input', { class: 'input', type: 'number', min: 0, value: f.minFreeMb, oninput: (e) => { f.minFreeMb = Number(e.target.value); } }), 'Если места меньше, копирование не начнётся.'),
            h('div', null, h('div', { class: 'small muted' }, 'Тома во время копирования'), seg(f.consistency, [['none', 'Как есть'], ['pause', 'Приостановить'], ['stop', 'Остановить']], (v) => { f.consistency = v; paint(); }),
              h('div', { class: 'small muted' }, f.consistency === 'none' ? 'Копия «на живую»: быстро, но файлы могут измениться во время копирования.' : f.consistency === 'pause' ? 'Сервис замораживается (docker pause) на время копирования тома и затем продолжает работу — данные согласованы, соединения не рвутся.' : 'Сервис останавливается на время копирования тома и затем запускается снова — самый надёжный вариант, но с простоем.')))),
          both ? h('div', { class: 'callout compact' }, icon('shield', 14), h('span', { class: 'small' }, 'Включены оба способа: копии лягут в два разных места, и потеря одного хранилища не оставит без данных.')) : null,
          !f.methods.easyadmin && !f.methods.easypanel ? warn(t('Не выбран ни один способ — сервисы копироваться не будут.')) : null,
          field('Сколько копий хранить', h('input', { class: 'input', type: 'number', min: 1, max: 30, value: f.keep, oninput: (e) => { f.keep = Number(e.target.value); } }), 'Одно число для обоих способов (у расписаний Easypanel для томов — как задано в панели).'),
          h('div', { class: 'callout compact' }, icon('alert', 14), h('span', { class: 'small' }, 'Копии баз и томов паролем не шифруются: храните их там, куда доступ ограничен (права на папку, шифрование на стороне S3 или диска). Пароль нужен только копии самой системы EasyAdmin.'))),
        s.dataLast ? h('div', { class: `callout compact ${s.dataLast.ok ? '' : 'err'}` }, icon(s.dataLast.ok ? 'activity' : 'alert', 14), h('span', { class: 'small' }, `${t('Копии EasyAdmin')}: ${fmtTime(s.dataLast.ts)} · ${t('файлов')}: ${s.dataLast.files}${s.dataLast.failed ? ` · ${t('ошибок')}: ${s.dataLast.failed}` : ''}`)) : null,
        h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: apply }, 'Сохранить'),
          f.mode !== 'none' && f.methods.easyadmin ? h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { if (await saveSettings(patch())) { await post('/api/backups/data/run'); toast(t('Копирование данных запущено'), 'success'); progress.replaceChildren(dataProgress(() => { reload(); })); } } catch (er) { toast(er.message, 'error', 9000); } b.disabled = false; } }, icon('database', 14), 'Копировать данные сейчас') : null),
        f.methods.easyadmin ? progress : null,
        f.methods.easyadmin ? h('div', { class: 'stack-sm' }, h('h4', null, 'Копии данных EasyAdmin'),
          h('div', null, h('button', { class: 'btn sm', onclick: showFiles }, icon('layers', 13), 'Показать копии'), h('span', { class: 'muted small', style: { marginLeft: '10px' } }, t('Список запрашивается у серверов панелей, поэтому загружается по кнопке.'))),
          filesBox) : null);
    };
    paint(); drawEp(true);
    return view;
  });
}

/* ---------------- вкладка «Настройки» (общие для системы и данных) ---------------- */
export function backupSettingsTab() {
  return tabShell((d, reload) => {
    const s = d.settings; const f = { enabled: s.enabled, every: s.every, hour: s.hour, s3: { ...s.s3 }, password: '' };
    const view = h('div', { class: 'stack' });
    const paint = () => {
      clear(view).append(
        h('p', { class: 'muted small' }, 'Эти настройки общие для вкладок «Система» и «Данные»: когда делать копии (то же расписание EasyAdmin переносит в расписания Easypanel), куда загружать в S3 и пароль копии системы.'),
        h('section', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h4', null, 'Расписание'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.enabled, onchange: (e) => { f.enabled = e.target.checked; saveSettings({ enabled: f.enabled }, reload); } }), 'По расписанию')),
          h('div', { class: 'grid-2' }, field('Как часто', seg(f.every, [['daily', 'Каждый день'], ['weekly', 'Раз в неделю']], (v) => { f.every = v; paint(); })),
            field('Во сколько (час)', h('input', { class: 'input', type: 'number', min: 0, max: 23, value: f.hour, oninput: (e) => { f.hour = Number(e.target.value); } }), `${t('По времени сервера EasyAdmin')}: ${pad2(s.serverTime.hour)}:${pad2(s.serverTime.minute)} (${s.serverTime.tz}). ${t('Пояс меняется в «Настройки → Время сервера».')} ${t('У расписаний Easypanel время — по часам сервера панели.')}`))),
        h('section', { class: 'card stack' }, h('h4', null, 'Хранилище S3'),
          h('p', { class: 'muted small' }, 'Нужно, если системные копии хранятся в S3 или копии данных сохраняются в S3.'),
          h('div', { class: 'grid-2' }, field('Адрес (endpoint)', h('input', { class: 'input mono', value: f.s3.endpoint, placeholder: 'https://s3.example.com', oninput: (e) => { f.s3.endpoint = e.target.value; } })), field('Регион', h('input', { class: 'input mono', value: f.s3.region, oninput: (e) => { f.s3.region = e.target.value; } }))),
          h('div', { class: 'grid-2' }, field('Бакет', h('input', { class: 'input mono', value: f.s3.bucket, oninput: (e) => { f.s3.bucket = e.target.value; } })), field('Папка в бакете', h('input', { class: 'input mono', value: f.s3.prefix, oninput: (e) => { f.s3.prefix = e.target.value; } }))),
          h('div', { class: 'grid-2' }, field('Access key', h('input', { class: 'input mono', value: f.s3.accessKey, autocomplete: 'off', oninput: (e) => { f.s3.accessKey = e.target.value; } })), field('Secret key', h('input', { class: 'input mono', type: 'password', autocomplete: 'new-password', placeholder: s.s3.hasSecret ? t('задан — оставьте пустым, чтобы не менять') : '', oninput: (e) => { f.s3.secretKey = e.target.value; } }))),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.s3.pathStyle, onchange: (e) => { f.s3.pathStyle = e.target.checked; } }), 'Адресация path-style (MinIO, большинство совместимых хранилищ)')),
        h('section', { class: 'card stack' }, h('h4', null, 'Пароль копии системы'),
          h('p', { class: 'muted small' }, 'Нужен только для копии самого EasyAdmin (вкладка «Система»): в ней лежат ключ приложения и токены панелей, поэтому она всегда шифруется. Копии баз и томов и расписания Easypanel этим паролем не защищаются.'),
          field('Пароль копии', h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: s.hasPassword ? t('задан — оставьте пустым, чтобы не менять') : t('не короче 8 символов'), oninput: (e) => { f.password = e.target.value; } }), 'Без пароля копию системы не открыть. Запишите его отдельно: восстановить пароль нельзя.')),
        h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: () => saveSettings({ every: f.every, hour: f.hour, s3: { endpoint: f.s3.endpoint, region: f.s3.region, bucket: f.s3.bucket, prefix: f.s3.prefix, accessKey: f.s3.accessKey, secretKey: f.s3.secretKey || undefined, pathStyle: f.s3.pathStyle }, ...(f.password ? { password: f.password } : {}) }, reload) }, 'Сохранить')));
    };
    paint();
    return view;
  });
}

