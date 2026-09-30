import crypto from 'node:crypto';
import http from 'node:http';

/**
 * Имитация tRPC API Easypanel для тестов и демо. Состояние в памяти.
 * seed: { projects: { name: [{name, type, enabled}] } }
 */

/** Игрушечный «шелл» для тестов консоли: читает маскированные клиентские кадры, понимает echo и $((a+b)). */
export function fakeShell(socket, url, socketFraming, opts = {}) {
  const FR = (opcode, text) => { const p = Buffer.from(text); return Buffer.concat([Buffer.from([0x80 | opcode, p.length]), p]); };
  const pick = (framing, raw) => {
    if (framing === 'raw') return raw;
    let o; try { o = JSON.parse(raw); } catch { return null; }
    const map = { 'json-input': ['input', 'data'], 'json-stdin': ['stdin', 'data'], 'json-data': [null, 'data'], 'json-input-key': [null, 'input'], 'json-command': [null, 'command'] }[framing];
    if (!map) return null;
    if (map[0] && o.type !== map[0]) return null;
    return typeof o[map[1]] === 'string' ? o[map[1]] : null;
  };
  const out = (t) => { if (!socket.destroyed) socket.write(FR(1, framingOut(t))); };
  const framingOut = (t) => (opts.jsonOut ? JSON.stringify({ output: t }) : t); // вывод — сырой текст (или {"output":…}, как у настоящей панели)
  out(`connected ${url.searchParams.get('service') ?? url.searchParams.get('container') ?? 'host'}\r\n# `);
  let buf = Buffer.alloc(0); let line = '';
  const run = (cmd) => {
    const m = /^echo (.*)$/.exec(cmd.trim());
    if (cmd.trim() === 'exit') { socket.end(); return; }
    if (m) {
      const text = m[1].replace(/\$\(\((\d+)\+(\d+)\)\)/g, (_, a, b) => String(Number(a) + Number(b)));
      out(`${text}\r\n# `);
    } else if (cmd.trim()) out(`sh: ${cmd.trim()}: not found\r\n# `); else out('# ');
  };
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 15; let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4); const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len)); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + 4 + len);
      if (opcode === 8) { socket.end(); return; }
      if (opcode !== 1) continue;
      if (opts.strict) { // как настоящая панель: JSON.parse без обработки ошибок — не-JSON кадр роняет процесс панели
        let o; try { o = JSON.parse(payload.toString('utf8')); } catch { opts.onCrash?.(payload.toString('utf8')); socket.destroy(); return; }
        if (o.resize) { opts.onResize?.(o.resize); continue; }
      }
      const text = pick(socketFraming, payload.toString('utf8'));
      if (text == null) continue; // чужой формат — панель молча игнорирует
      out(text.replace(/\n/g, '\r\n')); // эхо набранного
      line += text;
      let i; while ((i = line.indexOf('\n')) >= 0) { const cmd = line.slice(0, i); line = line.slice(i + 1); run(cmd); }
    }
  });
}

export function createMockPanel({ token = 'tok', seed = {}, stats = {}, certs = [], containers = null, logsPath = '/ws/serviceLogs', flatErrors = false, requireType = false, mountStyle = 'flat', containersPerProject = false, statsError = false, newStats = false, noStats = false, onRemove = null, sshKey = null, weirdKey = null, consolePath = null, consoleFraming = 'raw', realPanel = false } = {}) {
  const projects = new Map(Object.entries(seed).map(([n, svcs]) => [n, svcs.map((s) => ({ type: 'app', enabled: true, env: '', domains: [], ports: [], mounts: [], ...s }))]));
  const calls = [];
  const find = (i) => projects.get(i.projectName)?.find((s) => s.name === i.serviceName);
  const need = (s) => { if (!s) throw Object.assign(new Error('Service not found'), { code: 'NOT_FOUND' }); return s; };
  const ok = (v) => v ?? null;
  const drift = () => Math.round((20 + Math.random() * 50) * 10) / 10;

  // «nested»: type — тип сервиса, свойства в mount; «flat»: type — тип монтирования (volume|bind|file)
  const mountBody = (i) => {
    const bad = (m) => Object.assign(new Error(m), { code: 'BAD_REQUEST' });
    if (mountStyle === 'nested') {
      if (!['app', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'compose'].includes(i.type)) throw bad('Invalid service type.');
      if (!i.mount) throw bad('mount required');
      return { type: i.mount.type, name: i.mount.name, mountPath: i.mount.mountPath, hostPath: i.mount.hostPath, content: i.mount.content };
    }
    if (!['volume', 'bind', 'file'].includes(i.type)) throw bad('Invalid mount type.');
    return { type: i.type, name: i.name, mountPath: i.mountPath, hostPath: i.hostPath, content: i.content };
  };
  const procs = {
    'projects.listProjectsAndServices': () => ({
      projects: [...projects.keys()].map((name) => ({ name })),
      services: [...projects.entries()].flatMap(([projectName, l]) => l.map((s) => ({ projectName, name: s.name, type: s.type, enabled: s.enabled }))),
    }),
    'projects.listProjects': () => [...projects.keys()].map((name) => ({ name })),
    'projects.createProject': (i) => { projects.set(i.name, []); return null; },
    'users.listUsers': () => [{ id: 'u1', email: 'admin@example.com', admin: true, apiToken: 'tok-secret' }, { id: 'u2', email: 'dev@example.com', admin: false }],
    'branding.getBasicSettings': () => ({ name: 'Easypanel', apiSecretToken: 'super-secret-value', nested: { password: 'p', visible: 'ok' } }),
    'templates.createFromSchema': (i) => {
      if (!projects.has(i.projectName)) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND' });
      for (const sv of i.schema.services) projects.get(i.projectName).push({ name: sv.data.serviceName, type: sv.type, enabled: true, env: sv.data.env ?? '', domains: [], ports: [], mounts: [], source: sv.data.source, image: sv.data.source?.image });
      return null;
    },
    'projects.destroyProject': (i) => { projects.delete(i.name ?? i.projectName); return null; },
    'monitor.getSystemStats': () => statsError ? (() => { throw Object.assign(new Error(''), { code: 'INTERNAL_SERVER_ERROR', noMessage: true }); })() : ({
      uptime: 123456,
      memInfo: { totalMemMb: 8000, usedMemMb: 3200, freeMemMb: 4800, usedMemPercentage: stats.mem ?? drift(), freeMemPercentage: 40 },
      diskInfo: { totalGb: 100, usedGb: 41, freeGb: 59, usedPercentage: stats.disk ?? 41, freePercentage: 59 },
      cpuInfo: { usedPercentage: stats.cpu ?? drift(), count: 4, loadavg: [0.4, 0.5, 0.6] },
      network: { inputMb: 1200, outputMb: 800 },
    }),
    'domains.listDomains': (i) => need(find(i)).domains,
    'domains.createDomain': (i) => { need(find(i)).domains.push({ id: `d${Date.now()}`, host: i.host, https: i.https, port: i.port }); return null; },
    'domains.deleteDomain': (i) => { const s = need(find(i)); s.domains = s.domains.filter((d) => d.id !== i.id); return null; },
    'ports.listPorts': (i) => { if (requireType && !i.type) throw Object.assign(new Error('Invalid service type.'), { code: 'BAD_REQUEST' }); return need(find(i)).ports; },
    'ports.createPort': (i) => { need(find(i)).ports.push({ id: `p${Date.now()}`, published: i.published, target: i.target, protocol: i.protocol }); return null; },
    'ports.deletePort': (i) => { const s = need(find(i)); s.ports = s.ports.filter((p) => p.id !== i.id); return null; },
    'mounts.listMounts': (i) => { if (requireType && !i.type) throw Object.assign(new Error('Invalid service type.'), { code: 'BAD_REQUEST' }); return need(find(i)).mounts; },
    'mounts.createMount': (i) => { const m = mountBody(i); need(find(i)).mounts.push({ id: `m${Date.now()}${Math.random().toString(36).slice(2, 5)}`, ...m }); return null; },
    'mounts.updateMount': (i) => { const s = need(find(i)); const m = s.mounts.find((x) => x.id === i.id); if (!m) throw Object.assign(new Error('Mount not found'), { code: 'NOT_FOUND' }); Object.assign(m, mountBody(i)); return null; },
    'ports.updatePort': (i) => { const s = need(find(i)); const p = s.ports.find((x) => x.id === i.id); if (!p) throw Object.assign(new Error('Port not found'), { code: 'NOT_FOUND' }); Object.assign(p, { published: i.published, target: i.target, protocol: i.protocol }); return null; },
    'domains.updateDomain': (i) => { const s = need(find(i)); const d = s.domains.find((x) => x.id === i.id); if (!d) throw Object.assign(new Error('Domain not found'), { code: 'NOT_FOUND' }); Object.assign(d, { host: i.host, https: i.https, port: i.port, path: i.path }); return null; },
    'mounts.deleteMount': (i) => { const s = need(find(i)); s.mounts = s.mounts.filter((m) => m.id !== i.id); return null; },
    'common.setNotes': (i) => { need(find(i)).notes = i.notes; return null; },
    'actions.listActions': () => [],
    'certificates.listCertificates': () => certs,
    ...(weirdKey ? { 'settings.getInstanceGitIdentity': () => ({ pub: weirdKey }) } : {}),
    ...(sshKey ? { 'settings.getSshPublicKey': () => ({ publicKey: sshKey }) } : {}),
    'certificates.removeCertificate': (i) => {
      const d = typeof i.domain === 'string' ? i.domain : i.domain?.main ?? i.main ?? i.name;
      const k = certs.findIndex((c) => (typeof c.domain === 'string' ? c.domain : c.domain?.main) === d);
      if (!d || k < 0) throw Object.assign(new Error('Invalid domain'), { code: 'BAD_REQUEST' });
      certs.splice(k, 1); onRemove?.(d); return null;
    },
    'projects.getDockerContainers': (i) => {
      if (containersPerProject && !i.projectName) throw Object.assign(new Error('Input validation failed'), { code: 'BAD_REQUEST' });
      if (containers) return containers;
      const one = (p, s) => ({ Id: `cid-${p}-${s.name}`, Names: [`/${p}_${s.name}.1.abc`], State: s.crash ? 'exited' : 'running', name: `${p}_${s.name}.1.abc`, state: s.crash ? 'exited' : (s.enabled ? 'running' : 'shutdown') });
      // compose-стек: s.parts = имена внутренних сервисов → по контейнеру на каждый, с метками compose
      const part = (p, s, pt) => ({ Id: `cid-${p}-${s.name}-${pt}`, Names: [`/${p}_${s.name}-${pt}-1`], Labels: { 'com.docker.compose.service': pt, 'com.docker.compose.container-number': '1' }, State: 'running', name: `${p}_${s.name}-${pt}-1`, state: 'running' });
      return [...projects.entries()].filter(([p]) => !containersPerProject || p === i.projectName)
        .flatMap(([p, l]) => l.filter((s) => !i.service || `${p}_${s.name}` === i.service).flatMap((s) => (s.parts ? s.parts.map((pt) => part(p, s, pt)) : [one(p, s)])));
    },
    'monitor.getServiceStats': () => ({ cpu: 1.5, memory: 120 }),
    'settings.systemPrune': () => null,
    'settings.cleanupDockerImages': () => null,
    'settings.restartEasypanel': () => null,
    'server.reboot': () => null,
  };
  for (const type of ['app', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'compose']) {
    const db = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'].includes(type);
    procs[`services.${type}.inspectService`] = (i) => { const s = need(find(i)); return { name: s.name, projectName: i.projectName, type, enabled: s.enabled, env: s.env, notes: s.notes ?? '', source: s.source ?? { type: 'image', image: s.image ?? 'nginx:latest' }, resources: s.resources ?? null, build: s.build }; };
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
      procs[`services.${type}.updateSourceGit`] = (i) => { const s = need(find(i)); s.source = { type: 'git', repo: i.repo, ref: i.ref, path: i.path }; return null; };
      procs[`services.${type}.updateSourceGithub`] = (i) => { const s = need(find(i)); s.source = { type: 'github', owner: i.owner, repo: i.repo, ref: i.ref, path: i.path }; return null; };
      procs[`services.${type}.updateSourceDockerfile`] = (i) => { const s = need(find(i)); s.source = { type: 'dockerfile', dockerfile: i.dockerfile }; return null; };
      procs[`services.${type}.updateBuild`] = (i) => { need(find(i)).build = i.build; return null; };
      procs[`services.${type}.updateSourceImage`] = (i) => { const s = need(find(i)); s.image = i.image; s.source = { type: 'image', image: i.image }; return null; };
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if ((newStats || realPanel) && req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><script type="module" src="/assets/app.js"></script></html>'); }
    if (realPanel && url.pathname === '/assets/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('a=`/ws/hostShell`;b=`/ws/containerShell`;c=`/ws/diskUsage`;'); }
    if (newStats && url.pathname === '/assets/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('const a="projects.listProjects",b="system.getResourceUsage",c="monitor.getServiceStats",d="console.log",e="dashboard.getOverview",f="settings.setPanelDomain";' + (consolePath ? `h="${consolePath}";w=new WebSocket("wss://"+location.host+"${consolePath}?token="+t);` : '') + (weirdKey ? 'g="settings.getInstanceGitIdentity";' : '')); }
    const proc = url.pathname.replace('/api/trpc/', '');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const trpcErr = (message, code, httpStatus) => message === '' ? send(httpStatus, { error: { json: { code: -32603, data: { code, httpStatus, path: proc } } } }) : flatErrors ? send(httpStatus, { json: { defined: false, code, status: httpStatus, message } }) : send(httpStatus, { error: { json: { message, code: -32001, data: { code, httpStatus, path: proc } } } });
    if (proc === 'auth.login' && req.method === 'POST') return send(200, { result: { data: { json: { token } } } });
    if (req.headers.authorization !== `Bearer ${token}`) return trpcErr('Unauthorized', 'UNAUTHORIZED', 401);
    let input;
    if (req.method === 'GET') { const q = url.searchParams.get('input'); input = q ? JSON.parse(q).json : undefined; }
    else { const chunks = []; for await (const c of req) chunks.push(c); input = JSON.parse(Buffer.concat(chunks).toString() || '{}').json; }
    calls.push({ proc, input });
    if ((newStats || noStats) && proc.startsWith('monitor.') && proc !== 'monitor.getServiceStats') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Not found"}'); }
    if (newStats && proc === 'system.getResourceUsage') return send(200, { result: { data: { json: { json: { cpu: { percent: 12.5, cores: 4 }, memory: { used: 2048, total: 8192, usedMb: 2048, totalMb: 8192 }, disks: { root: { usedPercentage: 41, usedGb: 41, totalGb: 100 } }, uptime: 5000 } } } } });
    if (newStats && proc === 'dashboard.getOverview') return send(200, { result: { data: { json: { hello: 'world' } } } });
    const fn = procs[proc];
    if (!fn) return trpcErr(`No procedure ${proc}`, 'NOT_FOUND', 404);
    try { send(200, { result: { data: { json: ok(fn(input ?? {})) } } }); }
    catch (e) { trpcErr(e.message, e.code ?? 'INTERNAL_SERVER_ERROR', e.code === 'NOT_FOUND' ? 404 : e.code === 'BAD_REQUEST' ? 400 : 500); }
  });

  // WebSocket логов: текст, JSON, фрагментированное сообщение, ping, затем «тики» до закрытия клиентом
  const frame = (opcode, payload, fin = true) => { const b = Buffer.from(payload); return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, b.length]), b]); };
  const sockets = new Set(); const crashes = []; const resizes = []; const connects = [];
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const url = new URL(req.url, 'http://x');
    const bad = (code) => { socket.end(`HTTP/1.1 ${code} No\r\nContent-Length: 0\r\n\r\n`); };
    const isConsole = consolePath && url.pathname === consolePath;
    const isReal = realPanel && ['/ws/hostShell', '/ws/containerShell'].includes(url.pathname);
    if (url.pathname !== logsPath && !isConsole && !isReal) return bad(404);
    if (url.searchParams.get('token') !== token) return bad(401);
    if (isReal && url.pathname === '/ws/containerShell' && !(url.searchParams.get('container') && url.searchParams.get('command'))) return bad(400); // схема панели требует container и command
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (isReal) connects.push(url.pathname);
    if (isReal) return fakeShell(socket, url, 'json-input-key', { strict: true, jsonOut: true, onCrash: (t) => crashes.push(t), onResize: (r) => resizes.push({ path: url.pathname, size: r, command: url.searchParams.get('command') }) });
    if (isConsole) return fakeShell(socket, url, consoleFraming);
    calls.push({ proc: 'ws', input: { service: url.searchParams.get('service'), compose: url.searchParams.get('compose'), auth: req.headers.authorization } });
    socket.write(frame(1, `line one\n\x1b[31mline two\x1b[0m`));
    if (url.searchParams.get('compose') === 'true') socket.write(frame(1, 'web-1  | hello web\ndb-1   | db ready'));
    socket.write(frame(1, JSON.stringify({ line: 'json line' })));
    socket.write(frame(1, 'frag-', false)); socket.write(frame(9, 'hi')); socket.write(frame(0, 'mented'));
    let n = 0; const t = setInterval(() => { if (!socket.destroyed) socket.write(frame(1, `tick ${++n}`)); }, 40);
    socket.on('data', (d) => { if ((d[0] & 15) === 10) calls.push({ proc: 'ws-pong' }); if ((d[0] & 15) === 8) socket.end(); });
    socket.on('close', () => clearInterval(t)); socket.on('error', () => clearInterval(t));
  });

  return {
    server, calls, projects, token, crashes, resizes, connects,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.closeAllConnections?.(); server.close(r); }),
  };
}
