import { del, get, post, put } from './api.js';
import { clear, confirmDialog, field, fmtTime, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { store } from './store.js';

/** Резервные копии EasyAdmin: что копировать (система, панели — все или выбранные), расписание, хранилище, пароль, список копий, проверка и восстановление. */
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const seg = (cur, options, onPick) => h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { type: 'button', class: `seg-btn ${cur === v ? 'active' : ''}`, onclick: () => onPick(v) }, l)));
const iconBtn = (title, ic, onclick, cls = '') => h('button', { class: `btn sm icon ghost ${cls}`, title, 'aria-label': title, onclick }, icon(ic, 14));
const download = (name, blob) => { const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url); };

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

export function backupsCard() {
  const box = h('section', { class: 'card stack' });
  const draw = async () => {
    let d; try { d = await get('/api/backups'); } catch (e) { clear(box).append(h('h3', null, 'Резервные копии'), h('p', { class: 'muted' }, e.message)); return; }
    const s = d.settings; const f = { ...s, panelIds: [...s.panelIds], s3: { ...s.s3 }, password: '' };
    const redraw = () => { clear(box); build(); };
    const save = async (extra = {}) => {
      try {
        const body = { enabled: f.enabled, system: f.system, panels: f.panels, panelIds: f.panelIds, every: f.every, hour: f.hour, keep: f.keep, storage: f.storage, s3: { endpoint: f.s3.endpoint, region: f.s3.region, bucket: f.s3.bucket, prefix: f.s3.prefix, accessKey: f.s3.accessKey, secretKey: f.s3.secretKey || undefined, pathStyle: f.s3.pathStyle }, ...extra };
        if (f.password) body.password = f.password;
        await put('/api/backups/settings', body); toast(t('Сохранено'), 'success'); draw();
      } catch (e) { toast(e.message, 'error', 8000); }
    };
    const build = () => {
      const last = s.last;
      box.append(h('div', { class: 'card-head' }, h('h3', null, 'Резервные копии'), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.enabled, onchange: (e) => { f.enabled = e.target.checked; save(); } }), 'По расписанию')),
        h('p', { class: 'muted small' }, 'Зашифрованный паролем файл: система EasyAdmin и конфигурации панелей. История нагрузки в копию не входит.'),
        last ? h('div', { class: `callout compact ${last.ok ? '' : 'err'}` }, icon(last.ok ? 'activity' : 'alert', 14), h('span', { class: 'small' }, last.ok ? `${t('Последняя копия')}: ${fmtTime(last.ts)} · ${size(last.size)}` : `${t('Последняя копия не создана')}: ${last.error}`)) : null,
        h('div', null, h('div', { class: 'small muted' }, 'Что копировать'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.system, onchange: (e) => { f.system = e.target.checked; } }), 'Система EasyAdmin (панели, пользователи, настройки, шаблоны)'),
          h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Конфигурации панелей Easypanel'),
          seg(f.panels, [['none', 'Не копировать'], ['all', 'Все панели'], ['selected', 'Выбранные']], (v) => { f.panels = v; redraw(); }),
          f.panels === 'selected' ? h('div', { class: 'chips', style: { marginTop: '8px' } }, store.panels.map((p) => h('label', { class: 'chip clickable' }, h('input', { type: 'checkbox', checked: f.panelIds.includes(p.id), onchange: (e) => { f.panelIds = e.target.checked ? [...f.panelIds, p.id] : f.panelIds.filter((x) => x !== p.id); } }), ` ${p.name}`))) : null),
        h('div', { class: 'grid-3' }, field('Как часто', seg(f.every, [['daily', 'Каждый день'], ['weekly', 'Раз в неделю']], (v) => { f.every = v; redraw(); })),
          field('Во сколько (час)', h('input', { class: 'input', type: 'number', min: 0, max: 23, value: f.hour, oninput: (e) => { f.hour = Number(e.target.value); } })),
          field('Сколько копий хранить', h('input', { class: 'input', type: 'number', min: 1, max: 60, value: f.keep, oninput: (e) => { f.keep = Number(e.target.value); } }))),
        h('div', null, h('div', { class: 'small muted' }, 'Где хранить'), seg(f.storage, [['local', 'На этом сервере'], ['s3', 'S3-хранилище']], (v) => { f.storage = v; redraw(); }),
          f.storage === 'local' ? h('div', { class: 'small muted' }, 'Папка data/backups. Защищает от ошибок, но не от потери сервера — лучше S3 или регулярно скачивайте копии.') : h('div', { class: 'stack', style: { marginTop: '8px' } },
            h('div', { class: 'grid-2' }, field('Адрес (endpoint)', h('input', { class: 'input mono', value: f.s3.endpoint, placeholder: 'https://s3.example.com', oninput: (e) => { f.s3.endpoint = e.target.value; } })), field('Регион', h('input', { class: 'input mono', value: f.s3.region, oninput: (e) => { f.s3.region = e.target.value; } }))),
            h('div', { class: 'grid-2' }, field('Бакет', h('input', { class: 'input mono', value: f.s3.bucket, oninput: (e) => { f.s3.bucket = e.target.value; } })), field('Папка в бакете', h('input', { class: 'input mono', value: f.s3.prefix, oninput: (e) => { f.s3.prefix = e.target.value; } }))),
            h('div', { class: 'grid-2' }, field('Access key', h('input', { class: 'input mono', value: f.s3.accessKey, autocomplete: 'off', oninput: (e) => { f.s3.accessKey = e.target.value; } })), field('Secret key', h('input', { class: 'input mono', type: 'password', autocomplete: 'new-password', placeholder: s.s3.hasSecret ? t('задан — оставьте пустым, чтобы не менять') : '', oninput: (e) => { f.s3.secretKey = e.target.value; } }))),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.s3.pathStyle, onchange: (e) => { f.s3.pathStyle = e.target.checked; } }), 'Адресация path-style (MinIO, большинство совместимых хранилищ)'))),
        field('Пароль копии', h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: s.hasPassword ? t('задан — оставьте пустым, чтобы не менять') : t('не короче 8 символов'), oninput: (e) => { f.password = e.target.value; } }), 'Без пароля копию не открыть. Запишите его отдельно: восстановить пароль нельзя.'),
        h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: () => save() }, 'Сохранить'),
          h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await save(); const r = await post('/api/backups/run'); toast(`${t('Копия создана')}: ${size(r.size)}`, 'success'); } catch (er) { toast(er.message, 'error', 9000); } b.disabled = false; draw(); } }, icon('database', 14), 'Создать копию сейчас')),
        h('h4', null, 'Копии'), d.filesError ? h('div', { class: 'callout err compact' }, icon('alert', 14), d.filesError) : null,
        d.files.length ? h('div', { class: 'stack-sm' }, d.files.map((x) => h('div', { class: 'list-item' }, h('div', null, h('b', { class: 'mono small' }, x.name), h('div', { class: 'small muted' }, `${fmtTime(x.ts)} · ${size(x.size)}`)), h('span', { class: 'spacer' }),
          iconBtn('Скачать', 'download', async () => { try { const res = await fetch(`/api/backups/download?name=${encodeURIComponent(x.name)}`, { headers: { 'X-Requested-With': 'easyadmin' } }); if (!res.ok) throw new Error((await res.json()).error); download(x.name, await res.blob()); } catch (e) { toast(e.message, 'error'); } }),
          iconBtn('Проверить копию', 'shield', () => verifyModal(x.name)), iconBtn('Панели в копии', 'layers', () => panelsModal(x.name, d.files)), iconBtn('Восстановить систему', 'rotate', () => restoreSystem(x.name)),
          iconBtn('Удалить', 'trash', async () => { if (!await confirmDialog({ title: 'Удалить копию?', message: x.name, confirmText: 'Удалить', danger: true })) return; try { await del(`/api/backups?name=${encodeURIComponent(x.name)}`); draw(); } catch (e) { toast(e.message, 'error'); } }, 'danger-text')))) : h('p', { class: 'muted small' }, 'Копий пока нет.'));
    };
    clear(box); build();
  };
  draw();
  return box;
}
