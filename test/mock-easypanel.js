import http from 'node:http';

/**
 * Имитация tRPC API Easypanel для тестов и демо. Состояние в памяти.
 * seed: { projects: { name: [{name, type, enabled}] } }
 */
export function createMockPanel({ token = 'tok', seed = {}, stats = {}, certs = [], containers = null } = {}) {
  const projects = new Map(Object.entries(seed).map(([n, svcs]) => [n, svcs.map((s) => ({ type: 'app', enabled: true, env: '', domains: [], ports: [], mounts: [], ...s }))]));
  const calls = [];
  const find = (i) => projects.get(i.projectName)?.find((s) => s.name === i.serviceName);
  const need = (s) => { if (!s) throw Object.assign(new Error('Service not found'), { code: 'NOT_FOUND' }); return s; };
  const ok = (v) => v ?? null;
  const drift = () => Math.round((20 + Math.random() * 50) * 10) / 10;

  const procs = {
    'projects.listProjectsAndServices': () => ({
      projects: [...projects.keys()].map((name) => ({ name })),
      services: [...projects.entries()].flatMap(([projectName, l]) => l.map((s) => ({ projectName, name: s.name, type: s.type, enabled: s.enabled }))),
    }),
    'projects.listProjects': () => [...projects.keys()].map((name) => ({ name })),
    'projects.createProject': (i) => { projects.set(i.name, []); return null; },
    'projects.destroyProject': (i) => { projects.delete(i.name ?? i.projectName); return null; },
    'monitor.getSystemStats': () => ({
      uptime: 123456,
      memInfo: { totalMemMb: 8000, usedMemMb: 3200, freeMemMb: 4800, usedMemPercentage: stats.mem ?? drift(), freeMemPercentage: 40 },
      diskInfo: { totalGb: 100, usedGb: 41, freeGb: 59, usedPercentage: stats.disk ?? 41, freePercentage: 59 },
      cpuInfo: { usedPercentage: stats.cpu ?? drift(), count: 4, loadavg: [0.4, 0.5, 0.6] },
      network: { inputMb: 1200, outputMb: 800 },
    }),
    'domains.listDomains': (i) => need(find(i)).domains,
    'domains.createDomain': (i) => { need(find(i)).domains.push({ id: `d${Date.now()}`, host: i.host, https: i.https, port: i.port }); return null; },
    'domains.deleteDomain': (i) => { const s = need(find(i)); s.domains = s.domains.filter((d) => d.id !== i.id); return null; },
    'ports.listPorts': (i) => need(find(i)).ports,
    'ports.createPort': (i) => { need(find(i)).ports.push({ id: `p${Date.now()}`, published: i.published, target: i.target, protocol: i.protocol }); return null; },
    'ports.deletePort': (i) => { const s = need(find(i)); s.ports = s.ports.filter((p) => p.id !== i.id); return null; },
    'mounts.listMounts': (i) => need(find(i)).mounts,
    'mounts.createMount': (i) => { need(find(i)).mounts.push({ id: `m${Date.now()}`, type: i.type, name: i.name, mountPath: i.mountPath }); return null; },
    'mounts.deleteMount': (i) => { const s = need(find(i)); s.mounts = s.mounts.filter((m) => m.id !== i.id); return null; },
    'common.setNotes': (i) => { need(find(i)).notes = i.notes; return null; },
    'actions.listActions': () => [],
    'certificates.listCertificates': () => certs,
    'projects.getDockerContainers': () => {
      if (containers) return containers;
      return [...projects.entries()].flatMap(([p, l]) => l.map((s) => ({ name: `${p}_${s.name}.1.abc`, state: s.crash ? 'exited' : (s.enabled ? 'running' : 'shutdown') })));
    },
    'monitor.getServiceStats': () => ({ cpu: 1.5, memory: 120 }),
    'settings.systemPrune': () => null,
    'settings.cleanupDockerImages': () => null,
    'settings.restartEasypanel': () => null,
    'server.reboot': () => null,
  };
  for (const type of ['app', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'compose']) {
    const db = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'].includes(type);
    procs[`services.${type}.inspectService`] = (i) => { const s = need(find(i)); return { name: s.name, projectName: i.projectName, type, enabled: s.enabled, env: s.env, notes: s.notes ?? '', source: s.source ?? { type: 'image', image: s.image ?? 'nginx:latest' }, resources: s.resources ?? null }; };
    procs[`services.${type}.createService`] = (i) => { if (!projects.has(i.projectName)) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND' }); projects.get(i.projectName).push({ name: i.serviceName ?? i.name, type, enabled: true, env: '', domains: [], ports: [], mounts: [], image: i.source?.image }); return null; };
    procs[`services.${type}.destroyService`] = (i) => { const l = projects.get(i.projectName); l.splice(l.indexOf(need(find(i))), 1); return null; };
    procs[`services.${type}.updateEnv`] = (i) => { need(find(i)).env = i.env; return null; };
    procs[`services.${type}.updateResources`] = (i) => { need(find(i)).resources = { memoryLimit: i.memoryLimit, cpuLimit: i.cpuLimit }; return null; };
    if (db) {
      procs[`services.${type}.enableService`] = (i) => { need(find(i)).enabled = true; return null; };
      procs[`services.${type}.disableService`] = (i) => { need(find(i)).enabled = false; return null; };
    } else {
      procs[`services.${type}.deployService`] = (i) => { need(find(i)).enabled = true; return null; };
      procs[`services.${type}.startService`] = (i) => { need(find(i)).enabled = true; return null; };
      procs[`services.${type}.stopService`] = (i) => { need(find(i)).enabled = false; return null; };
      procs[`services.${type}.restartService`] = (i) => { need(find(i)).enabled = true; return null; };
      procs[`services.${type}.updateSourceImage`] = (i) => { const s = need(find(i)); s.image = i.image; s.source = { type: 'image', image: i.image }; return null; };
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const proc = url.pathname.replace('/api/trpc/', '');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const trpcErr = (message, code, httpStatus) => send(httpStatus, { error: { json: { message, code: -32001, data: { code, httpStatus, path: proc } } } });
    if (proc === 'auth.login' && req.method === 'POST') return send(200, { result: { data: { json: { token } } } });
    if (req.headers.authorization !== `Bearer ${token}`) return trpcErr('Unauthorized', 'UNAUTHORIZED', 401);
    let input;
    if (req.method === 'GET') { const q = url.searchParams.get('input'); input = q ? JSON.parse(q).json : undefined; }
    else { const chunks = []; for await (const c of req) chunks.push(c); input = JSON.parse(Buffer.concat(chunks).toString() || '{}').json; }
    calls.push({ proc, input });
    const fn = procs[proc];
    if (!fn) return trpcErr(`No procedure ${proc}`, 'NOT_FOUND', 404);
    try { send(200, { result: { data: { json: ok(fn(input ?? {})) } } }); }
    catch (e) { trpcErr(e.message, e.code ?? 'INTERNAL_SERVER_ERROR', e.code === 'NOT_FOUND' ? 404 : 500); }
  });

  return {
    server, calls, projects, token,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
