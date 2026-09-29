import { del, get, post, put } from './api.js';
import { empty, panelChip } from './components.js';
import { clear, confirmDialog, field, fmtTime, h, icon, modal, relTime, toast } from './dom.js';
import { actionLabel, languageCard, pageHead, themeCard } from './views.js';
import { can, panelById, store } from './store.js';
import { twoFaCard } from './views2.js';

const ROLE = { admin: ['администратор', 'ok'], operator: ['оператор', 'warn'], viewer: ['только чтение', 'muted'] };
const ROLE_HELP = { viewer: 'Только чтение — видит статусы, без env и секретов', operator: 'Оператор — деплой, перезапуск, env, домены; без удаления и системных операций', admin: 'Администратор — всё' };
export const roleBadge = (role) => h('span', { class: `badge ${ROLE[role]?.[1] ?? 'muted'}` }, ROLE[role]?.[0] ?? role);

/** Круглый аватар с инициалом; цвет зависит от имени. */
export function avatar(u, size = 36) {
  const name = u.displayName || u.username || '?';
  let hash = 0; for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return h('div', { class: 'avatar', style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: `hsl(${hash} 55% 32% / .45)`, color: `hsl(${hash} 80% 78%)` } }, [...name][0].toUpperCase());
}

/** «Chrome · Windows» из User-Agent. */
export function uaLabel(ua) {
  if (!ua) return 'Неизвестное устройство';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return browser || os ? [browser, os].filter(Boolean).join(' · ') : ua.slice(0, 40);
}
const accessText = (u) => (u.panels?.length ? u.panels.map((id) => panelById(id)?.name ?? `#${id}`).join(', ') : 'Все панели');

/* ============================== ПРОФИЛЬ ============================== */
export function profilePage() {
  const box = h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { height: '160px' } }));
  const load = () => get('/api/me').then((me) => { Object.assign(store.user, { totpEnabled: me.totpEnabled, displayName: me.displayName }); render(me); }).catch((e) => clear(box).append(h('div', { class: 'callout err' }, icon('alert'), e.message)));

  function render(me) {
    const dn = h('input', { class: 'input', value: me.displayName ?? '', placeholder: me.username, maxlength: 80 });
    const em = h('input', { class: 'input', type: 'email', value: me.email ?? '', placeholder: 'name@example.com' });
    const saveProfile = h('button', { class: 'btn primary', onclick: async () => { try { await put('/api/me', { displayName: dn.value, email: em.value }); store.user.displayName = dn.value.trim() || null; window.dispatchEvent(new Event('ea:profile')); toast('Профиль сохранён', 'success'); } catch (e) { toast(e.message, 'error'); } } }, 'Сохранить');

    const hero = h('section', { class: 'card profile-hero' }, avatar(me, 64),
      h('div', { class: 'grow' }, h('h2', null, me.displayName || me.username), h('div', { class: 'muted' }, `@${me.username}${me.email ? ` · ${me.email}` : ''}`),
        h('div', { class: 'inline', style: { marginTop: '8px' } }, roleBadge(me.role), me.sso ? h('span', { class: 'badge muted' }, 'SSO') : null, me.hasPassword ? h('span', { class: 'badge muted' }, 'Пароль') : null, me.totpEnabled ? h('span', { class: 'badge ok' }, '2FA') : null)),
      h('div', { class: 'profile-meta small muted' }, h('div', null, `Создан: ${fmtTime(me.createdAt)}`), me.lastLogin ? h('div', null, `Последний вход: ${fmtTime(me.lastLogin)}`) : null,
        h('div', null, `Доступ: ${accessText(me)}`)));

    const info = h('section', { class: 'card stack' }, h('h3', null, 'Личные данные'),
      h('div', { class: 'grid-2' }, field('Имя', dn, 'Отображается вместо логина'), field('Email', em)), field('Логин', h('input', { class: 'input', value: me.username, disabled: true }), 'Логин меняет администратор'),
      h('div', null, saveProfile));

    return clear(box).append(hero, h('div', { class: 'grid-cols' }, h('div', { class: 'stack' }, info, security(me), prefs()), h('div', { class: 'stack' }, sessionsCard(me), activityCard(me))));
  }

  function security(me) {
    if (!me.hasPassword) return h('section', { class: 'card stack' }, h('h3', null, 'Безопасность'), h('div', { class: 'callout' }, icon('shield', 16), 'Вход выполняется через SSO — пароль и двухфакторная защита настраиваются у провайдера.'));
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' }), n1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' }), n2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const pw = h('section', { class: 'card stack' }, h('h3', null, 'Смена пароля'), field('Текущий пароль', cur), h('div', { class: 'grid-2' }, field('Новый пароль', n1, 'Минимум 8 символов'), field('Повторите пароль', n2)),
      h('p', { class: 'muted small' }, 'После смены пароля вы останетесь в этой сессии, а на остальных устройствах вход будет завершён.'),
      h('div', null, h('button', { class: 'btn', onclick: async () => {
        if (n1.value !== n2.value) return toast('Пароли не совпадают', 'error');
        try { const r = await post('/api/me/password', { current: cur.value, next: n1.value }); toast(r.sessionsEnded ? `Пароль изменён, завершено сессий: ${r.sessionsEnded}` : 'Пароль изменён', 'success'); cur.value = n1.value = n2.value = ''; load(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Сменить пароль')));
    return h('div', { class: 'stack' }, pw, twoFaCard());
  }

  function sessionsCard(me) {
    const others = me.sessions.filter((s) => !s.current);
    return h('section', { class: 'card stack' }, h('div', { class: 'card-head', style: { margin: 0 } }, h('h3', null, 'Активные сессии'),
      others.length ? h('button', { class: 'btn sm', onclick: async () => { if (await confirmDialog({ title: 'Завершить остальные сессии?', message: `На ${others.length} устройствах придётся войти заново.`, danger: true, confirmText: 'Завершить' })) { try { await post('/api/me/sessions/revoke-others'); toast('Остальные сессии завершены', 'success'); load(); } catch (e) { toast(e.message, 'error'); } } } }, 'Завершить остальные') : null),
      h('div', { class: 'list' }, me.sessions.map((s) => h('div', { class: 'list-item' },
        h('div', { class: 'inline' }, icon(/Android|iPhone|iPad/.test(s.ua ?? '') ? 'menu' : 'terminal', 18), h('div', null, h('b', null, uaLabel(s.ua)), s.current ? h('span', { class: 'badge ok ml' }, 'Это устройство') : null,
          h('div', { class: 'muted small' }, `${s.ip ?? '—'} · вход ${relTime(s.createdAt)} · активность ${relTime(s.lastUsed ?? s.createdAt)}`))),
        s.current ? null : h('button', { class: 'btn sm ghost danger-text', onclick: async () => { try { await del(`/api/me/sessions/${s.sid}`); toast('Сессия завершена', 'success'); load(); } catch (e) { toast(e.message, 'error'); } } }, 'Завершить')))));
  }

  const prefs = () => h('div', { class: 'stack' }, languageCard(), themeCard());
  const activityCard = (me) => h('section', { class: 'card stack' }, h('h3', null, 'Мои последние действия'),
    me.activity.length ? h('div', { class: 'list' }, me.activity.map((a) => h('div', { class: 'list-item' }, h('div', null, h('b', null, actionLabel(a.action)),
      h('div', { class: 'muted small' }, [a.panelName, a.target].filter(Boolean).join(' · ') || ' ')), h('div', { class: 'inline' }, a.ok ? null : h('span', { class: 'badge err' }, 'ошибка'), h('span', { class: 'muted small' }, relTime(a.ts)))))) : h('p', { class: 'muted' }, 'Пока нет действий.'));

  load();
  return h('div', { class: 'page' }, pageHead('Профиль'), box);
}

/* ============================== ПОЛЬЗОВАТЕЛИ ============================== */
const filters = { q: '', role: 'all', status: 'all' };
export function usersPage() {
  if (!can('admin')) return h('div', { class: 'page' }, empty('Нет доступа', 'Управление пользователями доступно администратору.'));
  let users = [];
  const table = h('div');
  const count = h('span', { class: 'muted' });
  const load = () => get('/api/users').then((list) => { users = list; draw(); }).catch((e) => clear(table).append(h('div', { class: 'callout err' }, icon('alert'), e.message)));

  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg, 'success'); load(); } catch (e) { toast(e.message, 'error'); } };
  function draw() {
    const q = filters.q.trim().toLowerCase();
    const rows = users.filter((u) => (filters.role === 'all' || u.role === filters.role) && (filters.status === 'all' || (filters.status === 'off') === u.disabled)
      && (!q || [u.username, u.displayName, u.email].some((x) => x && x.toLowerCase().includes(q))));
    count.textContent = `${rows.length} из ${users.length}`;
    clear(table).append(rows.length ? h('div', { class: 'card flush' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['Пользователь', 'Роль', 'Вход', 'Доступ', 'Последний вход', 'Статус', ''].map((x, i) => h('th', { class: i === 3 || i === 4 ? 'hide-sm' : '' }, x)))),
      h('tbody', null, rows.map((u) => {
        const me = u.id === store.user.id;
        return h('tr', { class: `row ${u.disabled ? 'dim' : ''}`, onclick: () => userForm(u) },
          h('td', null, h('div', { class: 'inline' }, avatar(u), h('div', null, h('b', null, u.displayName || u.username, me ? h('span', { class: 'badge muted ml' }, 'это вы') : null), h('div', { class: 'muted small' }, `@${u.username}${u.email ? ` · ${u.email}` : ''}`)))),
          h('td', null, roleBadge(u.role)),
          h('td', null, h('div', { class: 'inline' }, u.hasPassword ? h('span', { class: 'chip' }, 'Пароль') : null, u.sso ? h('span', { class: 'chip' }, 'SSO') : null, u.totp ? h('span', { class: 'badge ok' }, '2FA') : null)),
          h('td', { class: 'hide-sm small', title: accessText(u) }, u.panels.length ? h('span', null, `${u.panels.length} `, u.panels.length === 1 ? panelChip(panelById(u.panels[0]) ?? { name: `#${u.panels[0]}`, color: '#64748b' }) : 'панел(ей)') : h('span', { class: 'muted' }, 'Все панели')),
          h('td', { class: 'hide-sm small' }, u.lastLogin ? h('span', { title: fmtTime(u.lastLogin) }, relTime(u.lastLogin)) : h('span', { class: 'muted' }, 'никогда'), u.sessions ? h('div', { class: 'muted small' }, `сессий: ${u.sessions}`) : null),
          h('td', null, u.disabled ? h('span', { class: 'badge err' }, 'Отключён') : h('span', { class: 'badge ok' }, 'Активен')),
          h('td', { class: 'w-actions' }, h('div', { class: 'inline', onclick: (e) => e.stopPropagation() },
            h('button', { class: 'btn icon ghost sm', title: 'Изменить', onclick: () => userForm(u) }, icon('edit', 15)),
            me ? null : h('button', { class: 'btn icon ghost sm', title: u.disabled ? 'Включить учётную запись' : 'Отключить учётную запись', onclick: () => act(() => put(`/api/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Учётная запись включена' : 'Учётная запись отключена') }, icon(u.disabled ? 'play' : 'stop', 15)),
            !u.sessions || me ? null : h('button', { class: 'btn icon ghost sm', title: 'Завершить все сессии', onclick: () => act(() => post(`/api/users/${u.id}/revoke-sessions`), 'Сессии завершены') }, icon('logout', 15)),
            me ? null : h('button', { class: 'btn icon ghost sm danger-text', title: 'Удалить', onclick: async () => { if (await confirmDialog({ title: 'Удалить пользователя?', message: `${u.displayName || u.username} (@${u.username}) будет удалён вместе с сессиями.`, danger: true, confirmText: 'Удалить', typeToConfirm: u.username })) act(() => del(`/api/users/${u.id}`), 'Пользователь удалён'); } }, icon('trash', 15)))));
      })))) : empty('Пользователи не найдены', 'Измените фильтры или добавьте нового пользователя.'));
  }

  const q = h('input', { class: 'input search', placeholder: 'Поиск: логин, имя, email…', oninput: () => { filters.q = q.value; draw(); } });
  q.value = filters.q;
  const sel = (key, opts) => h('select', { class: 'input', onchange: (e) => { filters[key] = e.target.value; draw(); } }, opts.map(([v, l]) => h('option', { value: v, selected: filters[key] === v }, l)));
  load();
  return h('div', { class: 'page' }, pageHead('Пользователи', count, h('button', { class: 'btn primary', onclick: () => userForm() }, icon('plus', 15), 'Добавить пользователя')),
    h('div', { class: 'filters' }, h('div', { class: 'input-icon' }, icon('search', 15), q), sel('role', [['all', 'Все роли'], ['admin', 'Администраторы'], ['operator', 'Операторы'], ['viewer', 'Только чтение']]), sel('status', [['all', 'Любой статус'], ['on', 'Активные'], ['off', 'Отключённые']])), table);

  /** Создание и редактирование пользователя. */
  function userForm(u) {
    const edit = !!u, self = edit && u.id === store.user.id;
    const un = h('input', { class: 'input', value: u?.username ?? '', autocomplete: 'off' }), dn = h('input', { class: 'input', value: u?.displayName ?? '', placeholder: 'необязательно' });
    const em = h('input', { class: 'input', type: 'email', value: u?.email ?? '', placeholder: 'name@example.com' });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: edit ? 'оставьте пустым, чтобы не менять' : '' });
    const role = h('select', { class: 'input', disabled: self }, ['viewer', 'operator', 'admin'].map((v) => h('option', { value: v, selected: (u?.role ?? 'viewer') === v }, ROLE_HELP[v])));
    const boxes = store.panels.map((p) => ({ p, cb: h('input', { type: 'checkbox', checked: u?.panels.includes(p.id) }) }));
    const reset = h('input', { type: 'checkbox' }), off = h('input', { type: 'checkbox', checked: u?.disabled, disabled: self });
    const body = h('div', { class: 'stack' },
      edit ? h('div', { class: 'inline' }, avatar(u, 44), h('div', { class: 'muted small' }, `Создан ${fmtTime(u.createdAt)}`, u.lastLogin ? ` · вход ${relTime(u.lastLogin)}` : ' · ещё не входил', ` · сессий: ${u.sessions}`, u.sso ? ' · вход через SSO' : '')) : null,
      h('div', { class: 'grid-2' }, field('Логин', un), field('Имя', dn)), field('Email', em), field(edit ? 'Новый пароль' : 'Пароль', pw, edit ? 'При смене пароля все сессии пользователя завершатся' : 'Минимум 8 символов'),
      field('Роль', role, self ? 'Свою роль изменить нельзя' : null),
      h('div', null, h('div', { class: 'field-label' }, 'Доступные панели (ничего не отмечено = все)'), h('div', { class: 'checklist' }, boxes.length ? boxes.map(({ p, cb }) => h('label', null, cb, panelChip(p))) : h('div', { class: 'muted pad' }, 'Панелей пока нет'))),
      edit && u.totp ? h('label', { class: 'check' }, reset, 'Сбросить 2FA (пользователь потерял устройство)') : null,
      edit && !self ? h('label', { class: 'check' }, off, 'Учётная запись отключена (вход закрыт, сессии завершены)') : null);
    modal({ title: edit ? `Пользователь · ${u.displayName || u.username}` : 'Новый пользователь', wide: true, body, actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Сохранить', kind: 'primary', onClick: async () => {
      const panels = boxes.filter((b) => b.cb.checked).map((b) => b.p.id);
      if (edit) await put(`/api/users/${u.id}`, { username: un.value.trim(), displayName: dn.value, email: em.value, role: self ? undefined : role.value, panels, password: pw.value || undefined, resetTotp: reset.checked || undefined, disabled: self ? undefined : off.checked });
      else await post('/api/users', { username: un.value.trim(), displayName: dn.value, email: em.value, password: pw.value, role: role.value, panels });
      toast(edit ? 'Изменения сохранены' : 'Пользователь создан', 'success'); load();
    } }] });
  }
}
