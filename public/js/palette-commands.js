/**
 * Command Palette 2.0 — чистая логика без DOM и внешних зависимостей (покрыта тестами).
 *
 * Реестр команд (id, title, aliases, hotkey, needs, risk, run), разбор префиксов (> / @ # ! ? :),
 * многошаговый выбор аргументов (команда → сервис/панель/путь/вариант → подтверждение → выполнение).
 * Всё окружение (API, toast, навигация) приходит через объект `ui`, поэтому модуль запускается и в Node.
 *
 * ctx: { panels: [{ id, name, color?, url? }], services: [{ panelId, type, project, name, panel: { name, color? }, domain? }],
 *        can(level) → bool, t(str) → str, themes: [{ id, label }], langs: [{ code, label }], filesPanelId? }
 * ui:  { api: { post }, toast(msg, kind), go(hash), openService(s, tab), openFiles(panelId, path), openConsole(panelId),
 *        applyTheme(id), setLang(code), t(str) }
 */
import { orderItems } from './palette-order.js';

export const PREFIXES = {
  '>': { mode: 'commands', title: 'Команды', hint: 'Действия над сервисом или сервером: > restart', ic: 'terminal' },
  '/': { mode: 'files', title: 'Файловый менеджер', hint: 'Переход по пути: / var/log', ic: 'folder' },
  '@': { mode: 'panels', title: 'Панели и серверы', hint: 'Найти панель: @ prod', ic: 'server' },
  '#': { mode: 'projects', title: 'Проекты', hint: 'Найти проект: # shop', ic: 'layers' },
  '!': { mode: 'logs', title: 'Быстрые логи', hint: 'Логи сервиса: ! api', ic: 'activity' },
  '?': { mode: 'help', title: 'Горячие клавиши', hint: 'Справка по палитре', ic: 'search' },
  ':': { mode: 'settings', title: 'Быстрые настройки', hint: 'Тема и язык: :theme dark', ic: 'settings' },
};

const LEVEL = { viewer: 0, operator: 1, admin: 2 };
export const RISK = ['low', 'medium', 'high'];
const norm = (s) => String(s ?? '').toLowerCase().replace(/\u0451/g, '\u0435');
const idt = (s) => s;

/** Первый символ запроса — префикс режима. Возвращает { prefix, mode, text } (text — остаток без пробелов по краям). */
export function parseQuery(raw) {
  const s = String(raw ?? '').replace(/^\s+/, '');
  const p = s[0];
  if (p && PREFIXES[p]) return { prefix: p, mode: PREFIXES[p].mode, text: s.slice(1).trim() };
  return { prefix: '', mode: 'search', text: s.trim() };
}

/** «var/log», «/ var/log», «~/x», «  /etc » → нормальный абсолютный путь (или ~/…); «..» и пустой → «/». */
export function normalizePath(text) {
  let p = String(text ?? '').trim().replace(/\s*\/\s*/g, '/').replace(/\/{2,}/g, '/');
  if (!p) return '/';
  if (!p.startsWith('/') && !p.startsWith('~')) p = `/${p}`;
  const parts = [];
  for (const seg of p.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  const head = p.startsWith('~') ? '' : '/';
  return (head + parts.join('/')) || '/';
}

const svcLabel = (s) => `${s.panel?.name ?? ''} · ${s.project}`;
const serviceAction = (action, okText) => async ({ service: s }, ui) => {
  await ui.api.post(`/api/panels/${s.panelId}/service/action`, { type: s.type, project: s.project, name: s.name, action });
  return `${s.name}: ${ui.t(okText)}`;
};

export const COMMANDS = [
  { id: 'service.restart', title: 'Перезапустить сервис', aliases: ['restart', 'rs', 'reboot', 'перезапуск'], hotkey: 'g r', needs: ['service'], risk: 'medium', min: 'operator', ic: 'refresh',
    run: serviceAction('restart', 'перезапущен') },
  { id: 'service.start', title: 'Запустить сервис', aliases: ['start', 'run', 'up', 'запуск'], hotkey: 'g s', needs: ['service'], risk: 'low', min: 'operator', ic: 'play',
    run: serviceAction('start', 'запущен') },
  { id: 'service.stop', title: 'Остановить сервис', aliases: ['stop', 'down', 'kill', 'остановка'], hotkey: 'g x', needs: ['service'], risk: 'high', min: 'operator', ic: 'stop',
    run: serviceAction('stop', 'остановлен') },
  { id: 'service.logs', title: 'Открыть логи сервиса', aliases: ['logs', 'log', 'tail', 'логи'], hotkey: 'g l', needs: ['service'], risk: 'low', min: 'operator', ic: 'activity',
    run: ({ service: s }, ui) => { ui.openService(s, 'logs'); } },
  { id: 'service.backup', title: 'Запустить бэкап сервиса', aliases: ['backup', 'bk', 'бэкап'], hotkey: 'g b', needs: ['service'], risk: 'medium', min: 'admin', ic: 'database',
    run: async ({ service: s }, ui) => {
      await ui.api.post('/api/backups/data/run', { panelId: s.panelId, project: s.project, service: s.name });
      return `${s.name}: ${ui.t('бэкап запущен')}`;
    } },
  { id: 'service.terminal', title: 'Открыть консоль контейнера', aliases: ['exec', 'shell', 'console', 'консоль'], hotkey: 'g t', needs: ['service'], risk: 'low', min: 'admin', ic: 'terminal',
    run: ({ service: s }, ui) => { ui.openService(s, 'console'); } },
  { id: 'panel.doctor', title: 'Запустить Server Doctor', aliases: ['doctor', 'diag', 'health', 'диагностика'], hotkey: 'g h', needs: ['panel'], risk: 'low', min: 'admin', ic: 'activity',
    run: ({ panel: p }, ui) => { ui.go(`#/panel/${p.id}/doctor`); } },
  { id: 'panel.clean', title: 'Очистить Docker на панели', aliases: ['clean', 'prune', 'cleanup', 'очистка'], hotkey: '', needs: ['panel'], risk: 'medium', min: 'admin', ic: 'trash',
    run: async ({ panel: p }, ui) => {
      await ui.api.post(`/api/panels/${p.id}/system`, { op: 'cleanupImages' });
      return `${p.name}: ${ui.t('образы Docker очищены')}`;
    } },
  { id: 'panel.terminal', title: 'Открыть консоль сервера', aliases: ['ssh', 'term', 'terminal', 'сервер'], hotkey: '', needs: ['panel'], risk: 'low', min: 'admin', ic: 'terminal',
    run: ({ panel: p }, ui) => { ui.openConsole(p.id); } },
  { id: 'panel.files', title: 'Открыть файлы панели', aliases: ['files', 'fm', 'файлы'], hotkey: '', needs: ['panel'], risk: 'low', min: 'admin', ic: 'folder',
    run: ({ panel: p }, ui) => { ui.openFiles(p.id); } },
  { id: 'files.jump', title: 'Перейти к пути в файлах', aliases: ['jump', 'cd', 'goto', 'path', 'путь'], hotkey: 'g f', needs: ['panel', 'path'], risk: 'low', min: 'admin', ic: 'folder',
    run: ({ panel: p, path }, ui) => { ui.openFiles(p.id, normalizePath(path)); } },
  { id: 'theme.switch', title: 'Сменить тему оформления', aliases: ['theme', 'dark', 'light', 'тема'], hotkey: 'g m', needs: ['choice'], risk: 'low', min: 'viewer', ic: 'settings', choices: 'themes',
    run: ({ choice }, ui) => { ui.applyTheme(choice.id); return `${ui.t('Тема')}: ${choice.label}`; } },
  { id: 'lang.switch', title: 'Сменить язык интерфейса', aliases: ['lang', 'language', 'locale', 'язык'], hotkey: '', needs: ['choice'], risk: 'low', min: 'viewer', ic: 'globe', choices: 'langs',
    run: ({ choice }, ui) => { ui.setLang(choice.id); } },
];

export const commandById = (id) => COMMANDS.find((c) => c.id === id) ?? null;
export const visibleCommands = (ctx) => COMMANDS.filter((c) => ctx.can(c.min ?? 'viewer'));
export const needsConfirm = (cmd) => RISK.indexOf(cmd.risk) >= 1;

/** Следующий недостающий аргумент команды ('service' | 'panel' | 'path' | 'choice') или null, если всё собрано. */
export function nextNeed(cmd, args = {}) {
  return cmd.needs.find((k) => args[k] == null || args[k] === '') ?? null;
}

/** Варианты для аргумента-выбора: темы или языки. */
export function choicesFor(cmd, ctx) {
  const list = cmd.choices === 'langs' ? ctx.langs.map((l) => ({ id: l.code, label: l.label })) : ctx.themes.map((x) => ({ id: x.id, label: x.label }));
  return list;
}

const cmdItem = (c, t, order) => ({ title: c.title, shown: t(c.title), extra: c.aliases.join(' '), hint: c.id, group: 'cmd', order, cmd: c });

/**
 * Ищет команды по вводу «restart api»: берёт самый длинный префикс слов, которому что-то соответствует;
 * остаток («api») становится начальным фильтром следующего шага.
 * @returns { rows: [{ cmd, rest }] }
 */
export function matchCommands(text, ctx) {
  const t = ctx.t ?? idt;
  const items = visibleCommands(ctx).map((c, i) => cmdItem(c, t, i));
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items.map((item) => ({ cmd: item.cmd, rest: '' }));
  for (let k = tokens.length; k >= 1; k--) {
    const found = orderItems(items, tokens.slice(0, k).join(' '));
    if (found.length) return found.map(({ item }) => ({ cmd: item.cmd, rest: tokens.slice(k).join(' ') }));
  }
  return [];
}

/** Ранжированные варианты для шага выбора аргумента. Возвращает [{ value, title, hint, ic?, color? }]. */
export function argOptions(kind, text, ctx, cmd) {
  const t = ctx.t ?? idt;
  if (kind === 'service') {
    const items = ctx.services.map((s, i) => ({ title: s.name, hint: svcLabel(s), extra: s.domain ?? '', group: 'service', order: i, sortKey: `${s.name} ${svcLabel(s)}`, value: s }));
    return orderItems(items, text).map(({ item }) => ({ value: item.value, title: item.title, hint: item.hint, ic: 'box', color: item.value.panel?.color }));
  }
  if (kind === 'panel') {
    const items = ctx.panels.map((p, i) => ({ title: p.name, hint: 'Панель', extra: p.url ?? '', group: 'panel', order: i, value: p }));
    return orderItems(items, text).map(({ item }) => ({ value: item.value, title: item.title, hint: item.hint, ic: 'server', color: item.value.color }));
  }
  if (kind === 'choice') {
    const items = choicesFor(cmd, ctx).map((c, i) => ({ title: c.label, shown: t(c.label), extra: c.id, group: 'cmd', order: i, value: c }));
    return orderItems(items, text).map(({ item }) => ({ value: item.value, title: item.shown, hint: item.value.id, ic: cmd.ic }));
  }
  if (kind === 'path') return [{ value: normalizePath(text), title: normalizePath(text), hint: 'Путь', ic: 'folder' }];
  return [];
}

export const BOOKMARKS = ['/', '/var/log', '/etc', '/root', '/home', '/opt', '/var/lib/docker', '/etc/easypanel'];

/** Подсказка по префиксам для пустой палитры. */
export const prefixHints = () => Object.entries(PREFIXES).map(([prefix, v]) => ({ prefix, title: v.title, hint: v.hint, ic: v.ic }));

/** Список горячих клавиш и префиксов для режима «?». */
export function helpRows(ctx) {
  const keys = [['Ctrl K', 'Открыть палитру'], ['↑ ↓', 'Выбор'], ['Enter', 'Выполнить'], ['Backspace', 'Назад на шаг'], ['Esc', 'Закрыть']].map(([k, d]) => ({ keys: k, title: d }));
  const cmds = visibleCommands(ctx).filter((c) => c.hotkey).map((c) => ({ keys: c.hotkey, title: c.title }));
  return { keys, prefixes: prefixHints(), commands: cmds };
}

/** Уникальные проекты: [{ panelId, panel, project, count }]. */
export function projectsOf(ctx) {
  const map = new Map();
  for (const s of ctx.services) {
    const k = `${s.panelId}\u0000${s.project}`;
    const cur = map.get(k) ?? { panelId: s.panelId, panel: s.panel, project: s.project, count: 0 };
    cur.count++; map.set(k, cur);
  }
  return [...map.values()];
}

/**
 * Строки списка для режима с префиксом. Типы строк:
 *  { type: 'command', cmd, args, rest }  — выбор запускает многошаговый поток
 *  { type: 'go', hash }                  — переход
 *  { type: 'fill', text }                — подставить текст в поле
 *  { type: 'help', keys, title }         — справка (без действия)
 */
export function buildRows(raw, ctx) {
  const { prefix, mode, text } = parseQuery(raw);
  const t = ctx.t ?? idt;
  const rows = [];
  if (mode === 'commands') return matchCommands(text, ctx).map(({ cmd, rest }) => ({ type: 'command', cmd, args: {}, rest, title: cmd.title, hint: cmd.aliases[0], ic: cmd.ic, hotkey: cmd.hotkey }));
  if (mode === 'files') {
    const cmd = commandById('files.jump');
    if (!ctx.can('admin') || !ctx.panels.length) return [];
    const panel = ctx.panels.find((p) => p.id === ctx.filesPanelId) ?? ctx.panels[0];
    const target = normalizePath(text);
    const row = (path, hint) => ({ type: 'command', cmd, args: { panel, path }, rest: '', title: path, hint, ic: 'folder' });
    if (text) rows.push(row(target, `${t('Перейти')} · ${panel.name}`));
    const q = norm(text);
    for (const b of BOOKMARKS) if (b !== target && (!q || norm(b).includes(norm(normalizePath(text)).replace(/^\//, '')) || norm(b).includes(q))) rows.push(row(b, t('Закладка')));
    return rows;
  }
  if (mode === 'panels') return argOptions('panel', text, ctx).map((o) => ({ type: 'go', hash: `#/panel/${o.value.id}`, title: o.title, hint: o.hint, ic: o.ic, color: o.color }));
  if (mode === 'projects') {
    const items = projectsOf(ctx).map((p, i) => ({ title: p.project, hint: p.panel?.name ?? '', extra: `${p.count}`, group: 'service', order: i, sortKey: `${p.project} ${p.panel?.name ?? ''}`, value: p }));
    return orderItems(items, text).map(({ item: i }) => ({ type: 'go', hash: `#/panel/${i.value.panelId}`, title: i.title, hint: `${i.hint} · ${i.value.count}`, ic: 'layers', color: i.value.panel?.color }));
  }
  if (mode === 'logs') {
    const cmd = commandById('service.logs');
    if (!ctx.can(cmd.min)) return [];
    return argOptions('service', text, ctx).map((o) => ({ type: 'command', cmd, args: { service: o.value }, rest: '', title: o.title, hint: o.hint, ic: 'activity', color: o.color }));
  }
  if (mode === 'help') {
    const h = helpRows(ctx);
    const q = norm(text);
    const all = [...h.prefixes.map((p) => ({ type: 'fill', text: p.prefix, keys: p.prefix, title: p.title, hint: p.hint, ic: p.ic })), ...h.commands.map((c) => ({ type: 'help', keys: c.keys, title: c.title })), ...h.keys.map((k) => ({ type: 'help', ...k }))];
    return all.filter((r) => !q || norm(`${r.keys} ${t(r.title)} ${r.title}`).includes(q));
  }
  if (mode === 'settings') {
    const tokens = text.split(/\s+/).filter(Boolean);
    const first = norm(tokens[0] ?? '');
    const out = [];
    for (const cmd of [commandById('theme.switch'), commandById('lang.switch')]) {
      const hit = !first || cmd.aliases.some((a) => a.startsWith(first)) || norm(cmd.id.split('.')[0]).startsWith(first);
      if (hit) {
        const rest = first ? tokens.slice(1).join(' ') : '';
        for (const o of argOptions('choice', rest, ctx, cmd)) out.push({ type: 'command', cmd, args: { choice: o.value }, rest: '', title: `${t(cmd.title)}: ${o.title}`, hint: o.hint, ic: cmd.ic });
      }
    }
    if (!out.length && text) {
      // «:dark» — без названия раздела: ищем среди тем и языков
      for (const cmd of [commandById('theme.switch'), commandById('lang.switch')]) for (const o of argOptions('choice', text, ctx, cmd)) out.push({ type: 'command', cmd, args: { choice: o.value }, rest: '', title: `${t(cmd.title)}: ${o.title}`, hint: o.hint, ic: cmd.ic });
    }
    return out;
  }
  return prefix ? rows : [];
}

/**
 * Выполняет команду с готовыми аргументами; ошибки превращает в toast.
 * @returns true — выполнено, false — ошибка или не хватает аргументов
 */
export async function runCommand(cmd, args, ui) {
  if (nextNeed(cmd, args)) return false;
  try {
    const msg = await cmd.run(args, ui);
    ui.toast(typeof msg === 'string' && msg ? msg : ui.t('Готово'), 'success');
    return true;
  } catch (e) {
    ui.toast(e?.message || ui.t('Ошибка'), 'error');
    return false;
  }
}
