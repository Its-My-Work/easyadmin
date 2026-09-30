import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';
import { decrypt, encrypt, randomToken, sha256 } from './crypto.js';
import { ACTIONS, SYSTEM_OPS, discoverBundle, discoverProcedures, firstOk, SERVICE_TYPES, inspectService, normalizeTree, redact, runAction, runServiceOp, shapeOf } from './easypanel.js';
import { EVENT_TYPES } from './alerts.js';
import { CatalogError, createCatalog } from './catalog.js';
import { ConsoleError, consoleCandidates } from './console.js';
import { HttpError, RawResponse, SECURITY_HEADERS, StreamResponse } from './http.js';
import { extractLines, logSocketCandidates, openWebSocket } from './ws.js';
import { applyConfig, extractConfig, mergeEnv, parseEnvLines } from './templates.js';

const CHANNEL_TYPES = ['telegram', 'webhook', 'email'];

/** Дополнительные маршруты: уведомления, шаблоны, клонирование, расписания, вебхуки, инвентарь, история, бэкап. */
export function extraRoutes(d) {
  const { db, key, config, manager, alerts, audit, mutateAudited, need, str, nameOf, asHttp, panelOr404, assertPanel, canPanel } = d;
  const now = () => Date.now();
  const treeOf = async (row) => (await manager.snapshot(row.id))?.tree?.projects ?? [];
  const accessible = (ctx) => db.prepare('SELECT * FROM panels ORDER BY position, id').all().filter((p) => canPanel(ctx.user, p.id));
  const ref = (t) => ({ type: t.type, project: nameOf(t.project, 'project'), name: nameOf(t.name, 'service') });

  /* ---------------- уведомления ---------------- */
  const cleanChannel = (b, old) => {
    need(CHANNEL_TYPES.includes(b.type), 'Тип канала: telegram, webhook или email');
    const cfg = { ...(old?.config ?? {}) };
    if (b.type === 'telegram') {
      if (b.botToken) cfg.botToken = String(b.botToken); if (b.chatId) cfg.chatId = String(b.chatId);
      need(cfg.botToken && cfg.chatId, 'Укажите токен бота и chat id');
    } else if (b.type === 'email') {
      for (const k of ['host', 'user', 'from', 'to']) if (b[k] !== undefined && b[k] !== '') cfg[k] = String(b[k]).trim();
      if (b.pass) cfg.pass = String(b.pass);
      if (b.port) cfg.port = Number(b.port);
      cfg.port ??= 587;
      if (b.security) { need(['starttls', 'tls', 'none'].includes(b.security), 'Шифрование: starttls, tls или none'); cfg.security = b.security; }
      cfg.security ??= 'starttls';
      if (b.insecureTls !== undefined) cfg.insecureTls = !!b.insecureTls;
      need(cfg.host && cfg.from && cfg.to, 'Укажите SMTP-сервер, отправителя и получателей');
      need(Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536, 'Некорректный порт');
    } else {
      if (b.url) { try { const u = new URL(b.url); need(['http:', 'https:'].includes(u.protocol), 'URL должен быть http(s)'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Некорректный URL'); } cfg.url = String(b.url); }
      if (b.secret !== undefined) cfg.secret = String(b.secret);
      need(cfg.url, 'Укажите URL webhook');
    }
    const events = (Array.isArray(b.events) ? b.events : alerts.defaultEvents).filter((e) => EVENT_TYPES[e]);
    return { name: str(b.name, 'Укажите название', 80), type: b.type, config_enc: alerts.seal(cfg), events: events.join(','), enabled: b.enabled === false ? 0 : 1 };
  };

  const channelRoutes = [
    ['GET', '/api/channels', () => ({ channels: alerts.list().map(alerts.publicChannel), eventTypes: EVENT_TYPES }), { admin: true }],
    ['POST', '/api/channels', (ctx) => {
      const c = cleanChannel(ctx.body);
      db.prepare('INSERT INTO channels (name, type, config_enc, events, enabled) VALUES (?,?,?,?,?)').run(c.name, c.type, c.config_enc, c.events, c.enabled);
      audit(ctx, { action: 'channel.add', target: c.name });
      return { ok: true };
    }, { admin: true }],
    ['PUT', '/api/channels/:id', (ctx) => {
      const old = alerts.list().find((c) => c.id === Number(ctx.params.id));
      need(old, 'Канал не найден');
      const c = cleanChannel({ type: old.type, ...ctx.body }, old);
      db.prepare('UPDATE channels SET name=?, config_enc=?, events=?, enabled=? WHERE id=?').run(c.name, c.config_enc, c.events, c.enabled, old.id);
      return { ok: true };
    }, { admin: true }],
    ['DELETE', '/api/channels/:id', (ctx) => { db.prepare('DELETE FROM channels WHERE id = ?').run(Number(ctx.params.id)); return { ok: true }; }, { admin: true }],
    ['POST', '/api/channels/:id/test', async (ctx) => {
      const c = alerts.list().find((x) => x.id === Number(ctx.params.id));
      need(c, 'Канал не найден');
      try { await alerts.sendTo(c, { type: 'test', icon: '✅', text: 'EasyAdmin: тестовое уведомление' }); return { ok: true }; } catch (e) { throw new HttpError(502, e.message); }
    }, { admin: true }],
  ];

  /* ---------------- публичный SSH-ключ панели (deploy key для git@… репозиториев) ---------------- */
  const SSH_CANDIDATES = ['settings.getPublicKey', 'settings.getSshPublicKey', 'settings.getPublicSshKey', 'settings.getGitPublicKey', 'settings.getSshKey', 'settings.getDeployKey', 'settings.getGitSshKey', 'git.getPublicKey', 'git.getSshKey', 'ssh.getPublicKey'];
  const findKey = (v, d = 0) => {
    if (typeof v === 'string') return /ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-/.test(v) ? v.trim() : null;
    if (v && typeof v === 'object' && d < 3) for (const x of Object.values(v)) { const r = findKey(x, d + 1); if (r) return r; }
    return null;
  };
  const sshSaved = (id) => db.prepare('SELECT v FROM settings WHERE k = ?').get(`ssh_proc_${id}`)?.v;
  const sshRoutes = [
    // Публичный ключ панели: пробуем сохранённую/выбранную процедуру, известные названия, затем безопасно (только get/list/inspect) все похожие из интерфейса панели
    ['GET', '/api/panels/:id/ssh-key', async (ctx) => {
      const row = panelOr404(ctx.params.id);
      const c = manager.clientFor(row);
      const wanted = ctx.url.searchParams.get('proc');
      if (wanted) need(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(wanted), 'Некорректное название процедуры');
      const tryProc = async (proc) => { try { return findKey(await c.query(proc)); } catch { return null; } };
      const remember = (proc) => { db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(`ssh_proc_${row.id}`, proc); };
      if (wanted) { const key = await tryProc(wanted); if (key) { remember(wanted); return { key, proc: wanted }; } return { key: null, tried: [wanted], candidates: [] }; }
      for (const proc of [sshSaved(row.id), ...SSH_CANDIDATES].filter(Boolean)) { const key = await tryProc(proc); if (key) { remember(proc); return { key, proc }; } }
      const found = await discoverProcedures(row.url, { insecure: !!row.insecure_tls, timeoutMs: config.requestTimeoutMs }).catch(() => []);
      const READ = /\.(get|list|inspect|read)[A-Z]/;
      const related = found.filter((n) => !SSH_CANDIDATES.includes(n) && /ssh|public.?key|deploy.?key|git|github|secret|token|key/i.test(n));
      const probe = related.filter((n) => READ.test(n)).slice(0, 30);
      for (let i = 0; i < probe.length; i += 6) {
        const res = await Promise.all(probe.slice(i, i + 6).map(async (proc) => ({ proc, key: await tryProc(proc) })));
        const hit = res.find((r) => r.key); if (hit) { remember(hit.proc); return { key: hit.key, proc: hit.proc }; }
      }
      return { key: null, tried: [...SSH_CANDIDATES, ...probe], candidates: related.slice(0, 40), discovered: found.length };
    }, { admin: true }],
  ];

  /* ---------------- настройки (язык уведомлений) ---------------- */
  const settingsRoutes = [
    ['GET', '/api/settings', () => ({ notifyLang: alerts.getLang() }), { admin: true }],
    ['PUT', '/api/settings', (ctx) => {
      if (ctx.body.notifyLang !== undefined) { need(['ru', 'en'].includes(ctx.body.notifyLang), 'Language: ru or en'); alerts.setLang(ctx.body.notifyLang); }
      return { notifyLang: alerts.getLang() };
    }, { admin: true }],
  ];

  /* ---------------- диагностика ответов панели ---------------- */
  // значения полей pass/secret/token/key в сыром теле ответа скрываем
  const SECRET_JSON = new RegExp('("[^"]*(?:pass|secret|token|key)[^"]*"\\s*:\\s*)"[^"]*"', 'gi');
  const redactJson = (body) => String(body).replace(SECRET_JSON, '$1"***"');
  const diagRoutes = [
    ['GET', '/api/panels/:id/diagnose', async (ctx) => {
      const row = panelOr404(ctx.params.id);
      const c = manager.clientFor(row);
      const procs = ['projects.listProjectsAndServices', 'projects.listProjects', 'monitor.getSystemStats', 'monitor.getAdvancedStats', 'projects.getDockerContainers', 'certificates.listCertificates', 'actions.listActions'];
      // getDockerContainers требует projectName, listDomains — проект и сервис: подставляем первые из дерева
      const tree = await treeOf(row).catch(() => []);
      const p0 = tree.find((p) => p.services.length) ?? tree[0], s0 = p0?.services.find((x) => x.type === 'app') ?? p0?.services[0];
      if (s0) procs.push('domains.listDomains');
      const inputOf = (proc) => (proc === 'actions.listActions' ? {} : proc === 'projects.getDockerContainers' && p0 ? { projectName: p0.name }
        : proc === 'domains.listDomains' ? { projectName: p0.name, serviceName: s0.name } : undefined);
      const results = await Promise.all(procs.map(async (proc) => {
        const t0 = now();
        try {
          const v = await c.query(proc, inputOf(proc));
          const sample = JSON.stringify(redact(v), null, 1) ?? 'undefined';
          return { proc, ok: true, ms: now() - t0, shape: shapeOf(v), sample: sample.slice(0, 2500), ...(proc === 'projects.listProjectsAndServices' ? { recognized: normalizeTree(v).projects.map((p) => `${p.name} (${p.services.length})`) } : {}) };
        } catch (e) { return { proc, ok: false, ms: now() - t0, error: e.message, kind: e.kind, status: e.status, body: e.body ? redactJson(e.body) : undefined }; }
      }));
      const discovered = (await discoverProcedures(row.url, { insecure: !!row.insecure_tls, timeoutMs: config.requestTimeoutMs }).catch(() => [])).filter((n) => /stat|monitor|metric|usage|resource|system|docker|container|cpu|memory|disk|cert/i.test(n)).slice(0, 80);
      return { panel: row.name, url: row.url, results, discovered };
    }, { admin: true }],
  ];

  /* ---------------- живые логи сервиса (WebSocket панели → SSE) ---------------- */
  const logRoutes = [
    ['GET', '/api/panels/:id/logs', (ctx) => {
      const row = panelOr404(ctx.params.id); const q = ctx.url.searchParams;
      const r = ref({ type: q.get('type'), project: q.get('project'), name: q.get('name') });
      return new StreamResponse(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
        const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        let ws = null, closed = false;
        const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
        const cleanup = () => { closed = true; clearInterval(hb); ws?.close(); };
        req.on('close', cleanup);
        const c = manager.clientFor(row);
        const errors = [];
        for (const url of logSocketCandidates(c.base, { project: r.project, name: r.name, token: c.token, paths: config.logsPaths })) {
          if (closed) return;
          try { ws = await openWebSocket(url, { headers: { Authorization: `Bearer ${c.token}`, Origin: new URL(c.base).origin }, insecure: !!row.insecure_tls }); break; }
          catch (e) { errors.push(`${new URL(url).pathname}: ${e.message}`); }
        }
        if (closed) { ws?.close(); return; }
        if (!ws) { send('status', { state: 'error', message: `Не удалось подключиться к логам (${errors.join('; ')}). Путь WebSocket зависит от версии Easypanel — его можно задать переменной EASYPANEL_LOGS_PATHS.` }); clearInterval(hb); return res.end(); }
        send('status', { state: 'connected' });
        ws.on('message', (m) => { for (const line of extractLines(m)) send('line', line); });
        ws.on('error', (e) => send('status', { state: 'error', message: e.message }));
        ws.on('close', () => { send('status', { state: 'closed' }); clearInterval(hb); res.end(); });
      });
    }, { min: 'operator' }],
  ];

  /* ---------------- консоль сервиса (терминал в контейнере через WebSocket панели) ---------------- */
  const hub = d.consoleHub;
  const consoleOn = () => { if (config.consoleEnabled === false) throw new HttpError(404, 'Консоль отключена (EASYADMIN_CONSOLE=off)'); };
  const consoleErr = (e) => { if (e instanceof ConsoleError) throw new HttpError(e.status, e.message, e.extra); throw e; };
  const consoleRoutes = [
    // пути WebSocket, найденные в интерфейсе панели, — для диагностики и ручного выбора
    ['GET', '/api/panels/:id/console/paths', async (ctx) => {
      consoleOn();
      const row = panelOr404(ctx.params.id);
      const { wsPaths } = await discoverBundle(row.url, { insecure: !!row.insecure_tls, timeoutMs: config.requestTimeoutMs }).catch(() => ({ wsPaths: [] }));
      return { known: config.consolePaths, found: wsPaths, related: wsPaths.filter((x) => /console|terminal|exec|shell|tty/i.test(x)) };
    }, { admin: true }],
    ['POST', '/api/panels/:id/console', async (ctx) => {
      consoleOn();
      const row = panelOr404(ctx.params.id); assertPanel(ctx, row.id);
      const r = ref({ type: ctx.body.type, project: ctx.body.project, name: ctx.body.name });
      const c = manager.clientFor(row);
      let paths = [];
      if (ctx.body.path) { need(/^\/[A-Za-z0-9_\/-]{1,80}$/.test(String(ctx.body.path)), 'Некорректный путь WebSocket'); paths = [String(ctx.body.path)]; }
      else {
        const { wsPaths } = await discoverBundle(row.url, { insecure: !!row.insecure_tls, timeoutMs: config.requestTimeoutMs }).catch(() => ({ wsPaths: [] }));
        paths = [...new Set([...config.consolePaths, ...wsPaths.filter((x) => /console|terminal|exec|shell|tty/i.test(x))])];
      }
      const urls = consoleCandidates(c.base, { project: r.project, name: r.name, type: r.type, token: c.token, paths });
      try {
        const s = await hub.open({ userId: ctx.user.id, urls, headers: { Authorization: `Bearer ${c.token}`, Origin: new URL(c.base).origin }, insecure: !!row.insecure_tls, framing: ctx.body.framing });
        audit(ctx, { action: 'console.open', panel: row, target: `${r.project}/${r.name}`, detail: `${s.path} · ${s.framing}` });
        return s;
      } catch (e) {
        audit(ctx, { action: 'console.open', panel: row, target: `${r.project}/${r.name}`, ok: false, detail: e.message });
        return consoleErr(e);
      }
    }, { admin: true }],
    ['GET', '/api/console/:cid/stream', (ctx) => {
      consoleOn();
      let unsub = null;
      try { hub.info(ctx.params.cid, ctx.user.id); } catch (e) { return consoleErr(e); }
      return new StreamResponse(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
        const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
        req.on('close', () => { clearInterval(hb); unsub?.(); });
        try { unsub = hub.subscribe(ctx.params.cid, ctx.user.id, (event, data) => { send(event, data); if (event === 'status' && data.state === 'closed') { clearInterval(hb); res.end(); } }); } catch (e) { send('status', { state: 'closed', message: e.message }); clearInterval(hb); res.end(); }
      });
    }, { admin: true }],
    ['POST', '/api/console/:cid/input', (ctx) => { consoleOn(); try { hub.input(ctx.params.cid, ctx.user.id, ctx.body.data); return { ok: true }; } catch (e) { return consoleErr(e); } }, { admin: true }],
    ['POST', '/api/console/:cid/framing', (ctx) => { consoleOn(); try { return { framing: hub.setFraming(ctx.params.cid, ctx.user.id, ctx.body.framing) }; } catch (e) { return consoleErr(e); } }, { admin: true }],
    ['DELETE', '/api/console/:cid', (ctx) => {
      consoleOn();
      try { const info = hub.close(ctx.params.cid, ctx.user.id); audit(ctx, { action: 'console.close', target: info.path, detail: `команд: ${info.commands}` }); return { ok: true }; } catch (e) { return consoleErr(e); }
    }, { admin: true }],
  ];

  /* ---------------- настройки панели: процедуры, найденные в интерфейсе панели ---------------- */
  const SETTINGS_NS = ['settings', 'branding', 'users', 'git', 'github', 'docker', 'traefik', 'cluster', 'notifications', 'backups', 'system', 'auth'];
  const SETTINGS_SEED = ['settings.systemPrune', 'settings.cleanupDockerImages', 'settings.restartEasypanel', 'branding.getBasicSettings', 'users.listUsers', 'users.generateApiToken', 'users.revokeApiToken'];
  const settingsRoutes2 = [
    ['GET', '/api/panels/:id/settings/procedures', async (ctx) => {
      const row = panelOr404(ctx.params.id);
      const found = await discoverProcedures(row.url, { insecure: !!row.insecure_tls, timeoutMs: config.requestTimeoutMs }).catch(() => []);
      const names = [...new Set([...SETTINGS_SEED, ...found])].filter((n) => SETTINGS_NS.includes(n.split('.')[0]));
      const READ = /^(get|list|inspect|read|is|has|check|find)[A-Z]/;
      const DANGER = /^(delete|remove|reset|reboot|restart|prune|cleanup|destroy|revoke|disable|stop|shutdown|kill|clear|purge)/i;
      const items = names.map((n) => { const [ns, proc] = n.split('.'); return { name: n, ns, kind: READ.test(proc) ? 'read' : 'write', danger: DANGER.test(proc), getter: READ.test(proc) ? null : names.find((g) => g.startsWith(`${ns}.get`) && g.slice(`${ns}.get`.length) === proc.replace(/^(set|update|save|change|enable|disable)/, '')) ?? null }; })
        .sort((a, b) => a.ns.localeCompare(b.ns) || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'read' ? -1 : 1));
      return { items, discovered: found.length };
    }, { admin: true }],
  ];

  /* ---------------- история нагрузки ---------------- */
  const historyRoutes = [
    ['GET', '/api/panels/:id/history', (ctx) => {
      const row = panelOr404(ctx.params.id);
      const hours = Math.min(Math.max(Number(ctx.url.searchParams.get('hours')) || 24, 1), 168);
      return db.prepare('SELECT ts, cpu, mem, disk FROM stats_history WHERE panel_id = ? AND ts > ? ORDER BY ts').all(row.id, now() - hours * 3600_000);
    }],
    ['GET', '/api/panels/:id/service-stats', async (ctx) => {
      const row = panelOr404(ctx.params.id); const q = ctx.url.searchParams;
      try { return { stats: await manager.clientFor(row).query('monitor.getServiceStats', { projectName: nameOf(q.get('project'), 'project'), serviceName: nameOf(q.get('name'), 'service') }) }; } catch (e) { throw asHttp(e); }
    }],
  ];

  /* ---------------- шаблоны и клонирование ---------------- */
  const summary = (cfg) => ({ image: cfg.source?.image ?? (cfg.source?.owner ? `${cfg.source.owner}/${cfg.source.repo}` : cfg.source?.repo ? String(cfg.source.repo).replace(/\/\/[^/@]*@/, '//') : cfg.source?.dockerfile ? 'Dockerfile' : null), envLines: cfg.env ? cfg.env.split('\n').filter(Boolean).length : 0 });
  const openTpl = (r) => ({ ...r, cfg: JSON.parse(decrypt(key, r.config_enc)) });
  const deployTo = async (ctx, cfg, to, deploy) => {
    assertPanel(ctx, to.panelId);
    const row = panelOr404(to.panelId);
    const target = { project: nameOf(to.project, 'project'), name: nameOf(to.name, 'service') };
    const existing = (await treeOf(row)).map((p) => p.name);
    if ((await treeOf(row)).some((p) => p.name === target.project && p.services.some((s) => s.name === target.name))) throw new HttpError(409, `Сервис ${target.project}/${target.name} уже существует на панели «${row.name}»`);
    const steps = await mutateAudited(ctx, row, 'service.clone', `${target.project}/${target.name} (${cfg.type})`, () => applyConfig(manager.clientFor(row), target, cfg, { deploy, existingProjects: existing }));
    return { ok: steps.every((s) => s.ok), steps };
  };

  /** Развернуть схему {services:[{type,data}]} на панели: templates.createFromSchema {projectName, schema} (общая часть импорта и каталога). */
  async function importSchema(ctx, row, project, schemaIn, action) {
    let schema = schemaIn;
    if (typeof schema === 'string') { try { schema = JSON.parse(schema); } catch { throw new HttpError(400, 'Схема — некорректный JSON'); } }
    need(schema && typeof schema === 'object' && !Array.isArray(schema), 'Схема должна быть объектом вида {"services": [...]}');
    need(Array.isArray(schema.services) && schema.services.length > 0 && schema.services.length <= 30, 'В схеме должен быть непустой список services (до 30)');
    for (const svc of schema.services) {
      need(svc && ['app', 'compose', ...SERVICE_TYPES].includes(svc.type), `Неизвестный тип сервиса в схеме: ${svc?.type ?? '—'}`);
      need(svc.data && typeof svc.data === 'object' && typeof svc.data.serviceName === 'string', 'У каждого сервиса в схеме должен быть data.serviceName');
      nameOf(svc.data.serviceName, 'service');
    }
    const c = manager.clientFor(row);
    try {
      const existing = await treeOf(row);
      const taken = schema.services.map((x) => x.data.serviceName).filter((n) => existing.some((p) => p.name === project && p.services.some((y) => y.name === n)));
      need(!taken.length, `В проекте ${project} уже есть сервис: ${taken.join(', ')}`);
      if (!existing.some((p) => p.name === project)) await c.mutate('projects.createProject', { name: project });
      await mutateAudited(ctx, row, action, `${project}: ${schema.services.map((x) => `${x.type}/${x.data.serviceName}`).join(', ')}`.slice(0, 200), () => c.mutate('templates.createFromSchema', { projectName: project, schema }));
      manager.invalidate(row.id);
      return { ok: true, services: schema.services.length };
    } catch (e) { throw asHttp(e); }
  }

  /* ---------------- каталог шаблонов Easypanel ---------------- */
  const catalog = createCatalog({ base: config.catalogUrl, fetchImpl: d.fetchImpl ?? globalThis.fetch });
  const catalogOn = () => { if (config.catalogEnabled === false) throw new HttpError(404, 'Каталог отключён (EASYADMIN_CATALOG=off)'); };
  const catalogErr = (e) => { if (e instanceof CatalogError) throw new HttpError(e.status, e.message); throw e; };
  const catalogRoutes = [
    ['GET', '/api/catalog', async (ctx) => {
      catalogOn();
      try { const r = await catalog.list({ force: ctx.url.searchParams.get('refresh') === '1' && ctx.user.role === 'admin' }); return { items: r.items, tags: r.tags, fetchedAt: r.at }; } catch (e) { return catalogErr(e); }
    }],
    ['GET', '/api/catalog/logo/:slug', async (ctx) => {
      catalogOn();
      try {
        const l = await catalog.logo(ctx.params.slug);
        return new RawResponse(l.body, l.type, { 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      } catch (e) { return catalogErr(e); }
    }],
    ['GET', '/api/catalog/:slug', async (ctx) => { catalogOn(); try { return await catalog.details(ctx.params.slug); } catch (e) { return catalogErr(e); } }],
    // предпросмотр схемы для выбранных значений формы (ничего не разворачивает)
    ['POST', '/api/catalog/:slug/schema', async (ctx) => {
      catalogOn();
      try { const r = await catalog.schemaFor(ctx.params.slug, ctx.body.values ?? {}); return { schema: r.schema }; } catch (e) { return catalogErr(e); }
    }, { admin: true }],
    ['POST', '/api/panels/:id/catalog/:slug/deploy', async (ctx) => {
      catalogOn();
      const row = panelOr404(ctx.params.id); assertPanel(ctx, row.id);
      const project = nameOf(ctx.body.project, 'project');
      let schema;
      try { schema = (await catalog.schemaFor(ctx.params.slug, ctx.body.values ?? {})).schema; } catch (e) { return catalogErr(e); }
      return importSchema(ctx, row, project, schema, 'template.catalog');
    }, { admin: true }],
  ];

  const templateRoutes = [
    ['GET', '/api/templates', () => db.prepare('SELECT * FROM templates ORDER BY id DESC').all().map(openTpl).map((t) => ({ id: t.id, name: t.name, type: t.type, origin: t.origin, createdAt: t.created_at, ...summary(t.cfg) }))],
    ['POST', '/api/templates', async (ctx) => {
      const r = ref(ctx.body); const row = panelOr404(ctx.body.panelId); assertPanel(ctx, row.id);
      try {
        const cfg = await extractConfig(manager.clientFor(row), r);
        db.prepare('INSERT INTO templates (name, type, config_enc, origin, created_at) VALUES (?,?,?,?,?)').run(str(ctx.body.templateName, 'Укажите название шаблона', 80), r.type, encrypt(key, JSON.stringify(cfg)), `${row.name} · ${r.project}/${r.name}`, now());
        audit(ctx, { action: 'template.save', panel: row, target: `${r.project}/${r.name}` });
        return { ok: true };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],
    ['DELETE', '/api/templates/:id', (ctx) => { db.prepare('DELETE FROM templates WHERE id = ?').run(Number(ctx.params.id)); return { ok: true }; }, { admin: true }],
    ['POST', '/api/templates/:id/deploy', async (ctx) => {
      const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(ctx.params.id));
      need(t, 'Шаблон не найден');
      try { return await deployTo(ctx, openTpl(t).cfg, ctx.body, !!ctx.body.deploy); } catch (e) { throw asHttp(e); }
    }, { admin: true }],
    // Экспорт нашего шаблона в схему Easypanel ({services:[{type,data}]}) — её можно вставить в «Create from JSON» панели
    ['GET', '/api/templates/:id/schema', (ctx) => {
      const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(ctx.params.id)); need(t, 'Шаблон не найден');
      const { cfg } = openTpl(t);
      const serviceName = String(t.name).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'service';
      const data = { serviceName };
      if (cfg.env) data.env = cfg.env;
      if (cfg.type === 'app' && cfg.source) data.source = cfg.source;
      if (cfg.type === 'app' && cfg.build) data.build = cfg.build;
      const body = JSON.stringify({ services: [{ type: cfg.type, data }] }, null, 2);
      return new RawResponse(body, 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="${serviceName}.easypanel.json"` });
    }, { admin: true }],
    // Развернуть схему шаблона Easypanel (как «Create from JSON» в панели): templates.createFromSchema {projectName, schema}
    ['POST', '/api/panels/:id/templates/import', async (ctx) => {
      const row = panelOr404(ctx.params.id); assertPanel(ctx, row.id);
      return importSchema(ctx, row, nameOf(ctx.body.project, 'project'), ctx.body.schema, 'template.import');
    }, { admin: true }],
    ['POST', '/api/clone', async (ctx) => {
      const from = ctx.body.from ?? {}; const r = ref(from); const src = panelOr404(from.panelId); assertPanel(ctx, src.id);
      try {
        const cfg = await extractConfig(manager.clientFor(src), r);
        return await deployTo(ctx, cfg, ctx.body.to ?? {}, !!ctx.body.deploy);
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],
  ];

  /* ---------------- массовые изменения настроек ---------------- */
  const bulkRoutes = [
    ['POST', '/api/bulk/op', async (ctx) => {
      const { op, targets, params = {}, deploy } = ctx.body;
      need(['env', 'image'].includes(op), 'Операция: env или image');
      need(Array.isArray(targets) && targets.length > 0 && targets.length <= 200, 'Выберите от 1 до 200 сервисов');
      for (const t of targets) assertPanel(ctx, t.panelId);
      const set = op === 'env' ? parseEnvLines(params.set) : {};
      const remove = op === 'env' ? String(params.remove ?? '').split(/[\s,]+/).filter(Boolean) : [];
      need(op !== 'env' || Object.keys(set).length || remove.length, 'Укажите переменные для изменения или удаления');
      need(op !== 'image' || (typeof params.image === 'string' && params.image.trim()), 'Укажите образ');
      const results = [];
      await Promise.all([...Map.groupBy(targets, (t) => t.panelId).entries()].map(async ([panelId, list]) => {
        const row = manager.getRow(Number(panelId));
        for (const t of list) {
          const label = `${t.project}/${t.name}`;
          try {
            if (!row) throw new Error('Панель не найдена');
            const r = ref(t);
            need(op === 'env' ? true : r.type === 'app', 'Смена образа доступна только для App');
            need(['app', 'compose', ...SERVICE_TYPES].includes(r.type), 'Тип не поддерживается');
            await mutateAudited(ctx, row, `bulk.${op}`, label, async () => {
              const c = manager.clientFor(row);
              if (op === 'env') {
                const cur = (await inspectService(c, r)).service;
                await runServiceOp(c, 'env', r, { env: mergeEnv(cur?.env ?? cur?.envs ?? '', set, remove) });
              } else await runServiceOp(c, 'sourceImage', r, { image: params.image.trim() });
              if (deploy && r.type !== 'postgres' && !['mysql', 'mariadb', 'mongo', 'redis'].includes(r.type)) await runAction(c, { ...r, action: 'deploy' });
            });
            results.push({ ...t, ok: true });
          } catch (e) { results.push({ ...t, ok: false, error: e.message }); }
        }
      }));
      return { results, okCount: results.filter((r) => r.ok).length, failCount: results.filter((r) => !r.ok).length };
    }, { min: 'operator' }],

    ['POST', '/api/bulk/system', async (ctx) => {
      const { op, panelIds } = ctx.body;
      need(['cleanupImages', 'prune'].includes(op), 'Массово доступны только очистки Docker');
      need(Array.isArray(panelIds) && panelIds.length > 0, 'Выберите панели');
      for (const id of panelIds) assertPanel(ctx, id);
      const results = await Promise.all(panelIds.map(async (id) => {
        const row = manager.getRow(Number(id));
        if (!row) return { panelId: id, ok: false, error: 'Панель не найдена' };
        try { await mutateAudited(ctx, row, `system.${op}`, row.name, () => SYSTEM_OPS[op](manager.clientFor(row))); return { panelId: id, name: row.name, ok: true }; }
        catch (e) { return { panelId: id, name: row.name, ok: false, error: e.message }; }
      }));
      return { results, okCount: results.filter((r) => r.ok).length, failCount: results.filter((r) => !r.ok).length };
    }, { admin: true }],
  ];

  /* ---------------- расписания ---------------- */
  const cleanSchedule = (ctx) => {
    const b = ctx.body;
    const service = b.target?.kind !== 'system';
    need(service ? ACTIONS.includes(b.action) && b.action !== 'destroy' : ['cleanupImages', 'prune'].includes(b.action), 'Недопустимое действие');
    const target = service
      ? { kind: 'services', items: (b.target?.items ?? []).map((t) => { assertPanel(ctx, t.panelId); return { panelId: Number(t.panelId), ...ref(t) }; }) }
      : { kind: 'system', panelIds: (b.target?.panelIds ?? []).map((id) => { assertPanel(ctx, id); return Number(id); }) };
    need((target.items ?? target.panelIds).length > 0, 'Выберите цели');
    need(['daily', 'interval'].includes(b.mode), 'Режим: daily или interval');
    if (b.mode === 'daily') need(/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time ?? ''), 'Время в формате ЧЧ:ММ');
    else need(Number(b.intervalMin) >= 5 && Number(b.intervalMin) <= 43200, 'Интервал — от 5 минут');
    const days = Array.isArray(b.days) ? b.days.map(Number).filter((n) => n >= 0 && n <= 6) : [];
    return { name: str(b.name, 'Укажите название', 80), enabled: b.enabled === false ? 0 : 1, target: JSON.stringify(target), action: b.action, mode: b.mode, time: b.mode === 'daily' ? b.time : null, days: days.join(','), interval_min: b.mode === 'interval' ? Number(b.intervalMin) : null };
  };
  const pubSchedule = (s) => ({ id: s.id, name: s.name, enabled: !!s.enabled, target: JSON.parse(s.target), action: s.action, mode: s.mode, time: s.time, days: s.days ? s.days.split(',').map(Number) : [], intervalMin: s.interval_min, lastRun: s.last_status ? s.last_run : null, lastStatus: s.last_status ?? null, running: !!d.scheduler?.()?.isRunning(s.id) });
  const scheduleRoutes = [
    ['GET', '/api/schedules', () => db.prepare('SELECT * FROM schedules ORDER BY id').all().map(pubSchedule)],
    ['POST', '/api/schedules', (ctx) => {
      const c = cleanSchedule(ctx);
      db.prepare('INSERT INTO schedules (name, enabled, target, action, mode, time, days, interval_min, last_run, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(c.name, c.enabled, c.target, c.action, c.mode, c.time, c.days, c.interval_min, null, now());
      audit(ctx, { action: 'schedule.add', target: c.name });
      return { ok: true };
    }, { admin: true }],
    ['PUT', '/api/schedules/:id', (ctx) => {
      const s = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(ctx.params.id)); need(s, 'Не найдено');
      if (Object.keys(ctx.body).length === 1 && 'enabled' in ctx.body) db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(ctx.body.enabled ? 1 : 0, s.id);
      else { const c = cleanSchedule(ctx); db.prepare('UPDATE schedules SET name=?, enabled=?, target=?, action=?, mode=?, time=?, days=?, interval_min=? WHERE id=?').run(c.name, c.enabled, c.target, c.action, c.mode, c.time, c.days, c.interval_min, s.id); }
      return { ok: true };
    }, { admin: true }],
    ['DELETE', '/api/schedules/:id', (ctx) => { db.prepare('DELETE FROM schedules WHERE id = ?').run(Number(ctx.params.id)); return { ok: true }; }, { admin: true }],
    ['POST', '/api/schedules/:id/run', async (ctx) => {
      const s = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(ctx.params.id)); need(s, 'Не найдено');
      return d.scheduler().run(s);
    }, { admin: true }],
  ];

  /* ---------------- вебхуки деплоя для CI ---------------- */
  const hits = new Map();
  const hookRoutes = [
    ['GET', '/api/hooks', (ctx) => db.prepare('SELECT h.id, h.label, h.panel_id panelId, p.name panelName, h.type, h.project, h.name, h.action, h.created_at createdAt, h.last_used lastUsed FROM hooks h JOIN panels p ON p.id = h.panel_id ORDER BY h.id').all().filter((h) => canPanel(ctx.user, h.panelId)), { admin: true }],
    ['POST', '/api/hooks', (ctx) => {
      const r = ref(ctx.body); const row = panelOr404(ctx.body.panelId); assertPanel(ctx, row.id);
      const action = ctx.body.action ?? 'deploy';
      need(ACTIONS.includes(action) && action !== 'destroy', 'Недопустимое действие');
      const token = randomToken();
      db.prepare('INSERT INTO hooks (token_hash, label, panel_id, type, project, name, action, created_at) VALUES (?,?,?,?,?,?,?,?)').run(sha256(token), str(ctx.body.label ?? `${r.project}/${r.name}`, 'Укажите название', 80), row.id, r.type, r.project, r.name, action, now());
      audit(ctx, { action: 'hook.create', panel: row, target: `${r.project}/${r.name}` });
      return { token, path: `/api/hooks/${token}` }; // токен показывается один раз
    }, { admin: true }],
    ['DELETE', '/api/hooks/:id', (ctx) => { db.prepare('DELETE FROM hooks WHERE id = ?').run(Number(ctx.params.id)); return { ok: true }; }, { admin: true }],
    ['POST', '/api/hooks/:token', async (ctx) => {
      const ip = ctx.req.socket.remoteAddress;
      const h = hits.get(ip) ?? { n: 0, at: now() };
      if (now() - h.at > 60_000) { h.n = 0; h.at = now(); }
      if (++h.n > 30) throw new HttpError(429, 'Слишком много запросов');
      hits.set(ip, h);
      const hook = db.prepare('SELECT * FROM hooks WHERE token_hash = ?').get(sha256(ctx.params.token));
      if (!hook) throw new HttpError(404, 'Не найдено');
      const row = manager.getRow(hook.panel_id);
      if (!row) throw new HttpError(404, 'Панель удалена');
      const hctx = { user: { username: `вебхук: ${hook.label}` } };
      try {
        await mutateAudited(hctx, row, `hook.${hook.action}`, `${hook.project}/${hook.name}`, () => runAction(manager.clientFor(row), { type: hook.type, project: hook.project, name: hook.name, action: hook.action }));
        db.prepare('UPDATE hooks SET last_used = ? WHERE id = ?').run(now(), hook.id);
        return { ok: true };
      } catch (e) { throw asHttp(e); }
    }, { hook: true }],
  ];

  /* ---------------- инвентарь: образы и сертификаты ---------------- */
  const imageCache = new Map(); // panelId → {at, items}
  async function mapLimit(items, n, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
    return out;
  }
  /** «владелец/репозиторий@ветка» для любого источника; адрес — без токена. */
  function repoInfo(src) {
    if (!src) return { repo: null };
    const ref = src.ref ?? src.branch ?? '';
    if (src.owner) return { repo: `${src.owner}/${src.repo}@${ref}`, repoUrl: `https://github.com/${src.owner}/${src.repo}` };
    if (src.repo) {
      const url = String(src.repo).replace(/\/\/[^/@]*@/, '//');
      const parts = url.replace(/\.git$/i, '').split(/[/:]/).filter(Boolean);
      const short = parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : url;
      return { repo: `${short}@${ref}`, repoUrl: url };
    }
    if (src.dockerfile) return { repo: 'Dockerfile' };
    return { repo: null };
  }
  async function imagesOf(row, force) {
    const hit = imageCache.get(row.id);
    if (!force && hit && now() - hit.at < 300_000) return hit.items;
    const svcs = (await treeOf(row)).flatMap((p) => p.services).filter((s) => s.type === 'app');
    const c = manager.clientFor(row);
    const items = await mapLimit(svcs, 5, async (s) => {
      try {
        const src = (await inspectService(c, { type: 'app', project: s.project, name: s.name })).service?.source;
        return { project: s.project, name: s.name, type: src?.type ?? 'unknown', image: src?.image ?? null, ...repoInfo(src) };
      } catch (e) { return { project: s.project, name: s.name, type: 'error', error: e.message }; }
    });
    imageCache.set(row.id, { at: now(), items });
    return items;
  }
  /* Формат сертификатов у разных версий панели отличается — ищем домен и срок действия в глубине объекта. */
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const findDomain = (c, depth = 0) => {
    if (text(c)) return text(c);
    if (Array.isArray(c)) return c.map((x) => findDomain(x, depth + 1)).filter(Boolean).join(', ') || null;
    if (c && typeof c === 'object' && depth < 3) {
      for (const k of ['main', 'domain', 'domains', 'host', 'hostname', 'name', 'commonName', 'cn', 'subject', 'id']) { const r = findDomain(c[k], depth + 1); if (r) return r; }
      for (const v of Object.values(c)) if (text(v)) return text(v); // последняя надежда: первое строковое поле
    }
    return null;
  };
  /** Дополнительные имена (SAN) сертификата, если панель их отдаёт. */
  const findSans = (c) => {
    const d = c?.domain && typeof c.domain === 'object' ? c.domain : c;
    const v = d?.sans ?? d?.altNames ?? d?.alt ?? c?.sans;
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  };
  const toTime = (v) => {
    if (typeof v === 'number' && v > 0) return v < 1e12 ? v * 1000 : v;
    if (typeof v === 'string' && v.trim()) { const t = /^\d+$/.test(v.trim()) ? toTime(Number(v)) : Date.parse(v); return Number.isFinite(t) ? t : null; }
    return null;
  };
  const findExpiry = (c, depth = 0) => {
    if (!c || typeof c !== 'object' || depth > 3) return null;
    for (const [k, v] of Object.entries(c)) if (/expir|valid.?(to|until)|not.?after/i.test(k)) { const t = toTime(v); if (t) return t; }
    for (const v of Object.values(c)) if (v && typeof v === 'object') { const r = findExpiry(v, depth + 1); if (r) return r; }
    return null;
  };
  const certExpiry = findExpiry;
  /* Панель не отдаёт срок действия — читаем его у самого домена по TLS (кэш 30 мин, неудачи 5 мин). */
  const tlsCache = new Map();
  const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
  function probeTlsExpiry(host, port, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let done = false, sock;
      const fin = (v) => { if (!done) { done = true; try { sock?.destroy(); } catch { /* уже закрыт */ } resolve(v); } };
      try {
        sock = tls.connect({ host, port, servername: HOSTNAME.test(host) && !/^[\d.]+$/.test(host) ? host : undefined, rejectUnauthorized: false, timeout: timeoutMs }, () => {
          const t = Date.parse(sock.getPeerCertificate()?.valid_to ?? '');
          fin(Number.isFinite(t) ? t : null);
        });
        sock.on('error', () => fin(null)); sock.on('timeout', () => fin(null));
      } catch { fin(null); }
    });
  }
  async function tlsExpiry(host) {
    if (!config.tlsProbe || host.startsWith('*.') || !HOSTNAME.test(host)) return null;
    const hit = tlsCache.get(host);
    if (hit && now() - hit.at < (hit.val ? 1_800_000 : 300_000)) return hit.val;
    const val = await probeTlsExpiry(host, config.tlsProbePort ?? 443);
    tlsCache.set(host, { at: now(), val });
    return val;
  }
  async function certsOf(row) {
    const raw = await manager.clientFor(row).query('certificates.listCertificates');
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.certificates) ? raw.certificates : [];
    return mapLimit(list, 8, async (c) => {
      const domain = findDomain(c) ?? (JSON.stringify(c) ?? '?').slice(0, 80);
      const sans = findSans(c);
      let expiresAt = certExpiry(c), source = expiresAt ? 'panel' : null;
      if (!expiresAt) { expiresAt = await tlsExpiry(domain.split(', ')[0]); if (expiresAt) source = 'tls'; }
      return { domain, sans, expiresAt, source, raw: c };
    });
  }
  /* Перевыпуск сертификата: панель выпускает сертификаты сама (Let's Encrypt) — удаляем текущий и «будим» домен запросом. */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const warmUp = (host) => new Promise((resolve) => {
    const req = https.request({ host, port: config.tlsProbePort ?? 443, path: '/', method: 'GET', servername: host, rejectUnauthorized: false, timeout: 5000 }, (res) => { res.resume(); resolve(); });
    req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); }); req.end();
  });
  /* Traefik сам не запросит сертификат после удаления записи — перезаписываем домен у владельца, чтобы панель пересобрала конфиг и выпустила заново. */
  async function resaveDomain(row, host) {
    const c = manager.clientFor(row);
    const svcs = (await treeOf(row)).flatMap((p) => p.services.map((s) => ({ ...s, project: s.project ?? p.name }))).filter((s) => s.type === 'app');
    for (const s of svcs) {
      let list; try { list = await c.query('domains.listDomains', { projectName: s.project, serviceName: s.name }); } catch { continue; }
      const dom = (Array.isArray(list) ? list : []).find((x) => (x.host ?? x.domain) === host);
      if (!dom) continue;
      await runServiceOp(c, 'domainUpdate', { type: s.type, project: s.project, name: s.name }, { id: dom.id ?? dom._id, original: dom, host, https: dom.https ?? true });
      return `${s.project}/${s.name}`;
    }
    return null;
  }
  const reissueRoutes = [
    ['POST', '/api/panels/:id/certs/reissue', async (ctx) => {
      const row = panelOr404(ctx.params.id);
      const domain = str(ctx.body.domain, 'Укажите домен', 253);
      need(/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domain), 'Некорректный домен');
      try {
        const item = (await certsOf(row)).find((x) => x.domain === domain || x.domain.split(', ')[0] === domain);
        need(item, 'Сертификат не найден на панели');
        const before = item.expiresAt;
        const c = manager.clientFor(row);
        const raw = item.raw && typeof item.raw === 'object' ? item.raw : {};
        await mutateAudited(ctx, row, 'cert.reissue', domain, () => firstOk(c, 'certificates.removeCertificate', [raw, { domain }, { domain: { main: domain } }, { main: domain }, { name: domain }]));
        let resaved = null, resaveError = null;
        try { resaved = await resaveDomain(row, domain); } catch (e) { resaveError = e.message; }
        let after = null;
        if (config.tlsProbe && !domain.startsWith('*.')) {
          tlsCache.delete(domain);
          await warmUp(domain); // первый HTTPS-запрос подталкивает выпуск нового сертификата
          for (const wait of config.reissueDelaysMs ?? []) {
            await sleep(wait); tlsCache.delete(domain);
            after = await tlsExpiry(domain);
            if (after && (!before || after > before + 3600_000)) break;
          }
        }
        return { ok: true, removed: true, resaved, resaveError, before, after, renewed: !!(after && before && after > before + 3600_000) };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],
  ];

  const inventoryRoutes = [
    ['GET', '/api/images', async (ctx) => {
      const force = ctx.url.searchParams.get('force') === '1';
      const out = await Promise.all(accessible(ctx).map(async (row) => {
        try { return (await imagesOf(row, force)).map((i) => ({ ...i, panelId: row.id, panelName: row.name, color: row.color })); } catch (e) { return [{ panelId: row.id, panelName: row.name, color: row.color, type: 'error', error: e.message, project: '—', name: '—' }]; }
      }));
      return out.flat();
    }],
    ['GET', '/api/certs', async (ctx) => Promise.all(accessible(ctx).map(async (row) => {
      try { return { panelId: row.id, panelName: row.name, color: row.color, certs: (await certsOf(row)).map(({ raw, ...c }) => c) }; }
      catch (e) { return { panelId: row.id, panelName: row.name, color: row.color, certs: [], error: e.message }; }
    }))],
  ];
  // ежедневная проверка сроков сертификатов → уведомление cert_expiring
  const certWarned = new Map();
  const checkCerts = async () => {
    for (const row of db.prepare('SELECT * FROM panels').all()) {
      try {
        for (const c of await certsOf(row)) {
          const days = c.expiresAt ? (c.expiresAt - now()) / 86_400_000 : null;
          const k = `${row.id}|${c.domain}`;
          if (days != null && days < 7 && now() - (certWarned.get(k) ?? 0) > 86_400_000) {
            certWarned.set(k, now());
            alerts.emit({ type: 'cert_expiring', icon: '🔒', panel: row.name, text: `Панель «${row.name}»: сертификат ${c.domain} истекает через ${Math.max(0, Math.floor(days))} дн.` });
          }
        }
      } catch { /* панель недоступна или нет доступа к сертификатам */ }
    }
  };
  const certTimer = setInterval(checkCerts, 6 * 3600_000); certTimer.unref();

  /* ---------------- бэкап ---------------- */
  const backupRoutes = [
    ['GET', '/api/backup', (ctx) => {
      need(config.dataDir !== ':memory:', 'Бэкап недоступен для БД в памяти');
      const tmp = path.join(os.tmpdir(), `easyadmin-backup-${randomToken().slice(0, 8)}.db`);
      try {
        db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        const body = { version: 1, createdAt: now(), db: fs.readFileSync(tmp).toString('base64'), ...(ctx.url.searchParams.get('withKey') === '1' ? { key: key.toString('hex') } : {}) };
        audit(ctx, { action: 'backup.download' });
        return new RawResponse(JSON.stringify(body), 'application/json', { 'Content-Disposition': `attachment; filename="easyadmin-backup-${new Date().toISOString().slice(0, 10)}.json"` });
      } finally { fs.rmSync(tmp, { force: true }); }
    }, { admin: true }],
  ];

  return [...consoleRoutes, ...settingsRoutes2, ...catalogRoutes, ...sshRoutes, ...channelRoutes, ...reissueRoutes, ...settingsRoutes, ...diagRoutes, ...logRoutes, ...historyRoutes, ...templateRoutes, ...bulkRoutes, ...scheduleRoutes, ...hookRoutes, ...inventoryRoutes, ...backupRoutes];
}
