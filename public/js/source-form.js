import { get } from './api.js';
import { field, h, icon, toast } from './dom.js';

/** Источники приложения Easypanel и способы сборки — общие для создания сервиса и вкладки «Источник». */
export const SOURCES = [
  ['image', 'Docker-образ', 'Готовый образ из Docker Hub или своего реестра'],
  ['github', 'GitHub', 'Репозиторий GitHub (владелец/репозиторий), сборка на панели'],
  ['git', 'Git', 'Любой Git-репозиторий по адресу (https или ssh)'],
  ['dockerfile', 'Dockerfile', 'Dockerfile, вставленный прямо в панель'],
];
export const BUILDS = [
  ['nixpacks', 'Nixpacks', 'Автоопределение языка и сборка без Dockerfile'],
  ['dockerfile', 'Dockerfile', 'Собрать по Dockerfile из репозитория'],
  ['heroku_buildpacks', 'Heroku Buildpacks', 'Сборка через Heroku buildpacks'],
  ['paketo_buildpacks', 'Paketo Buildpacks', 'Сборка через Paketo buildpacks'],
];

const NOFILL = { autocomplete: 'off', 'data-bwignore': 'true', 'data-lpignore': 'true', 'data-1p-ignore': 'true' }; // не даём менеджерам паролей рисовать значки поверх поля
const secret = (placeholder) => h('input', { class: 'input', type: 'password', placeholder, ...NOFILL });
/** Сворачиваемый блок необязательных полей (открыт, если что-то уже задано). */
const more = (title, open, ...children) => h('details', { class: 'more', open }, h('summary', null, title), h('div', { class: 'stack' }, ...children));
const inp = (ph, v, cls = 'input') => h('input', { class: cls, placeholder: ph, value: v ?? '', autocomplete: 'off' });

/** Разбор адреса репозитория с учётными данными: https://user:token@host/path → { url, user, token }. */
export function splitRepoUrl(repo = '') {
  const m = /^(https?:\/\/)([^\s/@]+)@(.+)$/i.exec(String(repo));
  if (!m) return { url: String(repo), user: '', token: '' };
  const [user, ...rest] = m[2].split(':');
  const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
  return { url: `${m[1]}${m[3]}`, user: dec(user), token: dec(rest.join(':')) };
}
/** Встраивает токен в https-адрес (для приватных репозиториев). */
export function joinRepoUrl(url, user, token) {
  if (!token) return url;
  const m = /^(https?:\/\/)(.+)$/i.exec(url);
  if (!m) throw new Error('Токен применим только к адресам https://…; для ssh-адреса используйте deploy-ключ панели');
  return `${m[1]}${encodeURIComponent(user || 'x-access-token')}:${encodeURIComponent(token)}@${m[2]}`;
}

/** «владелец/репозиторий@ветка» для отображения (адрес без токена). */
export function repoLabel(src = {}) {
  const ref = src.ref ?? src.branch ?? '';
  if (src.owner) return `${src.owner}/${src.repo}@${ref}`;
  const { url } = splitRepoUrl(src.repo);
  const parts = url.replace(/\.git$/i, '').split(/[/:]/).filter(Boolean);
  return `${parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : url}@${ref}`;
}

/** Определяет активный тип источника по данным панели. */
export function sourceKind(src = {}) {
  if (['image', 'github', 'git', 'dockerfile'].includes(src.type)) return src.type;
  if (src.dockerfile) return 'dockerfile';
  if (src.image) return 'image';
  if (src.owner) return 'github';
  return src.repo ? 'git' : 'image';
}

/** Поля одного источника: возвращает { els, get() } — get() отдаёт объект для API. */
export function sourceFields(kind, src = {}, build = {}, { panelId } = {}) {
  const same = sourceKind(src) === kind;
  const v = (k) => (same ? src[k] : '');
  if (kind === 'image') {
    const image = inp('nginx:latest', v('image'), 'input mono'), user = inp('логин реестра', v('username')), pass = secret('пароль / токен');
    return { els: [field('Образ', image), more('Приватный реестр', !!v('username'), h('div', { class: 'grid-2' }, field('Пользователь', user), field('Пароль или токен', pass)))],
      get: () => ({ type: 'image', image: image.value.trim(), username: user.value.trim() || undefined, password: user.value.trim() ? pass.value : undefined }),
      check: () => (image.value.trim() ? null : 'Укажите образ') };
  }
  if (kind === 'github' || kind === 'git') {
    const gh = kind === 'github';
    const cred = !gh && same ? splitRepoUrl(src.repo) : { url: v('repo'), user: '', token: '' };
    const owner = inp('owner', v('owner')), repo = inp(gh ? 'repo' : 'https://github.com/owner/repo.git  или  git@github.com:owner/repo.git', gh ? v('repo') : cred.url, gh ? 'input' : 'input mono');
    const tokUser = inp('x-access-token', cred.user), tok = secret(cred.token ? '•••••• сохранён — оставьте пустым, чтобы не менять' : 'токен доступа');
    const ref = inp('main', v('ref') || v('branch')), path = inp('/', v('path'));
    const bt = h('select', { class: 'input', onchange: syncBuild }, BUILDS.map(([id, label]) => h('option', { value: id, selected: (build?.type ?? 'nixpacks') === id }, label)));
    const file = inp('Dockerfile', build?.file, 'input mono');
    const fFile = field('Файл Dockerfile', file);
    // deploy-ключ панели: для ssh-адресов (git@…) — показываем публичный ключ, который нужно добавить в репозиторий
    const keyBox = h('div', { class: 'stack-sm', hidden: true });
    const isSsh = () => !gh && /^(git@|ssh:\/\/)/i.test(repo.value.trim());
    const showKey = async () => {
      keyBox.replaceChildren(h('span', { class: 'muted small' }, 'Запрашиваем ключ у панели…'));
      try {
        const id = typeof panelId === 'function' ? panelId() : panelId;
        const r = await get(`/api/panels/${id}/ssh-key`);
        keyBox.replaceChildren(h('div', { class: 'muted small' }, 'Публичный SSH-ключ панели — добавьте его в GitHub → репозиторий → Settings → Deploy keys:'),
          h('textarea', { class: 'input mono', rows: 3, readonly: true, onclick: (e) => e.target.select() }, r.key),
          h('button', { type: 'button', class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(r.key); toast('Ключ скопирован', 'success'); } catch { toast('Выделите ключ и скопируйте вручную', 'error'); } } }, icon('copy', 13), 'Копировать'));
      } catch (e) { keyBox.replaceChildren(h('div', { class: 'callout warn compact' }, icon('alert', 14), e.message)); }
    };
    const syncKey = () => {
      const ssh = isSsh(); tokenRow.hidden = ssh; keyBtn.hidden = !ssh || !panelId; if (ssh) priv.open = true;
      if (!ssh) { keyBox.hidden = true; keyBox.replaceChildren(); }
    };
    const keyBtn = h('button', { type: 'button', class: 'btn sm', hidden: true, onclick: () => { keyBox.hidden = false; showKey(); } }, icon('key', 13), 'Показать SSH-ключ панели (deploy key)');
    const tokenRow = h('div', { class: 'stack' }, h('div', { class: 'grid-2' }, field('Deploy-токен', tok), field('Пользователь токена', tokUser)), h('p', { class: 'hint' }, 'Для приватных https-репозиториев: GitHub PAT, deploy token GitLab или Bitbucket.'));
    const priv = more('Приватный репозиторий', !!cred.token, tokenRow, keyBtn, keyBox);
    repo.addEventListener('input', syncKey);
    function syncBuild() { fFile.hidden = bt.value !== 'dockerfile'; }
    syncBuild(); syncKey();
    return { els: [...(gh ? [h('div', { class: 'grid-2' }, field('Владелец', owner), field('Репозиторий', repo))] : [field('Адрес репозитория', repo)]),
      h('div', { class: 'grid-2' }, field('Ветка', ref), field('Путь сборки', path)), h('div', { class: 'grid-2' }, field('Способ сборки', bt), fFile), ...(gh ? [] : [priv])],
    get: () => ({ type: kind, owner: gh ? owner.value.trim() : undefined, repo: gh ? repo.value.trim() : joinRepoUrl(repo.value.trim(), tokUser.value.trim() || cred.user, tok.value || (repo.value.trim() === cred.url ? cred.token : '')), ref: ref.value.trim() || undefined, path: path.value.trim() || undefined, build: { type: bt.value, file: bt.value === 'dockerfile' ? file.value.trim() || 'Dockerfile' : undefined } }),
    check: () => (gh ? (owner.value.trim() && repo.value.trim() ? null : 'Укажите владельца и репозиторий') : (repo.value.trim() ? null : 'Укажите адрес репозитория')) };
  }
  const df = h('textarea', { class: 'input mono', rows: 10, spellcheck: 'false', placeholder: 'FROM node:22-alpine\nWORKDIR /app\n…' }, v('dockerfile'));
  return { els: [field('Содержимое Dockerfile', df)], get: () => ({ type: 'dockerfile', dockerfile: df.value }), check: () => (df.value.trim() ? null : 'Укажите содержимое Dockerfile') };
}

/** Выбор источника с переключателем — для диалога создания сервиса (первый вариант — «Позже», источник необязателен). */
export function sourcePicker(panelId) {
  const box = h('div', { class: 'stack' });
  const desc = h('div', { class: 'muted small' });
  const opts = [['none', 'Позже', 'Источник можно задать после создания — на вкладке «Источник»'], ...SOURCES];
  let kind = 'none', cur = null;
  const seg = h('div', { class: 'seg' });
  const draw = () => {
    seg.replaceChildren(...opts.map(([id, label]) => h('button', { type: 'button', class: `seg-btn ${id === kind ? 'active' : ''}`, onclick: () => { kind = id; cur = id === 'none' ? null : sourceFields(id, {}, {}, { panelId }); draw(); } }, label)));
    desc.textContent = opts.find(([id]) => id === kind)[2];
    box.replaceChildren(seg, desc, ...(cur?.els ?? []));
  };
  draw();
  return { el: box, get: () => cur?.get(), check: () => cur?.check() ?? null };
}
