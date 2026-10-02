import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseTs } from '../src/ts.js';

/* Время из ответов панели: строка без пояса — UTC, независимо от пояса процесса EasyAdmin (он меняется в настройках). */
describe('parseTs', () => {
  test('без пояса читается как UTC при любом поясе процесса', () => {
    const was = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Europe/Moscow', 'America/New_York']) {
        process.env.TZ = tz;
        assert.equal(parseTs('2026-10-01 22:19:50'), Date.UTC(2026, 9, 1, 22, 19, 50), tz);
        assert.equal(parseTs('2026-10-01T22:19:50.250'), Date.UTC(2026, 9, 1, 22, 19, 50, 250), tz);
        assert.equal(parseTs('2026-10-01'), Date.UTC(2026, 9, 1), tz);
      }
    } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
  });
  test('с поясом и числа не меняются; мусор — null', () => {
    assert.equal(parseTs('2026-10-01T22:19:50Z'), Date.UTC(2026, 9, 1, 22, 19, 50));
    assert.equal(parseTs('2026-10-02T01:19:50+03:00'), Date.UTC(2026, 9, 1, 22, 19, 50));
    assert.equal(parseTs(1790000000000), 1790000000000);
    for (const bad of [undefined, null, '', 'вчера', NaN]) assert.equal(parseTs(bad), null);
  });
});
