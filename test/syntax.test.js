import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// браузерный код не покрыт юнит-тестами: хотя бы проверяем, что каждый модуль разбирается (ловит битые правки)
test('синтаксис всех файлов public/js и src', () => {
  const files = ['public/js', 'src'].flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));
  assert.ok(files.length > 20);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr.split('\n').slice(0, 4).join(' | ')}`);
  }
});
