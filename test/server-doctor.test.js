import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DOCTOR_SCRIPT, analyze, buildFix, checkReboot, checkSwap, gradeOf, healthScore, parseDf, parseDockerDf, parseDockerLogs, parseInodes, parseJournal, parseMemory, parseSize, parseTop, serverDoctorRoutes } from '../src/server-doctor.js';

const DF = `Filesystem     Type 1-blocks        Used   Available Capacity Mounted on
/dev/vda1      ext4 105089261568 98000000000 7089261568      94% /
/dev/loop3     squashfs 67108864 67108864 0 100% /snap/core/1
/dev/vda15     vfat   109395456     6000000  103395456       6% /boot/efi
overlay        overlay 105089261568 98000000000 7089261568   94% /var/lib/docker/overlay2/x/merged
/dev/vdb1      ext4 53687091200  10737418240 42949672960  20% /mnt/data disk`;
const DFI = `Filesystem       Inodes   IUsed   IFree IUse% Mounted on
/dev/vda1       6553600 6000000  553600   92% /
/dev/vdb1       3276800  100000 3176800    4% /mnt/data
/dev/loop3        12000   12000       0  100% /snap/core/1
/dev/vdc1             0       0       0     - /btrfs`;
const DOCKER = `{"Type":"Images","TotalCount":"12","Active":"4","Size":"5.2GB","Reclaimable":"3.1GB (59%)"}
{"Type":"Containers","TotalCount":"6","Active":"4","Size":"120MB","Reclaimable":"0B (0%)"}
{"Type":"Local Volumes","TotalCount":"9","Active":"7","Size":"8GB","Reclaimable":"2GB (25%)"}
{"Type":"Build Cache","TotalCount":"40","Active":"0","Size":"2.4GB","Reclaimable":"2.4GB"}`;
const ID = 'a'.repeat(64);
const LOGS = `734003200 /var/lib/docker/containers/${ID}/${ID}-json.log\n1073741824 /var/lib/docker/containers/${'b'.repeat(64)}/${'b'.repeat(64)}-json.log`;

describe('парсеры', () => {
  test('parseSize: десятичные и двоичные единицы', () => {
    assert.equal(parseSize('96.0M'), 96 * 1024 ** 2);
    assert.equal(parseSize('3.1GB (59%)', 1000), 3.1e9);
    assert.equal(parseSize('0B'), 0);
    assert.equal(parseSize('мусор'), null);
  });
  test('parseDf отбрасывает loop/overlay/snap/efi и понимает пробел в точке монтирования', () => {
    const r = parseDf(DF);
    assert.deepEqual(r.map((x) => x.mount), ['/', '/mnt/data disk']);
    assert.equal(r[0].pct, 94);
  });
  test('parseInodes пропускает разделы без inode и loop', () => {
    assert.deepEqual(parseInodes(DFI).map((x) => [x.mount, x.pct]), [['/', 92], ['/mnt/data', 4]]);
  });
  test('parseTop', () => {
    const r = parseTop('12G\t/var\n9.5G\t/var/lib/docker\n1.1G\t/var/log\n');
    assert.equal(r.length, 3); assert.equal(r[1].path, '/var/lib/docker'); assert.equal(r[0].size, 12 * 1024 ** 3);
  });
  test('parseDockerDf: тома не входят в освобождаемое', () => {
    const r = parseDockerDf(DOCKER);
    assert.equal(r.reclaimable, 3.1e9 + 2.4e9);
    assert.equal(r.volumes.reclaimable, 2e9);
    assert.equal(parseDockerDf('docker: not found').found, false);
  });
  test('parseDockerLogs: сортировка и фильтр путей', () => {
    const r = parseDockerLogs(`${LOGS}\n999 /etc/passwd`);
    assert.equal(r.length, 2); assert.equal(r[0].size, 1073741824);
  });
  test('parseJournal / parseMemory', () => {
    assert.equal(parseJournal('Archived and active journals take up 1.2G in the file system.'), Math.round(1.2 * 1024 ** 3));
    assert.equal(parseJournal('Journal not found'), null);
    assert.deepEqual(parseMemory('MemTotal:        2048000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB'), { ram: 2048000 * 1024, swap: 0, swapFree: 0 });
  });
});

describe('оценка и проверки', () => {
  test('границы букв', () => {
    for (const [s, g] of [[100, 'A'], [95, 'A'], [94, 'B'], [80, 'B'], [79, 'C'], [60, 'C'], [59, 'D'], [40, 'D'], [39, 'F'], [0, 'F']]) assert.equal(gradeOf(s), g, String(s));
  });
  test('штрафы: crit −25, warn −10, info 0; не ниже 0', () => {
    assert.deepEqual(healthScore([{ severity: 'crit' }, { severity: 'warn' }, { severity: 'info' }]), { score: 65, grade: 'C' });
    assert.equal(healthScore(Array(10).fill({ severity: 'crit' })).score, 0);
  });
  test('checkSwap и checkReboot', () => {
    assert.equal(checkSwap({ ram: 2 * 1024 ** 3, swap: 0, swapFree: 0 })[0].fixIds[0], 'swap.add');
    assert.deepEqual(checkSwap({ ram: 16 * 1024 ** 3, swap: 0, swapFree: 0 }), []);
    assert.equal(checkSwap({ ram: 2 * 1024 ** 3, swap: 1000, swapFree: 50 })[0].severity, 'warn');
    assert.equal(checkReboot(['yes', 'linux-image'])[0].severity, 'info');
    assert.deepEqual(checkReboot([]), []);
  });
  test('analyze: полный вывод даёт находки по важности и оценку', () => {
    const out = ['##DF', DF, '##DFI', DFI, '##TOP', '12G\t/var', '##DOCKERDF', DOCKER, '##DLOGS', LOGS, '##JOURNAL', 'take up 800.0M in the file system.', '##MEM', 'MemTotal: 1048576 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB', '##REBOOT', 'yes', '##END'].join('\n');
    const r = analyze(out);
    assert.equal(r.findings[0].severity, 'crit'); assert.equal(r.findings[0].id, 'disk.usage');
    assert.deepEqual(r.findings.map((f) => f.id).filter((v, i, a) => a.indexOf(v) === i), ['disk.usage', 'disk.inodes', 'docker.df', 'docker.logs', 'journal.size', 'memory.swap', 'reboot.required', 'disk.top']);
    assert.equal(r.score, 100 - 25 - 25 - 10 * 4); assert.equal(r.grade, 'F');
  });
  test('analyze: здоровый сервер → A, неполный вывод → ошибка', () => {
    const ok = analyze('##DF\n/dev/vda1 ext4 100 10 90 10% /\n##END');
    assert.deepEqual([ok.score, ok.grade, ok.findings.length], [100, 'A', 0]);
    assert.throws(() => analyze('##DF'), /Неполный/);
  });
  test('скрипт диагностики только читает', () => {
    assert.ok(!/\b(rm|truncate|prune|vacuum|mkswap)\b/.test(DOCTOR_SCRIPT));
  });
});

describe('рецепты', () => {
  test('безопасные команды из каталога', () => {
    assert.equal(buildFix('journal.vacuum').script, 'journalctl --vacuum-size=100M');
    assert.equal(buildFix('docker.prune').script, 'docker builder prune -f && docker image prune -f');
    assert.match(buildFix('docker.logs.truncate').script, /-size \+200M .*truncate -s 0/);
  });
  test('swap.add: размер из белого списка, по умолчанию 2G, откат и fstab', () => {
    assert.match(buildFix('swap.add', {}).script, /fallocate -l 2G \/swapfile && chmod 600 \/swapfile && mkswap \/swapfile && swapon \/swapfile/);
    assert.match(buildFix('swap.add', { size: '4G' }).script, /fallocate -l 4G/);
    assert.match(buildFix('swap.add', { size: '1G' }).script, /echo '\/swapfile none swap sw 0 0' >> \/etc\/fstab/);
    assert.match(buildFix('swap.add', { size: '1G' }).script, /rm -f \/swapfile/);
  });
  test('инъекции и неизвестное отклоняются (400)', () => {
    for (const [id, p] of [['swap.add', { size: '1G; rm -rf /' }], ['swap.add', { size: '8G' }], ['rm -rf /', {}], ['__proto__', {}], [undefined, {}], ['journal.vacuum', { size: '1' }], ['swap.add', { path: '/x' }]]) {
      assert.throws(() => buildFix(id, p), (e) => e.status === 400, `${id} ${JSON.stringify(p)}`);
    }
  });
});

describe('маршруты', () => {
  const mk = (run) => {
    const audits = [];
    const routes = serverDoctorRoutes({ manager: { clientFor: () => ({}) }, audit: (_c, a) => audits.push(a), panelOr404: (id) => ({ id: Number(id), name: 'p' }), assertPanel: () => {}, hostRun: run });
    const find = (m, u) => routes.find((r) => r[0] === m && r[1] === u)[2];
    return { audits, scan: find('GET', '/api/panels/:id/doctor'), fix: find('POST', '/api/panels/:id/doctor/fix'), routes };
  };
  test('оба маршрута только для админа', () => assert.ok(mk(async () => ({})).routes.every((r) => r[3]?.admin)));
  test('scan возвращает оценку и каталог рецептов', async () => {
    const { scan } = mk(async () => ({ ok: true, output: '##DF\n/dev/vda1 ext4 100 95 5 95% /\n##END' }));
    const r = await scan({ params: { id: '1' } });
    assert.equal(r.grade, 'C'); assert.equal(r.transport, 'host'); assert.ok(r.recipes['swap.add']);
  });
  test('fix запускает скрипт; чужой fixId не доходит до хоста; параллельный запуск → 409', async () => {
    const calls = []; let release;
    const gate = new Promise((r) => { release = r; });
    const { fix, audits } = mk(async (_c, _r, script) => { calls.push(script); await gate; return { ok: true, output: 'done' }; });
    await assert.rejects(fix({ params: { id: '1' }, body: { fixId: 'evil' } }), (e) => e.status === 400);
    assert.equal(calls.length, 0); assert.equal(audits[0].ok, false);
    const first = fix({ params: { id: '1' }, body: { fixId: 'journal.vacuum' } });
    await assert.rejects(fix({ params: { id: '1' }, body: { fixId: 'docker.prune' } }), (e) => e.status === 409);
    release();
    assert.deepEqual(await first, { ok: true, fixId: 'journal.vacuum', output: 'done' });
    assert.deepEqual(calls, ['journalctl --vacuum-size=100M']);
  });
});
