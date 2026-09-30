import { del, get, post, put } from './api.js';
import { clear, confirmDialog, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { control } from './psettings-forms.js';

/* Хранилища бэкапов и каналы уведомлений панели (создание, правка, проверка), логотипы интерфейса. */
const badge = (text, cls = '') => h('span', { class: `badge ${cls}` }, text);
const card = (title, hint, ...body) => h('div', { class: 'card psf' }, h('div', { class: 'card-head' }, h('h4', null, title)), hint ? h('p', { class: 'muted small psf-hint' }, hint) : null, ...body);
const lazy = (box, fn) => { clear(box).append(h('div', { class: 'skeleton', style: { height: '100px' } })); fn().then((n) => clear(box).append(...[n].flat()), (e) => clear(box).append(h('div', { class: 'callout err' }, icon('alert'), e.message))); return box; };
const iconBtn = (title, ic, onclick) => h('button', { class: 'btn sm icon ghost', title, 'aria-label': title, onclick }, icon(ic, 14));

/** Поля по описанию (секреты при правке можно оставить пустыми). Возвращает { nodes, read }. */
function specFields(fields, values, hasSecret, editing) {
  const items = fields.filter((f) => !(editing && f.createOnly)).map((f) => {
    const field = f.secret && editing && hasSecret?.[f.name] ? { ...f, required: false, placeholder: t('Оставьте пустым, чтобы не менять') } : f;
    return { f, c: control({ ...field, max: f.max ?? 2000 }, f.secret ? '' : values?.[f.name] ?? (f.type === 'select' ? f.options[0][0] : ''), undefined) };
  });
  return { nodes: items.map(({ c }) => c.el), read: () => Object.fromEntries(items.map(({ f, c }) => [f.name, c.get()])) };
}

/* ---------- хранилища бэкапов ---------- */
function storageModal(p, specs, type, item, reload) {
  const spec = specs[type]; const editing = !!item;
  const form = specFields(spec.fields, item?.values, item?.hasSecret, editing);
  modal({ title: editing ? `${t('Хранилище')} · ${item.name}` : `${t('Новое хранилище')}: ${t(spec.label)}`, body: h('div', { class: 'stack' },
    spec.renameOnly ? h('p', { class: 'muted small' }, 'Подключение Dropbox и Google Drive выполняется в самой Easypanel (нужна авторизация у провайдера). Здесь можно переименовать.') : null,
    editing && !spec.renameOnly ? h('p', { class: 'muted small' }, 'Ключи и пароли не показываются: оставьте поле пустым, чтобы сохранить прежнее значение.') : null, ...form.nodes),
  actions: [{ label: 'Отмена', kind: 'ghost' }, { label: editing ? 'Сохранить' : 'Создать', kind: 'primary', onClick: async () => {
    if (editing) await put(`/api/panels/${p.id}/pstorage/${type}/${item.id}`, { values: form.read() }); else await post(`/api/panels/${p.id}/pstorage`, { type, values: form.read() });
    toast(t('Сохранено'), 'success'); reload();
  } }] });
}
export function storageCard(p) {
  const box = h('div');
  const draw = () => lazy(box, async () => {
    const r = await get(`/api/panels/${p.id}/pstorage`);
    const summary = (x) => Object.entries(x.values).filter(([k, v]) => v && k !== 'name').slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ');
    const typeSel = h('select', { class: 'input' }, ['s3', 'sftp', 'ftp', 'local'].map((k) => h('option', { value: k }, t(r.specs[k].label))));
    return card('Хранилища бэкапов', 'Куда панель складывает резервные копии баз данных и томов. Ключи и пароли не показываются и в журнал не попадают.',
      h('div', { class: 'list' }, r.providers.length ? r.providers.map((x) => h('div', { class: 'list-item' },
        h('div', { class: 'psf-user' }, h('b', null, x.name || x.id), h('div', { class: 'chips' }, x.type ? badge(t(r.specs[x.type]?.label ?? x.type)) : badge('?')), h('div', { class: 'muted small mono' }, summary(x))),
        h('div', { class: 'inline' }, x.type ? iconBtn('Изменить', 'edit', () => storageModal(p, r.specs, x.type, x, draw)) : null,
          x.type ? iconBtn('Удалить', 'trash', async () => { if (await confirmDialog({ title: 'Удалить хранилище?', message: `${x.name}. Расписания бэкапов, которые его используют, перестанут работать.`, danger: true, confirmText: 'Удалить' })) { try { await del(`/api/panels/${p.id}/pstorage/${x.type}/${x.id}`); toast(t('Удалено'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); } } }) : null))) : [h('div', { class: 'muted pad' }, 'Хранилищ нет')]),
      h('div', { class: 'inline psf-foot' }, typeSel, h('button', { class: 'btn sm', onclick: () => storageModal(p, r.specs, typeSel.value, null, draw) }, icon('plus', 13), 'Добавить хранилище')),
      h('p', { class: 'muted small' }, 'Dropbox и Google Drive подключаются в самой Easypanel (нужна авторизация у провайдера).'));
  });
  return draw();
}

/* ---------- каналы уведомлений панели ---------- */
function channelModal(p, r, type, item, reload) {
  const spec = r.specs[type]; const editing = !!item;
  const name = h('input', { class: 'input', value: item?.name ?? '', placeholder: 'Ops', maxlength: 80 });
  const form = specFields(spec.fields, item?.target, item?.hasSecret, editing);
  const ev = item?.events ?? {};
  const cbs = r.events.map(([k, label]) => ({ k, label, cb: h('input', { type: 'checkbox', checked: !!ev[k]?.enabled }) }));
  const min = h('input', { class: 'input', type: 'number', min: 1, max: 100, value: ev.diskLoad?.min ?? 80 });
  const sched = h('input', { class: 'input mono', value: ev.diskLoad?.schedule ?? '0 2 * * *', maxlength: 60 });
  const body = () => ({ type, name: name.value.trim(), target: form.read(), events: Object.fromEntries(cbs.map(({ k, cb }) => [k, k === 'diskLoad' ? { enabled: cb.checked, min: Number(min.value), schedule: sched.value.trim() } : { enabled: cb.checked }])) });
  modal({ title: editing ? `${t('Канал')} · ${item.name}` : `${t('Новый канал')}: ${t(spec.label)}`, wide: true, body: h('div', { class: 'stack' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Название')), name), ...form.nodes,
    h('div', null, h('div', { class: 'field-label' }, 'О чём уведомлять'), h('div', { class: 'stack-sm' }, cbs.map(({ label, cb }) => h('label', { class: 'check' }, cb, t(label))))),
    h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Порог нагрузки на диск, %')), min), h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('Расписание проверки диска (cron)')), sched)),
    editing ? h('p', { class: 'muted small' }, 'Секреты не показываются: оставьте поле пустым, чтобы сохранить прежнее значение.') : null),
  actions: [{ label: 'Закрыть', kind: 'ghost' }, { label: 'Отправить тест', onClick: async () => { await post(`/api/panels/${p.id}/pnotify/test`, { ...body(), ...(item ? { id: item.id } : {}) }); toast(t('Тестовое сообщение отправлено'), 'success'); return false; } },
    { label: editing ? 'Сохранить' : 'Создать', kind: 'primary', onClick: async () => { if (editing) await put(`/api/panels/${p.id}/pnotify/${item.id}`, body()); else await post(`/api/panels/${p.id}/pnotify`, body()); toast(t('Сохранено'), 'success'); reload(); } }] });
}
export function notifyCard(p, entry) {
  const box = h('div');
  const locked = entry?.license?.features?.notifications === false;
  const draw = () => lazy(box, async () => {
    const r = await get(`/api/panels/${p.id}/pnotify`);
    const typeSel = h('select', { class: 'input' }, Object.entries(r.specs).map(([k, v]) => h('option', { value: k }, t(v.label))));
    return card('Каналы уведомлений панели', 'Собственные уведомления Easypanel (деплои, бэкапы, диск, обновления). Каналы EasyAdmin настраиваются в разделе «Настройки» слева.',
      locked ? h('div', { class: 'callout warn compact' }, icon('key', 14), h('span', { class: 'small' }, 'Каналы уведомлений Easypanel доступны с лицензией (без неё панель молча игнорирует изменения). Активировать её можно на вкладке «Обзор».')) : null,
      h('div', { class: 'list' }, r.channels.length ? r.channels.map((x) => h('div', { class: 'list-item' },
        h('div', { class: 'psf-user' }, h('b', null, x.name || x.id), h('div', { class: 'chips' }, x.type ? badge(t(r.specs[x.type]?.label ?? x.type)) : null, r.events.filter(([k]) => x.events?.[k]?.enabled).map(([, l]) => badge(t(l))))),
        h('div', { class: 'inline' }, x.type && r.specs[x.type] && !locked ? iconBtn('Изменить', 'edit', () => channelModal(p, r, x.type, x, draw)) : null,
          locked ? null : iconBtn('Удалить', 'trash', async () => { if (await confirmDialog({ title: 'Удалить канал?', message: x.name, danger: true, confirmText: 'Удалить' })) { try { await del(`/api/panels/${p.id}/pnotify/${x.id}?name=${encodeURIComponent(x.name)}`); toast(t('Удалено'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); } } })))) : [h('div', { class: 'muted pad' }, 'Каналов нет')]),
      locked ? null : h('div', { class: 'inline psf-foot' }, typeSel, h('button', { class: 'btn sm', onclick: () => channelModal(p, r, typeSel.value, null, draw) }, icon('plus', 13), 'Добавить канал')));
  });
  return draw();
}

/* ---------- логотипы интерфейса ---------- */
const SLOTS = [['lightLogo', 'Логотип (светлая тема)'], ['lightLogoMark', 'Знак (светлая тема)'], ['darkLogo', 'Логотип (тёмная тема)'], ['darkLogoMark', 'Знак (тёмная тема)']];
const MAX_BYTES = 500 * 1024;
export function logosCard(p, entry) {
  const box = h('div');
  const locked = entry?.license?.features?.branding === false;
  const draw = () => lazy(box, async () => {
    const r = await get(`/api/panels/${p.id}/plogos`);
    const upload = (slot) => { const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml', hidden: true, onchange: () => {
      const f = inp.files?.[0]; if (!f) return;
      if (f.size > MAX_BYTES) { toast(t('Файл слишком большой (до 500 КБ)'), 'error'); return; }
      const fr = new FileReader(); fr.onload = async () => { try { await put(`/api/panels/${p.id}/plogos`, { slot, value: fr.result }); toast(t('Логотип загружен'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); } }; fr.readAsDataURL(f);
    } }); document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60_000); };
    return card('Логотипы интерфейса', 'Показываются в интерфейсе Easypanel. PNG, JPEG, GIF, WebP или SVG до 500 КБ. Загрузка одного логотипа не затрагивает остальные.',
      locked ? h('div', { class: 'callout warn compact' }, icon('key', 14), h('span', { class: 'small' }, 'Брендинг доступен в Easypanel с лицензией. Активировать её можно на вкладке «Обзор».')) : null,
      h('div', { class: 'list' }, SLOTS.map(([slot, label]) => { const l = r.logos[slot]; return h('div', { class: 'list-item' },
        h('div', { class: 'inline psf-logorow' }, l.preview ? h('img', { src: l.preview, alt: '', class: `psf-logo ${slot.startsWith('dark') ? 'dark' : ''}` }) : h('span', { class: 'psf-logo empty' }), h('div', null, h('b', null, label), h('div', { class: 'muted small' }, l.set ? `${Math.round(l.size / 1024)} КБ` : 'не задан'))),
        h('div', { class: 'inline' }, h('button', { class: 'btn sm', disabled: locked, onclick: () => upload(slot) }, icon('upload', 13), 'Загрузить'),
          l.set && !locked ? iconBtn('Удалить', 'trash', async () => { try { await put(`/api/panels/${p.id}/plogos`, { slot, value: null }); toast(t('Логотип удалён'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); } }) : null)); })));
  });
  return draw();
}
