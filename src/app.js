import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import {
  ACTIONS, PanelClient, SYSTEM_OPS, createService, inspectService, loginToPanel, normalizeUrl, runAction, runServiceOp,
} from './easypanel.js';
import { HttpError, RawResponse, StreamResponse, compile, parseCookies, readJson, redirect, sendJson, sendRaw, serveStatic } from './http.js';
import { createOidc } from './oidc.js';
import { createAlerts } from './alerts.js';
import { extraRoutes } from './routes-ext.js';
import { createManager } from './manager.js';
import { createScheduler } from './scheduler.js';
import { decrypt, encrypt } from './crypto.js';
import { otpauthUrl, generateSecret, verifyTotp } from './totp.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'ea_session';
const NAME_RE = /^[A-Za-z0-9_.-]{1,63}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

const need = (cond, msg) => { if (!cond) throw new HttpError(400, msg); };
const str = (v, msg, max = 200) => { need(typeof v === 'string' && v.trim() && v.length <= max, msg); return v.trim(); };
const nameOf = (v, label) => { need(typeof v === 'string' && NAME_RE.test(v), `Некорректное имя: ${label}`); return v; };

const SECRET_KEY = /pass|secret|token|credential|connection|env|key/i;
/** Рекурсивно вырезает поля с секретами (для роли viewer). */
export function redactSecrets(v) {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, redactSecrets(x)]));
  return v;
}

const LEVEL = { viewer: 0, operator: 1, admin: 2 };
export const ROLES = Object.keys(LEVEL);

export function createApp({ config, db, key, fetchImpl }) {
  const manager = createManager({ db, key, config });
  const alerts = createAlerts({ db, key, config, fetchImpl });
  const oidc = createOidc({ config, fetchImpl });
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
    const u = db.prepare(`SELECT u.id, u.username, u.role, u.totp_enabled FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?`).get(sha256(token), now());
    if (!u) return null;
    const ids = db.prepare('SELECT panel_id FROM user_panels WHERE user_id = ?').all(u.id).map((r) => r.panel_id);
    return { ...u, totpEnabled: !!u.totp_enabled, panels: ids.length ? new Set(ids) : null }; // null = все панели
  }
  const publicUser = (u) => u && ({ id: u.id, username: u.username, role: u.role, totpEnabled: u.totpEnabled, panels: u.panels ? [...u.panels] : null });
  const canPanel = (user, id) => !user?.panels || user.panels.has(Number(id));
  const assertPanel = (ctx, id) => { if (!canPanel(ctx.user, id)) throw new HttpError(403, 'Нет доступа к этой панели'); };
  const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;

  /* ---------------- аудит ---------------- */
  function audit(ctx, { action, panel, target, ok = true, detail }) {
    db.prepare('INSERT INTO audit (ts, username, panel_id, panel_name, action, target, ok, detail) VALUES (?,?,?,?,?,?,?,?)')
      .run(now(), ctx.user?.username ?? null, panel?.id ?? null, panel?.name ?? null, action, target ?? null, ok ? 1 : 0, detail ? String(detail).slice(0, 500) : null);
  }
  /** Выполняет мутацию над панелью, пишет аудит, сбрасывает кэш. */
  async function mutateAudited(ctx, panelRow, action, target, fn) {
    alerts.expect(panelRow.id, String(target).split(' ')[0]);
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

  function provisionOidcUser(p) {
    let u = db.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(p.sub);
    if (!u && p.email && p.emailVerified) { // привязка к существующему локальному пользователю только по подтверждённой почте
      u = db.prepare('SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?').get(p.email, p.email);
      if (u) db.prepare('UPDATE users SET oidc_sub = ?, email = ? WHERE id = ?').run(p.sub, p.email, u.id);
    }
    if (!u) {
      need(p.emailVerified || !p.email, 'Почта не подтверждена у провайдера');
      const base = (p.email ?? p.name ?? p.sub).slice(0, 60);
      let username = base;
      for (let i = 2; db.prepare('SELECT 1 FROM users WHERE username = ?').get(username); i++) username = `${base}-${i}`;
      const role = userCount() === 0 || (p.email && config.oidc.adminEmails.includes(p.email)) ? 'admin' : config.oidc.defaultRole;
      const id = db.prepare('INSERT INTO users (username, password_hash, role, created_at, oidc_sub, email) VALUES (?,?,?,?,?,?)')
        .run(username, `!sso$${randomToken()}`, role, now(), p.sub, p.email).lastInsertRowid; // пароль недействителен: вход только через SSO
      u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    }
    return u;
  }

  function setUserPanels(userId, panels) {
    db.prepare('DELETE FROM user_panels WHERE user_id = ?').run(userId);
    for (const pid of Array.isArray(panels) ? panels : []) {
      if (manager.getRow(Number(pid))) db.prepare('INSERT OR IGNORE INTO user_panels (user_id, panel_id) VALUES (?,?)').run(userId, Number(pid));
    }
  }

  const scheduler = createScheduler({ db, manager, alerts, audit });
  manager.onSnapshot = (row, snap) => {
    alerts.evaluate(row, snap);
    if (snap.stats && (!history.get(row.id) || now() - history.get(row.id) > 55_000)) {
      history.set(row.id, now());
      db.prepare('INSERT INTO stats_history (panel_id, ts, cpu, mem, disk) VALUES (?,?,?,?,?)').run(row.id, now(), snap.stats.cpu, snap.stats.memPct, snap.stats.diskPct);
    }
  };
  const history = new Map();

  /* ---------------- маршруты ---------------- */
  const routes = compile([
    ['GET', '/api/health', () => ({ ok: true }), { public: true }],
    ['GET', '/api/session', (ctx) => ({ setupRequired: userCount() === 0, user: publicUser(ctx.user), sso: oidc.enabled ? { name: config.oidc.name } : null }), { public: true }],

    /* ----- SSO (OpenID Connect) ----- */
    ['GET', '/api/oidc/login', async () => {
      need(oidc.enabled, 'SSO не настроен');
      try { return redirect(await oidc.begin()); } catch (e) { return redirect(`/?sso_error=${encodeURIComponent(e.message)}`); }
    }, { public: true }],
    ['GET', '/api/oidc/callback', async (ctx) => {
      const q = ctx.url.searchParams;
      const fail = (m) => redirect(`/?sso_error=${encodeURIComponent(m)}`);
      if (!oidc.enabled) return fail('SSO не настроен');
      if (q.get('error')) return fail(q.get('error_description') || q.get('error'));
      try {
        const profile = await oidc.complete(q.get('code') ?? '', q.get('state') ?? '');
        const u = provisionOidcUser(profile);
        createSession(ctx.res, u.id);
        audit({ user: u }, { action: 'login.sso', target: profile.email ?? profile.sub });
        return redirect('/');
      } catch (e) { return fail(e.message); }
    }, { public: true }],

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
      let ok = u && verifyPassword(String(ctx.body.password ?? ''), u.password_hash);
      if (ok && u.totp_enabled) {
        if (!ctx.body.code) throw new HttpError(401, 'Введите код из приложения-аутентификатора', { needTotp: true });
        ok = verifyTotp(decrypt(key, u.totp_secret_enc), ctx.body.code);
        if (!ok) { loginAttempts.set(ip, { n: (rec?.n ?? 0) + 1, until: (rec?.n ?? 0) + 1 >= 5 ? now() + 60_000 : 0 }); throw new HttpError(401, 'Неверный код 2FA', { needTotp: true }); }
      }
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

    /* ----- 2FA ----- */
    ['POST', '/api/me/2fa/setup', (ctx) => {
      const secret = generateSecret();
      db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 0 WHERE id = ?').run(encrypt(key, secret), ctx.user.id);
      return { secret, url: otpauthUrl(secret, ctx.user.username) };
    }, { anyRole: true }],
    ['POST', '/api/me/2fa/enable', (ctx) => {
      const u = db.prepare('SELECT totp_secret_enc FROM users WHERE id = ?').get(ctx.user.id);
      need(u.totp_secret_enc, 'Сначала начните настройку 2FA');
      need(verifyTotp(decrypt(key, u.totp_secret_enc), ctx.body.code), 'Неверный код');
      db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(ctx.user.id);
      audit(ctx, { action: 'user.2fa_on' });
      return { ok: true };
    }, { anyRole: true }],
    ['POST', '/api/me/2fa/disable', (ctx) => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
      need(verifyPassword(String(ctx.body.password ?? ''), u.password_hash), 'Неверный пароль');
      need(!u.totp_enabled || verifyTotp(decrypt(key, u.totp_secret_enc), ctx.body.code), 'Неверный код');
      db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE id = ?').run(u.id);
      audit(ctx, { action: 'user.2fa_off' });
      return { ok: true };
    }, { anyRole: true }],

    /* ----- пользователи ----- */
    ['GET', '/api/users', () => db.prepare('SELECT id, username, role, totp_enabled totp, created_at createdAt FROM users ORDER BY id').all()
      .map((u) => ({ ...u, totp: !!u.totp, panels: db.prepare('SELECT panel_id FROM user_panels WHERE user_id = ?').all(u.id).map((r) => r.panel_id) })), { admin: true }],
    ['POST', '/api/users', (ctx) => {
      const username = str(ctx.body.username, 'Укажите логин', 64);
      need(ROLES.includes(ctx.body.role), 'Роль: admin, operator или viewer');
      need(typeof ctx.body.password === 'string' && ctx.body.password.length >= 8, 'Пароль — минимум 8 символов');
      let id;
      try {
        id = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)').run(username, hashPassword(ctx.body.password), ctx.body.role, now()).lastInsertRowid;
      } catch { throw new HttpError(409, 'Такой логин уже существует'); }
      setUserPanels(Number(id), ctx.body.panels);
      audit(ctx, { action: 'user.create', target: username });
      return { ok: true };
    }, { admin: true }],
    ['PUT', '/api/users/:id', (ctx) => {
      const id = Number(ctx.params.id);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      need(u, 'Пользователь не найден');
      if (ctx.body.role !== undefined) {
        need(ROLES.includes(ctx.body.role), 'Неверная роль');
        need(!(id === ctx.user.id && ctx.body.role !== 'admin'), 'Нельзя снять права администратора с самого себя');
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(ctx.body.role, id);
      }
      if (ctx.body.panels !== undefined) setUserPanels(id, ctx.body.panels);
      if (ctx.body.password) {
        need(String(ctx.body.password).length >= 8, 'Пароль — минимум 8 символов');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(ctx.body.password), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (ctx.body.resetTotp) db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE id = ?').run(id);
      audit(ctx, { action: 'user.update', target: u.username });
      return { ok: true };
    }, { admin: true }],
    ['DELETE', '/api/users/:id', (ctx) => {
      need(Number(ctx.params.id) !== ctx.user.id, 'Нельзя удалить самого себя');
      db.prepare('DELETE FROM users WHERE id = ?').run(Number(ctx.params.id));
      audit(ctx, { action: 'user.delete', target: ctx.params.id });
      return { ok: true };
    }, { admin: true }],

    /* ----- панели ----- */
    ['GET', '/api/overview', async (ctx) => (await manager.overview({ force: ctx.url.searchParams.get('force') === '1' })).filter((p) => canPanel(ctx.user, p.id))],

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
      try {
        const r = await inspectService(manager.clientFor(row), svcRef({ type: q.get('type'), project: q.get('project'), name: q.get('name') }));
        return ctx.user.role === 'viewer' ? redactSecrets(r) : r; // наблюдатель не видит env и пароли
      } catch (e) { throw asHttp(e); }
    }],

    ['POST', '/api/panels/:id/service/action', async (ctx) => {
      const row = panelOr404(ctx.params.id); const ref = svcRef(ctx.body);
      need(ACTIONS.includes(ctx.body.action), 'Неизвестное действие');
      if (ctx.body.action === 'destroy' && ctx.user.role !== 'admin') throw new HttpError(403, 'Удаление доступно только администратору');
      try {
        await mutateAudited(ctx, row, `service.${ctx.body.action}`, `${ref.project}/${ref.name}`, () => runAction(manager.clientFor(row), { ...ref, action: ctx.body.action }));
        return { ok: true };
      } catch (e) { throw asHttp(e); }
    }, { min: 'operator' }],

    ['POST', '/api/panels/:id/service/op', async (ctx) => {
      const row = panelOr404(ctx.params.id); const ref = svcRef(ctx.body);
      try {
        const r = await mutateAudited(ctx, row, `service.${ctx.body.op}`, `${ref.project}/${ref.name}`, () => runServiceOp(manager.clientFor(row), ctx.body.op, ref, ctx.body.params ?? {}));
        return { ok: true, result: r };
      } catch (e) { throw asHttp(e); }
    }, { min: 'operator' }],

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
      need(ACTIONS.includes(action) && action !== 'destroy', 'Неизвестное действие');
      need(Array.isArray(targets) && targets.length > 0 && targets.length <= 200, 'Выберите от 1 до 200 сервисов');
      for (const t of targets) assertPanel(ctx, t.panelId);
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
    }, { min: 'operator' }],

    ['GET', '/api/audit', (ctx) => {
      const q = ctx.url.searchParams;
      const limit = Math.min(Number(q.get('limit')) || 100, 5000);
      const like = q.get('q') ? `%${q.get('q')}%` : null;
      const rows = db.prepare(`SELECT id, ts, username, panel_id panelId, panel_name panelName, action, target, ok, detail FROM audit
        WHERE (? IS NULL OR username LIKE ? OR panel_name LIKE ? OR action LIKE ? OR target LIKE ?) ORDER BY id DESC LIMIT ?`)
        .all(like, like, like, like, like, limit).filter((r) => !ctx.user.panels || (r.panelId && ctx.user.panels.has(r.panelId)));
      if (q.get('format') !== 'csv') return rows;
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
      const csv = ['time,user,panel,action,target,ok,detail', ...rows.map((r) => [new Date(r.ts).toISOString(), r.username, r.panelName, r.action, r.target, r.ok ? 'ok' : 'error', r.detail].map(esc).join(','))].join('\n');
      return new RawResponse('\ufeff' + csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="easyadmin-audit.csv"' });
    }],

    ...extraRoutes({ db, key, config, manager, alerts, scheduler: () => scheduler, audit, mutateAudited, need, str, nameOf, asHttp, panelOr404, assertPanel, canPanel, svcRef }),
  ]);

  const decryptOf = (row) => manager.clientFor(row).token;
  const cleanTags = (t) => (Array.isArray(t) ? t : String(t ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 10).join(',');

  /* ---------------- HTTP-сервер ---------------- */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/metrics') return metrics(req, res);
    if (!url.pathname.startsWith('/api/')) return serveStatic(PUBLIC_DIR, url.pathname, res);
    try {
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw new HttpError(404, 'Не найдено');
      const user = userFromReq(req);
      const mutating = req.method !== 'GET';
      if (mutating && !route.opts.hook) {
        // CSRF: кастомный заголовок + проверка Origin
        if (req.headers['x-requested-with'] !== 'easyadmin') throw new HttpError(403, 'CSRF');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origin');
      }
      const params = route.re.exec(url.pathname).groups ?? {};
      if (!route.opts.public && !route.opts.hook) {
        if (!user) throw new HttpError(401, 'Требуется вход');
        const min = route.opts.min ?? (route.opts.admin ? 'admin' : mutating && !route.opts.anyRole ? 'operator' : 'viewer');
        if (LEVEL[user.role] < LEVEL[min]) throw new HttpError(403, `Недостаточно прав (роль ${user.role})`);
        if (url.pathname.startsWith('/api/panels/') && /^\d+$/.test(params.id ?? '') && !canPanel(user, params.id)) throw new HttpError(403, 'Нет доступа к этой панели');
      }
      const ctx = { req, res, url, user, params, body: mutating ? await readJson(req) : {} };
      const out = await route.handler(ctx);
      if (out instanceof StreamResponse) return await out.run(req, res);
      if (out instanceof RawResponse) sendRaw(res, out); else sendJson(res, 200, out);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.end();
      sendJson(res, status, { ...(e.extra ?? {}), error: status === 500 ? 'Внутренняя ошибка' : e.message });
    }
  }

  function metrics(req, res) {
    if (!config.metricsToken || req.headers.authorization !== `Bearer ${config.metricsToken}`) { res.writeHead(config.metricsToken ? 401 : 404); return res.end(); }
    const esc = (v) => String(v).replace(/[\\"\n]/g, ' ');
    const lines = ['# TYPE easyadmin_panel_up gauge'];
    for (const p of db.prepare('SELECT * FROM panels').all()) {
      const snap = manager.cache.get(p.id); const l = `panel="${esc(p.name)}"`;
      lines.push(`easyadmin_panel_up{${l}} ${p.status === 'online' || p.status === 'degraded' ? 1 : 0}`);
      if (snap?.stats) for (const [k, v] of [['cpu_percent', snap.stats.cpu], ['memory_percent', snap.stats.memPct], ['disk_percent', snap.stats.diskPct]]) if (v != null) lines.push(`easyadmin_panel_${k}{${l}} ${v}`);
      const svcs = (snap?.tree?.projects ?? []).flatMap((x) => x.services);
      lines.push(`easyadmin_services_total{${l}} ${svcs.length}`, `easyadmin_services_stopped{${l}} ${svcs.filter((x) => !x.enabled).length}`);
      if (snap?.latencyMs != null) lines.push(`easyadmin_panel_latency_ms{${l}} ${snap.latencyMs}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }); res.end(lines.join('\n') + '\n');
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  let maintenance;
  const start = () => {
    manager.startPolling(); scheduler.start();
    const prune = () => {
      db.prepare('DELETE FROM audit WHERE ts < ?').run(now() - 90 * 86_400_000);
      db.prepare('DELETE FROM stats_history WHERE ts < ?').run(now() - 7 * 86_400_000);
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    };
    prune(); maintenance = setInterval(prune, 6 * 3600_000); maintenance.unref();
  };
  const stop = () => { manager.stop(); scheduler.stop(); clearInterval(maintenance); };
  return { server, manager, alerts, scheduler, start, stop };
}
