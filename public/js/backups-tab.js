import { del, get, post, put } from './api.js';
import { clear, confirmDialog, field, fmtTime, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';

/** Вкладка «Бэкапы» сервиса: расписания копий базы данных (postgres/mysql/mariadb/mongo) или томов приложения, запуск сразу, восстановление базы. */
const PRESETS = [['0 * * * *', 'Каждый час'], ['0 2 * * *', 'Каждый день в 02:00'], ['0 3 * * 1', 'Каждый понедельник в 03:00'], ['0 3 1 * *', 'Первого числа в 03:00'], ['', 'Свой cron']];
const presetName = (cron) => PRESETS.find(([c]) => c === cron)?.[1] ?? null;
const badge = (text, cls = '') => h('span', { class: `badge ${cls}` }, text);
const iconBtn = (title, ic, onclick) => h('button', { class: 'btn sm icon ghost', title, 'aria-label': title, onclick }, icon(ic, 14));

function scheduleModal(p, ref, data, item, reload) {
  const db = data.kind === 'db'; const editing = !!item;
  const names = db ? data.databases : data.mounts.map((m) => m.name);
  const target = names.length ? h('select', { class: 'input' }, names.map((n) => h('option', { value: n, selected: n === (item?.databaseName ?? item?.volumeName) }, n)))
    : h('input', { class: 'input mono', value: item?.databaseName ?? item?.volumeName ?? '', placeholder: db ? 'database' : 'volume' });
  const noSched = db && data.scheduled === false; // без лицензии панель не выполняет расписания баз данных
  const enabled = h('input', { type: 'checkbox', checked: noSched ? false : item ? !!item.enabled : true, disabled: noSched });
  const cron = h('input', { class: 'input mono', value: item?.schedule ?? '0 2 * * *', maxlength: 60, spellcheck: 'false' });
  const preset = h('select', { class: 'input', onchange: () => { if (preset.value) cron.value = preset.value; } }, PRESETS.map(([c, l]) => h('option', { value: c, selected: c === (PRESETS.some(([x]) => x === cron.value) ? cron.value : '') }, t(l))));
  cron.addEventListener('input', () => { preset.value = PRESETS.some(([c]) => c === cron.value) ? cron.value : ''; });
  const prov = h('select', { class: 'input' }, data.providers.map((x) => h('option', { value: x.id, selected: x.id === item?.storageProviderId }, x.name || x.id)));
  const path = h('input', { class: 'input mono', value: item?.storageProviderPath ?? `${ref.name}`, placeholder: `${ref.name}`, maxlength: 200 });
  const keep = h('input', { class: 'input', type: 'number', min: 1, max: 3650, value: item?.retention ?? 7 });
  modal({ title: editing ? 'Расписание бэкапа' : 'Новое расписание бэкапа', body: h('div', { class: 'stack' },
    field(db ? 'База данных' : 'Том', target), h('label', { class: 'check' }, enabled, 'Включено'), noSched ? h('p', { class: 'muted small' }, 'Без лицензии Easypanel расписание не выполняется, поэтому включить его нельзя.') : null,
    h('div', { class: 'grid-2' }, field('Расписание', preset), field('Cron (минута час день месяц день_недели)', cron)),
    field('Хранилище', prov), field('Папка в хранилище', path, 'Буквы, цифры, / - _ . и пробел.'), db ? field('Сколько копий хранить', keep) : null),
  actions: [{ label: 'Отмена', kind: 'ghost' }, { label: editing ? 'Сохранить' : 'Создать', kind: 'primary', onClick: async () => {
    const schedule = { [db ? 'databaseName' : 'volumeName']: target.value, enabled: enabled.checked, schedule: cron.value.trim(), storageProviderId: prov.value, storageProviderPath: path.value.trim(), ...(db ? { retention: Number(keep.value) } : {}) };
    if (editing) await put(`/api/panels/${p.id}/pbackups/${item.id}`, { ...ref, schedule }); else await post(`/api/panels/${p.id}/pbackups`, { ...ref, schedule });
    toast(t('Сохранено'), 'success'); reload();
  } }] });
}

export function backupsView({ s, ref, state }) {
  const p = { id: s.panelId };
  const box = h('div', { class: 'stack' });
  const q = new URLSearchParams(ref);
  const draw = async () => {
    clear(box).append(h('div', { class: 'skeleton', style: { height: '120px' } }));
    try {
      const d = await get(`/api/panels/${p.id}/pbackups?${q}`);
      if (!d.kind) return clear(box).append(h('div', { class: 'muted pad' }, 'У этого типа сервиса нет расписаний бэкапов.'));
      const db = d.kind === 'db';
      const provName = (id) => d.providers.find((x) => x.id === id)?.name ?? id;
      const run = async (x) => { try { await post(`/api/panels/${p.id}/pbackups/${x.id}/run`, ref); toast(t('Бэкап запущен — ход выполнения смотрите в журнале панели'), 'success'); setTimeout(draw, 3000); } catch (e) { toast(e.message, 'error'); } };
      const remove = async (x) => { if (await confirmDialog({ title: 'Удалить расписание?', message: `${x.databaseName ?? x.volumeName} · ${x.schedule}. Уже созданные копии в хранилище останутся.`, danger: true, confirmText: 'Удалить' })) { try { await del(`/api/panels/${p.id}/pbackups/${x.id}?${q}`); toast(t('Удалено'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); } } };
      const restore = async (x) => {
        if (!await confirmDialog({ title: 'Восстановить базу данных?', message: `База «${x.databaseName}» будет ЗАМЕНЕНА содержимым копии ${x.path}. Текущие данные этой базы пропадут.`, danger: true, confirmText: 'Восстановить', typeToConfirm: `${ref.project}/${ref.name}` })) return;
        try { await post(`/api/panels/${p.id}/pbackups/restore`, { ...ref, databaseName: x.databaseName, path: x.path, storageProviderId: x.storageProviderId, confirm: `${ref.project}/${ref.name}` }); toast(t('Восстановление запущено — ход выполнения смотрите в журнале панели'), 'success'); } catch (e) { toast(e.message, 'error', 8000); }
      };
      clear(box).append(
        db && d.scheduled === false ? h('div', { class: 'callout warn' }, icon('key'), h('div', null, h('b', null, 'Расписания баз данных требуют лицензии'), h('p', null, 'Без лицензии Easypanel не выполняет бэкапы баз по расписанию. Доступны: запуск копии вручную, журнал копий и восстановление. Тома приложений копируются и без лицензии.'),
          h('a', { class: 'btn sm', href: `#/panel/${p.id}/settings`, onclick: () => { try { localStorage.setItem('ea-pset-section', 'overview'); } catch { /* приватный режим */ } } }, 'Открыть лицензию панели'))) : null,
        !d.providers.length ? h('div', { class: 'callout warn' }, icon('alert'), h('div', null, h('b', null, 'Нет хранилища для копий'), h('p', null, 'Сначала добавьте хранилище бэкапов в настройках панели.'),
          h('a', { class: 'btn sm', href: `#/panel/${p.id}/settings`, onclick: () => { try { localStorage.setItem('ea-pset-section', 'infra'); } catch { /* приватный режим */ } } }, 'Открыть настройки панели'))) : null,
        h('div', { class: 'card psf' }, h('div', { class: 'card-head' }, h('h4', null, db ? 'Бэкапы базы данных' : 'Бэкапы томов'), h('button', { class: 'btn sm', disabled: !d.providers.length || (db && d.scheduled === false), onclick: () => scheduleModal(p, ref, d, null, draw) }, icon('plus', 13), 'Новое расписание')),
          h('p', { class: 'muted small psf-hint' }, db ? 'Копии баз данных по расписанию складываются в выбранное хранилище.' : 'Копии томов приложения по расписанию складываются в выбранное хранилище.'),
          h('div', { class: 'list' }, d.schedules.length ? d.schedules.map((x) => h('div', { class: 'list-item' },
            h('div', { class: 'psf-user' }, h('b', { class: 'mono' }, x.databaseName ?? x.volumeName), h('div', { class: 'chips' }, x.enabled ? badge('включено', 'ok') : badge('выключено'), badge(presetName(x.schedule) ? t(presetName(x.schedule)) : x.schedule), db && x.retention ? badge(`${t('копий')}: ${x.retention}`) : null),
              h('div', { class: 'muted small' }, `${provName(x.storageProviderId)} / ${x.storageProviderPath || ''}`)),
            h('div', { class: 'inline' }, iconBtn('Запустить сейчас', 'play', () => run(x)), iconBtn('Изменить', 'edit', () => scheduleModal(p, ref, d, x, draw)), iconBtn('Удалить', 'trash', () => remove(x))))) : [h('div', { class: 'muted pad' }, 'Расписаний нет')])),
        h('div', { class: 'card psf' }, h('div', { class: 'card-head' }, h('h4', null, 'Последние бэкапы'), h('button', { class: 'btn sm ghost', onclick: draw }, icon('refresh', 13), 'Обновить')),
          h('p', { class: 'muted small psf-hint' }, db ? 'Из успешной копии базу можно восстановить. Восстановление заменяет текущее содержимое базы.' : 'Журнал последних запусков бэкапов этого сервиса.'),
          h('div', { class: 'list' }, d.history.length ? d.history.map((x) => h('div', { class: 'list-item' },
            h('div', { class: 'psf-user' }, h('b', null, x.description ?? x.path ?? x.id), h('div', { class: 'muted small' }, x.createdAt ? fmtTime(typeof x.createdAt === 'number' ? x.createdAt : Date.parse(x.createdAt)) : '', x.path ? ` · ${x.path}` : '')),
            h('div', { class: 'inline' }, x.status ? badge(String(x.status), /fail|error/i.test(x.status) ? 'err' : /done|ok|success/i.test(x.status) ? 'ok' : '') : null, x.restorable ? h('button', { class: 'btn sm', onclick: () => restore(x) }, icon('rotate', 13), 'Восстановить') : null))) : [h('div', { class: 'muted pad' }, 'Бэкапов пока не было')])));
    } catch (e) { clear(box).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
  };
  draw();
  return box;
}
