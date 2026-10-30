import { del, get, post, put } from './api.js';
import { clear, confirmDialog, field, h, icon, modal, relTime, toast } from './dom.js';

/**
 * Настройки публичной страницы статуса (Настройки → Status Page): белый список сервисов, оформление,
 * бейджи и инциденты с модалкой создания/редактирования.
 */

const STATUSES = [['investigating', 'Расследуем'], ['identified', 'Причина найдена'], ['monitoring', 'Наблюдаем'], ['resolved', 'Решён']];
const SEVERITIES = [['minor', 'Незначительный'], ['major', 'Серьёзный'], ['maintenance', 'Плановые работы']];
const label = (list, v) => list.find(([k]) => k === v)?.[1] ?? v;
const select = (options, value, onchange) => h('select', { class: 'input', onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

export function incidentModal(incident, services, done) {
  const f = { title: incident?.title ?? '', severity: incident?.severity ?? 'minor', status: incident?.status ?? 'investigating', message: incident?.message ?? '', components: new Set(incident?.components ?? []) };
  const comps = services.length ? services.map((s) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.components.has(s.slug), onchange: (e) => { if (e.target.checked) f.components.add(s.slug); else f.components.delete(s.slug); } }), s.name))
    : [h('p', { class: 'muted small' }, 'Сервисы не добавлены')];
  modal({
    title: incident ? 'Изменить инцидент' : 'Новый инцидент',
    body: h('div', { class: 'stack' },
      field('Название', h('input', { class: 'input', value: f.title, maxlength: 120, oninput: (e) => { f.title = e.target.value; } })),
      h('div', { class: 'grid-2' }, field('Важность', select(SEVERITIES, f.severity, (v) => { f.severity = v; })), field('Статус', select(STATUSES, f.status, (v) => { f.status = v; }))),
      field('Сообщение', h('textarea', { class: 'input', rows: 4, maxlength: 2000, oninput: (e) => { f.message = e.target.value; } }, f.message)),
      field('Затронутые сервисы', h('div', { class: 'stack-sm' }, comps))),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Сохранить', kind: 'primary', onClick: async () => {
      const body = { title: f.title, severity: f.severity, status: f.status, message: f.message, components: [...f.components] };
      if (incident) await put(`/api/status/incidents/${incident.id}`, body); else await post('/api/status/incidents', body);
      toast('Сохранено', 'success'); done();
    } }],
  });
}

export function statusPageCard() {
  const box = h('section', { class: 'card stack status-settings' });
  const draw = async () => {
    let s; let incidents;
    try { [s, incidents] = await Promise.all([get('/api/status/settings'), get('/api/status/incidents')]); } catch (e) { clear(box).append(h('h3', null, 'Status Page'), h('p', { class: 'muted' }, e.message)); return; }
    const f = { enabled: s.enabled, title: s.title, description: s.description, logoUrl: s.logoUrl, services: s.services.map((x) => ({ ...x })) };
    const rows = h('div', { class: 'stack-sm' });
    const drawRows = () => {
      clear(rows).append(...(f.services.length ? f.services.map((x, i) => h('div', { class: 'inline' },
        h('input', { class: 'input', value: x.name, maxlength: 60, oninput: (e) => { x.name = e.target.value; } }),
        h('span', { class: 'muted small mono' }, `${x.project}/${x.service}`),
        h('span', { class: 'spacer' }),
        x.slug ? h('button', { class: 'btn icon ghost sm', type: 'button', title: 'Скопировать бейдж', onclick: () => copyBadge(x.slug) }, icon('copy', 14)) : null,
        h('button', { class: 'btn icon ghost sm', type: 'button', title: 'Убрать', onclick: () => { f.services.splice(i, 1); drawRows(); } }, icon('trash', 14))))
        : [h('p', { class: 'muted small' }, 'Сервисы не добавлены')]));
    };
    const copyBadge = async (slug) => {
      const md = `![uptime](${location.origin}/status/badge/${slug}.svg)`;
      try { await navigator.clipboard.writeText(md); toast('Скопировано', 'success'); } catch { toast(md, 'info', 8000); }
    };
    const panelSel = h('select', { class: 'input' }, s.available.map((p) => h('option', { value: p.panelId }, p.panel)));
    const svcSel = h('select', { class: 'input' });
    const fillSvc = () => { clear(svcSel).append(...(s.available.find((p) => String(p.panelId) === panelSel.value)?.services ?? []).map((x) => h('option', { value: `${x.project}/${x.service}` }, `${x.project}/${x.service}`))); };
    panelSel.addEventListener('change', fillSvc); fillSvc();
    const addSvc = () => {
      const [project, service] = svcSel.value.split('/');
      if (!project || !service) return;
      if (f.services.some((x) => x.panelId === Number(panelSel.value) && x.project === project && x.service === service)) return toast('Сервис уже добавлен', 'error');
      f.services.push({ name: service, panelId: Number(panelSel.value), project, service }); drawRows();
    };
    const save = async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { await post('/api/status/settings', f); toast('Сохранено', 'success'); draw(); } catch (x) { toast(x.message, 'error'); b.disabled = false; }
    };
    const removeIncident = async (i) => {
      if (!await confirmDialog({ title: 'Удалить инцидент', message: i.title, confirmText: 'Удалить', danger: true })) return;
      try { await del(`/api/status/incidents/${i.id}`); draw(); } catch (x) { toast(x.message, 'error'); }
    };
    drawRows();
    clear(box).append(
      h('div', { class: 'card-head' }, h('h3', { class: 'inline' }, icon('activity', 16), 'Status Page'),
        h('span', { class: `badge ${s.enabled ? 'ok' : ''}` }, s.enabled ? 'Включена' : 'Выключена')),
      h('p', { class: 'muted small' }, 'Публичная страница статуса без входа. Публикуются только добавленные сервисы и их публичные имена — адреса, проекты и панели не раскрываются.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.enabled, onchange: (e) => { f.enabled = e.target.checked; } }), 'Страница включена'),
      s.enabled ? h('p', { class: 'small' }, icon('link', 13), ' ', h('a', { href: '/status', target: '_blank', rel: 'noopener' }, `${location.origin}/status`)) : null,
      h('div', { class: 'grid-2' },
        field('Заголовок', h('input', { class: 'input', value: f.title, maxlength: 80, oninput: (e) => { f.title = e.target.value; } })),
        field('Логотип', h('input', { class: 'input mono', value: f.logoUrl, placeholder: 'https://…/logo.png', oninput: (e) => { f.logoUrl = e.target.value; } }), 'Адрес https:// или путь на этом сервере')),
      field('Описание', h('textarea', { class: 'input', rows: 2, maxlength: 500, oninput: (e) => { f.description = e.target.value; } }, f.description)),
      h('h4', null, 'Публичные сервисы'), rows,
      h('div', { class: 'inline' }, panelSel, svcSel, h('button', { class: 'btn sm', type: 'button', onclick: addSvc }, icon('plus', 13), 'Добавить')),
      h('div', null, h('button', { class: 'btn primary sm', onclick: save }, 'Сохранить')),
      h('div', { class: 'card-head' }, h('h4', null, 'Инциденты'),
        h('button', { class: 'btn sm', onclick: () => incidentModal(null, s.services, draw) }, icon('plus', 13), 'Новый инцидент')),
      incidents.length ? h('div', { class: 'stack-sm' }, incidents.map((i) => h('div', { class: 'inline' },
        h('span', { class: `badge ${i.status === 'resolved' ? 'ok' : ''}` }, label(STATUSES, i.status)),
        h('b', null, i.title), h('span', { class: 'muted small' }, `${label(SEVERITIES, i.severity)} · ${relTime(i.updatedAt)}`), h('span', { class: 'spacer' }),
        h('button', { class: 'btn icon ghost sm', title: 'Изменить', onclick: () => incidentModal(i, s.services, draw) }, icon('edit', 14)),
        h('button', { class: 'btn icon ghost sm', title: 'Удалить', onclick: () => removeIncident(i) }, icon('trash', 14)))))
        : h('p', { class: 'muted small' }, 'Инцидентов нет'));
  };
  draw();
  return box;
}
