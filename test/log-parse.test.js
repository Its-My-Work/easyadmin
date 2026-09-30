import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLogLine, tagHue } from '../public/js/log-parse.js';

test('строка docker compose logs: префикс контейнера отделяется, выравнивающие пробелы убираются', () => {
  assert.deepEqual(parseLogLine('n8n-app-1  | Editor is now accessible'), { tag: 'n8n-app-1', text: 'Editor is now accessible' });
  assert.deepEqual(parseLogLine('db-1   | ready | to accept connections'), { tag: 'db-1', text: 'ready | to accept connections' });
  assert.deepEqual(parseLogLine('web_1 |'), { tag: null, text: 'web_1 |' }, 'без номера через дефис — не префикс compose v2');
  assert.deepEqual(parseLogLine('web-1  |'), { tag: 'web-1', text: '' });
});

test('строки без префикса и похожие на префикс остаются как есть', () => {
  for (const l of ['plain line', '2026-09-30 error | something', 'a - 1 | x', '', '  web-1 | indented']) assert.deepEqual(parseLogLine(l), { tag: null, text: l });
});

test('цвет контейнера стабилен и в диапазоне 0..7', () => {
  for (const t of ['web-1', 'db-1', 'n8n-app-1', 'x-10']) { const h = tagHue(t); assert.ok(Number.isInteger(h) && h >= 0 && h < 8); assert.equal(h, tagHue(t)); }
});
