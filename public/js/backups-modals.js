import { del, get, post, put } from './api.js';
import { clear, confirmDialog, field, fmtTime, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { store } from './store.js';
import { isArchive, restoreWizard } from './restore-wizard.js';

/** Окна и кирпичики раздела «Бэкапы» и вкладки «Бэкапы» сервиса. Резервные копии EasyAdmin: что копировать (система, панели — все или выбранные), расписание, хранилище, пароль, список копий, проверка и восстановление. */
export const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
export const seg = (cur, options, onPick) => h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { type: 'button', class: `seg-btn ${cur === v ? 'active' : ''}`, onclick: () => onPick(v) }, l)));
export const iconBtn = (title, ic, onclick, cls = '') => h('button', { class: `btn sm icon ghost ${cls}`, title, 'aria-label': title, onclick }, icon(ic, 14));
export const copyText = (text) => { navigator.clipboard?.writeText(text); toast(t('Скопировано'), 'success'); };
export const download = (name, blob) => { const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url); };

const askPassword = (text) => new Promise((resolve) => {
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: t('Оставьте пустым — использовать пароль из настроек') });
  modal({ title: 'Пароль копии', body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, text), input), actions: [{ label: 'Отмена', kind: 'ghost', onClick: () => resolve(null) }, { label: 'Продолжить', kind: 'primary', onClick: () => resolve(input.value) }], onClose: () => resolve(null) });
});

export async function verifyModal(name) {
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

export async function restoreSystem(name) {
  const pw = await askPassword('Введите пароль копии (или оставьте пустым, чтобы взять сохранённый).'); if (pw == null) return;
  if (!await confirmDialog({ title: 'Восстановить систему из копии?', danger: true, confirmText: 'Восстановить и перезапустить', typeToConfirm: 'EasyAdmin',
    message: 'Текущие панели, пользователи и настройки будут заменены данными из копии. EasyAdmin перезапустится на несколько секунд, прежняя база сохранится в папке before-restore рядом с данными. Войти придётся с учётными данными из копии.' })) return;
  try {
    const r = await post('/api/backups/restore', { name, password: pw || undefined, confirm: true });
    if (r.warn) toast(r.warn, 'error', 12000);
    toast(t('Восстановление запущено, страница обновится'), 'success'); setTimeout(() => location.reload(), 6000);
  } catch (e) { toast(e.message, 'error', 8000); }
}

export async function panelsModal(name, files) {
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

/* ---------------- состояние и общие действия ---------------- */
const pad2 = (n) => String(n).padStart(2, '0');
export const STATUS = {
  off: ['Не копируется', 'muted'], error: ['Ошибка', 'err'], stale: ['Давно не было', 'warn'], pending: ['Ждёт первой копии', 'warn'],
  queued: ['В очереди', 'muted'], running: ['Копируется…', 'warn'], empty: ['Нечего копировать', 'muted'], ok: ['В порядке', 'ok'],
};
export const switchBtn = (on, label, onclick, disabled = false) => h('button', { type: 'button', class: `toggle ${on ? 'on' : ''}`, role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, title: label, disabled, onclick });

/** Понятное название части сервиса по имени файла внутри архива (db-postgres.sql.gz, cvol~app~имя.tar.gz, bind-имя.tar.gz …). */
export function partTitle(member) {
  const m = String(member ?? '').replace(/\.(sql|archive|rdb|tar)\.gz$/, ''); const p = m.split('~');
  if (p[0] === 'cdb') return `${t('база')} ${p[1]}${p[2] ? ` (${p[2]})` : ''}`;
  if (m.startsWith('db-')) return `${t('база')} ${m.slice(3)}`;
  if (p[0] === 'cvol') return `${t('том')} ${p.slice(2).join('~')}`;
  if (m.startsWith('vol-')) return `${t('том')} ${m.slice(4)}`;
  if (p[0] === 'cbind') return `${t('папка')} ${p.slice(2).join('~')}`;
  if (m.startsWith('bind-')) return `${t('папка')} ${m.slice(5)}`;
  return m;
}

/** Что поменять в настройках, чтобы сервис вошёл в копии или вышел из них. mode/keys — текущие, allKeys — все сервисы обзора. */
export function inclusionPatch({ mode, keys, allKeys }, key, on) {
  const cur = mode === 'all' ? allKeys : mode === 'selected' ? keys : [];
  const next = on ? [...new Set([...cur, key])] : cur.filter((k) => k !== key);
  return { data: next.length ? { mode: 'selected', keys: next } : { mode: 'none' } };
}
export const saveSettings = async (patch) => { try { await put('/api/backups/settings', patch); return true; } catch (e) { toast(e.message, 'error', 8000); return false; } };

/** Один запуск копирования (всех сервисов или одного); ход виден в странице раздела. */
export async function runCopy(only) {
  try { await post('/api/backups/data/run', only ?? {}); toast(t('Копирование запущено'), 'success'); return true; } catch (e) { toast(e.message, 'error', 9000); return false; }
}

/* ---------------- журнал копирования ---------------- */
const REASON = { manual: 'вручную', schedule: 'по расписанию', resume: 'дослежен после перезапуска EasyAdmin' };
const ITEM_MARK = { ok: '✓', fail: '✗', run: '…', wait: '·' };
const itemLine = (x) => h('div', { class: 'small', style: { marginLeft: '12px' } }, `${ITEM_MARK[x.status] ?? '·'} ${x.label}`, x.size ? h('span', { class: 'muted' }, ` · ${size(x.size)}`) : null,
  x.error ? h('div', { class: 'danger-text log-err' }, x.error) : null, x.note ? h('div', { class: 'warn-text log-err' }, `${t('пропущено')}: ${x.note}`) : null);

/** Один запуск: по панелям и сервисам, с полным текстом ошибок. */
export function runDetails(run) {
  return h('div', { class: 'stack-sm' }, ...run.panels.map((p) => h('div', { class: 'stack-sm' },
    h('div', { class: 'inline' }, h('b', null, p.name), h('span', { class: `badge ${p.status === 'done' ? 'ok' : p.status === 'partial' || p.status === 'error' ? 'err' : ''}` }, ({ done: 'готово', partial: 'есть ошибки', error: 'ошибка' })[p.status] ?? p.status)),
    p.error ? h('div', { class: 'danger-text small log-err' }, p.error) : null, p.note ? h('div', { class: 'muted small' }, p.note) : null,
    ...p.items.map(itemLine), p.empty?.length ? h('div', { class: 'muted small', style: { marginLeft: '12px' } }, `${t('нечего копировать')}: ${p.empty.join(', ')}`) : null)));
}

export async function logModal() {
  const body = h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { height: '80px' } }));
  modal({ title: 'Журнал копирования', wide: true, body, actions: [{ label: 'Закрыть', kind: 'ghost' }] });
  try {
    const { runs } = await get('/api/backups/data/log'); clear(body);
    if (!runs.length) return body.append(h('p', { class: 'muted' }, 'Запусков ещё не было.'));
    body.append(h('p', { class: 'muted small' }, 'Последние запуски копирования данных: что и как скопировалось, полный текст ошибок.'), ...runs.map((r) => {
      const det = h('div', { hidden: true, style: { padding: '8px 4px 2px' } }, runDetails(r));
      const head = h('button', { type: 'button', class: 'list-item link btn-row', onclick: () => { det.hidden = !det.hidden; } },
        h('div', null, h('b', null, fmtTime(r.ts)), h('span', { class: 'muted small' }, `  ${t(r.only ? 'один сервис' : REASON[r.reason] ?? r.reason)}`)),
        h('div', { class: 'inline' }, h('span', { class: `badge ${r.ok ? 'ok' : 'err'}` }, r.ok ? t('без ошибок') : `${t('ошибок')}: ${r.failed}`), h('span', { class: 'muted small' }, `${t('копий')}: ${r.files}`), icon('chevron', 14)));
      return h('div', null, head, det);
    }));
  } catch (e) { clear(body).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
}

/** Последние запуски одного сервиса (из журнала): когда, чем закончились, текст ошибки. */
export function serviceHistory({ project, name, panelName }) {
  const box = h('div', { class: 'stack-sm' }); const label = `${project}/${name}`;
  get('/api/backups/data/log').then(({ runs }) => {
    const rows = runs.flatMap((r) => r.panels.filter((p) => !panelName || p.name === panelName).flatMap((p) => p.items.filter((x) => x.label === label).map((x) => ({ r, p, x })))).slice(0, 8);
    box.append(...(rows.length ? rows.map(({ r, x }) => h('div', { class: 'list-item' }, h('div', null, h('b', { class: 'small' }, fmtTime(r.ts)), x.error ? h('div', { class: 'danger-text small log-err' }, x.error) : x.note ? h('div', { class: 'warn-text small' }, `${t('пропущено')}: ${x.note}`) : null),
      h('div', { class: 'inline' }, x.size ? h('span', { class: 'muted small' }, size(x.size)) : null, h('span', { class: `badge ${x.status === 'ok' ? 'ok' : x.status === 'fail' ? 'err' : ''}` }, x.status === 'ok' ? t('ок') : x.status === 'fail' ? t('ошибка') : '…')))) : [h('p', { class: 'muted small' }, 'Запусков с этим сервисом ещё не было.')]));
  }).catch(() => {});
  return box;
}

/* ---------------- как восстановить ---------------- */
export async function hintModal(panelId, name) {
  try {
    const hint = await post('/api/backups/data/hint', { panelId, name });
    modal({ title: 'Как восстановить', wide: true, body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Выполните на сервере панели.'),
      ...hint.notes.map((n) => h('div', { class: 'callout compact' }, icon('alert', 14), h('span', { class: 'small' }, n))), h('pre', { class: 'code' }, hint.text)),
    actions: [{ label: 'Копировать', close: false, onClick: () => { copyText(hint.text); return false; } }, { label: 'Закрыть', kind: 'ghost' }] });
  } catch (e) { toast(e.message, 'error'); }
}

/** Список копий одного сервиса (с сервера панели или из S3) и кнопка «Как восстановить». */
export function copiesList({ panelId, project, name }) {
  const box = h('div', { class: 'stack-sm' });
  const load = async () => {
    clear(box).append(h('div', { class: 'skeleton', style: { height: '56px' } }));
    try {
      const q = new URLSearchParams({ panel: String(panelId), project, service: name });
      const { files } = await get(`/api/backups/data/files?${q}`); clear(box);
      if (!files.length) return box.append(h('p', { class: 'muted small' }, 'Копий этого сервиса пока нет.'));
      box.append(...files.map((x) => (x.error ? h('div', { class: 'callout err compact' }, icon('alert', 14), x.error)
        : h('div', { class: 'list-item' }, h('div', null, h('b', { class: 'mono small' }, x.name), h('div', { class: 'small muted' }, `${fmtTime(x.ts)} · ${size(x.size)}`)), h('span', { class: 'spacer' }),
          isArchive(x.name) ? h('button', { class: 'btn sm primary', onclick: () => restoreWizard({ panelId: x.panelId, panelName: x.panel, name: x.name }) }, icon('rotate', 13), 'Восстановить') : null,
          h('button', { class: 'btn sm', onclick: () => hintModal(x.panelId, x.name) }, icon('terminal', 13), 'Как восстановить')))));
    } catch (e) { clear(box).append(h('div', { class: 'callout err compact' }, icon('alert', 14), e.message)); }
  };
  load();
  return box;
}
export const copiesModal = (svc) => modal({ title: `${svc.project}/${svc.name}`, wide: true, body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Копии лежат в выбранном хранилище, зашифрованы паролем копий. Распаковка и восстановление — по подсказке.'), copiesList(svc), h('h4', null, 'Последние запуски'), serviceHistory(svc)), actions: [{ label: 'Закрыть', kind: 'ghost' }] });

/* ---------------- копии самого EasyAdmin (система и конфигурации панелей) ---------------- */
export function systemCopiesModal(files, reload) {
  const body = h('div', { class: 'stack-sm' });
  const draw = () => {
    clear(body).append(...(files.length ? files.map((x) => h('div', { class: 'list-item' }, h('div', null, h('b', { class: 'mono small' }, x.name), h('div', { class: 'small muted' }, `${fmtTime(x.ts)} · ${size(x.size)}`)), h('span', { class: 'spacer' }),
      iconBtn('Скачать', 'download', async () => { try { const res = await fetch(`/api/backups/download?name=${encodeURIComponent(x.name)}`, { headers: { 'X-Requested-With': 'easyadmin' } }); if (!res.ok) throw new Error((await res.json()).error); download(x.name, await res.blob()); } catch (e) { toast(e.message, 'error'); } }),
      iconBtn('Проверить копию', 'shield', () => verifyModal(x.name)), iconBtn('Панели в копии', 'layers', () => panelsModal(x.name, files)), iconBtn('Восстановить систему', 'rotate', () => restoreSystem(x.name)),
      iconBtn('Удалить', 'trash', async () => { if (!await confirmDialog({ title: 'Удалить копию?', message: x.name, confirmText: 'Удалить', danger: true })) return; try { await del(`/api/backups?name=${encodeURIComponent(x.name)}`); files.splice(files.indexOf(x), 1); draw(); reload?.(); } catch (e) { toast(e.message, 'error'); } }, 'danger-text'))) : [h('p', { class: 'muted small' }, 'Копий пока нет.')]));
  };
  draw();
  modal({ title: 'Копии EasyAdmin', wide: true, body, actions: [{ label: 'Закрыть', kind: 'ghost' }] });
}

/* ---------------- настройки: когда, куда, пароль ---------------- */
export async function settingsModal(reload, { focusPassword = false } = {}) {
  let d; try { d = await get('/api/backups'); } catch (e) { return toast(e.message, 'error'); }
  const s = d.settings; const f = { enabled: s.enabled, every: s.every, hour: s.hour, where: s.where, keep: s.data.keep, dir: s.data.dir, consistency: s.data.consistency, minFreeMb: s.data.minFreeMb, s3: { ...s.s3 }, password: '' };
  const body = h('div', { class: 'stack' }); let modalHandle;
  const s3Ready = () => !!(f.s3.endpoint && f.s3.bucket && f.s3.accessKey && (s.s3.hasSecret || f.s3.secretKey));
  let s3Open = !s3Ready(); let advOpen = false;
  const s3Summary = () => { let host = f.s3.endpoint; try { host = new URL(f.s3.endpoint).host; } catch {} return s3Ready() ? `S3 · ${f.s3.bucket}${f.s3.prefix ? '/' + f.s3.prefix.replace(/\/$/, '') : ''} · ${host}` : t('S3 не настроен — заполните доступы'); };
  const paint = () => clear(body).append(
    h('section', { class: 'stack-sm' }, h('div', { class: 'inline' }, h('h4', null, 'Когда'), h('span', { class: 'spacer' }), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.enabled, onchange: (e) => { f.enabled = e.target.checked; } }), 'Копировать по расписанию')),
      h('div', { class: 'grid-2' }, field('Как часто', seg(f.every, [['daily', 'Каждый день'], ['weekly', 'Раз в неделю']], (v) => { f.every = v; paint(); })),
        field('Во сколько (час)', h('input', { class: 'input', type: 'number', min: 0, max: 23, value: f.hour, oninput: (e) => { f.hour = Number(e.target.value); } }), `${t('Сейчас на сервере EasyAdmin')}: ${pad2(s.serverTime.hour)}:${pad2(s.serverTime.minute)} (${s.serverTime.tz})`))),
    h('section', { class: 'stack-sm' }, h('h4', null, 'Куда'),
      seg(f.where, [['server', 'На сервере'], ['s3', 'В S3']], (v) => { f.where = v; paint(); }),
      h('div', { class: 'small muted' }, f.where === 'server' ? 'Копии баз и томов лежат на сервере своей панели, копии настроек EasyAdmin — в его папке data. Это не спасает от потери самого сервера.' : 'Все копии загружаются в S3-хранилище (серверы панелей грузят сами по временным ссылкам, ключи на них не передаются).'),
      f.where === 's3' ? h('details', { class: 'more', open: s3Open, ontoggle: (e) => { if (s3Open === e.target.open) return; s3Open = e.target.open; if (!s3Open) paint(); } }, h('summary', null, s3Summary(), h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, s3Open ? '' : 'Нажмите, чтобы изменить')), h('div', { class: 'stack', style: { paddingTop: '8px' } },
        h('div', { class: 'grid-2' }, field('Адрес (endpoint)', h('input', { class: 'input mono', value: f.s3.endpoint, placeholder: 'https://s3.example.com', oninput: (e) => { f.s3.endpoint = e.target.value; } })), field('Регион', h('input', { class: 'input mono', value: f.s3.region, oninput: (e) => { f.s3.region = e.target.value; } }))),
        h('div', { class: 'grid-2' }, field('Бакет', h('input', { class: 'input mono', value: f.s3.bucket, oninput: (e) => { f.s3.bucket = e.target.value; } })), field('Папка в бакете', h('input', { class: 'input mono', value: f.s3.prefix, oninput: (e) => { f.s3.prefix = e.target.value; } }))),
        h('div', { class: 'grid-2' }, field('Access key', h('input', { class: 'input mono', value: f.s3.accessKey, autocomplete: 'off', oninput: (e) => { f.s3.accessKey = e.target.value; } })), field('Secret key', h('input', { class: 'input mono', type: 'password', autocomplete: 'new-password', placeholder: s.s3.hasSecret ? t('задан — оставьте пустым, чтобы не менять') : '', oninput: (e) => { f.s3.secretKey = e.target.value; } }))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.s3.pathStyle, onchange: (e) => { f.s3.pathStyle = e.target.checked; } }), 'Адресация path-style (MinIO, большинство совместимых хранилищ)'),
      )) : null,
      field('Сколько копий хранить', h('input', { class: 'input', type: 'number', min: 1, max: 30, value: f.keep, oninput: (e) => { f.keep = Number(e.target.value); } }), 'Столько последних копий остаётся у каждого сервиса и у самого EasyAdmin.')),
    h('section', { class: 'stack-sm' }, h('h4', null, 'Пароль копий'),
      field('Пароль', h('input', { class: 'input', id: 'bk-pass', type: 'password', autocomplete: 'new-password', placeholder: s.hasPassword ? t('задан — оставьте пустым, чтобы не менять') : t('не короче 8 символов'), oninput: (e) => { f.password = e.target.value; } }),
        'Шифрует ВСЕ копии EasyAdmin: настройки, конфигурации панелей, базы и тома. Без него копии не открыть, восстановить пароль нельзя — запишите его отдельно.')),
    h('details', { class: 'more', open: advOpen, ontoggle: (e) => { advOpen = e.target.open; } }, h('summary', null, 'Дополнительно'), h('div', { class: 'stack', style: { paddingTop: '8px' } },
      f.where === 'server' ? field('Папка на сервере панели', h('input', { class: 'input mono', value: f.dir, oninput: (e) => { f.dir = e.target.value; } }), 'Сюда серверы панелей кладут копии своих баз и томов.') : null,
      h('div', null, h('div', { class: 'small muted' }, 'Тома во время копирования'), seg(f.consistency, [['none', 'Как есть'], ['pause', 'Приостановить'], ['stop', 'Остановить']], (v) => { f.consistency = v; paint(); }),
        h('div', { class: 'small muted' }, f.consistency === 'none' ? 'Копия «на живую»: быстро, но файлы могут измениться во время копирования.' : f.consistency === 'pause' ? 'Сервис замораживается (docker pause) на время копирования тома и затем продолжает работу.' : 'Сервис останавливается на время копирования тома и затем запускается снова — надёжнее, но с простоем.')),
      field('Свободного места не меньше, МБ', h('input', { class: 'input', type: 'number', min: 0, value: f.minFreeMb, oninput: (e) => { f.minFreeMb = Number(e.target.value); } }), 'Если места меньше, копирование не начнётся.'))));
  paint();
  modalHandle = modal({ title: 'Настройки бэкапов', wide: true, body, actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Сохранить', kind: 'primary', onClick: async () => {
    const patch = { enabled: f.enabled, every: f.every, hour: f.hour, where: f.where, keep: f.keep, data: { keep: f.keep, dir: f.dir, consistency: f.consistency, minFreeMb: f.minFreeMb },
      s3: { endpoint: f.s3.endpoint, region: f.s3.region, bucket: f.s3.bucket, prefix: f.s3.prefix, accessKey: f.s3.accessKey, secretKey: f.s3.secretKey || undefined, pathStyle: f.s3.pathStyle } };
    if (f.password) patch.password = f.password;
    await put('/api/backups/settings', patch); toast(t('Сохранено'), 'success'); reload?.();
  } }] });
  if (focusPassword) setTimeout(() => modalHandle.el.querySelector('#bk-pass')?.focus(), 60);
}
