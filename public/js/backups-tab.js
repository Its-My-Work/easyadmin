import { get, post } from './api.js';
import { clear, fmtTime, h, icon, relTime, toast } from './dom.js';
import { t } from './i18n.js';
import { STATUS, copiesList, inclusionPatch, runCopy, saveSettings, settingsModal, size, switchBtn } from './backups-modals.js';

/** Вкладка «Бэкапы» сервиса: входит ли сервис в копии EasyAdmin, последняя копия, запуск сейчас, список копий и восстановление. */
export function backupsView({ s, ref }) {
  const box = h('div', { class: 'stack' });
  const load = async () => {
    clear(box).append(h('div', { class: 'skeleton', style: { height: '120px' } }));
    let ov;
    try { ov = await get('/api/backups/overview'); } catch (e) { return clear(box).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
    const panel = ov.panels.find((p) => p.panelId === s.panelId); const r = panel?.rows.find((x) => x.project === ref.project && x.name === ref.name);
    if (!r) return clear(box).append(h('div', { class: 'callout warn' }, icon('alert'), panel?.error ?? t('Сервис не найден в обзоре бэкапов')));
    const allKeys = ov.panels.flatMap((p) => p.rows.map((x) => x.key)); const keys = ov.panels.flatMap((p) => p.rows.filter((x) => x.included).map((x) => x.key));
    const toggle = async () => {
      const on = !r.included;
      if (on && !ov.system.hasPassword) { toast(t('Сначала задайте пароль копий'), 'error'); return settingsModal(load, { focusPassword: true }); }
      if (await saveSettings(inclusionPatch({ mode: ov.mode, keys, allKeys }, r.key, on))) load();
    };
    const [label, cls] = STATUS[r.status] ?? ['—', 'muted'];
    const last = r.last?.ok === false ? h('span', { class: 'danger-text' }, `${relTime(r.last.ts)} · ${r.last.error}`) : r.last?.empty ? t('у сервиса нет томов и баз — копировать нечего') : r.last ? `${fmtTime(r.last.ts)}${r.last.size ? ` · ${size(r.last.size)}` : ''}` : t('копий ещё не было');
    clear(box).append(
      h('div', { class: 'card flat' }, h('div', { class: 'inline' }, switchBtn(r.included || ov.mode === 'all', t('Копировать этот сервис'), toggle, ov.mode === 'all'), h('div', null, h('b', null, 'Копировать этот сервис'),
        h('div', { class: 'muted small' }, ov.mode === 'all' ? 'Включено для всех сервисов (в разделе «Бэкапы»).' : 'Дамп базы или копия томов, зашифрованные паролем копий.')), h('span', { class: 'spacer' }), h('span', { class: `badge ${cls}` }, h('i', { class: 'dot' }), label)),
        h('div', { class: 'kv' }, h('span', null, 'Последняя копия'), h('b', null, last))),
      h('div', { class: 'inline' }, h('button', { class: 'btn primary', disabled: !r.included || ov.running, onclick: async () => { if (await runCopy({ panelId: s.panelId, project: ref.project, service: ref.name })) setTimeout(load, 1500); } }, icon('play', 14), 'Копировать сейчас'),
        h('a', { class: 'btn ghost', href: '#/backups' }, icon('database', 14), 'Все бэкапы'), h('a', { class: 'btn ghost', onclick: () => settingsModal(load) }, icon('settings', 14), 'Настройки')),
      h('h4', null, 'Копии сервиса'), copiesList({ panelId: s.panelId, project: ref.project, name: ref.name }));
  };
  load();
  return box;
}
