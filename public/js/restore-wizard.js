import { get, post } from './api.js';
import { clear, confirmDialog, field, fmtTime, h, icon, modal, spinner, toast } from './dom.js';
import { t } from './i18n.js';
import { store } from './store.js';
import { partTitle, seg, size } from './backups-modals.js';

/**
 * Восстановление данных баз и томов из архива сервиса прямо из EasyAdmin.
 * Шаги: чтение архива (на сервере панели) → что и куда восстановить (тот же сервис, другой или новый) → подтверждение → ход выполнения.
 * Перед перезаписью сервер делает страховочную копию текущих данных; сам процесс идёт на сервере панели и не зависит от этой страницы.
 */
const ARCHIVE = /^([a-z0-9_-]+)__([a-z0-9_-]+)__(\d{8}-\d{6})\.tar(\.enc)?$/;
export const isArchive = (name) => ARCHIVE.test(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const RESTORE_BADGE = { done: ['Восстановлено', 'ok'], partial: ['Есть ошибки', 'err'], error: ['Ошибка', 'err'], running: ['Идёт…', 'warn'] };
const BADGE = RESTORE_BADGE;

/** Опрашивает задание, пока оно не завершится; прерывается, когда окно закрыли. */
async function pollJob(id, alive, onTick) {
  for (let i = 0; i < 6000 && alive(); i++) {
    let j; try { j = await get(`/api/backups/data/job?id=${encodeURIComponent(id)}`); } catch (e) { if (e.status === 404) throw e; await sleep(2500); continue; }
    onTick?.(j); if (j.status !== 'running') return j;
    await sleep(1500);
  }
  return null;
}
const panelServices = (panelId) => store.panels.find((p) => p.id === panelId)?.tree?.projects?.flatMap((p) => p.services.map((s) => ({ project: p.name, name: s.name, type: s.type }))) ?? [];
const projectsOf = (panelId) => store.panels.find((p) => p.id === panelId)?.tree?.projects?.map((p) => p.name) ?? [];

/* ---------------- ход выполнения ---------------- */
const partIcon = (r) => (r === 'ok' ? icon('check', 15) : r === 'fail' ? icon('alert', 15) : r === 'run' ? spinner(14) : r === 'skip' ? icon('x', 15) : icon('clock', 15));
export function jobView(j) {
  const [label, cls] = BADGE[j.status] ?? ['—', ''];
  return h('div', { class: 'stack' },
    h('div', { class: 'inline' }, h('b', null, j.target), j.targetPanel ? h('span', { class: 'muted small' }, j.targetPanel) : null, h('span', { class: 'spacer' }), h('span', { class: `badge ${cls}` }, j.status === 'running' ? spinner(10) : h('i', { class: 'dot' }), t(label))),
    h('div', { class: 'muted small' }, `${fmtTime(j.startedAt)} · ${j.mode === 'merge' ? t('поверх имеющегося') : t('с заменой данных')}${j.created ? ` · ${t('новый сервис')}` : ''}${j.by ? ` · ${j.by}` : ''}`),
    j.error ? h('div', { class: 'callout err compact' }, icon('alert', 14), h('span', { class: 'small log-err' }, j.error)) : null,
    h('div', { class: 'stack-sm' }, ...j.parts.map((p) => h('div', { class: 'rw-part' }, h('span', { class: `rw-ic ${p.result}` }, partIcon(p.result)),
      h('div', null, h('b', { class: 'small' }, partTitle(p.member)), p.target ? h('span', { class: 'muted small' }, ` → ${p.target}`) : null,
        p.result === 'skip' ? h('div', { class: 'muted small' }, p.status === 'nomatch' ? t('нет подходящего тома или базы — пропущено') : p.status === 'unsupported' ? t('автоматически не восстанавливается — пропущено') : t('пропущено')) : null,
        p.error ? h('div', { class: 'danger-text small log-err' }, p.error) : null, p.warn ? h('div', { class: 'warn-text small log-err' }, `${t('предупреждения')}: ${p.warn}`) : null)))),
    j.snapDir ? h('div', { class: 'callout compact' }, icon('shield', 14), h('span', { class: 'small' }, `${t('Страховочная копия прежних данных на сервере панели')}: `, h('code', null, j.snapDir), ` · ${t('хранится 14 дней')}`)) : null,
    j.status === 'done' || j.status === 'partial' ? h('p', { class: 'muted small' }, t('Сервис, остановленный на время восстановления, запущен обратно. Приложению может понадобиться перезапуск или деплой, чтобы подхватить данные.')) : null);
}
/** Окно хода одного восстановления. */
export function showRestoreJob(id, first) {
  const body = h('div', { class: 'stack' }, first ? jobView(first) : h('div', { class: 'skeleton', style: { height: '90px' } }));
  const m = modal({ title: 'Восстановление данных', wide: true, body, actions: [{ label: 'Закрыть', kind: 'ghost' }] });
  pollJob(id, () => m.el.isConnected, (j) => clear(body).append(jobView(j))).then((j) => { if (j && m.el.isConnected) clear(body).append(jobView(j)); }).catch((e) => clear(body).append(h('div', { class: 'callout err' }, icon('alert'), e.message)));
  return m;
}
/** Недавние восстановления. */
export async function restoresModal() {
  const body = h('div', { class: 'stack-sm' }, h('div', { class: 'skeleton', style: { height: '70px' } }));
  modal({ title: 'Восстановления данных', wide: true, body, actions: [{ label: 'Закрыть', kind: 'ghost' }] });
  try {
    const { jobs } = await get('/api/backups/data/restores'); clear(body);
    if (!jobs.length) return body.append(h('p', { class: 'muted' }, 'Восстановлений ещё не было.'));
    body.append(...jobs.map((j) => { const [label, cls] = BADGE[j.status] ?? ['—', '']; return h('button', { type: 'button', class: 'list-item link btn-row', onclick: () => showRestoreJob(j.id, j) },
      h('div', null, h('b', null, j.target), h('span', { class: 'muted small' }, `  ${fmtTime(j.startedAt)}`)), h('span', { class: `badge ${cls}` }, t(label))); }));
  } catch (e) { clear(body).append(h('div', { class: 'callout err' }, icon('alert'), e.message)); }
}

/* ---------------- мастер ---------------- */
export function restoreWizard({ panelId, panelName, name }) {
  const [, project, service] = ARCHIVE.exec(name);
  const body = h('div', { class: 'stack' });
  const m = modal({ title: `${t('Восстановить')} · ${project}/${service}`, wide: true, body });
  const alive = () => m.el.isConnected;
  let password = ''; let where = 's3'; let members = [];
  // состояние выбора
  const st = { sel: new Set(), target: 'same', tPanel: panelId, tProject: project, tService: service, nProject: project, nService: `${service}-restored`, mode: 'clean', snapshot: true, plan: null, planning: 0 };

  async function inspect() {
    clear(body).append(h('div', { class: 'inline' }, spinner(16), h('span', null, t('Читаю архив на сервере панели… Большие архивы читаются несколько минут.'))), h('p', { class: 'muted small' }, name));
    try {
      where = (await get('/api/backups')).settings.where;
      const { id } = await post('/api/backups/data/inspect', { panelId, name, password: password || undefined });
      const j = await pollJob(id, alive); if (!j) return;
      if (j.status !== 'done') throw new Error(j.error || t('Не удалось прочитать архив'));
      members = j.members; if (!members.length) throw new Error(t('В архиве нет баз и томов'));
      st.sel = new Set(members.map((x) => x.member)); configure(); replan();
    } catch (e) {
      if (!alive()) return;
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: t('Пароль этой копии (если он не тот, что в настройках)'), value: password, oninput: () => { password = pw.value; } });
      clear(body).append(h('div', { class: 'callout err' }, icon('alert'), e.message), /парол/i.test(e.message) ? field('Пароль копии', pw) : null,
        h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: inspect }, icon('refresh', 14), 'Повторить'), h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Закрыть')));
    }
  }

  const targetBody = () => (st.target === 'same' ? { panelId, project, service } : st.target === 'other' ? { panelId: st.tPanel, project: st.tProject, service: st.tService } : null);
  async function replan() {
    const tg = targetBody(); const my = ++st.planning;
    if (!tg) { st.plan = null; return paint(); }
    if (!tg.project || !tg.service) { st.plan = { error: t('Выберите сервис') }; return paint(); }
    try {
      const r = await post('/api/backups/data/restore-plan', { panelId, name, members: members.map((x) => x.member), target: tg });
      if (my !== st.planning || !alive()) return;
      st.plan = r; for (const it of r.items) if (it.status !== 'ok') st.sel.delete(it.member);
    } catch (e) { if (my !== st.planning || !alive()) return; st.plan = { error: e.message }; }
    paint();
  }

  const slot = h('div', { class: 'stack' });
  function configure() { clear(body).append(slot); paint(); }
  function paint() {
    if (!alive()) return;
    const itemOf = (member) => st.plan?.items?.find((i) => i.member === member);
    const parts = h('div', { class: 'stack-sm' }, ...members.map((x) => {
      const it = itemOf(x.member); const bad = it && it.status !== 'ok';
      const cb = h('input', { type: 'checkbox', checked: st.sel.has(x.member) && !bad, disabled: bad, onchange: () => { if (cb.checked) st.sel.add(x.member); else st.sel.delete(x.member); paint(); } });
      return h('label', { class: `rw-part ${bad ? 'dim' : ''}` }, cb, h('div', null, h('b', { class: 'small' }, partTitle(x.member)), h('span', { class: 'muted small' }, `  ${size(x.size)}`),
        it?.status === 'ok' ? h('div', { class: 'muted small' }, `→ ${it.target}`) : null,
        bad ? h('div', { class: 'warn-text small' }, it.status === 'nomatch' ? t('в целевом сервисе нет подходящего тома или базы') : it.status === 'unsupported' ? t('Redis внутри compose-стека автоматически не восстанавливается') : t('небезопасный путь — пропущено')) : null));
    }));
    const panelOpts = (where === 's3' ? store.panels : store.panels.filter((p) => p.id === panelId));
    let targetFields = null;
    if (st.target === 'same') {
      const exists = panelServices(panelId).some((s) => s.project === project && s.name === service);
      targetFields = h('div', { class: 'callout compact' }, icon('database', 14), h('span', { class: 'small' }, `${project}/${service} · ${panelName}`, exists ? '' : ` — ${t('такого сервиса сейчас нет на панели, выберите «В другой сервис» или «В новый сервис»')}`));
    } else if (st.target === 'other') {
      const panelSel = h('select', { class: 'input', onchange: (e) => { st.tPanel = Number(e.target.value); const l = panelServices(st.tPanel); st.tProject = l[0]?.project ?? ''; st.tService = l[0]?.name ?? ''; replan(); } }, panelOpts.map((p) => h('option', { value: p.id, selected: p.id === st.tPanel }, p.name)));
      const list = panelServices(st.tPanel);
      const svcSel = h('select', { class: 'input', onchange: (e) => { const [pr, nm] = e.target.value.split('/'); st.tProject = pr; st.tService = nm; replan(); } }, list.map((s) => h('option', { value: `${s.project}/${s.name}`, selected: s.project === st.tProject && s.name === st.tService }, `${s.project}/${s.name} (${s.type})`)));
      targetFields = h('div', { class: 'grid-2' }, field('Панель', panelSel), field('Сервис', svcSel));
    } else {
      const panelSel = h('select', { class: 'input', onchange: (e) => { st.tPanel = Number(e.target.value); paint(); } }, panelOpts.map((p) => h('option', { value: p.id, selected: p.id === st.tPanel }, p.name)));
      const dl = h('datalist', { id: 'rw-projects' }, projectsOf(st.tPanel).map((p) => h('option', { value: p })));
      targetFields = h('div', { class: 'stack' }, h('div', { class: 'grid-2' }, field('Панель', panelSel), field('Проект', h('input', { class: 'input mono', list: 'rw-projects', value: st.nProject, oninput: (e) => { st.nProject = e.target.value.trim(); } }), dl)),
        field('Имя нового сервиса', h('input', { class: 'input mono', value: st.nService, oninput: (e) => { st.nService = e.target.value.trim(); } }), 'Латиница нижнего регистра, цифры, - и _'),
        h('p', { class: 'muted small' }, 'Сервис создаётся по типу копии: для базы — такая же база, для приложения — по настройкам исходного сервиса с теми же томами (если исходный сервис ещё существует). Пароль базы после восстановления станет таким же, как в исходном сервисе.'));
    }
    const picked = [...st.sel].filter((x) => st.target === 'new' || itemOf(x)?.status === 'ok');
    const canGo = picked.length > 0 && (st.target !== 'new' || (st.nProject && st.nService)) && !(st.plan?.error);
    clear(slot).append(
      h('p', { class: 'muted small' }, `${t('Копия')}: `, h('span', { class: 'mono' }, name)),
      h('section', { class: 'stack-sm' }, h('h4', null, 'Что восстановить'), parts, st.plan?.error ? h('div', { class: 'callout err compact' }, icon('alert', 14), h('span', { class: 'small' }, st.plan.error)) : null),
      h('section', { class: 'stack-sm' }, h('h4', null, 'Куда'), seg(st.target, [['same', t('В тот же сервис')], ['other', t('В другой сервис')], ['new', t('В новый сервис')]], (v) => {
        st.target = v; if (v !== 'same' && !panelOpts.some((p) => p.id === st.tPanel)) st.tPanel = panelOpts[0]?.id ?? panelId;
        if (v === 'other' && !panelServices(st.tPanel).some((s) => s.project === st.tProject && s.name === st.tService)) { const l = panelServices(st.tPanel).find((s) => !(s.project === project && s.name === service)) ?? panelServices(st.tPanel)[0]; st.tProject = l?.project ?? ''; st.tService = l?.name ?? ''; }
        st.sel = new Set(members.map((x) => x.member)); st.plan = null; paint(); replan(); }), targetFields,
        where !== 's3' ? h('div', { class: 'small muted' }, t('Копии лежат на сервере своей панели, поэтому восстановить их можно только на этой же панели. Для других панелей храните копии в S3.')) : null),
      h('section', { class: 'stack-sm' }, h('h4', null, 'Как'), seg(st.mode, [['clean', t('Заменить данные')], ['merge', t('Дописать поверх')]], (v) => { st.mode = v; paint(); }),
        h('div', { class: 'small muted' }, st.mode === 'clean' ? t('Базы и папки томов сначала очищаются, затем заполняются данными из копии: сервис получит ровно то, что было на момент копии.') : t('Данные из копии записываются поверх имеющихся, ничего не удаляется. Для баз это может дать дубликаты и ошибки «уже существует».')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.snapshot, onchange: (e) => { st.snapshot = e.target.checked; paint(); } }), t('Сначала сделать страховочную копию текущих данных (хранится на сервере панели 14 дней)')),
        st.snapshot ? null : h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, t('Без страховочной копии вернуть прежние данные будет нечем.')))),
      h('div', { class: 'callout compact' }, icon('alert', 14), h('span', { class: 'small' }, t('Тома: сервис на время восстановления останавливается и затем запускается обратно. Базы восстанавливаются в работающем контейнере. Сам EasyAdmin так восстановить нельзя — для него есть «Восстановить систему».'))),
      h('div', { class: 'modal-foot-inline' }, h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Отмена'),
        h('button', { class: 'btn primary', disabled: !canGo, onclick: () => go(picked) }, icon('rotate', 14), `${t('Восстановить')} (${picked.length})`)));
  }

  async function go(picked) {
    const tg = st.target === 'new' ? { panelId: st.tPanel, create: { project: st.nProject, service: st.nService } } : targetBody();
    const label = `${tg.create ? tg.create.project : tg.project}/${tg.create ? tg.create.service : tg.service}`;
    const needType = st.target !== 'new' && st.mode === 'clean';
    const msg = st.target === 'new' ? `${t('Будет создан сервис')} ${label} ${t('и в него восстановлены выбранные части')}.`
      : st.mode === 'clean' ? `${t('Текущие данные сервиса')} ${label} ${t('в выбранных частях будут заменены данными из копии')}${st.snapshot ? '' : `. ${t('Страховочной копии не будет')}`}.` : `${t('Данные из копии будут записаны в сервис')} ${label} ${t('поверх имеющихся')}.`;
    if (!await confirmDialog({ title: 'Восстановить данные?', message: msg, danger: needType, confirmText: 'Восстановить', typeToConfirm: needType ? label : undefined })) return;
    try {
      const r = await post('/api/backups/data/restore', { panelId, name, password: password || undefined, target: tg, members: picked, mode: st.mode, snapshot: st.snapshot, confirm: true });
      if (r.skipped) toast(`${t('Пропущено частей')}: ${r.skipped}`, 'info');
      clear(body).append(h('div', { class: 'skeleton', style: { height: '90px' } }));
      const j = await pollJob(r.id, alive, (x) => { if (alive()) clear(body).append(jobView(x)); });
      if (j && alive()) { clear(body).append(jobView(j), h('div', { class: 'modal-foot-inline' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Закрыть'))); toast(j.status === 'done' ? t('Данные восстановлены') : t('Восстановление завершено с ошибками'), j.status === 'done' ? 'success' : 'error', 8000); }
    } catch (e) { toast(e.message, 'error', 10000); }
  }
  inspect();
  return m;
}
