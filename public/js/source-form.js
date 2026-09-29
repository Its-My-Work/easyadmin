import { field, h } from './dom.js';

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

const inp = (ph, v, cls = 'input') => h('input', { class: cls, placeholder: ph, value: v ?? '', autocomplete: 'off' });

/** Определяет активный тип источника по данным панели. */
export function sourceKind(src = {}) {
  if (['image', 'github', 'git', 'dockerfile'].includes(src.type)) return src.type;
  if (src.dockerfile) return 'dockerfile';
  if (src.image) return 'image';
  if (src.owner) return 'github';
  return src.repo ? 'git' : 'image';
}

/** Поля одного источника: возвращает { els, get() } — get() отдаёт объект для API. */
export function sourceFields(kind, src = {}, build = {}) {
  const same = sourceKind(src) === kind;
  const v = (k) => (same ? src[k] : '');
  if (kind === 'image') {
    const image = inp('nginx:latest', v('image'), 'input mono'), user = inp('логин реестра (необязательно)', v('username')), pass = h('input', { class: 'input', type: 'password', placeholder: 'пароль / токен', autocomplete: 'new-password' });
    return { els: [field('Образ', image), h('div', { class: 'grid-2' }, field('Пользователь реестра', user), field('Пароль реестра', pass))],
      get: () => ({ type: 'image', image: image.value.trim(), username: user.value.trim() || undefined, password: user.value.trim() ? pass.value : undefined }),
      check: () => (image.value.trim() ? null : 'Укажите образ') };
  }
  if (kind === 'github' || kind === 'git') {
    const gh = kind === 'github';
    const owner = inp('owner', v('owner')), repo = inp(gh ? 'repo' : 'git@github.com:owner/repo.git', v('repo'), gh ? 'input' : 'input mono');
    const ref = inp('main', v('ref') || v('branch')), path = inp('/', v('path'));
    const bt = h('select', { class: 'input', onchange: syncBuild }, BUILDS.map(([id, label]) => h('option', { value: id, selected: (build?.type ?? 'nixpacks') === id }, label)));
    const file = inp('Dockerfile', build?.file, 'input mono');
    const fFile = field('Файл Dockerfile', file);
    function syncBuild() { fFile.hidden = bt.value !== 'dockerfile'; }
    syncBuild();
    return { els: [...(gh ? [h('div', { class: 'grid-2' }, field('Владелец', owner), field('Репозиторий', repo))] : [field('Адрес репозитория', repo)]),
      h('div', { class: 'grid-2' }, field('Ветка', ref), field('Путь сборки', path)), h('div', { class: 'grid-2' }, field('Способ сборки', bt), fFile)],
    get: () => ({ type: kind, owner: gh ? owner.value.trim() : undefined, repo: repo.value.trim(), ref: ref.value.trim() || undefined, path: path.value.trim() || undefined, build: { type: bt.value, file: bt.value === 'dockerfile' ? file.value.trim() || 'Dockerfile' : undefined } }),
    check: () => (gh ? (owner.value.trim() && repo.value.trim() ? null : 'Укажите владельца и репозиторий') : (repo.value.trim() ? null : 'Укажите адрес репозитория')) };
  }
  const df = h('textarea', { class: 'input mono', rows: 10, spellcheck: 'false', placeholder: 'FROM node:22-alpine\nWORKDIR /app\n…' }, v('dockerfile'));
  return { els: [field('Содержимое Dockerfile', df)], get: () => ({ type: 'dockerfile', dockerfile: df.value }), check: () => (df.value.trim() ? null : 'Укажите содержимое Dockerfile') };
}

/** Выбор источника с переключателем — для диалога создания сервиса (первый вариант — «Позже», источник необязателен). */
export function sourcePicker() {
  const box = h('div', { class: 'stack' });
  const desc = h('div', { class: 'muted small' });
  const opts = [['none', 'Позже', 'Источник можно задать после создания — на вкладке «Источник»'], ...SOURCES];
  let kind = 'none', cur = null;
  const seg = h('div', { class: 'seg' });
  const draw = () => {
    seg.replaceChildren(...opts.map(([id, label]) => h('button', { type: 'button', class: `seg-btn ${id === kind ? 'active' : ''}`, onclick: () => { kind = id; cur = id === 'none' ? null : sourceFields(id); draw(); } }, label)));
    desc.textContent = opts.find(([id]) => id === kind)[2];
    box.replaceChildren(seg, desc, ...(cur?.els ?? []));
  };
  draw();
  return { el: box, get: () => cur?.get(), check: () => cur?.check() ?? null };
}
