import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BOOKMARKS, COMMANDS, PREFIXES, argOptions, buildRows, commandById, matchCommands, needsConfirm, nextNeed, normalizePath, parseQuery, prefixHints, projectsOf, runCommand } from '../public/js/palette-commands.js';

const LV = { viewer: 0, operator: 1, admin: 2 };
const prod = { id: 1, name: 'Prod', color: '#fff', url: 'https://prod.example.com' };
const stage = { id: 2, name: 'Stage', url: 'https://stage.example.com' };
const svc = (panel, project, name) => ({ panelId: panel.id, panel, type: 'app', project, name, domain: `${name}.example.com` });
const mkCtx = (role = 'admin') => ({
  panels: [prod, stage], services: [svc(prod, 'shop', 'api'), svc(prod, 'shop', 'web'), svc(stage, 'blog', 'cms')],
  can: (l) => LV[role] >= LV[l], t: (s) => s, filesPanelId: 2,
  themes: [{ id: 'dark', label: 'Полночь' }, { id: 'light-sand', label: 'Песок' }], langs: [{ code: 'ru', label: 'Русский' }, { code: 'de', label: 'Deutsch' }],
});
const mkUi = () => {
  const calls = []; const toasts = [];
  return { calls, toasts, t: (s) => s, toast: (m, k) => toasts.push([m, k]), api: { post: async (...a) => { calls.push(['post', ...a]); } },
    go: (h) => calls.push(['go', h]), openService: (s, tab) => calls.push(['openService', s.name, tab]), openFiles: (id, p) => calls.push(['openFiles', id, p]),
    openConsole: (id) => calls.push(['openConsole', id]), applyTheme: (id) => calls.push(['theme', id]), setLang: (c) => calls.push(['lang', c]) };
};

describe('реестр команд', () => {
  test('все 13 команд на месте, поля заполнены, id уникальны', () => {
    const ids = ['service.restart', 'service.start', 'service.stop', 'service.logs', 'service.backup', 'service.terminal', 'panel.doctor', 'panel.clean', 'panel.terminal', 'panel.files', 'files.jump', 'theme.switch', 'lang.switch'];
    assert.deepEqual(COMMANDS.map((c) => c.id), ids);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of COMMANDS) {
      assert.ok(c.title && /[А-Яа-я]/.test(c.title), c.id);
      assert.ok(c.aliases.length && c.needs.length && typeof c.run === 'function', c.id);
      assert.ok(['low', 'medium', 'high'].includes(c.risk), c.id);
      assert.ok(['viewer', 'operator', 'admin'].includes(c.min), c.id);
    }
  });
  test('риск и подтверждение: stop — high, restart — medium, start/logs — без подтверждения', () => {
    assert.equal(commandById('service.stop').risk, 'high');
    assert.ok(needsConfirm(commandById('service.restart')) && needsConfirm(commandById('service.stop')) && needsConfirm(commandById('panel.clean')));
    assert.ok(!needsConfirm(commandById('service.start')) && !needsConfirm(commandById('service.logs')));
  });
  test('nextNeed ведёт по шагам: панель → путь → готово', () => {
    const jump = commandById('files.jump');
    assert.equal(nextNeed(jump, {}), 'panel');
    assert.equal(nextNeed(jump, { panel: prod }), 'path');
    assert.equal(nextNeed(jump, { panel: prod, path: '/etc' }), null);
  });
  test('горячие клавиши не повторяются', () => {
    const keys = COMMANDS.map((c) => c.hotkey).filter(Boolean);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('префиксы', () => {
  test('семь префиксов и режимы', () => {
    assert.deepEqual(Object.keys(PREFIXES), ['>', '/', '@', '#', '!', '?', ':']);
    assert.deepEqual(prefixHints().map((p) => p.prefix), ['>', '/', '@', '#', '!', '?', ':']);
    for (const [p, mode] of [['> restart', 'commands'], ['/var/log', 'files'], ['@ prod', 'panels'], ['# shop', 'projects'], ['! api', 'logs'], ['?', 'help'], [':theme dark', 'settings'], ['kilo', 'search']]) assert.equal(parseQuery(p).mode, mode, p);
  });
  test('остаток запроса без префикса и пробелов', () => {
    assert.deepEqual(parseQuery('  >  restart api '), { prefix: '>', mode: 'commands', text: 'restart api' });
    assert.deepEqual(parseQuery('kilo'), { prefix: '', mode: 'search', text: 'kilo' });
    assert.deepEqual(parseQuery(''), { prefix: '', mode: 'search', text: '' });
  });
  test('normalizePath', () => {
    assert.equal(normalizePath(' var / log '), '/var/log');
    assert.equal(normalizePath('/etc//nginx/../ssl/'), '/etc/ssl');
    assert.equal(normalizePath('~/backups'), '~/backups');
    assert.equal(normalizePath(''), '/');
    assert.equal(normalizePath('..'), '/');
  });
});

describe('поиск команд и шаги', () => {
  test('«restart api» → команда перезапуска, «api» уходит в фильтр сервиса', () => {
    const [top] = matchCommands('restart api', mkCtx());
    assert.equal(top.cmd.id, 'service.restart');
    assert.equal(top.rest, 'api');
  });
  test('алиасы и русские синонимы', () => {
    assert.equal(matchCommands('rs', mkCtx())[0].cmd.id, 'service.restart');
    assert.equal(matchCommands('prune', mkCtx())[0].cmd.id, 'panel.clean');
    assert.equal(matchCommands('логи', mkCtx())[0].cmd.id, 'service.logs');
  });
  test('роль скрывает команды: viewer видит только тему и язык, operator — без админских', () => {
    assert.deepEqual(matchCommands('', mkCtx('viewer')).map((r) => r.cmd.id), ['theme.switch', 'lang.switch']);
    const op = matchCommands('', mkCtx('operator')).map((r) => r.cmd.id);
    assert.ok(op.includes('service.restart') && !op.includes('panel.clean') && !op.includes('service.backup'));
    assert.equal(matchCommands('', mkCtx()).length, 13);
  });
  test('варианты сервиса ранжируются по фильтру', () => {
    const ctx = mkCtx();
    assert.deepEqual(argOptions('service', 'api', ctx).map((o) => o.value.name), ['api']);
    assert.equal(argOptions('service', '', ctx).length, 3);
    assert.deepEqual(argOptions('panel', 'sta', ctx).map((o) => o.value.id), [2]);
    assert.deepEqual(argOptions('choice', 'de', ctx, commandById('lang.switch')).map((o) => o.value.id), ['de']);
  });
});

describe('строки по режимам', () => {
  const ctx = mkCtx();
  test('«/» — путь и закладки, панель берётся последняя использованная', () => {
    const rows = buildRows('/ var/log', ctx);
    assert.equal(rows[0].title, '/var/log');
    assert.equal(rows[0].args.panel.id, 2);
    assert.equal(rows[0].cmd.id, 'files.jump');
    assert.ok(buildRows('/', ctx).length >= BOOKMARKS.length - 1);
    assert.deepEqual(buildRows('/ x', mkCtx('operator')), []);
  });
  test('«@» панели, «#» проекты, «!» логи', () => {
    assert.deepEqual(buildRows('@ prod', ctx).map((r) => r.hash), ['#/panel/1']);
    assert.deepEqual(buildRows('# blog', ctx).map((r) => [r.title, r.hash]), [['blog', '#/panel/2']]);
    assert.equal(projectsOf(ctx).length, 2);
    const logs = buildRows('! web', ctx);
    assert.equal(logs[0].cmd.id, 'service.logs');
    assert.equal(logs[0].args.service.name, 'web');
  });
  test('«?» — справка с префиксами и горячими клавишами; фильтруется', () => {
    const rows = buildRows('?', ctx);
    assert.equal(rows.filter((r) => r.type === 'fill').length, 7);
    assert.ok(rows.some((r) => r.keys === 'g r'));
    assert.ok(buildRows('? Ctrl', ctx).every((r) => /ctrl/i.test(r.keys)));
  });
  test('«:theme dark» и «:lang de» — готовые команды с выбором', () => {
    const th = buildRows(':theme sand', ctx);
    assert.deepEqual(th.map((r) => [r.cmd.id, r.args.choice.id]), [['theme.switch', 'light-sand']]);
    const lg = buildRows(':lang de', ctx);
    assert.deepEqual(lg.map((r) => [r.cmd.id, r.args.choice.id]), [['lang.switch', 'de']]);
    assert.equal(buildRows(':', ctx).length, 4);
  });
  test('«>» без текста — все доступные команды', () => assert.equal(buildRows('>', ctx).length, 13));
});

describe('выполнение', () => {
  test('перезапуск → API панели + toast', async () => {
    const ui = mkUi();
    const ok = await runCommand(commandById('service.restart'), { service: svc(prod, 'shop', 'api') }, ui);
    assert.ok(ok);
    assert.deepEqual(ui.calls[0], ['post', '/api/panels/1/service/action', { type: 'app', project: 'shop', name: 'api', action: 'restart' }]);
    assert.equal(ui.toasts[0][1], 'success');
    assert.match(ui.toasts[0][0], /^api: /);
  });
  test('stop/start используют своё действие; бэкап — отдельный маршрут; очистка — op панели', async () => {
    const ui = mkUi(); const s = svc(prod, 'shop', 'web');
    await runCommand(commandById('service.stop'), { service: s }, ui);
    await runCommand(commandById('service.start'), { service: s }, ui);
    await runCommand(commandById('service.backup'), { service: s }, ui);
    await runCommand(commandById('panel.clean'), { panel: stage }, ui);
    assert.deepEqual(ui.calls.map((c) => [c[1], c[2].action ?? c[2].op ?? c[2].service]), [['/api/panels/1/service/action', 'stop'], ['/api/panels/1/service/action', 'start'], ['/api/backups/data/run', 'web'], ['/api/panels/2/system', 'cleanupImages']]);
  });
  test('навигационные команды', async () => {
    const ui = mkUi(); const s = svc(prod, 'shop', 'api');
    await runCommand(commandById('service.logs'), { service: s }, ui);
    await runCommand(commandById('service.terminal'), { service: s }, ui);
    await runCommand(commandById('panel.doctor'), { panel: prod }, ui);
    await runCommand(commandById('panel.terminal'), { panel: prod }, ui);
    await runCommand(commandById('panel.files'), { panel: prod }, ui);
    await runCommand(commandById('files.jump'), { panel: prod, path: 'var/log' }, ui);
    await runCommand(commandById('theme.switch'), { choice: { id: 'dark', label: 'Полночь' } }, ui);
    await runCommand(commandById('lang.switch'), { choice: { id: 'de', label: 'Deutsch' } }, ui);
    assert.deepEqual(ui.calls, [['openService', 'api', 'logs'], ['openService', 'api', 'console'], ['go', '#/panel/1/doctor'], ['openConsole', 1], ['openFiles', 1, undefined], ['openFiles', 1, '/var/log'], ['theme', 'dark'], ['lang', 'de']]);
  });
  test('ошибка API → toast error, false; неполные аргументы не выполняются', async () => {
    const ui = mkUi(); ui.api.post = async () => { throw new Error('boom'); };
    assert.equal(await runCommand(commandById('service.restart'), { service: svc(prod, 'shop', 'api') }, ui), false);
    assert.deepEqual(ui.toasts[0], ['boom', 'error']);
    assert.equal(await runCommand(commandById('files.jump'), { panel: prod }, mkUi()), false);
  });
});
