import { del, get, post } from './api.js';
import { runServiceAction, svcBadge, typeChip } from './components.js';
import { clear, confirmDialog, field, h, icon, modal, toast } from './dom.js';
import { can, favorites, isDb, pushRecent, refresh, store, subscribe, svcKey, toggleFavorite } from './store.js';
import { cloneModal, saveTemplateModal } from './views2.js';

let current = null;

export function closeDrawer() {
  current?.unsub?.();
  current?.leave?.();
  current?.el.remove(); current?.back.remove(); current = null;
  document.removeEventListener('keydown', onKey);
}
const onKey = (e) => {
  if (document.querySelector('#overlay-root .backdrop')) return;
  if (e.key === 'Escape') return closeDrawer();
  // 1–9 переключают разделы (не мешаем вводу текста)
  if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) current?.switchIndex?.(Number(e.key) - 1);
};

const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return undefined; };
const asList = (v) => (Array.isArray(v) ? v : []);
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };

/** Поля домена/порта/тома из ответа панели — с запасными названиями на случай другой версии API. */
const domainOf = (x) => ({ id: x.id ?? x._id, host: x.host ?? x.domain ?? '', https: x.https ?? x.ssl ?? true, port: x.port ?? x.service?.port ?? x.destinationPort ?? x.targetPort ?? '', path: x.path ?? x.service?.path ?? '/' });
const portOf = (x) => ({ id: x.id ?? x._id, published: x.published ?? x.publishedPort ?? x.external ?? x.hostPort ?? '', target: x.target ?? x.targetPort ?? x.internal ?? x.containerPort ?? '', protocol: String(x.protocol ?? 'tcp').toLowerCase() });
const mountOf = (x) => ({ id: x.id ?? x._id, type: x.type ?? 'volume', name: x.name ?? x.volume ?? '', hostPath: x.hostPath ?? x.source ?? '', mountPath: x.mountPath ?? x.target ?? x.path ?? '', content: x.content ?? '' });

const NAV_ICON = { overview: 'grid', env: 'edit', logs: 'terminal', domains: 'globe', storage: 'database', resources: 'activity', source: 'box', automation: 'link', raw: 'layers', danger: 'trash' };

/** Открывает боковую панель сервиса. */
export function openService(s) {
  closeDrawer();
  pushRecent(s);
  const ro = !can('operator');
  const ref = { type: s.type, project: s.project, name: s.name };
  const base = `/api/panels/${s.panelId}`;
  const state = { data: null, tab: 'overview' };
  const body = h('div', { class: 'drawer-body' }, h('div', { class: 'skeleton', style: { height: '120px' } }));
  const navEl = h('nav', { class: 'dnav', 'aria-label': 'Разделы сервиса' });
  const live = () => store.panels.find((p) => p.id === s.panelId)?.tree?.projects.find((p) => p.name === s.project)?.services.find((x) => x.name === s.name) ?? s;
  const headActions = h('div', { class: 'row-actions' });
  const star = h('button', { class: 'btn icon ghost sm star', title: 'В избранное', 'aria-label': 'Избранное', onclick: () => { const on = toggleFavorite(s); star.classList.toggle('on', on); } }, icon('star', 16));
  star.classList.toggle('on', favorites().has(svcKey(s)));

  const el = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': `Сервис ${s.name}` },
    h('div', { class: 'drawer-head' },
      h('div', null,
        h('div', { class: 'crumbs' }, h('i', { class: 'swatch', style: { background: s.panel.color } }), `${s.panel.name} / ${s.project}`),
        h('h2', null, s.name, ' ', star),
        h('div', { class: 'inline' }, typeChip(s.type), h('span', { class: 'status-slot' }))),
      h('button', { class: 'btn icon ghost', onclick: closeDrawer, 'aria-label': 'Закрыть' }, icon('x'))),
    headActions, h('div', { class: 'drawer-main' }, navEl, body));
  const back = h('div', { class: 'drawer-back', onclick: closeDrawer });
  document.body.append(back, el);
  document.addEventListener('keydown', onKey);
  current = { el, back, leave: () => { state.onLeave?.(); state.onLeave = null; } };
  requestAnimationFrame(() => { el.classList.add('in'); back.classList.add('in'); });

  const renderHead = () => {
    const cur = live();
    el.querySelector('.status-slot').replaceChildren(svcBadge(cur.enabled));
    const act = (a, ic, label, cls = '') => h('button', { class: `btn sm ${cls}`, onclick: async (e) => { const b = e.currentTarget; b.disabled = true; await runServiceAction({ ...cur, panel: s.panel, panelId: s.panelId }, a); if (a === 'destroy') closeDrawer(); else { renderHead(); } b.disabled = false; } }, icon(ic, 14), label);
    clear(headActions).append(
      ro || isDb(s.type) ? null : act('deploy', 'rocket', 'Деплой', 'primary'),
      ro ? null : act('restart', 'rotate', 'Перезапуск'),
      ro ? null : (cur.enabled ? act('stop', 'stop', 'Стоп') : act('start', 'play', 'Запуск')),
      h('a', { class: 'btn sm ghost', href: s.panel.url, target: '_blank', rel: 'noopener', title: 'Открыть панель Easypanel' }, icon('external', 14), 'Easypanel'));
  };
  renderHead();
  current.unsub = subscribe(renderHead);

  const tabs = [
    ['overview', 'Обзор'], ...(ro ? [] : [['env', 'Окружение'], ['logs', 'Логи']]), ['domains', 'Домены'], ['storage', 'Порты и тома'],
    ['resources', 'Ресурсы'], ...(s.type === 'app' && !ro ? [['source', 'Источник']] : []),
    ...(can('admin') ? [['automation', 'Автоматизация']] : []), ...(ro ? [] : [['raw', 'Данные']]), ...(can('admin') ? [['danger', 'Удаление']] : []),
  ];
  const remembered = lsGet('ea-drawer-tab');
  if (tabs.some(([id]) => id === remembered)) state.tab = remembered;
  const count = (id) => {
    const d = state.data; if (!d) return null;
    const n = id === 'domains' ? asList(d.domains).length : id === 'storage' ? asList(d.ports).length + asList(d.mounts).length : null;
    return n || null;
  };
  const switchTab = (id) => { state.tab = id; lsSet('ea-drawer-tab', id); renderTabs(); renderBody(); };
  current.switchIndex = (i) => { if (tabs[i]) switchTab(tabs[i][0]); };
  const renderTabs = () => {
    clear(navEl).append(...tabs.flatMap(([id, label], i) => {
      const n = count(id);
      const btn = h('button', { class: `dtab ${state.tab === id ? 'active' : ''}${id === 'danger' ? ' danger' : ''}`, title: `${label} (${i + 1})`, 'aria-current': state.tab === id ? 'page' : null, onclick: () => switchTab(id) },
        icon(NAV_ICON[id], 16), h('span', { class: 'lbl' }, label), n ? h('span', { class: 'cnt' }, n) : null);
      return id === 'danger' ? [h('div', { class: 'dsep' }), btn] : [btn];
    }));
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
      renderTabs(); renderBody();
    } catch (e) {
      clear(body).append(h('div', { class: 'callout err' }, icon('alert'), h('div', null, h('b', null, 'Не удалось загрузить сервис'), h('p', null, e.message),
        h('button', { class: 'btn sm', onclick: load }, 'Повторить'))));
    }
  }

  function renderBody() {
    const d = state.data;
    if (!d) return;
    state.onLeave?.(); state.onLeave = null; // закрываем потоки логов при смене вкладки
    const svc = d.service || {};
    clear(body);
    if (d.warnings?.length) body.append(h('div', { class: 'callout warn' }, icon('alert'), h('div', null, d.warnings.join('; '))));
    const views = { overview, env, logs, domains, storage, resources, source, raw, danger, automation };
    body.append(views[state.tab](svc, d));
  }

  /* ---- Обзор ---- */
  function overview(svc, d) {
    const domainsList = asList(d.domains);
    const notes = h('textarea', { class: 'input', rows: 4, placeholder: 'Заметки о сервисе…' }, pick(svc, 'notes') ?? '');
    const kv = (k, v) => { if (v == null) return null; const str = String(v); return h('div', { class: 'kv' }, h('span', null, k), str.length > 44 ? h('b', { class: 'clip', title: str, onclick: (e) => e.currentTarget.classList.toggle('open') }, str) : h('b', null, str)); };
    const statsBox = h('div');
    get(`${base}/service-stats?project=${encodeURIComponent(s.project)}&name=${encodeURIComponent(s.name)}`).then(({ stats }) => {
      const flat = Object.entries(stats && typeof stats === 'object' ? stats : {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string').slice(0, 8);
      if (flat.length) statsBox.append(h('div', { class: 'card flat' }, h('h4', { style: { marginBottom: '6px' } }, 'Ресурсы сейчас'), ...flat.map(([k, v]) => kv(k, typeof v === 'number' ? Math.round(v * 100) / 100 : v))));
    }).catch(() => {});
    const src = svc.source;
    return h('div', { class: 'stack' },
      h('div', { class: 'card flat' },
        kv('Панель', s.panel.name), kv('Проект', s.project), kv('Тип', s.type),
        kv('Образ', pick(src, 'image')), kv('Репозиторий', src?.owner ? `${src.owner}/${src.repo}@${src.ref || src.branch || ''}` : undefined),
        kv('Доменов', domainsList.length), kv('Томов', asList(d.mounts).length), kv('Портов', asList(d.ports).length)),
      domainsList.length ? h('div', { class: 'stack-sm' }, h('h4', null, 'Домены'), domainsList.map((x) => h('a', { class: 'link-row', href: `${x.https === false ? 'http' : 'https'}://${x.host}`, target: '_blank', rel: 'noopener' }, icon('globe', 14), x.host, icon('external', 12)))) : null,
      statsBox,
      field('Заметки', notes),
      ro ? null : h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: () => op('notes', { notes: notes.value }) }, 'Сохранить заметки'),
        can('admin') ? h('button', { class: 'btn', onclick: () => cloneModal({ ...s, ...live() }) }, icon('copy', 14), 'Клонировать…') : null,
        can('admin') ? h('button', { class: 'btn', onclick: () => saveTemplateModal({ ...s, ...live() }) }, icon('layers', 14), 'Сохранить как шаблон') : null));
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

  const itemActions = (onEdit, onDelete) => ro ? null : h('div', { class: 'inline' },
    h('button', { class: 'btn icon ghost sm', title: 'Изменить', onclick: onEdit }, icon('edit', 15)),
    h('button', { class: 'btn icon ghost sm danger-text', title: 'Удалить', onclick: onDelete }, icon('trash', 15)));
  const sectionHead = (title, onAdd, label) => h('div', { class: 'section-head' }, h('h4', null, title), ro ? null : h('button', { class: 'btn sm', onclick: onAdd }, icon('plus', 14), label));
  const confirmDel = (title, message, opName, params, okMsg) => async () => { if (await confirmDialog({ title, message, danger: true, confirmText: 'Удалить' })) op(opName, params, okMsg); };
  const check = (checked, label) => { const i = h('input', { type: 'checkbox', checked }); return { i, el: h('label', { class: 'check' }, i, label) }; };
  const dialog = (title, body, onSave, saveLabel = 'Сохранить') => modal({ title, body, actions: [{ label: 'Отмена', kind: 'ghost' }, { label: saveLabel, kind: 'primary', onClick: onSave }] });

  /* ---- Домены ---- */
  function domainForm(x) {
    const v = x ? domainOf(x) : { host: '', port: 80, path: '/', https: true };
    const host = h('input', { class: 'input', placeholder: 'app.example.com', value: v.host }), port = h('input', { class: 'input', type: 'number', min: 1, max: 65535, value: v.port }), path = h('input', { class: 'input mono', value: v.path });
    const https = check(v.https !== false, 'HTTPS (Let’s Encrypt)');
    dialog(x ? 'Изменить домен' : 'Добавить домен', h('div', { class: 'stack' }, field('Хост', host), h('div', { class: 'grid-2' }, field('Порт контейнера', port), field('Путь', path)), https.el), async () => {
      if (!host.value.trim()) throw new Error('Укажите хост');
      const params = { id: x ? v.id : undefined, original: x, host: host.value.trim(), port: port.value, path: path.value || '/', https: https.i.checked };
      return x ? op('domainUpdate', params, 'Домен обновлён') : op('domainAdd', params, 'Домен добавлен');
    });
  }
  function domains(_svc, d) {
    const list = asList(d.domains);
    return h('div', { class: 'stack' }, sectionHead('Домены', () => domainForm(), 'Добавить домен'),
      list.length ? h('div', { class: 'list' }, list.map((x) => {
        const v = domainOf(x);
        return h('div', { class: 'list-item' },
          h('div', null, h('a', { class: 'link-row', href: `${v.https === false ? 'http' : 'https'}://${v.host}${v.path && v.path !== '/' ? v.path : ''}`, target: '_blank', rel: 'noopener' }, h('b', null, v.host), icon('external', 12)),
            h('div', { class: 'muted small' }, `порт ${v.port === '' ? '—' : v.port} · ${v.https === false ? 'HTTP' : 'HTTPS'}${v.path && v.path !== '/' ? ` · ${v.path}` : ''}`)),
          itemActions(() => domainForm(x), confirmDel('Удалить домен?', v.host, 'domainDelete', { id: v.id }, 'Домен удалён')));
      })) : h('div', { class: 'muted' }, 'Доменов пока нет.'));
  }

  /* ---- Порты и тома ---- */
  function portForm(x) {
    const v = x ? portOf(x) : { published: '', target: '', protocol: 'tcp' };
    const pub = h('input', { class: 'input', type: 'number', placeholder: '8080', value: v.published }), tgt = h('input', { class: 'input', type: 'number', placeholder: '80', value: v.target });
    const proto = h('select', { class: 'input' }, ['tcp', 'udp'].map((t) => h('option', { value: t, selected: v.protocol === t }, t.toUpperCase())));
    dialog(x ? 'Изменить порт' : 'Открыть порт', h('div', { class: 'grid-3' }, field('Внешний', pub), field('Внутренний', tgt), field('Протокол', proto)), async () => {
      if (!pub.value || !tgt.value) throw new Error('Укажите оба порта');
      const params = { id: x ? v.id : undefined, original: x, published: pub.value, target: tgt.value, protocol: proto.value };
      return x ? op('portUpdate', params, 'Порт обновлён') : op('portAdd', params, 'Порт добавлен');
    });
  }
  function mountForm(x) {
    const v = x ? mountOf(x) : { type: 'volume', name: '', hostPath: '', mountPath: '', content: '' };
    const type = h('select', { class: 'input', onchange: sync }, ['volume', 'bind', 'file'].map((t) => h('option', { value: t, selected: v.type === t }, t)));
    const mPath = h('input', { class: 'input mono', placeholder: '/var/lib/data', value: v.mountPath });
    const name = h('input', { class: 'input mono', placeholder: 'data', value: v.name }), host = h('input', { class: 'input mono', placeholder: '/srv/data', value: v.hostPath });
    const content = h('textarea', { class: 'input mono', rows: 6, spellcheck: 'false' }, v.content);
    const fName = field('Имя тома', name), fHost = field('Путь на хосте', host), fContent = field('Содержимое файла', content);
    function sync() { fName.hidden = type.value !== 'volume'; fHost.hidden = type.value !== 'bind'; fContent.hidden = type.value !== 'file'; }
    sync();
    dialog(x ? 'Изменить монтирование' : 'Добавить монтирование', h('div', { class: 'stack' }, h('div', { class: 'grid-2' }, field('Тип', type), field('Путь в контейнере', mPath)), fName, fHost, fContent), async () => {
      if (!mPath.value.trim()) throw new Error('Укажите путь в контейнере');
      const t = type.value;
      const params = { id: x ? v.id : undefined, original: x, type: t, mountPath: mPath.value.trim(), name: t === 'volume' ? name.value.trim() || undefined : undefined, hostPath: t === 'bind' ? host.value.trim() || undefined : undefined, content: t === 'file' ? content.value : undefined };
      return x ? op('mountUpdate', params, 'Монтирование обновлено') : op('mountAdd', params, 'Монтирование добавлено');
    });
  }
  function storage(svc, d) {
    const ports = asList(d.ports), mounts = asList(d.mounts);
    return h('div', { class: 'stack' },
      sectionHead('Открытые порты', () => portForm(), 'Открыть порт'),
      ports.length ? h('div', { class: 'list' }, ports.map((x) => {
        const v = portOf(x);
        return h('div', { class: 'list-item' }, h('div', null, h('b', null, `${v.published === '' ? '—' : v.published} → ${v.target === '' ? '—' : v.target}`), h('span', { class: 'muted small ml' }, v.protocol.toUpperCase())),
          itemActions(() => portForm(x), confirmDel('Удалить порт?', `${v.published} → ${v.target}`, 'portDelete', { id: v.id }, 'Порт удалён')));
      })) : h('div', { class: 'muted' }, 'Нет открытых портов. Внутренний порт приложения задаётся в домене (поле «Порт контейнера»).'),
      sectionHead('Тома и монтирования', () => mountForm(), 'Добавить монтирование'),
      mounts.length ? h('div', { class: 'list' }, mounts.map((x) => {
        const v = mountOf(x);
        return h('div', { class: 'list-item' }, h('div', null, h('b', { class: 'mono' }, v.mountPath), h('div', { class: 'muted small' }, `${v.type}${v.type === 'volume' && v.name ? ` · ${v.name}` : ''}${v.type === 'bind' && v.hostPath ? ` · ${v.hostPath}` : ''}${v.type === 'file' && v.content ? ` · ${v.content.split('\n').length} стр.` : ''}`)),
          itemActions(() => mountForm(x), confirmDel('Удалить монтирование?', v.mountPath, 'mountDelete', { id: v.id }, 'Монтирование удалено')));
      })) : h('div', { class: 'muted' }, 'Нет монтирований.'));
  }

  /* ---- Ресурсы ---- */
  function resources(svc) {
    const r = svc.resources || {};
    const mk = (label, key, hint) => { const i = h('input', { class: 'input', type: 'number', min: 0, step: 'any', value: r[key] ?? '', placeholder: '0 = без лимита' }); return { i, f: field(label, i, hint) }; };
    const ml = mk('Лимит памяти, МБ', 'memoryLimit'), mr = mk('Резерв памяти, МБ', 'memoryReservation'), cl = mk('Лимит CPU, ядер', 'cpuLimit'), cr = mk('Резерв CPU, ядер', 'cpuReservation');
    return h('div', { class: 'stack' }, h('div', { class: 'grid-2' }, ml.f, mr.f, cl.f, cr.f),
      ro ? null : h('div', null, h('button', { class: 'btn primary', onclick: () => op('resources', { memoryLimit: ml.i.value, memoryReservation: mr.i.value, cpuLimit: cl.i.value, cpuReservation: cr.i.value }, 'Лимиты сохранены') }, 'Сохранить')));
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

  /* ---- Логи (SSE ← WebSocket панели) ---- */
  function logs() {
    const MAX = 3000;
    const view = h('div', { class: 'logview', tabindex: 0 });
    const status = h('span', { class: 'muted small' }, 'Подключение…');
    const count = h('span', { class: 'muted small' });
    let es = null, paused = false, follow = true, filter = '', buffer = [], all = [];
    const cls = (l) => (/\b(error|fatal|panic|exception|fail(ed)?)\b/i.test(l) ? 'err' : /\bwarn(ing)?\b/i.test(l) ? 'warn' : '');
    const row = (l) => h('div', { class: `ll ${cls(l)}` }, l);
    const shown = (l) => !filter || l.toLowerCase().includes(filter);
    const stick = () => { if (follow) view.scrollTop = view.scrollHeight; };
    const push = (l) => {
      all.push(l); if (all.length > MAX) { all.shift(); if (view.firstChild) view.firstChild.remove(); }
      if (paused) { buffer.push(l); count.textContent = `на паузе, накоплено ${buffer.length}`; return; }
      if (shown(l)) view.append(row(l));
      count.textContent = `${all.length} строк`; stick();
    };
    const redraw = () => { clear(view).append(...all.filter(shown).map(row)); stick(); };
    view.addEventListener('scroll', () => { follow = view.scrollTop + view.clientHeight >= view.scrollHeight - 24; followBtn.classList.toggle('on', follow); });
    const connect = () => {
      es?.close();
      status.textContent = 'Подключение…'; status.className = 'muted small';
      es = new EventSource(`${base}/logs?${new URLSearchParams(ref)}`);
      es.addEventListener('line', (e) => push(JSON.parse(e.data)));
      es.addEventListener('status', (e) => {
        const st = JSON.parse(e.data);
        if (st.state === 'connected') { status.textContent = '● Онлайн'; status.className = 'small ok-text'; }
        else { status.textContent = st.state === 'closed' ? 'Поток завершён' : st.message; status.className = `small ${st.state === 'closed' ? 'muted' : 'danger-text'}`; es.close(); }
      });
      es.onerror = () => { status.textContent = 'Соединение потеряно — переподключение…'; status.className = 'small warn-text'; };
    };
    const pauseBtn = h('button', { class: 'btn sm', onclick: () => { paused = !paused; pauseBtn.replaceChildren(icon(paused ? 'play' : 'stop', 13), paused ? 'Продолжить' : 'Пауза'); if (!paused) { const b = buffer; buffer = []; b.forEach((l) => shown(l) && view.append(row(l))); count.textContent = `${all.length} строк`; stick(); } } }, icon('stop', 13), 'Пауза');
    const followBtn = h('button', { class: 'btn sm on', title: 'Прокручивать к новым строкам', onclick: () => { follow = !follow; followBtn.classList.toggle('on', follow); stick(); } }, icon('down', 13), 'Следить');
    const q = h('input', { class: 'input', placeholder: 'Фильтр…', oninput: () => { filter = q.value.toLowerCase(); redraw(); } });
    const dl = h('button', { class: 'btn sm ghost', title: 'Скачать', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([all.join('\n')], { type: 'text/plain' })), download: `${s.name}.log` }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 13));
    const clr = h('button', { class: 'btn sm ghost', onclick: () => { all = []; buffer = []; clear(view); count.textContent = ''; } }, icon('trash', 13), 'Очистить');
    const re = h('button', { class: 'btn sm ghost', onclick: connect }, icon('refresh', 13), 'Переподключить');
    state.onLeave = () => es?.close();
    connect();
    return h('div', { class: 'stack' }, h('div', { class: 'inline' }, q, pauseBtn, followBtn, dl, clr, re), h('div', { class: 'inline' }, status, h('span', { class: 'spacer' }), count), view);
  }

  function automation() {
    const box = h('div', { class: 'stack' });
    const load = () => get('/api/hooks').then((list) => {
      const mine = list.filter((x) => x.panelId === s.panelId && x.project === s.project && x.name === s.name);
      clear(box).append(
        h('p', { class: 'muted' }, 'Вебхук позволяет запускать действие по ссылке без входа — например, из GitHub Actions или GitLab CI после публикации образа. Ссылка показывается один раз; храните её как секрет.'),
        mine.length ? h('div', { class: 'list' }, mine.map((x) => h('div', { class: 'list-item' }, h('div', null, h('b', null, x.label), h('div', { class: 'muted small' }, `${x.action} · ${x.lastUsed ? 'вызван' : 'не вызывался'}`)),
          h('button', { class: 'btn icon ghost sm danger-text', onclick: async () => { await del(`/api/hooks/${x.id}`); load(); } }, icon('trash', 14))))) : h('div', { class: 'muted' }, 'Вебхуков для этого сервиса нет.'),
        h('div', { class: 'inline' }, [['deploy', 'Вебхук деплоя'], ['restart', 'Вебхук перезапуска']].filter(([a]) => a !== 'deploy' || !isDb(s.type)).map(([a, l]) => h('button', { class: 'btn', onclick: () => create(a) }, icon('plus', 14), l))));
    });
    const create = async (action) => {
      try {
        const r = await post('/api/hooks', { panelId: s.panelId, type: s.type, project: s.project, name: s.name, action });
        const url = `${location.origin}${r.path}`;
        const cmd = `curl -X POST ${url}`;
        modal({ title: 'Вебхук создан', body: h('div', { class: 'stack' }, h('p', null, 'Скопируйте сейчас — повторно ссылка не показывается.'), h('div', { class: 'secret', style: { fontSize: '12.5px', letterSpacing: 0 } }, cmd)),
          actions: [{ label: 'Копировать', kind: 'primary', close: false, onClick: () => { navigator.clipboard?.writeText(cmd); toast('Скопировано', 'success'); return false; } }, { label: 'Закрыть', kind: 'ghost' }] });
        load();
      } catch (e) { toast(e.message, 'error'); }
    };
    load();
    return box;
  }

  const raw = (_svc, d) => h('pre', { class: 'code' }, JSON.stringify(d, null, 2));

  function danger() {
    return h('div', { class: 'stack' }, h('div', { class: 'callout err' }, icon('alert'), h('div', null, h('b', null, 'Удаление сервиса'), h('p', null, 'Контейнер и данные будут удалены с сервера панели. Отменить нельзя.'),
      h('button', { class: 'btn danger', onclick: async () => { if (await runServiceAction({ ...live(), panel: s.panel, panelId: s.panelId }, 'destroy')) closeDrawer(); } }, icon('trash', 14), 'Удалить сервис'))));
  }

  renderTabs();
  load();
}
