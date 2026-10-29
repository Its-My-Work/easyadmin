import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import {
  ACTIONS, BUILD_TYPES, SOURCE_KINDS, PanelClient, SYSTEM_OPS, createService, inspectService, loginToPanel, normalizeUrl, runAction, runServiceOp,
} from './easypanel.js';
import { createConsoleHub } from './console.js';
import { HttpError, RawResponse, StreamResponse, compile, parseCookies, readJson, redirect, sendJson, sendRaw, serveStatic } from './http.js';
import { createOidc } from './oidc.js';
import { translate } from '../public/js/i18n-dict.js';
import { createLoadMonitor } from './load-monitor.js';
import { createBackups } from './backups.js';
import { createAlerts } from './alerts.js';
import { applyTimezone, getSavedTimezone } from './timezone.js';
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
// пароль/токен внутри адреса репозитория: https://user:TOKEN@host/…
const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/gi;
export function redactSecrets(v) {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, redactSecrets(x)]));
  return typeof v === 'string' ? v.replace(URL_CREDS, '$1***@') : v;
}

const LEVEL = { viewer: 0, operator: 1, admin: 2 };
export const ROLES = Object.keys(LEVEL);

export function createApp({ config, db, key, restart, hostRun, dataPollMs, mpMin, partMb, fetchImpl, ssh, installPollMs, installHttpsPollMs, installHttpsTries, installDnsTimeoutMs, installExtTimeoutMs, snapshotFn }) {
  applyTimezone(getSavedTimezone(db)); // сохранённый часовой пояс сервера (Настройки → Время сервера)
  const manager = createManager({ db, key, config });
  const alerts = createAlerts({ db, key, config, fetchImpl });
  const oidc = createOidc({ config, fetchImpl });
  const loginAttempts = new Map(); // ip → {n, until}

  /* ---------------- сессии ---------------- */
  const now = () => Date.now();
  function createSession(res, userId, req) {
    const token = randomToken();
    const ttl = config.sessionDays * 86_400_000;
    db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, ip, ua, last_used) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, now(), now() + ttl, req?.socket?.remoteAddress ?? null, String(req?.headers?.['user-agent'] ?? '').slice(0, 300), now());
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now(), userId);
    const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionDays * 86_400}${config.secureCookies ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${flags}`);
  }
  function userFromReq(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const hash = sha256(token);
    const u = db.prepare(`SELECT u.id, u.username, u.role, u.totp_enabled, u.display_name displayName, u.email FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ? AND u.disabled = 0`).get(hash, now());
    if (!u) return null;
    db.prepare('UPDATE sessions SET last_used = ? WHERE id_hash = ? AND (last_used IS NULL OR last_used < ?)').run(now(), hash, now() - 60_000);
    const ids = db.prepare('SELECT panel_id FROM user_panels WHERE user_id = ?').all(u.id).map((r) => r.panel_id);
    return { ...u, sessionHash: hash, totpEnabled: !!u.totp_enabled, panels: ids.length ? new Set(ids) : null }; // null = все панели
  }
  const publicUser = (u) => u && ({ id: u.id, username: u.username, displayName: u.displayName ?? null, role: u.role, totpEnabled: u.totpEnabled, panels: u.panels ? [...u.panels] : null });
  const canPanel = (user, id) => !user?.panels || user.panels.has(Number(id));
  const assertPanel = (ctx, id) => { if (!canPanel(ctx.user, id)) throw new HttpError(403, 'Нет доступа к этой панели'); };
  const activeAdmins = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND disabled = 0").get().c;
  const cleanName = (v) => { const t = String(v ?? '').trim(); need(t.length <= 80, 'Имя слишком длинное'); return t || null; };
  const cleanEmail = (v) => { if (v == null || String(v).trim() === '') return null; const t = String(v).trim().toLowerCase(); need(t.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t), 'Некорректный email'); return t; };
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
  const cleanSource = (src) => {
    if (!src || typeof src !== 'object' || !src.type) return undefined;
    if (!SOURCE_KINDS.includes(src.type)) throw new HttpError(400, 'Неизвестный тип источника');
    const t = (v, max = 500) => (v == null || v === '' ? undefined : String(v).slice(0, max));
    const out = { type: src.type };
    if (src.type === 'image') { out.image = t(src.image); out.username = t(src.username, 200); out.password = t(src.password, 500); if (!out.image) throw new HttpError(400, 'Укажите образ'); }
    else if (src.type === 'github') { out.owner = t(src.owner, 200); out.repo = t(src.repo, 200); out.ref = t(src.ref ?? src.branch, 200); out.path = t(src.path); if (!out.owner || !out.repo) throw new HttpError(400, 'Укажите владельца и репозиторий'); }
    else if (src.type === 'git') { out.repo = t(src.repo); out.ref = t(src.ref ?? src.branch, 200); out.path = t(src.path); if (!out.repo) throw new HttpError(400, 'Укажите адрес репозитория'); }
    else { out.dockerfile = t(src.dockerfile, 100_000); if (!out.dockerfile) throw new HttpError(400, 'Укажите содержимое Dockerfile'); }
    if (src.build?.type) { if (!BUILD_TYPES.includes(src.build.type)) throw new HttpError(400, 'Неизвестный способ сборки'); out.build = { type: src.build.type, file: t(src.build.file, 200) }; }
    return out;
  };
  const svcRef = (b) => ({ type: b.type, project: nameOf(b.project, 'project'), name: nameOf(b.name, 'service') });
  const asHttp = (e) => (e instanceof HttpError ? e : new HttpError(502, e.message));
  /** Добавляет панель в базу (общая часть ручного добавления и установки по SSH). */
  function addPanelRow(b) {
    const url = normalizeUrl(b.url);
    const token = str(b.token, 'Укажите API-токен', 4000);
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM panels').get().p;
    const id = db.prepare('INSERT INTO panels (name, url, token_enc, insecure_tls, color, tags, notes, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(str(b.name, 'Укажите название', 80), url, manager.sealToken(token), b.insecureTls ? 1 : 0,
        HEX.test(b.color) ? b.color : '#6366f1', cleanTags(b.tags), String(b.notes ?? '').slice(0, 1000), pos, now()).lastInsertRowid;
    const row = manager.getRow(Number(id));
    manager.snapshot(row.id, { force: true }).catch(() => {});
    return row;
  }

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
  const consoleHub = createConsoleHub();
  const loadmon = createLoadMonitor({ db, manager, alerts, config, snapshotFn });
  const backups = createBackups({ db, key, config, alerts, manager, audit, fetchImpl: fetchImpl ?? globalThis.fetch, restart, hostRun, dataPollMs, mpMin, partMb });
  manager.onSnapshot = (row, snap) => {
    alerts.evaluate(row, snap);
    try { loadmon.onHost(row, snap); } catch { /* метрики не должны мешать опросу панелей */ }
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
        need(!u.disabled, 'Учётная запись отключена');
        createSession(ctx.res, u.id, ctx.req);
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
      createSession(ctx.res, Number(id), ctx.req);
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
      if (u.disabled) throw new HttpError(403, 'Учётная запись отключена');
      createSession(ctx.res, u.id, ctx.req);
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
      const ended = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(u.id, ctx.user.sessionHash).changes; // остальные устройства выходят
      audit(ctx, { action: 'user.password_changed', detail: `${ended}` });
      return { ok: true, sessionsEnded: Number(ended) };
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

    /* ----- профиль ----- */
    ['GET', '/api/me', (ctx) => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
      return {
        id: u.id, username: u.username, displayName: u.display_name, email: u.email, role: u.role, totpEnabled: !!u.totp_enabled,
        sso: !!u.oidc_sub, hasPassword: !u.password_hash.startsWith('!'), createdAt: u.created_at, lastLogin: u.last_login,
        panels: ctx.user.panels ? [...ctx.user.panels] : null,
        sessions: db.prepare('SELECT id_hash, ip, ua, created_at createdAt, last_used lastUsed FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_used, created_at) DESC').all(u.id, now())
          .map((r) => ({ sid: r.id_hash.slice(0, 16), current: r.id_hash === ctx.user.sessionHash, ip: r.ip, ua: r.ua, createdAt: r.createdAt, lastUsed: r.lastUsed })),
        activity: db.prepare('SELECT ts, action, panel_name panelName, target, ok FROM audit WHERE username = ? ORDER BY id DESC LIMIT 15').all(u.username),
      };
    }],
    ['PUT', '/api/me', (ctx) => {
      const sets = []; const vals = [];
      if (ctx.body.displayName !== undefined) { sets.push('display_name = ?'); vals.push(cleanName(ctx.body.displayName)); }
      if (ctx.body.email !== undefined) { sets.push('email = ?'); vals.push(cleanEmail(ctx.body.email)); }
      if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, ctx.user.id);
      audit(ctx, { action: 'profile.update' });
      return { ok: true };
    }, { anyRole: true }],
    ['DELETE', '/api/me/sessions/:sid', (ctx) => {
      const row = db.prepare('SELECT id_hash FROM sessions WHERE user_id = ? AND substr(id_hash, 1, 16) = ?').get(ctx.user.id, ctx.params.sid);
      need(row, 'Сессия не найдена');
      need(row.id_hash !== ctx.user.sessionHash, 'Это текущая сессия — используйте «Выйти»');
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
      audit(ctx, { action: 'session.revoke' });
      return { ok: true };
    }, { anyRole: true }],
    ['POST', '/api/me/sessions/revoke-others', (ctx) => {
      const n = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(ctx.user.id, ctx.user.sessionHash).changes;
      audit(ctx, { action: 'session.revoke_others', detail: `${n}` });
      return { ok: true, revoked: Number(n) };
    }, { anyRole: true }],

    /* ----- пользователи (администратор) ----- */
    ['GET', '/api/users', () => db.prepare(`SELECT u.id, u.username, u.display_name displayName, u.email, u.role, u.disabled, u.totp_enabled totp, u.oidc_sub, u.password_hash,
        u.created_at createdAt, u.last_login lastLogin, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) sessions FROM users u ORDER BY u.id`).all(now())
      .map(({ oidc_sub: sub, password_hash: ph, disabled, totp, ...u }) => ({ ...u, disabled: !!disabled, totp: !!totp, sso: !!sub, hasPassword: !ph.startsWith('!'),
        panels: db.prepare('SELECT panel_id FROM user_panels WHERE user_id = ?').all(u.id).map((r) => r.panel_id) })), { admin: true }],
    ['POST', '/api/users', (ctx) => {
      const username = str(ctx.body.username, 'Укажите логин', 64);
      need(ROLES.includes(ctx.body.role), 'Роль: admin, operator или viewer');
      need(typeof ctx.body.password === 'string' && ctx.body.password.length >= 8, 'Пароль — минимум 8 символов');
      const dname = cleanName(ctx.body.displayName), email = cleanEmail(ctx.body.email); // проверка до вставки: иначе ошибка формата приняла бы вид «логин занят»
      let id;
      try {
        id = db.prepare('INSERT INTO users (username, password_hash, role, created_at, display_name, email) VALUES (?,?,?,?,?,?)')
          .run(username, hashPassword(ctx.body.password), ctx.body.role, now(), dname, email).lastInsertRowid;
      } catch { throw new HttpError(409, 'Такой логин уже существует'); }
      setUserPanels(Number(id), ctx.body.panels);
      audit(ctx, { action: 'user.create', target: username, detail: ctx.body.role });
      return { ok: true };
    }, { admin: true }],
    ['PUT', '/api/users/:id', (ctx) => {
      const id = Number(ctx.params.id); const b = ctx.body;
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      need(u, 'Пользователь не найден');
      const wasActiveAdmin = u.role === 'admin' && !u.disabled;
      const nextRole = b.role ?? u.role, nextDisabled = b.disabled === undefined ? !!u.disabled : !!b.disabled;
      if (b.role !== undefined) need(ROLES.includes(b.role), 'Неверная роль');
      need(!(id === ctx.user.id && b.role !== undefined && b.role !== 'admin'), 'Нельзя снять права администратора с самого себя');
      need(!(id === ctx.user.id && nextDisabled), 'Нельзя отключить самого себя');
      need(!(wasActiveAdmin && !(nextRole === 'admin' && !nextDisabled) && activeAdmins() <= 1), 'Нельзя лишить прав или отключить последнего администратора');
      const changed = [];
      if (b.username !== undefined && b.username !== u.username) {
        const name = str(b.username, 'Укажите логин', 64);
        need(!db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(name, id), 'Такой логин уже существует');
        db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, id); changed.push('username');
      }
      if (b.role !== undefined && b.role !== u.role) { db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id); changed.push('role'); }
      if (b.displayName !== undefined) { db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(cleanName(b.displayName), id); changed.push('name'); }
      if (b.email !== undefined) { db.prepare('UPDATE users SET email = ? WHERE id = ?').run(cleanEmail(b.email), id); changed.push('email'); }
      if (b.panels !== undefined) { setUserPanels(id, b.panels); changed.push('panels'); }
      if (b.password) {
        need(String(b.password).length >= 8, 'Пароль — минимум 8 символов');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); changed.push('password');
      }
      if (b.resetTotp) { db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE id = ?').run(id); changed.push('2fa'); }
      if (b.disabled !== undefined && !!b.disabled !== !!u.disabled) {
        db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, id);
        if (b.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        changed.push(b.disabled ? 'disabled' : 'enabled');
      }
      audit(ctx, { action: 'user.update', target: b.username ?? u.username, detail: changed.join(', ') || undefined });
      return { ok: true };
    }, { admin: true }],
    ['POST', '/api/users/:id/revoke-sessions', (ctx) => {
      const u = db.prepare('SELECT username FROM users WHERE id = ?').get(Number(ctx.params.id));
      need(u, 'Пользователь не найден');
      const n = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(ctx.params.id)).changes;
      audit(ctx, { action: 'user.sessions_revoked', target: u.username, detail: `${n}` });
      return { ok: true, revoked: Number(n) };
    }, { admin: true }],
    ['DELETE', '/api/users/:id', (ctx) => {
      const id = Number(ctx.params.id);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      need(u, 'Пользователь не найден');
      need(id !== ctx.user.id, 'Нельзя удалить самого себя');
      need(!(u.role === 'admin' && !u.disabled && activeAdmins() <= 1), 'Нельзя удалить последнего администратора');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      audit(ctx, { action: 'user.delete', target: u.username });
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
      const row = addPanelRow(ctx.body);
      audit(ctx, { action: 'panel.add', panel: row });
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
      manager.invalidate(row.id); loadmon.forget(row.id);
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
        let steps = [];
        await mutateAudited(ctx, row, 'service.create', `${ref.project}/${ref.name} (${ref.type})`, async () => { steps = (await createService(manager.clientFor(row), { ...ref, image: ctx.body.image, password: ctx.body.password, source: cleanSource(ctx.body.source) })) ?? []; });
        return { ok: true, steps: Array.isArray(steps) ? steps : [], warnings: (Array.isArray(steps) ? steps : []).filter((x) => !x.ok).map((x) => `${x.step}: ${x.error}`) };
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

    ['GET', '/api/audit/facets', (ctx) => {
      const rows = db.prepare('SELECT username, action, panel_id panelId FROM audit ORDER BY id DESC LIMIT 5000').all()
        .filter((r) => !ctx.user.panels || (r.panelId && ctx.user.panels.has(r.panelId)));
      return { users: [...new Set(rows.map((r) => r.username).filter(Boolean))].sort(), actions: [...new Set(rows.map((r) => r.action))].sort() };
    }],

    ['GET', '/api/audit', (ctx) => {
      const q = ctx.url.searchParams;
      const limit = Math.min(Number(q.get('limit')) || 100, 5000);
      const like = q.get('q') ? `%${q.get('q')}%` : null;
      const pid = Number(q.get('panel')) || null;
      const user = q.get('user') || null;
      const okf = q.get('ok') === '1' ? 1 : q.get('ok') === '0' ? 0 : null;
      const since = Number(q.get('since')) || null, until = Number(q.get('until')) || null;
      // категории: список префиксов действий через запятую (service., cert. …); без точки — точное совпадение
      const cats = (q.get('action') || '').split(',').map((x) => x.trim()).filter((x) => /^[a-z0-9_.]+$/i.test(x)).slice(0, 20);
      const catSql = cats.length ? ` AND (${cats.map(() => 'a.action LIKE ?').join(' OR ')})` : '';
      const catArgs = cats.map((c) => (c.endsWith('.') ? `${c}%` : c));
      const rows = db.prepare(`SELECT a.id, a.ts, a.username, a.panel_id panelId, COALESCE(p.name, a.panel_name) panelName, p.url panelUrl, p.color panelColor, (a.panel_id IS NOT NULL AND p.id IS NULL) panelDeleted,
        a.action, a.target, a.ok, a.detail FROM audit a LEFT JOIN panels p ON p.id = a.panel_id
        WHERE (? IS NULL OR a.username LIKE ? OR a.panel_name LIKE ? OR p.name LIKE ? OR p.url LIKE ? OR a.action LIKE ? OR a.target LIKE ?) AND (? IS NULL OR a.panel_id = ?)
        AND (? IS NULL OR a.username = ?) AND (? IS NULL OR a.ok = ?) AND (? IS NULL OR a.ts >= ?) AND (? IS NULL OR a.ts <= ?)${catSql} ORDER BY a.id DESC LIMIT ?`)
        .all(like, like, like, like, like, like, like, pid, pid, user, user, okf, okf, since, since, until, until, ...catArgs, limit).filter((r) => !ctx.user.panels || (r.panelId && ctx.user.panels.has(r.panelId)));
      if (q.get('format') !== 'csv') return rows;
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
      const csv = ['time,user,panel,action,target,ok,detail,panel_url', ...rows.map((r) => [new Date(r.ts).toISOString(), r.username, r.panelName, r.action, r.target, r.ok ? 'ok' : 'error', r.detail, r.panelUrl].map(esc).join(','))].join('\n');
      return new RawResponse('\ufeff' + csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="easyadmin-audit.csv"' });
    }],

    ...extraRoutes({ db, key, config, fetchImpl, ssh, hostRun, dataPollMs, loadmon, backups, addPanelRow, installPollMs, installHttpsPollMs, installHttpsTries, installDnsTimeoutMs, installExtTimeoutMs, consoleHub, manager, alerts, scheduler: () => scheduler, audit, mutateAudited, need, str, nameOf, asHttp, panelOr404, assertPanel, canPanel, svcRef, cleanSource }),
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
      const ctx = { req, res, url, user, params, body: mutating && !route.opts.raw ? await readJson(req) : {} };
      const out = await route.handler(ctx);
      if (out instanceof StreamResponse) return await out.run(req, res);
      if (out instanceof RawResponse) sendRaw(res, out); else sendJson(res, 200, out);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.end();
      const msg = status === 500 ? 'Внутренняя ошибка' : e.message;
      sendJson(res, status, { ...(e.extra ?? {}), error: req.headers['x-lang'] === 'en' ? translate(msg) : msg });
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
    manager.startPolling(); scheduler.start(); loadmon.start(); backups.start();
    const prune = () => {
      db.prepare('DELETE FROM audit WHERE ts < ?').run(now() - 90 * 86_400_000);
      db.prepare('DELETE FROM stats_history WHERE ts < ?').run(now() - 7 * 86_400_000);
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    };
    prune(); maintenance = setInterval(prune, 6 * 3600_000); maintenance.unref();
  };
  const stop = () => { manager.stop(); scheduler.stop(); loadmon.stop(); backups.stop(); consoleHub.closeAll(); clearInterval(maintenance); };
  return { server, manager, alerts, scheduler, loadmon, backups, start, stop };
}
