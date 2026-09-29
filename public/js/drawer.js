import { get, post } from './api.js';
import { runServiceAction, svcBadge, typeChip } from './components.js';
import { clear, confirmDialog, field, h, icon, toast } from './dom.js';
import { isDb, refresh, store, subscribe } from './store.js';

let current = null;

export function closeDrawer() {
  current?.unsub?.();
  current?.el.remove(); current?.back.remove(); current = null;
  document.removeEventListener('keydown', onKey);
}
const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('#overlay-root .backdrop')) closeDrawer(); };

const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return undefined; };
const asList = (v) => (Array.isArray(v) ? v : []);

/** Открывает боковую панель сервиса. */
export function openService(s) {
  closeDrawer();
  const ref = { type: s.type, project: s.project, name: s.name };
  const base = `/api/panels/${s.panelId}`;
  const state = { data: null, tab: 'overview', dirtyEnv: null };
  const body = h('div', { class: 'drawer-body' }, h('div', { class: 'skeleton', style: { height: '120px' } }));
  const tabsEl = h('div', { class: 'tabs' });
  const live = () => store.panels.find((p) => p.id === s.panelId)?.tree?.projects.find((p) => p.name === s.project)?.services.find((x) => x.name === s.name) ?? s;
  const headActions = h('div', { class: 'row-actions' });

  const el = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': `Сервис ${s.name}` },
    h('div', { class: 'drawer-head' },
      h('div', null,
        h('div', { class: 'crumbs' }, h('i', { class: 'swatch', style: { background: s.panel.color } }), `${s.panel.name} / ${s.project}`),
        h('h2', null, s.name),
        h('div', { class: 'inline' }, typeChip(s.type), h('span', { class: 'status-slot' }))),
      h('button', { class: 'btn icon ghost', onclick: closeDrawer, 'aria-label': 'Закрыть' }, icon('x'))),
    headActions, tabsEl, body);
  const back = h('div', { class: 'drawer-back', onclick: closeDrawer });
  document.body.append(back, el);
  document.addEventListener('keydown', onKey);
  current = { el, back };
  requestAnimationFrame(() => { el.classList.add('in'); back.classList.add('in'); });

  const renderHead = () => {
    const cur = live();
    el.querySelector('.status-slot').replaceChildren(svcBadge(cur.enabled));
    const act = (a, ic, label, cls = '') => h('button', { class: `btn sm ${cls}`, onclick: async (e) => { const b = e.currentTarget; b.disabled = true; await runServiceAction({ ...cur, panel: s.panel, panelId: s.panelId }, a); if (a === 'destroy') closeDrawer(); else { renderHead(); } b.disabled = false; } }, icon(ic, 14), label);
    clear(headActions).append(
      isDb(s.type) ? null : act('deploy', 'rocket', 'Деплой', 'primary'),
      act('restart', 'rotate', 'Перезапуск'),
      cur.enabled ? act('stop', 'stop', 'Стоп') : act('start', 'play', 'Запуск'),
      h('a', { class: 'btn sm ghost', href: s.panel.url, target: '_blank', rel: 'noopener', title: 'Открыть панель Easypanel' }, icon('external', 14), 'Easypanel'));
  };
  renderHead();
  current.unsub = subscribe(renderHead);

  const tabs = [
    ['overview', 'Обзор'], ['env', 'Окружение'], ['domains', 'Домены'], ['storage', 'Порты и тома'],
    ['resources', 'Ресурсы'], ...(s.type === 'app' ? [['source', 'Источник']] : []), ['raw', 'Данные'], ['danger', 'Удаление'],
  ];
  const renderTabs = () => {
    clear(tabsEl).append(...tabs.map(([id, label]) => h('button', { class: `tab ${state.tab === id ? 'active' : ''}${id === 'danger' ? ' danger' : ''}`, onclick: () => { state.tab = id; renderTabs(); renderBody(); } }, label)));
  };

  const op = async (name, params, okMsg) => {
    try {
      await post(`${base}/service/op`, { ...ref, op: name, params });
      toast(okMsg || 'Сохранено', 'success');
      await load(); refresh(true, { silent: true });
      return true;
    } catch (e) { toast(e.message, 'error', 7000); return false; }
  };

  async function load() {
    try {
      state.data = await get(`${base}/service?${new URLSearchParams(ref)}`);
      renderBody();
    } catch (e) {
      clear(body).append(h('div', { class: 'callout err' }, icon('alert'), h('div', null, h('b', null, 'Не удалось загрузить сервис'), h('p', null, e.message),
        h('button', { class: 'btn sm', onclick: load }, 'Повторить'))));
    }
  }

  function renderBody() {
    const d = state.data;
    if (!d) return;
    const svc = d.service || {};
    clear(body);
    if (d.warnings?.length) body.append(h('div', { class: 'callout warn' }, icon('alert'), h('div', null, d.warnings.join('; '))));
    const views = { overview, env, domains, storage, resources, source, raw, danger };
    body.append(views[state.tab](svc, d));
  }

  /* ---- Обзор ---- */
  function overview(svc, d) {
    const domainsList = asList(d.domains);
    const notes = h('textarea', { class: 'input', rows: 4, placeholder: 'Заметки о сервисе…' }, pick(svc, 'notes') ?? '');
    const kv = (k, v) => v == null ? null : h('div', { class: 'kv' }, h('span', null, k), h('b', null, String(v)));
    const src = svc.source;
    return h('div', { class: 'stack' },
      h('div', { class: 'card flat' },
        kv('Панель', s.panel.name), kv('Проект', s.project), kv('Тип', s.type),
        kv('Образ', pick(src, 'image')), kv('Репозиторий', src?.owner ? `${src.owner}/${src.repo}@${src.ref || src.branch || ''}` : undefined),
        kv('Доменов', domainsList.length), kv('Томов', asList(d.mounts).length), kv('Портов', asList(d.ports).length)),
      domainsList.length ? h('div', { class: 'stack-sm' }, h('h4', null, 'Домены'), domainsList.map((x) => h('a', { class: 'link-row', href: `${x.https === false ? 'http' : 'https'}://${x.host}`, target: '_blank', rel: 'noopener' }, icon('globe', 14), x.host, icon('external', 12)))) : null,
      field('Заметки', notes),
      h('div', null, h('button', { class: 'btn primary', onclick: () => op('notes', { notes: notes.value }) }, 'Сохранить заметки')));
  }

  /* ---- Окружение ---- */
  function env(svc) {
    const text = String(pick(svc, 'env', 'envs') ?? '');
    let masked = true;
    const ta = h('textarea', { class: 'input mono env', rows: 14, spellcheck: 'false', autocomplete: 'off' });
    const showMasked = () => { ta.value = text.split('\n').map((l) => { const i = l.indexOf('='); return i > 0 && !l.startsWith('#') ? `${l.slice(0, i)}=••••••••` : l; }).join('\n'); ta.readOnly = true; };
    const reveal = () => { ta.value = text; ta.readOnly = false; };
    showMasked();
    const toggle = h('button', { class: 'btn sm', onclick: () => { masked = !masked; masked ? showMasked() : reveal(); toggle.replaceChildren(icon('eye', 14), masked ? 'Показать значения' : 'Скрыть'); save.disabled = masked; saveDeploy.disabled = masked; } }, icon('eye', 14), 'Показать значения');
    const copy = h('button', { class: 'btn sm ghost', onclick: () => { if (masked) return toast('Сначала покажите значения', 'error'); navigator.clipboard?.writeText(ta.value); toast('Скопировано', 'success'); } }, icon('copy', 14), 'Копировать');
    const save = h('button', { class: 'btn primary', disabled: true, onclick: () => op('env', { env: ta.value }, 'Переменные сохранены') }, 'Сохранить');
    const saveDeploy = h('button', { class: 'btn', disabled: true, onclick: async () => { if (await op('env', { env: ta.value }, 'Переменные сохранены')) runServiceAction({ ...live(), panel: s.panel, panelId: s.panelId }, 'deploy'); } }, icon('rocket', 14), 'Сохранить и задеплоить');
    return h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Формат: одна переменная на строку, KEY=value. Значения скрыты, пока вы не нажмёте «Показать».'),
      ta, h('div', { class: 'inline' }, toggle, copy, h('span', { class: 'spacer' }), save, isDb(s.type) ? null : saveDeploy));
  }

  /* ---- Домены ---- */
  function domains(_svc, d) {
    const list = asList(d.domains);
    const hostI = h('input', { class: 'input', placeholder: 'app.example.com' });
    const portI = h('input', { class: 'input', type: 'number', value: 80, min: 1, max: 65535 });
    const httpsI = h('input', { type: 'checkbox', checked: true });
    return h('div', { class: 'stack' },
      list.length ? h('div', { class: 'list' }, list.map((x) => h('div', { class: 'list-item' },
        h('div', null, h('b', null, x.host), h('div', { class: 'muted small' }, `порт ${x.port ?? '—'} · ${x.https === false ? 'HTTP' : 'HTTPS'}`)),
        h('button', { class: 'btn icon ghost sm', title: 'Удалить домен', onclick: async () => { if (await confirmDialog({ title: 'Удалить домен?', message: x.host, danger: true, confirmText: 'Удалить' })) op('domainDelete', { id: x.id ?? x._id }, 'Домен удалён'); } }, icon('trash', 15)))))
        : h('div', { class: 'muted' }, 'Доменов пока нет.'),
      h('div', { class: 'card flat stack' }, h('h4', null, 'Добавить домен'),
        h('div', { class: 'grid-2' }, field('Хост', hostI), field('Порт контейнера', portI)),
        h('label', { class: 'check' }, httpsI, 'HTTPS (Let’s Encrypt)'),
        h('div', null, h('button', { class: 'btn primary', onclick: () => { if (!hostI.value.trim()) return toast('Укажите хост', 'error'); op('domainAdd', { host: hostI.value.trim(), port: portI.value, https: httpsI.checked }, 'Домен добавлен'); } }, icon('plus', 14), 'Добавить'))));
  }

  /* ---- Порты и тома ---- */
  function storage(_svc, d) {
    const ports = asList(d.ports), mounts = asList(d.mounts);
    const pub = h('input', { class: 'input', type: 'number', placeholder: '8080' });
    const tgt = h('input', { class: 'input', type: 'number', placeholder: '80' });
    const proto = h('select', { class: 'input' }, h('option', { value: 'tcp' }, 'TCP'), h('option', { value: 'udp' }, 'UDP'));
    const mType = h('select', { class: 'input' }, ['volume', 'bind', 'file'].map((t) => h('option', { value: t }, t)));
    const mName = h('input', { class: 'input', placeholder: 'data (для volume)' });
    const mHost = h('input', { class: 'input', placeholder: '/srv/data (для bind)' });
    const mPath = h('input', { class: 'input', placeholder: '/var/lib/data' });
    return h('div', { class: 'stack' },
      h('h4', null, 'Открытые порты'),
      ports.length ? h('div', { class: 'list' }, ports.map((x) => h('div', { class: 'list-item' }, h('b', null, `${x.published ?? x.publishedPort} → ${x.target ?? x.targetPort}`), h('span', { class: 'muted small' }, String(x.protocol ?? 'tcp').toUpperCase()),
        h('button', { class: 'btn icon ghost sm', onclick: () => op('portDelete', { id: x.id }, 'Порт удалён') }, icon('trash', 15))))) : h('div', { class: 'muted' }, 'Нет открытых портов.'),
      h('div', { class: 'card flat stack' }, h('div', { class: 'grid-3' }, field('Внешний', pub), field('Внутренний', tgt), field('Протокол', proto)),
        h('div', null, h('button', { class: 'btn', onclick: () => { if (!pub.value || !tgt.value) return toast('Укажите оба порта', 'error'); op('portAdd', { published: pub.value, target: tgt.value, protocol: proto.value }, 'Порт добавлен'); } }, icon('plus', 14), 'Открыть порт'))),
      h('h4', null, 'Тома и монтирования'),
      mounts.length ? h('div', { class: 'list' }, mounts.map((x) => h('div', { class: 'list-item' }, h('div', null, h('b', null, x.mountPath), h('div', { class: 'muted small' }, `${x.type ?? 'volume'} · ${x.name ?? x.hostPath ?? ''}`)),
        h('button', { class: 'btn icon ghost sm', onclick: async () => { if (await confirmDialog({ title: 'Удалить монтирование?', message: x.mountPath, danger: true, confirmText: 'Удалить' })) op('mountDelete', { id: x.id }, 'Монтирование удалено'); } }, icon('trash', 15))))) : h('div', { class: 'muted' }, 'Нет монтирований.'),
      h('div', { class: 'card flat stack' }, h('div', { class: 'grid-2' }, field('Тип', mType), field('Путь в контейнере', mPath)), h('div', { class: 'grid-2' }, field('Имя тома', mName), field('Путь на хосте', mHost)),
        h('div', null, h('button', { class: 'btn', onclick: () => { if (!mPath.value) return toast('Укажите путь в контейнере', 'error'); op('mountAdd', { type: mType.value, name: mName.value || undefined, hostPath: mHost.value || undefined, mountPath: mPath.value }, 'Монтирование добавлено'); } }, icon('plus', 14), 'Добавить'))));
  }

  /* ---- Ресурсы ---- */
  function resources(svc) {
    const r = svc.resources || {};
    const mk = (label, key, hint) => { const i = h('input', { class: 'input', type: 'number', min: 0, step: 'any', value: r[key] ?? '', placeholder: '0 = без лимита' }); return { i, f: field(label, i, hint) }; };
    const ml = mk('Лимит памяти, МБ', 'memoryLimit'), mr = mk('Резерв памяти, МБ', 'memoryReservation'), cl = mk('Лимит CPU, ядер', 'cpuLimit'), cr = mk('Резерв CPU, ядер', 'cpuReservation');
    return h('div', { class: 'stack' }, h('div', { class: 'grid-2' }, ml.f, mr.f, cl.f, cr.f),
      h('div', null, h('button', { class: 'btn primary', onclick: () => op('resources', { memoryLimit: ml.i.value, memoryReservation: mr.i.value, cpuLimit: cl.i.value, cpuReservation: cr.i.value }, 'Лимиты сохранены') }, 'Сохранить')));
  }

  /* ---- Источник ---- */
  function source(svc) {
    const src = svc.source || {};
    const image = h('input', { class: 'input mono', placeholder: 'nginx:latest', value: src.image ?? '' });
    const owner = h('input', { class: 'input', placeholder: 'owner', value: src.owner ?? '' });
    const repo = h('input', { class: 'input', placeholder: 'repo', value: src.repo ?? '' });
    const branch = h('input', { class: 'input', placeholder: 'main', value: src.ref ?? src.branch ?? '' });
    const path = h('input', { class: 'input', placeholder: '/', value: src.path ?? '' });
    return h('div', { class: 'stack' },
      h('div', { class: 'card flat stack' }, h('h4', null, 'Docker-образ'), field('Образ', image),
        h('div', null, h('button', { class: 'btn primary', onclick: () => { if (!image.value.trim()) return toast('Укажите образ', 'error'); op('sourceImage', { image: image.value.trim() }, 'Источник обновлён'); } }, 'Применить образ'))),
      h('div', { class: 'card flat stack' }, h('h4', null, 'GitHub'), h('div', { class: 'grid-2' }, field('Владелец', owner), field('Репозиторий', repo), field('Ветка', branch), field('Путь сборки', path)),
        h('div', null, h('button', { class: 'btn', onclick: () => { if (!owner.value || !repo.value) return toast('Укажите владельца и репозиторий', 'error'); op('sourceGithub', { owner: owner.value, repo: repo.value, branch: branch.value, path: path.value }, 'Источник обновлён'); } }, 'Применить репозиторий'))),
      h('p', { class: 'muted small' }, 'После смены источника выполните деплой, чтобы изменения вступили в силу.'));
  }

  const raw = (_svc, d) => h('pre', { class: 'code' }, JSON.stringify(d, null, 2));

  function danger() {
    return h('div', { class: 'stack' }, h('div', { class: 'callout err' }, icon('alert'), h('div', null, h('b', null, 'Удаление сервиса'), h('p', null, 'Контейнер и данные будут удалены с сервера панели. Отменить нельзя.'),
      h('button', { class: 'btn danger', onclick: async () => { if (await runServiceAction({ ...live(), panel: s.panel, panelId: s.panelId }, 'destroy')) closeDrawer(); } }, icon('trash', 14), 'Удалить сервис'))));
  }

  renderTabs();
  load();
}
