import { runOnHost } from './host-exec.js';

/**
 * Снимок «что грузит сервер»: фиксированные команды только на чтение через консоль хоста Easypanel.
 * Каждый процесс привязывается к контейнеру по cgroup (id контейнера → сервис); процессы без контейнера — «система».
 */
export const SNAPSHOT_SCRIPT = [
  `P() { printf '%s\\n' "$1"; }`,
  `T=$(top -b -n 2 -d 1 -w 512 2>/dev/null | awk '/^top - /{n++} n==2' | head -n 24)`,
  `PM=$(ps -ww -eo pid=,user=,rss=,args= --sort=-rss 2>/dev/null | head -n 10)`,
  `P '##LOAD'; cat /proc/loadavg`,
  `P '##TOP'; printf '%s\\n' "$T"`,
  `P '##MEM'; grep -E '^(MemTotal|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo`,
  `P '##DISK'; df -Pk / | tail -n 1`,
  `P '##PSMEM'; printf '%s\\n' "$PM"`,
  `P '##CG'; for p in $(printf '%s\\n' "$T" | awk '$1 ~ /^[0-9]+$/ {print $1}' | head -n 15) $(printf '%s\\n' "$PM" | awk '{print $1}'); do id=$(grep -o '[0-9a-f]\\{64\\}' /proc/$p/cgroup 2>/dev/null | head -n 1); [ -n "$id" ] && echo "$p $id"; done`,
  `P '##END'`,
].join('; ');

const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Разбор вывода SNAPSHOT_SCRIPT. containers — список из monitorOld.getMonitorTableData (для привязки процессов к сервисам). */
export function parseSnapshot(output, containers = []) {
  const sections = {}; let cur = null;
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r/g, '');
    const m = /^##([A-Z]+)$/.exec(line);
    if (m) { cur = m[1]; sections[cur] = []; continue; }
    if (cur && line.trim()) sections[cur].push(line);
  }
  if (!sections.END) throw new Error('Неполный ответ сервера');
  const byId = new Map(containers.map((c) => [String(c.id), { project: c.projectName, service: c.serviceName, container: c.containerName }]));
  const cg = new Map((sections.CG ?? []).map((l) => l.trim().split(/\s+/)).filter((x) => x.length === 2).map(([pid, id]) => [pid, id]));
  const owner = (pid) => { const id = cg.get(String(pid)); if (!id) return null; return byId.get(id) ?? { project: null, service: null, container: id.slice(0, 12) }; };

  const load = (sections.LOAD?.[0] ?? '').trim().split(/\s+/).slice(0, 3).map(num);
  const cpuLine = (sections.TOP ?? []).find((l) => /^%Cpu/.test(l)) ?? '';
  const g = (re) => { const m = re.exec(cpuLine); return m ? num(m[1]) : null; };
  const cpu = { user: g(/([\d.,]+)\s*us/), system: g(/([\d.,]+)\s*sy/), iowait: g(/([\d.,]+)\s*wa/), steal: g(/([\d.,]+)\s*st/), idle: g(/([\d.,]+)\s*id/) };
  const mem = Object.fromEntries((sections.MEM ?? []).map((l) => /^(\w+):\s+(\d+)/.exec(l)).filter(Boolean).map((m) => [m[1], Number(m[2]) * 1024]));
  const disk = (() => { const p = (sections.DISK?.[0] ?? '').trim().split(/\s+/); return p.length >= 5 ? { total: Number(p[1]) * 1024, used: Number(p[2]) * 1024, pct: num(String(p[4]).replace('%', '')) } : null; })();
  const procs = [];
  let inTable = false;
  for (const l of sections.TOP ?? []) {
    if (/^\s*PID\s+USER/.test(l)) { inTable = true; continue; }
    if (!inTable) continue;
    const m = /^\s*(\d+)\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+([\d.,]+)\s+([\d.,]+)\s+\S+\s+(.*)$/.exec(l);
    if (m) procs.push({ pid: Number(m[1]), user: m[2], cpu: num(m[4]), memPct: num(m[5]), rss: m[3], command: short(m[6].trim()), owner: owner(m[1]) });
  }
  const memTop = (sections.PSMEM ?? []).map((l) => /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), user: m[2], rss: Number(m[3]) * 1024, command: short(m[4].trim()), owner: owner(m[1]) }));
  return {
    load: { m1: load[0] ?? null, m5: load[1] ?? null, m15: load[2] ?? null }, cpu,
    memory: { total: mem.MemTotal ?? null, available: mem.MemAvailable ?? null, used: mem.MemTotal != null && mem.MemAvailable != null ? mem.MemTotal - mem.MemAvailable : null, cache: (mem.Cached ?? 0) + (mem.Buffers ?? 0), swapTotal: mem.SwapTotal ?? 0, swapUsed: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0) },
    disk, processes: procs.filter((p) => p.cpu != null).slice(0, 15), memoryTop: memTop,
  };
}

/** Сводка для уведомления: 3 самых активных процесса и чьи они. */
export function topLines(snap, n = 3) {
  const label = (p) => `${p.owner?.service ?? (p.owner ? `контейнер ${p.owner.container}` : 'система')}`;
  return snap.processes.slice(0, n).map((p) => `${p.command.split(' ')[0].split('/').pop()} (${label(p)}) ${p.cpu}%`);
}

export async function takeSnapshot(c, row, containers) {
  const r = await runOnHost(c, row, SNAPSHOT_SCRIPT, { timeoutMs: 40_000 });
  return parseSnapshot(r.output, containers);
}
