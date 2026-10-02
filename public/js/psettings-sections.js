import { del, get, post, put } from './api.js';
import { clear, confirmDialog, field, fmtTime, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';
import { settingsGroup } from './psettings-forms.js';
import { logosCard, notifyCard } from './psettings-extras.js';

/* Разделы настроек панели Easypanel. Каждая функция получает панель p, общий entry (счётчик несохранённых форм) и go(section). */
const skeleton = () => h('div', { class: 'skeleton', style: { height: '120px' } });
const errBox = (e) => h('div', { class: 'callout err' }, icon('alert'), h('div', null, e.message ?? String(e)));
const kv = (label, value) => h('div', { class: 'kv' }, h('span', null, label), h('b', null, value ?? '—'));
const badge = (text, cls = '') => h('span', { class: `badge ${cls}` }, text);
const card = (title, hint, ...body) => h('div', { class: 'card psf' }, h('div', { class: 'card-head' }, h('h4', null, title)), hint ? h('p', { class: 'muted small psf-hint' }, hint) : null, ...body);
const copyText = async (text) => { try { await navigator.clipboard.writeText(text); toast(t('Скопировано'), 'success'); } catch { toast(t('Выделите текст и скопируйте вручную'), 'error'); } };

/** Заполняет контейнер результатом асинхронной функции; ошибка показывается в нём же. */
function lazy(box, fn) {
  clear(box).append(skeleton());
  fn().then((nodes) => clear(box).append(...[nodes].flat()), (e) => clear(box).append(errBox(e)));
  return box;
}

async function runSystem(p, op, { title, message, danger = false, typed = false, done }) {
  if (!await confirmDialog({ title, message: `${message} ${t('Панель')}: «${p.name}».`, danger, confirmText: 'Выполнить', typeToConfirm: typed ? p.name : undefined })) return false;
  try { await post(`/api/panels/${p.id}/system`, { op }); toast(`${t(title)}: ${t('готово')}`, 'success'); done?.(); return true; } catch (e) { toast(e.message, 'error', 8000); return false; }
}

/* ---------- Лицензия ---------- */
function licenseModal(p, entry) {
  const mode = h('select', { class: 'input' }, [['lemon', 'Ключ Lemon Squeezy'], ['order', 'По номеру заказа'], ['portal', 'Portal-лицензия']].map(([v, l]) => h('option', { value: v }, t(l))));
  const key = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX', spellcheck: 'false', 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
  const ident = h('input', { class: 'input', placeholder: 'you@example.com', autocomplete: 'off' });
  const order = h('input', { class: 'input mono', placeholder: '123456', autocomplete: 'off' });
  const panes = { lemon: h('div', { class: 'stack' }, field('Лицензионный ключ', key, 'Ключ передаётся панели и в EasyAdmin не сохраняется, в журнал не попадает.')),
    order: h('div', { class: 'stack' }, field('E-mail или идентификатор заказа', ident), field('Номер заказа', order)),
    portal: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Панель сама запросит Portal-лицензию для этого сервера. Подойдёт, если лицензия куплена на портале Easypanel и привязана к серверу.')) };
  const pane = h('div'); const draw = () => clear(pane).append(panes[mode.value]); mode.addEventListener('change', draw); draw();
  modal({ title: 'Активация лицензии', body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, `${t('Панель')}: «${p.name}». ${t('Лицензия покупается на сайте Easypanel.')}`), field('Способ', mode), pane),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Активировать', kind: 'primary', onClick: async () => {
      if (mode.value === 'lemon') await post(`/api/panels/${p.id}/plicense/lemon`, { licenseKey: key.value.trim() });
      else if (mode.value === 'order') await post(`/api/panels/${p.id}/plicense/order`, { identifier: ident.value.trim(), orderId: order.value.trim() });
      else await post(`/api/panels/${p.id}/plicense/portal`);
      toast(t('Лицензия активирована'), 'success'); await entry.reloadLicense();
    } }] });
}
function licenseCard(p, entry) {
  const l = entry.license; if (!l) return null;
  const tier = l.tier === 'portal' ? `Portal${l.portal?.plan ? ` · ${l.portal.plan}` : ''}` : l.tier === 'lemon' ? `Lemon Squeezy${l.lemon?.productId ? ` · ${t('продукт')} ${l.lemon.productId}` : ''}` : t('Бесплатный тариф');
  const off = (kind) => async () => { if (await confirmDialog({ title: 'Деактивировать лицензию?', message: 'Платные функции панели перестанут работать. Данные сохранятся.', danger: true, confirmText: 'Деактивировать', typeToConfirm: p.name })) { try { await del(`/api/panels/${p.id}/plicense/${kind}`); toast(t('Лицензия деактивирована'), 'success'); await entry.reloadLicense(); } catch (e) { toast(e.message, 'error'); } } };
  return card('Лицензия Easypanel', 'Платные функции панели открываются лицензией. Закрытые настройки в EasyAdmin неактивны и помечены замком.',
    kv('Тариф', h('span', null, tier, ' ', l.tier === 'free' ? badge('ограничения', 'warn') : badge('активна', 'ok'))),
    l.known ? null : h('div', { class: 'callout compact' }, icon('activity', 14), h('span', { class: 'small' }, 'Панель не отдаёт сведения о лицензии (старая версия) — ограничения в EasyAdmin не применяются.')),
    h('div', { class: 'list' }, Object.entries(l.featureLabels ?? {}).map(([k, label]) => h('div', { class: 'list-item' }, h('span', null, label), l.features[k] ? badge('доступно', 'ok') : h('span', { class: 'badge warn' }, icon('key', 11), t('нужна лицензия'))))),
    h('div', { class: 'inline psf-foot' }, h('button', { class: 'btn sm primary', onclick: () => licenseModal(p, entry) }, icon('key', 13), 'Активировать лицензию'),
      l.lemon ? h('button', { class: 'btn sm ghost', onclick: off('lemon') }, 'Деактивировать Lemon') : null, l.portal ? h('button', { class: 'btn sm ghost', onclick: off('portal') }, 'Деактивировать Portal') : null));
}

/* ---------- Обзор ---------- */
export function overview(p, entry, go) {
  const box = h('div', { class: 'stack' });
  const draw = () => lazy(box, async () => {
    const s = await get(`/api/panels/${p.id}/pstatus`);
    const n = (v) => (v == null ? '—' : String(v));
    const update = () => runSystem(p, 'updatePanel', { title: 'Обновить Easypanel', message: 'Панель скачает свежий образ и перезапустится, на несколько минут станет недоступна. Сервисы продолжают работать.', danger: true, typed: true, done: () => setTimeout(draw, 5000) });
    return [
      s.updateAvailable ? h('div', { class: 'callout warn' }, icon('alert'), h('div', null, h('b', null, 'Доступно обновление Easypanel'), h('p', null, 'Новая версия готова к установке.'),
        h('div', { class: 'inline' }, h('button', { class: 'btn sm primary', onclick: update }, icon('rocket', 13), 'Обновить Easypanel'), h('button', { class: 'btn sm ghost', onclick: () => go('system') }, 'Подробнее')))) : null,
      s.dockerUpdate?.available ? h('div', { class: 'callout compact' }, icon('activity', 14), h('span', { class: 'small' }, `${t('Доступна новая версия Docker')}: ${s.dockerUpdate.latest}`), h('span', { class: 'spacer' }), h('button', { class: 'btn sm danger', onclick: () => dockerFromOverview(p, s, draw) }, icon('rotate', 13), 'Обновить Docker')) : null,
      card('Состояние панели', null,
        kv('Версия Easypanel', s.version ? h('span', null, s.version, ' ', s.releaseTag ? badge(s.releaseTag) : null, ' ', s.updateAvailable ? badge('есть обновление', 'warn') : badge('актуальная', 'ok')) : '—'),
        kv('Версия Docker', s.dockerVersion ? h('span', null, s.dockerVersion, ' ', s.dockerUpdate?.available ? badge(`→ ${s.dockerUpdate.latest}`, 'warn') : null) : '—'),
        kv('IP-адрес сервера', s.serverIp), kv('Пользователи Easypanel', n(s.users)), kv('Билдеры Docker', n(s.builders)), kv('Узлы кластера', n(s.nodes)), kv('Сертификаты', n(s.certificates))),
      licenseCard(p, entry),
      card('Быстрые переходы', null, h('div', { class: 'chips' },
        [['address', 'Домен панели'], ['users', 'Пользователи'], ['system', 'Очистка Docker'], ['traefik', 'Traefik'], ['monitoring', 'Метрики и логи']].map(([id, l]) => h('button', { class: 'chip-btn', onclick: () => go(id) }, l)))),
    ];
  });
  return draw();
}

/* ---------- Адреса ---------- */
export function address(p, entry) {
  const box = h('div', { class: 'stack' });
  const draw = () => lazy(box, async () => {
    const [cards, st] = await Promise.all([settingsGroup(p, 'address', entry), get(`/api/panels/${p.id}/pstatus`).catch(() => ({}))]);
    return [...cards, card('Сервер', 'IP-адрес нужен для DNS-записей. Обновление перечитывает IP и пересоздаёт сгенерированный домен, сертификаты и домены сервисов.',
      kv('Публичный IP', st.serverIp), h('div', { class: 'inline psf-foot' },
        h('button', { class: 'btn sm', onclick: () => runSystem(p, 'refreshServerIp', { title: 'Обновить IP-адрес сервера', message: 'Пересоздаст сгенерированный домен, сертификаты и домены сервисов.', danger: true, typed: true, done: draw }) }, icon('refresh', 13), 'Обновить IP'),
        h('a', { class: 'btn sm ghost', href: '#/inventory' }, icon('shield', 13), 'Сертификаты')))];
  });
  return draw();
}

/* ---------- Обновления и Docker ---------- */
function builderModal(p, reload) {
  const name = h('input', { class: 'input mono', placeholder: 'builder-1', autocomplete: 'off' });
  const cpus = h('input', { class: 'input', type: 'number', value: 2, min: 1, max: 128 });
  const mem = h('input', { class: 'input', type: 'number', value: 2048, min: 256 });
  const swap = h('input', { class: 'input', type: 'number', value: 4096, min: 256 });
  modal({ title: 'Новый билдер Docker', body: h('div', { class: 'stack' }, field('Имя', name, 'Латиница, цифры, - _ .'), h('div', { class: 'grid-2' }, field('CPU', cpus), field('Память, МБ', mem)), field('Swap, МБ', swap, 'Не меньше памяти.'), h('p', { class: 'muted small' }, 'Создаётся и сразу выбирается для следующих сборок.')),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Создать', kind: 'primary', onClick: async () => { await post(`/api/panels/${p.id}/pbuilders`, { op: 'create', name: name.value.trim(), cpus: Number(cpus.value), memory: Number(mem.value), memorySwap: Number(swap.value) }); toast(t('Билдер создан'), 'success'); reload(); } }] });
}
/** Ход обновления Docker: журнал юнита на хосте и версия Docker. Во время перезапуска Docker панель недоступна — это нормально, ждём. */
function dockerProgress(p, from, to, reload) {
  const status = h('div', { class: 'small muted' }, 'Обновление запущено…');
  const logEl = h('pre', { class: 'code', style: { maxHeight: '260px' } }, '');
  let stop = false; let timer = null; let tries = 0; let idle = 0;
  const poll = async () => {
    if (stop) return; tries++;
    try {
      const st = await get(`/api/panels/${p.id}/pstatus`);
      if (st.dockerVersion && st.dockerVersion === to) { status.textContent = `✓ ${t('Готово: Docker обновлён до')} ${to}`; status.className = 'small ok-text'; reload(); return; }
      const r = await get(`/api/panels/${p.id}/pdocker/log`);
      logEl.textContent = r.log || '';
      idle = r.state === 'active' ? 0 : idle + 1;
      if (idle >= 3) { status.textContent = `${t('Обновление не применилось: версия Docker осталась')} ${st.dockerVersion ?? '—'}. ${t('Причина — в журнале ниже.')}`; status.className = 'small danger-text'; reload(); return; } // юнит завершился, а версия прежняя
      status.textContent = r.state === 'active' ? t('Идёт установка…') : t('Юнит обновления завершён — проверяем версию…'); status.className = 'small muted';
    } catch { status.textContent = t('Панель недоступна — идёт перезапуск Docker, ждём…'); status.className = 'small warn-text'; }
    if (tries < 120) timer = setTimeout(poll, 5000); else { status.textContent = t('Не дождались завершения. Проверьте сервер вручную: journalctl -u docker-upgrade-ea'); status.className = 'small danger-text'; }
  };
  modal({ title: `Docker ${from ?? ''} → ${to}`, wide: true, body: h('div', { class: 'stack' }, h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, 'Обновление идёт отдельным процессом на сервере и продолжится, даже если связь с панелью пропадёт. Сервисы перезапустятся.')), status, logEl),
    actions: [{ label: 'Закрыть', kind: 'ghost' }], onClose: () => { stop = true; clearTimeout(timer); reload(); } });
  timer = setTimeout(poll, 4000);
}
async function updateDocker(p, st, reload) {
  const to = st.dockerUpdate?.latest; const from = st.dockerVersion;
  const ok = await confirmDialog({ title: `${t('Обновить Docker')}: ${from} → ${to}`, danger: true, confirmText: 'Обновить Docker', typeToConfirm: p.name,
    message: `${t('Docker будет обновлён на самом сервере. На время обновления Docker перезапустится: ВСЕ сервисы, включая Easypanel и EasyAdmin, остановятся на несколько минут и поднимутся заново. Выполняйте это в удобное время и после резервных копий. Обновление идёт отдельным процессом на сервере (apt) и продолжится, даже если связь пропадёт.')} ${t('Панель')}: «${p.name}».` });
  if (!ok) return;
  try { const r = await post(`/api/panels/${p.id}/pdocker/update`, { confirm: p.name }); toast(t('Обновление Docker запущено'), 'success'); dockerProgress(p, r.from, r.to, reload); } catch (e) { toast(e.message, 'error', 9000); }
}
/** Кнопка в «Обзоре»: сначала проверка системы сервера, затем обычное подтверждение и запуск. */
async function dockerFromOverview(p, st, reload) {
  try {
    const c = await get(`/api/panels/${p.id}/pdocker/check`);
    if (!c.supported) return toast(c.reason || t('Обновление Docker на этом сервере недоступно'), 'error', 9000);
  } catch (e) { return toast(e.message, 'error', 9000); }
  updateDocker(p, st, reload);
}
export function system(p, entry, go) {
  const box = h('div', { class: 'stack' });
  const draw = () => lazy(box, async () => {
    const [st, bl] = await Promise.all([get(`/api/panels/${p.id}/pstatus`), get(`/api/panels/${p.id}/pbuilders`).catch(() => ({ builders: [] }))]);
    // кнопка «Обновить Docker» активируется после проверки системы сервера (apt/dnf/yum, systemd, docker-ce)
    const dockerNote = h('div');
    const dockerBtn = h('button', { class: `btn sm ${st.dockerUpdate?.available ? 'danger' : ''}`, disabled: true, title: st.dockerUpdate?.available ? '' : 'Docker актуален', onclick: () => updateDocker(p, st, draw) }, icon('rotate', 13), 'Обновить Docker');
    if (st.dockerUpdate?.available) {
      clear(dockerNote).append(h('div', { class: 'muted small' }, 'Проверяем систему сервера…'));
      get(`/api/panels/${p.id}/pdocker/check`).then((c) => {
        dockerBtn.disabled = !c.supported;
        clear(dockerNote).append(c.supported ? h('div', { class: 'small ok-text' }, `✓ ${t('Система поддерживается')}: ${c.os} · ${c.packageManager}`) : h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, `${t('Обновить Docker отсюда нельзя')}: ${t(c.reason)}`)));
      }, (e) => clear(dockerNote).append(h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, `${t('Не удалось проверить систему сервера')}: ${e.message}`))));
    }
    const act = (label, desc, op, o = {}) => h('div', { class: 'list-item' }, h('div', null, h('b', null, label), h('div', { class: 'muted small' }, desc)),
      h('button', { class: `btn sm ${o.danger ? 'danger' : ''}`, onclick: () => runSystem(p, op, { title: label, message: desc, ...o, done: draw }) }, o.icon ?? 'Выполнить'));
    return [
      card('Обновления', 'Обновление скачивает свежий образ Easypanel и перезапускает панель — она будет недоступна несколько минут. Сервисы продолжают работать.',
        kv('Версия Easypanel', st.version ? h('span', null, st.version, ' ', st.updateAvailable ? badge('есть обновление', 'warn') : badge('актуальная', 'ok')) : '—'),
        kv('Версия Docker', st.dockerVersion ? h('span', null, st.dockerVersion, ' ', st.dockerUpdate?.available ? badge(`доступна ${st.dockerUpdate.latest}`, 'warn') : badge('актуальная', 'ok')) : '—'),
        st.dockerUpdate?.available ? h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, 'Обновление Docker перезапускает Docker: все сервисы, включая Easypanel и EasyAdmin, остановятся на несколько минут. Работает на Ubuntu и Debian (apt) с Docker из репозитория Docker.')) : null,
        dockerNote,
        h('div', { class: 'inline psf-foot' }, h('button', { class: 'btn sm', onclick: draw }, icon('refresh', 13), 'Проверить снова'),
          dockerBtn,
          h('button', { class: `btn sm ${st.updateAvailable ? 'primary' : ''}`, onclick: () => runSystem(p, 'updatePanel', { title: 'Обновить Easypanel', message: 'Панель скачает свежий образ и перезапустится, на несколько минут станет недоступна.', danger: true, typed: true, done: () => setTimeout(draw, 4000) }) }, icon('rocket', 13), 'Обновить Easypanel'))),
      card('Очистка и перезапуск', null, h('div', { class: 'list' },
        act('Очистить образы Docker', 'Удалит неиспользуемые образы. Работающие сервисы не затрагиваются.', 'cleanupImages'),
        act('Очистить кэш сборки', 'Удалит кэш сборщика Docker — следующие сборки будут дольше.', 'cleanupBuilder'),
        act('Docker system prune', 'Удалит остановленные контейнеры, неиспользуемые сети и образы.', 'prune', { danger: true }),
        act('Перезапустить Easypanel', 'Сама панель будет недоступна пару минут.', 'restartPanel', { danger: true, typed: true }),
        act('Перезагрузить сервер', 'Сервер целиком уйдёт в перезагрузку, все сервисы остановятся.', 'reboot', { danger: true, typed: true }))),
      card('Билдеры Docker', 'Buildx-билдеры собирают образы. Лимиты создаваемого билдера защищают сервер от перегрузки при сборке.',
        h('div', { class: 'list' }, bl.builders.length ? bl.builders.map((b) => h('div', { class: 'list-item' },
          h('div', null, h('b', { class: 'mono' }, b.name), ' ', b.current ? badge('используется', 'ok') : null, b.status ? h('span', { class: 'muted small' }, ` · ${b.status}`) : null),
          h('div', { class: 'inline' },
            b.current ? null : h('button', { class: 'btn sm', onclick: async () => { try { await post(`/api/panels/${p.id}/pbuilders`, { op: 'use', name: b.name }); toast(t('Билдер выбран'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); } } }, 'Использовать'),
            h('button', { class: 'btn sm', onclick: async () => { try { await post(`/api/panels/${p.id}/pbuilders`, { op: 'stop', name: b.name }); toast(t('Билдер остановлен'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); } } }, 'Остановить'),
            b.name === 'default' ? null : h('button', { class: 'btn sm icon ghost', title: 'Удалить', 'aria-label': 'Удалить', onclick: async () => { if (await confirmDialog({ title: 'Удалить билдер?', message: `${b.name}`, danger: true, confirmText: 'Удалить' })) { try { await post(`/api/panels/${p.id}/pbuilders`, { op: 'remove', name: b.name }); draw(); } catch (e) { toast(e.message, 'error'); } } } }, icon('trash', 14))))) : [h('div', { class: 'muted pad' }, 'Билдеров нет')]),
        h('div', { class: 'inline psf-foot' }, h('button', { class: 'btn sm', onclick: () => builderModal(p, draw) }, icon('plus', 13), 'Новый билдер'))),
    ];
  });
  return draw();
}

/* ---------- Пользователи и аккаунт ---------- */
function tokenModal(token) {
  modal({ title: 'API-токен', body: h('div', { class: 'stack' }, h('div', { class: 'callout warn compact' }, icon('alert', 14), h('span', { class: 'small' }, 'Токен показывается один раз и нигде не сохраняется. Скопируйте его сейчас.')), h('pre', { class: 'code' }, token ?? '—')),
    actions: [{ label: 'Закрыть', kind: 'ghost' }, { label: 'Копировать', kind: 'primary', onClick: async () => { await copyText(token ?? ''); return false; } }] });
}
function userModal(p, u, reload) {
  const email = h('input', { class: 'input', type: 'email', placeholder: 'user@example.com', autocomplete: 'off', value: u?.email ?? '', disabled: !!u });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: u ? 'Оставьте пустым, чтобы не менять' : 'Не короче 8 символов' });
  const admin = h('input', { type: 'checkbox', checked: !!u?.admin });
  modal({ title: u ? `Пользователь · ${u.email}` : 'Новый пользователь Easypanel', body: h('div', { class: 'stack' }, field('E-mail', email), field('Пароль', pass), h('label', { class: 'check' }, admin, 'Администратор')),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: u ? 'Сохранить' : 'Создать', kind: 'primary', onClick: async () => {
      if (u) await put(`/api/panels/${p.id}/pusers/${u.id}`, { admin: admin.checked, password: pass.value || undefined, email: u.email });
      else await post(`/api/panels/${p.id}/pusers`, { email: email.value.trim(), password: pass.value, admin: admin.checked });
      toast(t('Сохранено'), 'success'); reload();
    } }] });
}
function credentialsModal(p) {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'off' });
  const old = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Не короче 8 символов' });
  modal({ title: 'Свои e-mail и пароль', body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Относится к пользователю Easypanel, от имени которого EasyAdmin работает с этой панелью. API-токен при этом не меняется.'), field('Новый e-mail', email), field('Текущий пароль', old), field('Новый пароль', nw)),
    actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Изменить', kind: 'primary', onClick: async () => { await post(`/api/panels/${p.id}/paccount/credentials`, { email: email.value.trim(), oldPassword: old.value, newPassword: nw.value }); toast(t('Данные изменены'), 'success'); } }] });
}
async function twoFactorModal(p) {
  const r = await post(`/api/panels/${p.id}/paccount/2fa`, { op: 'configure' });
  const code = h('input', { class: 'input mono', inputmode: 'numeric', maxlength: 6, placeholder: '123456', autocomplete: 'one-time-code' });
  modal({ title: 'Двухфакторная аутентификация', body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Добавьте секрет в приложение-аутентификатор и введите шестизначный код, чтобы включить защиту.'),
    r.qr ? h('img', { src: r.qr, alt: 'QR', class: 'psf-qr' }) : null, r.secret ? h('div', null, h('div', { class: 'field-label' }, 'Секрет'), h('pre', { class: 'code' }, r.secret)) : null, field('Код из приложения', code)),
  actions: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Включить', kind: 'primary', onClick: async () => { await post(`/api/panels/${p.id}/paccount/2fa`, { op: 'enable', code: code.value.trim() }); toast(t('Двухфакторная аутентификация включена'), 'success'); } }] });
}
export function users(p, entry) {
  const box = h('div', { class: 'stack' });
  const lockedUsers = entry?.license?.features?.multipleUsers === false;
  const draw = () => lazy(box, async () => {
    const r = await get(`/api/panels/${p.id}/pusers`);
    const row = (u) => h('div', { class: 'list-item' },
      h('div', { class: 'psf-user' }, h('b', null, u.email || u.id), h('div', { class: 'chips' }, u.admin ? badge('админ', 'ok') : badge('пользователь'), u.hasToken ? badge('API-токен') : null, u.twoFactor ? badge('2FA') : null, u.self ? badge('EasyAdmin', 'warn') : null)),
      h('div', { class: 'inline' },
        h('button', { class: 'btn sm icon ghost', title: 'Изменить', 'aria-label': 'Изменить', disabled: lockedUsers, onclick: () => userModal(p, u, draw) }, icon('edit', 14)),
        u.self ? null : h('button', { class: 'btn sm icon ghost', title: u.hasToken ? 'Отозвать токен' : 'Выдать API-токен', 'aria-label': 'API-токен', onclick: async () => {
          try {
            if (u.hasToken) { if (await confirmDialog({ title: 'Отозвать API-токен?', message: u.email, danger: true, confirmText: 'Отозвать' })) { await del(`/api/panels/${p.id}/pusers/${u.id}/token?email=${encodeURIComponent(u.email)}`); toast(t('Токен отозван'), 'success'); draw(); } }
            else { const x = await post(`/api/panels/${p.id}/pusers/${u.id}/token?email=${encodeURIComponent(u.email)}`); draw(); tokenModal(x.token); }
          } catch (e) { toast(e.message, 'error'); }
        } }, icon('key', 14)),
        u.self ? null : h('button', { class: 'btn sm icon ghost', title: 'Удалить', 'aria-label': 'Удалить', disabled: lockedUsers, onclick: async () => { if (await confirmDialog({ title: 'Удалить пользователя?', message: u.email, danger: true, confirmText: 'Удалить', typeToConfirm: u.email })) { try { await del(`/api/panels/${p.id}/pusers/${u.id}?email=${encodeURIComponent(u.email)}`); toast(t('Пользователь удалён'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); } } } }, icon('trash', 14))));
    return [
      lockedUsers ? h('div', { class: 'callout warn' }, icon('key'), h('div', null, h('b', null, 'Нужна лицензия'), h('p', null, 'Создание, изменение и удаление пользователей Easypanel доступно с лицензией (без неё панель молча игнорирует такие запросы). Список, API-токены и свой аккаунт работают.'))) : null,
      card('Пользователи Easypanel', 'Метка «EasyAdmin» — пользователь, от имени которого EasyAdmin работает с панелью. Его нельзя удалить и нельзя менять ему токен: доступ к панели пропадёт.',
        h('div', { class: 'list' }, r.users.length ? r.users.map(row) : [h('div', { class: 'muted pad' }, 'Пользователей нет')]),
        h('div', { class: 'inline psf-foot' }, h('button', { class: 'btn sm', disabled: lockedUsers, onclick: () => userModal(p, null, draw) }, icon('plus', 13), 'Добавить пользователя'))),
      card('Мой аккаунт', 'Свой e-mail, пароль и двухфакторная защита пользователя, от имени которого работает EasyAdmin.', h('div', { class: 'inline psf-foot' },
        h('button', { class: 'btn sm', onclick: () => credentialsModal(p) }, icon('edit', 13), 'Изменить e-mail и пароль'),
        h('button', { class: 'btn sm', onclick: () => twoFactorModal(p).catch((e) => toast(e.message, 'error')) }, icon('shield', 13), 'Настроить 2FA'),
        h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDialog({ title: 'Отключить 2FA?', message: 'Вход в панель будет защищён только паролем.', danger: true, confirmText: 'Отключить' })) { try { await post(`/api/panels/${p.id}/paccount/2fa`, { op: 'disable' }); toast(t('2FA отключена'), 'success'); } catch (e) { toast(e.message, 'error'); } } } }, 'Отключить 2FA'))),
    ];
  });
  return draw();
}

/* ---------- Traefik ---------- */
function editorCard(p, kind, title, hint, entry, { lazyLoad }) {
  const box = h('div', { class: 'card psf' });
  let initial = ''; let hist = [];
  const ta = h('textarea', { class: 'input mono psf-code', rows: 14, spellcheck: 'false' });
  const status = h('span', { class: 'small muted' });
  const saveBtn = h('button', { class: 'btn primary sm', disabled: true, onclick: () => save(ta.value) }, icon('check', 13), 'Сохранить');
  const histBox = h('div', { class: 'list' });
  let dirty = false;
  const mark = () => { const d = ta.value !== initial; saveBtn.disabled = !d; if (d !== dirty) { entry.dirty += d ? 1 : -1; dirty = d; } status.textContent = d ? t('Есть несохранённые изменения') : ''; status.className = 'small warn-text'; };
  ta.addEventListener('input', mark);
  const drawHist = () => clear(histBox).append(...(hist.length ? hist.map((x) => h('div', { class: 'list-item' }, h('div', null, fmtTime(x.ts), h('span', { class: 'muted small' }, ` · ${x.username ?? '—'}`)),
    h('button', { class: 'btn sm ghost', onclick: () => view(x) }, 'Посмотреть'))) : [h('div', { class: 'muted small' }, 'Прежние версии появятся после первой записи')]));
  async function view(x) {
    const r = await get(`/api/panels/${p.id}/ptraefik/${kind}/history/${x.id}`);
    modal({ title: `${title} · ${fmtTime(x.ts)}`, wide: true, body: h('pre', { class: 'code' }, r.content || '(пусто)'), actions: [{ label: 'Закрыть', kind: 'ghost' }, { label: 'Вернуть эту версию', kind: 'primary', onClick: async () => { ta.value = r.content; mark(); } }] });
  }
  async function save(text) {
    if (!await confirmDialog({ title: `${title}: сохранить?`, message: `Неверное содержимое может остановить маршрутизацию всех сервисов панели «${p.name}». Прежняя версия сохранится, её можно вернуть.`, danger: true, confirmText: 'Сохранить', typeToConfirm: p.name })) return;
    try { const r = await put(`/api/panels/${p.id}/ptraefik/${kind}`, { content: text }); initial = text; hist = r.history; drawHist(); mark(); status.textContent = `✓ ${t('Сохранено')}`; status.className = 'small ok-text'; toast(`${t(title)}: ${t('сохранено')}`, 'success'); } catch (e) { status.textContent = e.message; status.className = 'small danger-text'; }
  }
  const load = async () => { const r = await lazyLoad(); initial = r.text; ta.value = r.text; hist = r.history; drawHist(); mark(); dirty = false; clear(box).append(h('div', { class: 'card-head' }, h('h4', null, title), h('span', { class: 'badge warn' }, 'осторожно')), h('p', { class: 'muted small psf-hint' }, hint), ta, h('div', { class: 'inline psf-foot' }, saveBtn, h('span', { class: 'spacer' }), status), h('details', { class: 'more' }, h('summary', null, 'Прежние версии'), histBox)); mark(); };
  return { box, load };
}
export function traefik(p, entry) {
  const box = h('div', { class: 'stack' });
  return lazy(box, async () => {
    const base = await get(`/api/panels/${p.id}/ptraefik`);
    const cfg = editorCard(p, 'config', 'Конфигурация Traefik (YAML)', 'Своя конфигурация Traefik. Ошибка здесь может остановить маршрутизацию всех сервисов.', entry, { lazyLoad: async () => { const r = await get(`/api/panels/${p.id}/ptraefik`); return { text: r.config, history: r.history.config }; } });
    await cfg.load();
    const envBox = h('div', { class: 'card psf' }, h('div', { class: 'card-head' }, h('h4', null, 'Переменные окружения Traefik')), h('p', { class: 'muted small psf-hint' }, 'Файл может содержать токены (например, для DNS-проверки). Поэтому он читается только по кнопке.'),
      h('div', { class: 'inline psf-foot' }, h('button', { class: 'btn sm', onclick: async (e) => { e.currentTarget.disabled = true; try { const env = editorCard(p, 'env', 'Переменные окружения Traefik', 'Файл окружения Traefik. После изменения нужен перезапуск Traefik.', entry, { lazyLoad: async () => { const r = await get(`/api/panels/${p.id}/ptraefik?env=1`); return { text: r.env ?? '', history: r.history.env }; } }); await env.load(); envBox.replaceWith(env.box); } catch (er) { toast(er.message, 'error'); e.currentTarget.disabled = false; } } }, icon('eye', 13), 'Показать и изменить')));
    return [cfg.box, envBox, card('Перезапуск', 'Перезапуск Traefik обновляет токен дашборда, пересоздаёт конфигурацию и перезапускает Traefik — сервисы на секунды станут недоступны.',
      h('div', { class: 'inline psf-foot' }, h('button', { class: 'btn sm danger', onclick: () => runSystem(p, 'restartTraefik', { title: 'Перезапустить Traefik', message: 'Сервисы на несколько секунд станут недоступны.', danger: true, typed: true }) }, icon('rotate', 13), 'Перезапустить Traefik')))];
  });
}

/* ---------- Мониторинг ---------- */
export const monitoring = (p, entry) => lazy(h('div', { class: 'stack' }), () => settingsGroup(p, 'monitoring', entry));
export const general = (p, entry) => lazy(h('div', { class: 'stack' }), () => settingsGroup(p, 'general', entry));
export const branding = (p, entry) => lazy(h('div', { class: 'stack' }), async () => [...await settingsGroup(p, 'branding', entry), await Promise.resolve(logosCard(p, entry))]);

/* ---------- Кластер, хранилища бэкапов, каналы панели ---------- */
export function infra(p, entry) {
  const box = h('div', { class: 'stack' });
  const draw = () => lazy(box, async () => {
    const cl = await get(`/api/panels/${p.id}/pcluster`);
    const rm = (what, url, name) => async () => { if (await confirmDialog({ title: `Удалить ${what}?`, message: name, danger: true, confirmText: 'Удалить' })) { try { await del(url); toast(t('Удалено'), 'success'); draw(); } catch (e) { toast(e.message, 'error'); } } };
    return [
      cl.locked ? card('Кластер Docker Swarm', 'Узлы кластера и команда подключения нового рабочего узла (worker).', h('div', { class: 'callout warn compact' }, icon('key', 14), h('span', { class: 'small' }, 'Кластер доступен в Easypanel только с лицензией. Активировать её можно на вкладке «Обзор».'))) : card('Кластер Docker Swarm', 'Узлы кластера и команда подключения нового рабочего узла (worker).',
        cl.error ? h('div', { class: 'muted small' }, cl.error) : null,
        h('div', { class: 'list' }, cl.nodes.length ? cl.nodes.map((n) => h('div', { class: 'list-item' }, h('div', null, h('b', null, n.host || n.id), ' ', badge(n.manager ? 'manager' : (n.role ?? 'worker'), n.manager ? 'ok' : ''), n.state ? h('span', { class: 'muted small' }, ` · ${n.state}`) : null),
          n.manager ? null : h('button', { class: 'btn sm icon ghost', title: 'Удалить узел', 'aria-label': 'Удалить узел', onclick: rm('узел', `/api/panels/${p.id}/pcluster/${n.id}`, n.host || n.id) }, icon('trash', 14)))) : [h('div', { class: 'muted pad' }, 'Узлов нет')]),
        cl.workerCommand ? h('div', { class: 'stack-sm' }, h('div', { class: 'field-label' }, 'Подключение worker'), h('pre', { class: 'code' }, cl.workerCommand), h('button', { class: 'btn sm', onclick: () => copyText(cl.workerCommand) }, icon('copy', 13), 'Копировать')) : null),
      notifyCard(p, entry),
    ];
  });
  return draw();
}

/* ---------- Журнал действий панели ---------- */
export function actions(p) {
  const box = h('div', { class: 'stack' });
  const draw = () => lazy(box, async () => {
    const r = await get(`/api/panels/${p.id}/pactions?limit=30`);
    const title = (a) => a.description ?? a.title ?? a.type ?? a.id;
    const when = (a) => { const v = a.createdAt ?? a.startedAt ?? a.date; return v ? fmtTime(typeof v === 'number' ? v : Date.parse(v)) : ''; };
    const open = async (a) => { const d = await get(`/api/panels/${p.id}/pactions/${a.id}`); modal({ title: String(title(a)), wide: true, body: h('pre', { class: 'code' }, typeof (d.log ?? d.logs) === 'string' ? (d.log ?? d.logs) : JSON.stringify(d, null, 2)) }); };
    return card('Последние действия панели', 'Деплои, обновления и другие задачи, которые выполняла Easypanel.',
      h('div', { class: 'list' }, r.actions.length ? r.actions.map((a) => h('div', { class: 'list-item link', onclick: () => open(a).catch((e) => toast(e.message, 'error')) },
        h('div', null, h('b', null, String(title(a))), h('div', { class: 'muted small' }, when(a))),
        h('div', { class: 'inline' }, a.status ? badge(String(a.status), /fail|error/i.test(a.status) ? 'err' : /ok|success|done|complete/i.test(a.status) ? 'ok' : '') : null,
          /pending|running/i.test(String(a.status ?? '')) ? h('button', { class: 'btn sm ghost', onclick: async (e) => { e.stopPropagation(); if (await confirmDialog({ title: 'Остановить действие?', message: String(title(a)), danger: true, confirmText: 'Остановить' })) { try { await post(`/api/panels/${p.id}/pactions/${a.id}/kill`); draw(); } catch (er) { toast(er.message, 'error'); } } } }, 'Остановить') : null))) : [h('div', { class: 'muted pad' }, 'Действий нет')]),
      h('div', { class: 'inline psf-foot' }, h('button', { class: 'btn sm', onclick: draw }, icon('refresh', 13), 'Обновить')));
  });
  return draw();
}
