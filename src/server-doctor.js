import { HttpError } from './http.js';
import { runOnHost } from './host-exec.js';

/**
 * Server Doctor: проверки сервера только на чтение и безопасные рецепты исправления «в 1 клик».
 * Команды — константы кода; из запроса в оболочку попадает только значение из белого списка (размер swap).
 * Проверки и разбор вывода — чистые функции (тестируются на образцах вывода), выполнение — через консоль хоста Easypanel.
 */
const MB = 1024 ** 2; const GB = 1024 ** 3;
export const THRESHOLDS = { usageWarn: 80, usageCrit: 90, inodeWarn: 80, inodeCrit: 90, dockerReclaim: 1 * GB, dockerLogBytes: 200 * MB, journalBytes: 500 * MB, swapRamBytes: 4 * GB };
export const PENALTY = { crit: 25, warn: 10, info: 0, ok: 0 };
export const SWAP_SIZES = ['1G', '2G', '4G'];

/** Одна диагностика: разделы выводятся маркерами ##ИМЯ, каждая команда с таймаутом и без падения всего скрипта. */
export const DOCTOR_SCRIPT = [
  `P() { printf '%s\\n' "$1"; }`,
  `P '##DF'; df -PT -x tmpfs -x devtmpfs -B1 2>/dev/null`,
  `P '##DFI'; df -Pi -x tmpfs -x devtmpfs 2>/dev/null`,
  `P '##TOP'; timeout 20 du -xh --max-depth=1 /var /var/lib/docker /var/log 2>/dev/null | sort -rh | head -15`,
  `P '##DOCKERDF'; timeout 20 docker system df --format '{{json .}}' 2>/dev/null`,
  `P '##DLOGS'; timeout 20 find /var/lib/docker/containers -name '*-json.log' -size +200M -printf '%s %p\\n' 2>/dev/null`,
  `P '##JOURNAL'; journalctl --disk-usage 2>/dev/null`,
  `P '##MEM'; grep -E '^(MemTotal|SwapTotal|SwapFree):' /proc/meminfo`,
  `P '##REBOOT'; if [ -f /var/run/reboot-required ]; then echo yes; cat /var/run/reboot-required.pkgs 2>/dev/null | head -n 5; fi`,
  `P '##END'`,
].join('; ');

const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const POW = { '': 0, B: 0, K: 1, KB: 1, KIB: 1, M: 2, MB: 2, MIB: 2, G: 3, GB: 3, GIB: 3, T: 4, TB: 4, TIB: 4, P: 5, PB: 5 };

/** «1.2GB», «96.0M», «3.5kB», «500MB (41%)» → байты. base: 1024 для journalctl/du, 1000 для docker. */
export function parseSize(text, base = 1024) {
  const m = /^\s*([\d.,]+)\s*([A-Za-z]*)/.exec(String(text ?? ''));
  if (!m) return null;
  const n = num(m[1]); const p = POW[m[2].toUpperCase()];
  if (n == null || p === undefined) return null;
  return Math.round(n * base ** p);
}

export const sections = (output) => {
  const out = {}; let cur = null;
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.replace(/\r/g, '');
    const m = /^##([A-Z]+)$/.exec(line);
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur && line.trim()) out[cur].push(line);
  }
  return out;
};

/** Разделы, которые не считаются «диском сервера»: виртуальные, сетевые, снапшоты, слои докера. */
const SKIP_FS = new Set(['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'iso9660', 'efivarfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'shm', 'none', 'nsfs', 'fuse.lxcfs', 'nfs', 'nfs4', 'cifs', 'smbfs', 'fuse.sshfs']);
const skipMount = (m) => /^\/(snap|run|sys|proc|dev)(\/|$)/.test(m) || m.startsWith('/var/lib/docker/') || m.startsWith('/boot/efi');
const skipDev = (d) => /^\/dev\/loop\d+/.test(d) || d === 'overlay' || d === 'shm' || d === 'none';

/** `df -PT -B1` → [{device, fs, size, used, avail, pct, mount}] */
export function parseDf(output) {
  const rows = [];
  for (const line of String(output ?? '').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 7 || p[0] === 'Filesystem') continue;
    const [device, fs, size, used, avail, cap] = p; const mount = p.slice(6).join(' ');
    if (SKIP_FS.has(fs) || skipDev(device) || skipMount(mount)) continue;
    const s = num(size); const u = num(used); const a = num(avail); const pct = num(String(cap).replace('%', ''));
    if (!s || u == null || a == null || pct == null) continue;
    rows.push({ device, fs, size: s, used: u, avail: a, pct, mount });
  }
  return rows;
}

/** `df -Pi` → [{device, inodes, used, free, pct, mount}] (разделы без inode — btrfs/xfs-динамика — пропускаются). */
export function parseInodes(output) {
  const rows = [];
  for (const line of String(output ?? '').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 6 || p[0] === 'Filesystem') continue;
    const [device, total, used, free, cap] = p; const mount = p.slice(5).join(' ');
    if (SKIP_FS.has(device) || skipDev(device) || skipMount(mount)) continue;
    const t = num(total); const u = num(used); const f = num(free); const pct = num(String(cap).replace('%', ''));
    if (!t || u == null || f == null || pct == null) continue;
    rows.push({ device, inodes: t, used: u, free: f, pct, mount });
  }
  return rows;
}

/** `du -xh … | sort -rh` → [{size (байты), human, path}] */
export function parseTop(output) {
  const rows = [];
  for (const line of String(output ?? '').split('\n')) {
    const m = /^\s*([\d.,]+[KMGTP]?)\s+(\/\S.*)$/.exec(line);
    if (m) rows.push({ size: parseSize(m[1]) ?? 0, human: m[1], path: m[2].trim() });
  }
  return rows;
}

/** `docker system df --format '{{json .}}'` → { images, containers, volumes, cache: {size, reclaimable, count} }, reclaimable — сумма. */
export function parseDockerDf(output) {
  const kinds = { Images: 'images', Containers: 'containers', 'Local Volumes': 'volumes', 'Build Cache': 'cache' };
  const res = { images: null, containers: null, volumes: null, cache: null, reclaimable: 0, found: false };
  for (const line of String(output ?? '').split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const key = kinds[j?.Type]; if (!key) continue;
    const size = parseSize(j.Size, 1000) ?? 0; const reclaimable = parseSize(j.Reclaimable, 1000) ?? 0;
    res[key] = { size, reclaimable, count: num(j.TotalCount) ?? 0 };
    // тома не трогаем: данные пользователя, в «освобождаемое» не входят
    if (key !== 'volumes') res.reclaimable += reclaimable;
    res.found = true;
  }
  return res;
}

/** `find … -printf '%s %p\n'` → [{size, path}] по убыванию размера. */
export function parseDockerLogs(output) {
  const rows = [];
  for (const line of String(output ?? '').split('\n')) {
    const m = /^(\d+)\s+(\/var\/lib\/docker\/containers\/[0-9a-f]+\/[0-9a-f]+-json\.log)$/.exec(line.trim());
    if (m) rows.push({ size: Number(m[1]), path: m[2] });
  }
  return rows.sort((a, b) => b.size - a.size);
}

/** `journalctl --disk-usage` → байты или null. */
export function parseJournal(output) {
  const m = /take up\s+([\d.,]+\s*[KMGT]?)/i.exec(String(output ?? ''));
  return m ? parseSize(m[1]) : null;
}

/** /proc/meminfo → {ram, swap, swapFree} в байтах. */
export function parseMemory(output) {
  const g = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(String(output ?? '')); return m ? Number(m[1]) * 1024 : null; };
  return { ram: g('MemTotal'), swap: g('SwapTotal'), swapFree: g('SwapFree') };
}

/** Оценка 0..100 → буква: A 95–100, B 80–94, C 60–79, D 40–59, F <40. */
export const gradeOf = (score) => (score >= 95 ? 'A' : score >= 80 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F');
export function healthScore(findings) {
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + (PENALTY[f.severity] ?? 0), 0));
  return { score, grade: gradeOf(score) };
}

const mk = (id, severity, title, args, extra = {}) => ({ id, severity, title, args, details: null, metrics: {}, fixIds: [], ...extra });
const worst = (rows, warn, crit) => rows.filter((r) => r.pct >= warn).sort((a, b) => b.pct - a.pct).map((r) => ({ ...r, severity: r.pct >= crit ? 'crit' : 'warn' }));

/* ---------- проверки: (разобранные данные) → находки ---------- */
export function checkDiskUsage(rows, th = THRESHOLDS) {
  return worst(rows, th.usageWarn, th.usageCrit).map((r) => mk('disk.usage', r.severity, 'Раздел {0} заполнен на {1}%', [r.mount, r.pct], {
    metrics: { mount: r.mount, pct: r.pct, used: r.used, size: r.size, avail: r.avail },
    fixIds: ['docker.prune', 'journal.vacuum', 'docker.logs.truncate'],
  }));
}
export function checkInodes(rows, th = THRESHOLDS) {
  return worst(rows, th.inodeWarn, th.inodeCrit).map((r) => mk('disk.inodes', r.severity, 'Inode на {0} заполнены на {1}%', [r.mount, r.pct], { metrics: { mount: r.mount, pct: r.pct, used: r.used, inodes: r.inodes } }));
}
export function checkDiskTop(rows) {
  if (!rows.length) return [];
  return [mk('disk.top', 'info', 'Что занимает место', [], { metrics: { top: rows.slice(0, 10) } })];
}
export function checkDockerDf(df, th = THRESHOLDS) {
  if (!df.found || df.reclaimable <= th.dockerReclaim) return [];
  return [mk('docker.df', 'warn', 'Docker: можно освободить {0} МБ', [Math.round(df.reclaimable / MB)], { metrics: { reclaimable: df.reclaimable, images: df.images, cache: df.cache, containers: df.containers, volumes: df.volumes }, fixIds: ['docker.prune'] })];
}
export function checkDockerLogs(rows, th = THRESHOLDS) {
  const big = rows.filter((r) => r.size > th.dockerLogBytes);
  if (!big.length) return [];
  const total = big.reduce((s, r) => s + r.size, 0);
  return [mk('docker.logs', 'warn', 'Огромные логи контейнеров: {0} шт., {1} МБ', [big.length, Math.round(total / MB)], { metrics: { files: big.slice(0, 10), total }, fixIds: ['docker.logs.truncate'] })];
}
export function checkJournal(bytes, th = THRESHOLDS) {
  if (bytes == null || bytes <= th.journalBytes) return [];
  return [mk('journal.size', 'warn', 'Журнал systemd занимает {0} МБ', [Math.round(bytes / MB)], { metrics: { bytes }, fixIds: ['journal.vacuum'] })];
}
export function checkSwap(mem, th = THRESHOLDS) {
  if (mem.ram == null || mem.swap == null) return [];
  if (mem.swap === 0 && mem.ram < th.swapRamBytes) return [mk('memory.swap', 'warn', 'Нет swap при {0} МБ RAM', [Math.round(mem.ram / MB)], { metrics: mem, fixIds: ['swap.add'] })];
  if (mem.swap > 0 && mem.swapFree != null && mem.swapFree / mem.swap < 0.1) return [mk('memory.swap', 'warn', 'Swap почти исчерпан: свободно {0}%', [Math.round((mem.swapFree / mem.swap) * 100)], { metrics: mem })];
  return [];
}
export function checkReboot(lines) {
  if (lines[0]?.trim() !== 'yes') return [];
  return [mk('reboot.required', 'info', 'Требуется перезагрузка сервера', [], { details: lines.slice(1).join(', ') || null })];
}

/** Полный разбор вывода DOCTOR_SCRIPT → находки и оценка. */
export function analyze(output, th = THRESHOLDS) {
  const s = sections(output);
  if (!s.END) throw new Error('Неполный ответ сервера');
  const text = (k) => (s[k] ?? []).join('\n');
  const findings = [
    ...checkDiskUsage(parseDf(text('DF')), th), ...checkInodes(parseInodes(text('DFI')), th), ...checkDockerDf(parseDockerDf(text('DOCKERDF')), th),
    ...checkDockerLogs(parseDockerLogs(text('DLOGS')), th), ...checkJournal(parseJournal(text('JOURNAL')), th), ...checkSwap(parseMemory(text('MEM')), th),
    ...checkReboot(s.REBOOT ?? []), ...checkDiskTop(parseTop(text('TOP'))),
  ];
  const order = { crit: 0, warn: 1, info: 2, ok: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { ...healthScore(findings), findings };
}

/* ---------- рецепты: только из каталога ---------- */
const swapScript = (size) => [
  `[ ! -e /swapfile ] || { echo '/swapfile already exists'; exit 1; }`,
  `case "$(findmnt -no FSTYPE / 2>/dev/null)" in btrfs|zfs) echo 'swap file on btrfs/zfs is not created automatically'; exit 1;; esac`,
  `fallocate -l ${size} /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile || { swapoff /swapfile 2>/dev/null; rm -f /swapfile; echo 'swap creation failed, changes rolled back'; exit 1; }`,
  `grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab`,
  `swapon --show; free -m`,
].join('; ');

export const RECIPES = {
  'journal.vacuum': { title: 'Очистить журнал systemd до 100 МБ', risk: 'low', params: [], script: () => 'journalctl --vacuum-size=100M' },
  'docker.prune': { title: 'Очистить билд-кэш и неиспользуемые образы Docker', risk: 'low', params: [], script: () => 'docker builder prune -f && docker image prune -f' },
  'swap.add': {
    title: 'Добавить swap-файл', risk: 'medium', params: ['size'],
    validate: (p) => { const size = p?.size ?? '2G'; if (!SWAP_SIZES.includes(size)) throw new HttpError(400, `Размер swap: ${SWAP_SIZES.join(', ')}`); return { size }; },
    script: ({ size }) => swapScript(size),
  },
  'docker.logs.truncate': { title: 'Обнулить логи контейнеров больше 200 МБ', risk: 'low', params: [], script: () => `find /var/lib/docker/containers -name '*-json.log' -size +200M -exec truncate -s 0 {} +` },
};

/** Проверка запроса на рецепт → готовый скрипт. Любой неизвестный fixId или параметр — 400. */
export function buildFix(fixId, params) {
  const r = Object.hasOwn(RECIPES, String(fixId)) ? RECIPES[fixId] : null;
  if (!r) throw new HttpError(400, 'Неизвестный рецепт исправления');
  const extra = Object.keys(params ?? {}).filter((k) => !r.params.includes(k));
  if (extra.length) throw new HttpError(400, 'Недопустимые параметры рецепта');
  const clean = r.validate ? r.validate(params) : {};
  return { fixId, risk: r.risk, script: r.script(clean), params: clean };
}

const cut = (s) => String(s ?? '').slice(-64 * 1024);

export function serverDoctorRoutes(d) {
  const { manager, audit, panelOr404, assertPanel, hostRun } = d;
  const host = (c, row, script, o) => (hostRun ?? runOnHost)(c, row, script, o);
  const busy = new Set(); // один рецепт на хост одновременно
  const access = (ctx) => { const row = panelOr404(ctx.params.id); assertPanel(ctx, row.id); return row; };
  return [
    ['GET', '/api/panels/:id/doctor', async (ctx) => {
      const row = access(ctx);
      let r;
      try { r = await host(manager.clientFor(row), row, DOCTOR_SCRIPT, { timeoutMs: 90_000 }); } catch (e) { throw e instanceof HttpError ? e : new HttpError(502, e.message); }
      let res;
      try { res = analyze(r.output); } catch (e) { throw new HttpError(502, e.message); }
      audit(ctx, { action: 'doctor.scan', panel: row, target: row.name, detail: `${res.grade} (${res.score}), находок: ${res.findings.length}` });
      return { transport: 'host', checkedAt: Date.now(), recipes: Object.fromEntries(Object.entries(RECIPES).map(([id, x]) => [id, { title: x.title, risk: x.risk, params: x.params }])), ...res };
    }, { admin: true }],
    ['POST', '/api/panels/:id/doctor/fix', async (ctx) => {
      const row = access(ctx); const b = ctx.body ?? {};
      let fix;
      try { fix = buildFix(b.fixId, b.params); } catch (e) {
        audit(ctx, { action: 'doctor.fix', panel: row, target: row.name, ok: false, detail: `отклонено: ${String(b.fixId).slice(0, 40)}` });
        throw e;
      }
      if (busy.has(row.id)) throw new HttpError(409, 'На этом сервере уже выполняется исправление');
      busy.add(row.id);
      try {
        const r = await host(manager.clientFor(row), row, fix.script, { timeoutMs: 120_000 });
        audit(ctx, { action: 'doctor.fix', panel: row, target: row.name, ok: r.ok, detail: `${fix.fixId} ${JSON.stringify(fix.params)}` });
        return { ok: r.ok, fixId: fix.fixId, output: cut(r.output) };
      } catch (e) {
        audit(ctx, { action: 'doctor.fix', panel: row, target: row.name, ok: false, detail: `${fix.fixId}: ${e.message}` });
        throw e instanceof HttpError ? e : new HttpError(502, e.message);
      } finally { busy.delete(row.id); }
    }, { admin: true }],
  ];
}
