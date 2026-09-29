import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decrypt, encrypt, randomToken, sha256 } from './crypto.js';
import { ACTIONS, SYSTEM_OPS, SERVICE_TYPES, inspectService, runAction, runServiceOp } from './easypanel.js';
import { EVENT_TYPES } from './alerts.js';
import { HttpError, RawResponse } from './http.js';
import { applyConfig, extractConfig, mergeEnv, parseEnvLines } from './templates.js';

const CHANNEL_TYPES = ['telegram', 'webhook'];

/** Дополнительные маршруты: уведомления, шаблоны, клонирование, расписания, вебхуки, инвентарь, история, бэкап. */
export function extraRoutes(d) {
  const { db, key, config, manager, alerts, audit, mutateAudited, need, str, nameOf, asHttp, panelOr404, assertPanel, canPanel } = d;
  const now = () => Date.now();
  const treeOf = async (row) => (await manager.snapshot(row.id))?.tree?.projects ?? [];
  const accessible = (ctx) => db.prepare('SELECT * FROM panels ORDER BY position, id').all().filter((p) => canPanel(ctx.user, p.id));
  const ref = (t) => ({ type: t.type, project: nameOf(t.project, 'project'), name: nameOf(t.name, 'service') });

  /* ---------------- уведомления ---------------- */
  const cleanChannel = (b, old) => {
    need(CHANNEL_TYPES.includes(b.type), 'Тип канала: telegram или webhook');
    const cfg = { ...(old?.config ?? {}) };
    if (b.type === 'telegram') {
      if (b.botToken) cfg.botToken = String(b.botToken); if (b.chatId) cfg.chatId = String(b.chatId);
      need(cfg.botToken && cfg.chatId, 'Укажите токен бота и chat id');
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
  const summary = (cfg) => ({ image: cfg.source?.image ?? (cfg.source?.owner ? `${cfg.source.owner}/${cfg.source.repo}` : null), envLines: cfg.env ? cfg.env.split('\n').filter(Boolean).length : 0 });
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
  const pubSchedule = (s) => ({ id: s.id, name: s.name, enabled: !!s.enabled, target: JSON.parse(s.target), action: s.action, mode: s.mode, time: s.time, days: s.days ? s.days.split(',').map(Number) : [], intervalMin: s.interval_min, lastRun: s.last_run, lastStatus: s.last_status });
  const scheduleRoutes = [
    ['GET', '/api/schedules', () => db.prepare('SELECT * FROM schedules ORDER BY id').all().map(pubSchedule)],
    ['POST', '/api/schedules', (ctx) => {
      const c = cleanSchedule(ctx);
      db.prepare('INSERT INTO schedules (name, enabled, target, action, mode, time, days, interval_min, last_run, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(c.name, c.enabled, c.target, c.action, c.mode, c.time, c.days, c.interval_min, now(), now());
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
  async function imagesOf(row, force) {
    const hit = imageCache.get(row.id);
    if (!force && hit && now() - hit.at < 300_000) return hit.items;
    const svcs = (await treeOf(row)).flatMap((p) => p.services).filter((s) => s.type === 'app');
    const c = manager.clientFor(row);
    const items = await mapLimit(svcs, 5, async (s) => {
      try {
        const src = (await inspectService(c, { type: 'app', project: s.project, name: s.name })).service?.source;
        return { project: s.project, name: s.name, type: src?.type ?? 'unknown', image: src?.image ?? null, repo: src?.owner ? `${src.owner}/${src.repo}@${src.ref ?? src.branch ?? ''}` : null };
      } catch (e) { return { project: s.project, name: s.name, type: 'error', error: e.message }; }
    });
    imageCache.set(row.id, { at: now(), items });
    return items;
  }
  const certExpiry = (c) => {
    const v = c?.expiresAt ?? c?.validTo ?? c?.notAfter ?? c?.expiry ?? c?.expires ?? c?.validUntil;
    const t = v ? new Date(v).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  };
  async function certsOf(row) {
    const list = await manager.clientFor(row).query('certificates.listCertificates');
    return (Array.isArray(list) ? list : list?.certificates ?? []).map((c) => ({ domain: c?.domain ?? c?.host ?? c?.name ?? (Array.isArray(c?.domains) ? c.domains.join(', ') : String(c?.id ?? '?')), expiresAt: certExpiry(c), raw: c }));
  }
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

  return [...channelRoutes, ...historyRoutes, ...templateRoutes, ...bulkRoutes, ...scheduleRoutes, ...hookRoutes, ...inventoryRoutes, ...backupRoutes];
}
