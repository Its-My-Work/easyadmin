import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import {
  ACTIONS, PanelClient, SYSTEM_OPS, createService, inspectService, loginToPanel, normalizeUrl, runAction, runServiceOp,
} from './easypanel.js';
import { HttpError, SECURITY_HEADERS, compile, parseCookies, readJson, sendJson, serveStatic } from './http.js';
import { createManager } from './manager.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'ea_session';
const NAME_RE = /^[A-Za-z0-9_.-]{1,63}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

const need = (cond, msg) => { if (!cond) throw new HttpError(400, msg); };
const str = (v, msg, max = 200) => { need(typeof v === 'string' && v.trim() && v.length <= max, msg); return v.trim(); };
const nameOf = (v, label) => { need(typeof v === 'string' && NAME_RE.test(v), `Некорректное имя: ${label}`); return v; };

export function createApp({ config, db, key }) {
  const manager = createManager({ db, key, config });
  const loginAttempts = new Map(); // ip → {n, until}

  /* ---------------- сессии ---------------- */
  const now = () => Date.now();
  function createSession(res, userId) {
    const token = randomToken();
    const ttl = config.sessionDays * 86_400_000;
    db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now(), now() + ttl);
    const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionDays * 86_400}${config.secureCookies ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${flags}`);
  }
  function userFromReq(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    return db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?`).get(sha256(token), now()) ?? null;
  }
  const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;

  /* ---------------- аудит ---------------- */
  function audit(ctx, { action, panel, target, ok = true, detail }) {
    db.prepare('INSERT INTO audit (ts, username, panel_id, panel_name, action, target, ok, detail) VALUES (?,?,?,?,?,?,?,?)')
      .run(now(), ctx.user?.username ?? null, panel?.id ?? null, panel?.name ?? null, action, target ?? null, ok ? 1 : 0, detail ? String(detail).slice(0, 500) : null);
  }
  /** Выполняет мутацию над панелью, пишет аудит, сбрасывает кэш. */
  async function mutateAudited(ctx, panelRow, action, target, fn) {
    try {
      const r = await fn();
      audit(ctx, { action, panel: panelRow, target });
      return r;
    } catch (e) {
      audit(ctx, { action, panel: panelRow, target, ok: false, detail: e.message });
      throw e;
    } finally {
      manager.invalidate(panelRow.id);
    }
  }
  const panelOr404 = (id) => {
    const row = manager.getRow(Number(id));
    if (!row) throw new HttpError(404, 'Панель не найдена');
    return row;
  };
  const svcRef = (b) => ({ type: b.type, project: nameOf(b.project, 'project'), name: nameOf(b.name, 'service') });
  const asHttp = (e) => (e instanceof HttpError ? e : new HttpError(502, e.message));

  /* ---------------- маршруты ---------------- */
  const routes = compile([
    ['GET', '/api/health', () => ({ ok: true }), { public: true }],
    ['GET', '/api/session', (ctx) => ({ setupRequired: userCount() === 0, user: ctx.user }), { public: true }],

    ['POST', '/api/setup', (ctx) => {
      if (userCount() > 0) throw new HttpError(403, 'Администратор уже создан');
      const username = str(ctx.body.username, 'Укажите логин', 64);
      need(typeof ctx.body.password === 'string' && ctx.body.password.length >= 8, 'Пароль — минимум 8 символов');
      const id = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)')
        .run(username, hashPassword(ctx.body.password), 'admin', now()).lastInsertRowid;
      createSession(ctx.res, Number(id));
      return { ok: true };
    }, { public: true }],

    ['POST', '/api/login', (ctx) => {
      const ip = ctx.req.socket.remoteAddress;
      const rec = loginAttempts.get(ip);
      if (rec && rec.until > now()) throw new HttpError(429, 'Слишком много попыток. Подождите минуту.');
      const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(ctx.body.username ?? ''));
      const ok = u && verifyPassword(String(ctx.body.password ?? ''), u.password_hash);
      if (!ok) {
        const n = (rec?.n ?? 0) + 1;
        loginAttempts.set(ip, { n, until: n >= 5 ? now() + 60_000 : 0 });
        throw new HttpError(401, 'Неверный логин или пароль');
      }
      loginAttempts.delete(ip);
      createSession(ctx.res, u.id);
      audit({ user: u }, { action: 'login' });
      return { ok: true };
    }, { public: true }],

    ['POST', '/api/logout', (ctx) => {
      const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
      if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
      ctx.res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return { ok: true };
    }, { anyRole: true }],

    ['POST', '/api/me/password', (ctx) => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
      need(verifyPassword(String(ctx.body.current ?? ''), u.password_hash), 'Текущий пароль неверен');
      need(typeof ctx.body.next === 'string' && ctx.body.next.length >= 8, 'Новый пароль — минимум 8 символов');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(ctx.body.next), u.id);
      return { ok: true };
    }, { anyRole: true }],

    /* ----- пользователи ----- */
    ['GET', '/api/users', () => db.prepare('SELECT id, username, role, created_at createdAt FROM users ORDER BY id').all(), { admin: true }],
    ['POST', '/api/users', (ctx) => {
      const username = str(ctx.body.username, 'Укажите логин', 64);
      need(['admin', 'viewer'].includes(ctx.body.role), 'Роль: admin или viewer');
      need(typeof ctx.body.password === 'string' && ctx.body.password.length >= 8, 'Пароль — минимум 8 символов');
      try {
        db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)').run(username, hashPassword(ctx.body.password), ctx.body.role, now());
      } catch { throw new HttpError(409, 'Такой логин уже существует'); }
      audit(ctx, { action: 'user.create', target: username });
      return { ok: true };
    }, { admin: true }],
    ['DELETE', '/api/users/:id', (ctx) => {
      need(Number(ctx.params.id) !== ctx.user.id, 'Нельзя удалить самого себя');
      db.prepare('DELETE FROM users WHERE id = ?').run(Number(ctx.params.id));
      audit(ctx, { action: 'user.delete', target: ctx.params.id });
      return { ok: true };
    }, { admin: true }],

    /* ----- панели ----- */
    ['GET', '/api/overview', async (ctx) => manager.overview({ force: ctx.url.searchParams.get('force') === '1' })],

    ['POST', '/api/panels/login-probe', async (ctx) => {
      const url = normalizeUrl(ctx.body.url);
      try {
        const token = await loginToPanel({ url, email: str(ctx.body.email, 'Укажите email'), password: str(ctx.body.password, 'Укажите пароль', 500), insecure: !!ctx.body.insecureTls, timeoutMs: config.requestTimeoutMs });
        return { token };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    ['POST', '/api/panels/test', async (ctx) => {
      const url = normalizeUrl(ctx.body.url);
      const token = ctx.body.token || (ctx.body.id ? decryptOf(panelOr404(ctx.body.id)) : '');
      need(token, 'Укажите API-токен');
      const c = new PanelClient({ url, token, insecure: !!ctx.body.insecureTls, timeoutMs: config.requestTimeoutMs });
      const t0 = now();
      try {
        await c.query('projects.listProjects');
        return { ok: true, latencyMs: now() - t0 };
      } catch (e) { return { ok: false, error: e.message, kind: e.kind }; }
    }, { admin: true }],

    ['POST', '/api/panels', async (ctx) => {
      const b = ctx.body;
      const url = normalizeUrl(b.url);
      const token = str(b.token, 'Укажите API-токен', 4000);
      const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM panels').get().p;
      const id = db.prepare('INSERT INTO panels (name, url, token_enc, insecure_tls, color, tags, notes, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(str(b.name, 'Укажите название', 80), url, manager.sealToken(token), b.insecureTls ? 1 : 0,
          HEX.test(b.color) ? b.color : '#6366f1', cleanTags(b.tags), String(b.notes ?? '').slice(0, 1000), pos, now()).lastInsertRowid;
      const row = manager.getRow(Number(id));
      audit(ctx, { action: 'panel.add', panel: row });
      manager.snapshot(row.id, { force: true }).catch(() => {});
      return manager.publicPanel(row);
    }, { admin: true }],

    ['PUT', '/api/panels/:id', (ctx) => {
      const row = panelOr404(ctx.params.id); const b = ctx.body;
      const token = b.token ? manager.sealToken(String(b.token)) : row.token_enc;
      db.prepare('UPDATE panels SET name=?, url=?, token_enc=?, insecure_tls=?, color=?, tags=?, notes=?, position=? WHERE id=?')
        .run(b.name ? str(b.name, 'Название', 80) : row.name, b.url ? normalizeUrl(b.url) : row.url, token,
          b.insecureTls === undefined ? row.insecure_tls : (b.insecureTls ? 1 : 0),
          HEX.test(b.color) ? b.color : row.color, b.tags === undefined ? row.tags : cleanTags(b.tags),
          b.notes === undefined ? row.notes : String(b.notes).slice(0, 1000),
          Number.isFinite(b.position) ? b.position : row.position, row.id);
      manager.invalidate(row.id);
      audit(ctx, { action: 'panel.update', panel: row });
      return manager.publicPanel(manager.getRow(row.id));
    }, { admin: true }],

    ['DELETE', '/api/panels/:id', (ctx) => {
      const row = panelOr404(ctx.params.id);
      db.prepare('DELETE FROM panels WHERE id = ?').run(row.id);
      manager.invalidate(row.id);
      audit(ctx, { action: 'panel.remove', panel: row });
      return { ok: true };
    }, { admin: true }],

    ['GET', '/api/panels/:id/snapshot', async (ctx) => {
      panelOr404(ctx.params.id);
      return manager.snapshot(Number(ctx.params.id), { force: ctx.url.searchParams.get('force') === '1' });
    }],

    /* ----- сервисы ----- */
    ['GET', '/api/panels/:id/service', async (ctx) => {
      const row = panelOr404(ctx.params.id);
      const q = ctx.url.searchParams;
      try { return await inspectService(manager.clientFor(row), svcRef({ type: q.get('type'), project: q.get('project'), name: q.get('name') })); } catch (e) { throw asHttp(e); }
    }],

    ['POST', '/api/panels/:id/service/action', async (ctx) => {
      const row = panelOr404(ctx.params.id); const ref = svcRef(ctx.body);
      need(ACTIONS.includes(ctx.body.action), 'Неизвестное действие');
      try {
        await mutateAudited(ctx, row, `service.${ctx.body.action}`, `${ref.project}/${ref.name}`, () => runAction(manager.clientFor(row), { ...ref, action: ctx.body.action }));
        return { ok: true };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    ['POST', '/api/panels/:id/service/op', async (ctx) => {
      const row = panelOr404(ctx.params.id); const ref = svcRef(ctx.body);
      try {
        const r = await mutateAudited(ctx, row, `service.${ctx.body.op}`, `${ref.project}/${ref.name}`, () => runServiceOp(manager.clientFor(row), ctx.body.op, ref, ctx.body.params ?? {}));
        return { ok: true, result: r };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    ['POST', '/api/panels/:id/services', async (ctx) => {
      const row = panelOr404(ctx.params.id); const ref = svcRef(ctx.body);
      try {
        await mutateAudited(ctx, row, 'service.create', `${ref.project}/${ref.name} (${ref.type})`, () => createService(manager.clientFor(row), { ...ref, image: ctx.body.image, password: ctx.body.password }));
        return { ok: true };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    ['POST', '/api/panels/:id/projects', async (ctx) => {
      const row = panelOr404(ctx.params.id); const name = nameOf(ctx.body.name, 'project');
      try {
        await mutateAudited(ctx, row, 'project.create', name, () => manager.clientFor(row).mutate('projects.createProject', { name }));
        return { ok: true };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    ['DELETE', '/api/panels/:id/projects/:name', async (ctx) => {
      const row = panelOr404(ctx.params.id); const name = nameOf(ctx.params.name, 'project');
      try {
        await mutateAudited(ctx, row, 'project.destroy', name, () => manager.clientFor(row).mutate('projects.destroyProject', { name, projectName: name }));
        return { ok: true };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    /* ----- система, история, консоль ----- */
    ['POST', '/api/panels/:id/system', async (ctx) => {
      const row = panelOr404(ctx.params.id); const fn = SYSTEM_OPS[ctx.body.op];
      need(fn, 'Неизвестная операция');
      try {
        const r = await mutateAudited(ctx, row, `system.${ctx.body.op}`, row.name, () => fn(manager.clientFor(row)));
        return { ok: true, result: r };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    ['GET', '/api/panels/:id/actions', async (ctx) => {
      const row = panelOr404(ctx.params.id);
      try { return await manager.clientFor(row).query('actions.listActions', {}); } catch (e) { throw asHttp(e); }
    }],
    ['GET', '/api/panels/:id/actions/:actionId', async (ctx) => {
      const row = panelOr404(ctx.params.id);
      try { return await manager.clientFor(row).query('actions.getAction', { id: ctx.params.actionId }); } catch (e) { throw asHttp(e); }
    }],

    ['POST', '/api/panels/:id/trpc', async (ctx) => {
      const row = panelOr404(ctx.params.id); const b = ctx.body;
      const kind = b.kind === 'mutation' ? 'mutation' : 'query';
      const c = manager.clientFor(row);
      try {
        if (kind === 'query') return { result: await c.query(str(b.procedure, 'Укажите процедуру'), b.input) };
        return { result: await mutateAudited(ctx, row, 'raw.mutation', b.procedure, () => c.mutate(str(b.procedure, 'Укажите процедуру'), b.input ?? {})) };
      } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    /* ----- массовые операции ----- */
    ['POST', '/api/bulk', async (ctx) => {
      const { action, targets } = ctx.body;
      need(ACTIONS.includes(action), 'Неизвестное действие');
      need(Array.isArray(targets) && targets.length > 0 && targets.length <= 200, 'Выберите от 1 до 200 сервисов');
      const results = [];
      // разные панели — параллельно, внутри одной панели — последовательно (щадим сервер)
      const byPanel = new Map();
      for (const t of targets) byPanel.set(t.panelId, [...(byPanel.get(t.panelId) ?? []), t]);
      await Promise.all([...byPanel.entries()].map(async ([panelId, list]) => {
        const row = manager.getRow(Number(panelId));
        for (const t of list) {
          const label = `${t.project}/${t.name}`;
          if (!row) { results.push({ ...t, ok: false, error: 'Панель не найдена' }); continue; }
          try {
            const ref = svcRef(t);
            await mutateAudited(ctx, row, `bulk.${action}`, label, () => runAction(manager.clientFor(row), { ...ref, action }));
            results.push({ ...t, ok: true });
          } catch (e) { results.push({ ...t, ok: false, error: e.message }); }
        }
      }));
      return { results, okCount: results.filter((r) => r.ok).length, failCount: results.filter((r) => !r.ok).length };
    }, { admin: true }],

    ['GET', '/api/audit', (ctx) => {
      const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 500);
      return db.prepare('SELECT id, ts, username, panel_id panelId, panel_name panelName, action, target, ok, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit);
    }],
  ]);

  const decryptOf = (row) => manager.clientFor(row).token;
  const cleanTags = (t) => (Array.isArray(t) ? t : String(t ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 10).join(',');

  /* ---------------- HTTP-сервер ---------------- */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(PUBLIC_DIR, url.pathname, res);
    try {
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw new HttpError(404, 'Не найдено');
      const user = userFromReq(req);
      const mutating = req.method !== 'GET';
      if (mutating) {
        // CSRF: кастомный заголовок + проверка Origin
        if (req.headers['x-requested-with'] !== 'easyadmin') throw new HttpError(403, 'CSRF');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origin');
      }
      if (!route.opts.public) {
        if (!user) throw new HttpError(401, 'Требуется вход');
        if ((route.opts.admin || (mutating && !route.opts.anyRole)) && user.role !== 'admin') throw new HttpError(403, 'Недостаточно прав (роль viewer)');
      }
      const ctx = { req, res, url, user, params: route.re.exec(url.pathname).groups ?? {}, body: mutating ? await readJson(req) : {} };
      sendJson(res, 200, await route.handler(ctx));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      sendJson(res, status, { error: status === 500 ? 'Внутренняя ошибка' : e.message });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return { server, manager };
}
