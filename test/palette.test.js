import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GROUP_ORDER, highlight, orderItems } from '../public/js/palette-order.js';

const page = (title, order, shown = title) => ({ title, shown, hint: 'Страница', group: 'page', order });
const svc = (title, hint, extra = '', o = {}) => ({ title, hint, extra, group: 'service', sortKey: `${title} ${hint}`, ...o });
const items = [
  page('Обзор', 0, 'Overview'), page('Все сервисы', 1, 'All services'), page('Инвентарь', 2, 'Inventory'), page('Настройки', 6, 'Settings'),
  { title: 'Добавить панель', shown: 'Add panel', hint: 'Команда', group: 'cmd', order: 0 },
  { title: 'Prod', hint: 'Панель', extra: 'https://prod.example.com', group: 'panel', order: 0 },
  svc('web', 'Prod · shop'), svc('web-api', 'Prod · shop'), svc('api', 'Prod · shop'), svc('kilo-gateway', 'Prod · main', 'kilo.example.com'),
  svc('cache', 'Prod · shop', '', { group: 'recent', recentIndex: 1 }), svc('db', 'Prod · shop', '', { group: 'recent', recentIndex: 0 }),
  svc('worker', 'Prod · shop', '', { group: 'fav' }), svc('backup', 'Prod · main', '', { group: 'fav' }),
];
const titles = (rows) => rows.map((r) => r.item.title);

describe('порядок в палитре команд', () => {
  test('пустой запрос: разделы в фиксированном порядке, заголовок только у первого элемента раздела', () => {
    const rows = orderItems(items, '');
    const sections = rows.filter((r) => r.section).map((r) => r.section);
    assert.deepEqual(sections, GROUP_ORDER, 'все разделы, в порядке fav → recent → panel → page → cmd → service');
    assert.deepEqual(titles(rows).slice(0, 4), ['backup', 'worker', 'db', 'cache'], 'избранные по алфавиту, затем недавние — свежие выше');
  });
  test('страницы идут в порядке бокового меню, а не в порядке объявления', () => {
    const shuffled = [...items].sort(() => 0.5 - Math.random());
    const pages = titles(orderItems(shuffled, '')).filter((t) => ['Обзор', 'Все сервисы', 'Инвентарь', 'Настройки'].includes(t));
    assert.deepEqual(pages, ['Обзор', 'Все сервисы', 'Инвентарь', 'Настройки']);
  });
  test('оставшиеся сервисы — по имени, натурально (svc2 < svc10)', () => {
    const many = ['svc10', 'svc2', 'svc1'].map((n) => svc(n, 'P · x'));
    assert.deepEqual(titles(orderItems(many, '')), ['svc1', 'svc2', 'svc10']);
  });
  test('пустой запрос ограничивает длинный хвост сервисов', () => {
    const lots = Array.from({ length: 300 }, (_, i) => svc(`s${i}`, 'P · x'));
    assert.equal(orderItems(lots, '').length, 40);
  });
  test('релевантность: точное > начало > начало слова > вхождение > нечёткое', () => {
    const r = titles(orderItems([svc('xweb', 'P'), svc('my-web', 'P'), svc('web-api', 'P'), svc('web', 'P'), svc('wxexbx', 'P')], 'web'));
    assert.deepEqual(r, ['web', 'web-api', 'my-web', 'xweb', 'wxexbx']);
  });
  test('избранное и недавние выигрывают при равной релевантности', () => {
    const r = titles(orderItems([svc('web-a', 'P'), svc('web-b', 'P', '', { group: 'recent', recentIndex: 0 }), svc('web-c', 'P', '', { group: 'fav' })], 'web'));
    assert.deepEqual(r, ['web-c', 'web-b', 'web-a']);
  });
  test('поиск по домену, панели и проекту; несколько слов — все должны совпасть', () => {
    assert.deepEqual(titles(orderItems(items, 'kilo.example')), ['kilo-gateway']);
    assert.ok(titles(orderItems(items, 'shop web')).includes('web'));
    assert.ok(!titles(orderItems(items, 'shop kilo')).length);
  });
  test('ищет и по переведённому заголовку, и по исходному', () => {
    assert.equal(titles(orderItems(items, 'settings'))[0], 'Настройки');
    assert.equal(titles(orderItems(items, 'настр'))[0], 'Настройки');
    assert.equal(titles(orderItems(items, 'add pan'))[0], 'Добавить панель');
  });
  test('при равенстве: панели → страницы → команды → сервисы, затем по алфавиту', () => {
    const r = orderItems([svc('inv', 'x'), { title: 'inv-cmd', hint: 'Команда', group: 'cmd' }, { title: 'inv-page', hint: 'Страница', group: 'page' }, { title: 'inv-panel', hint: 'Панель', group: 'panel' }], 'inv');
    assert.deepEqual(titles(r).slice(1), ['inv-panel', 'inv-page', 'inv-cmd']); // «inv» — точное имя, остальные — по группам
    assert.equal(titles(r)[0], 'inv');
  });
  test('Ё = Е, регистр не важен, результатов не больше лимита', () => {
    assert.equal(titles(orderItems([svc('Ёжик', 'P')], 'еж')).length, 1);
    assert.equal(orderItems(Array.from({ length: 200 }, (_, i) => svc(`web${i}`, 'P')), 'WEB').length, 40);
  });
  test('подсветка первого совпавшего токена', () => {
    assert.deepEqual(highlight('kilo-gateway', 'gate'), [{ text: 'kilo-' }, { text: 'gate', match: true }, { text: 'way' }]);
    assert.deepEqual(highlight('web', 'zzz'), [{ text: 'web' }]);
    assert.deepEqual(highlight('web', ''), [{ text: 'web' }]);
  });
});
