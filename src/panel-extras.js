import { HttpError } from './http.js';
import { makeLicense } from './panel-license.js';

/**
 * Дополнения к настройкам панели: хранилища бэкапов и каналы уведомлений Easypanel (создание, правка, проверка),
 * логотипы интерфейса, расписания и запуск бэкапов баз данных и томов сервиса, восстановление базы из копии.
 * Секреты (ключи, пароли, URL вебхуков) в браузер не уходят: при правке пустое поле означает «оставить как есть».
 */
const S = (name, label, extra = {}) => ({ name, type: 'text', label, ...extra });
const SECRET = (name, label, extra = {}) => ({ name, type: 'secret', label, secret: true, ...extra });

export const PROVIDER_SPECS = {
  s3: { label: 'S3-совместимое', fields: [S('name', 'Название', { required: true }), S('bucket', 'Бакет', { required: true }), S('region', 'Регион', { required: true, placeholder: 'eu-central-1' }), S('endpoint', 'Endpoint', { placeholder: 'https://s3.example.com', hint: 'Пусто — AWS.' }), SECRET('accessKeyId', 'Access key ID', { required: true }), SECRET('secretAccessKey', 'Secret access key', { required: true }), S('storageClass', 'Класс хранения'),
    { name: 'subtype', type: 'select', label: 'Провайдер', options: [['other', 'Другой'], ['aws', 'AWS'], ['backblaze', 'Backblaze'], ['cloudflare-r2', 'Cloudflare R2'], ['digital-ocean', 'DigitalOcean'], ['wasabi', 'Wasabi']], createOnly: true }] },
  sftp: { label: 'SFTP', fields: [S('name', 'Название', { required: true }), S('host', 'Хост', { required: true }), S('port', 'Порт', { placeholder: '22' }), S('username', 'Пользователь', { required: true }), SECRET('password', 'Пароль', { required: true })] },
  ftp: { label: 'FTP', fields: [S('name', 'Название', { required: true }), S('host', 'Хост', { required: true }), S('port', 'Порт', { placeholder: '21', required: true }), S('username', 'Пользователь', { required: true }), SECRET('password', 'Пароль', { required: true })] },
  local: { label: 'Папка на сервере', fields: [S('name', 'Название', { required: true }), S('path', 'Путь', { required: true, placeholder: '/backups' })] },
  dropbox: { label: 'Dropbox', fields: [S('name', 'Название')], renameOnly: true },
  google: { label: 'Google Drive', fields: [S('name', 'Название')], renameOnly: true },
};
const EVENTS = [['appDeploy', 'Деплой сервисов'], ['databaseBackup', 'Бэкапы баз данных'], ['dockerCleanup', 'Очистка Docker'], ['updateAvailable', 'Доступно обновление'], ['diskLoad', 'Нагрузка на диск']];
export const NOTIFY_SPECS = {
  discord: { label: 'Discord', fields: [SECRET('url', 'URL вебхука', { required: true, placeholder: 'https://discord.com/api/webhooks/…' })] },
  slack: { label: 'Slack', fields: [SECRET('url', 'URL вебхука', { required: true, placeholder: 'https://hooks.slack.com/…' })] },
  telegram: { label: 'Telegram', fields: [SECRET('access_token', 'Токен бота', { required: true }), S('chat_id', 'Chat ID', { required: true })] },
  webhook: { label: 'Webhook', fields: [SECRET('url', 'URL', { required: true }), SECRET('secret', 'Секрет подписи')] },
  smtp: { label: 'E-mail (SMTP)', fields: [S('host', 'SMTP-сервер', { required: true }), { name: 'port', type: 'int', label: 'Порт', min: 1, max: 65535, required: true }, S('username', 'Пользователь', { required: true }), SECRET('password', 'Пароль', { required: true }), S('recipients', 'Получатели', { required: true, hint: 'Адреса через запятую.' })] },
};
const LOGO_SLOTS = ['lightLogo', 'lightLogoMark', 'darkLogo', 'darkLogoMark'];
const DATA_IMG = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CRON = /^\s*(\S+\s+){4}\S+\s*$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DB_NAME = /^[A-Za-z0-9_.$-]{1,128}$/;
const BACKUP_PATH = /^[A-Za-z0-9_./ -]{0,200}$/;
const need = (c, m) => { if (!c) throw new HttpError(400, m); };
const id = (v) => { const s = String(v ?? ''); need(ID.test(s), 'Некорректный идентификатор'); return s; };
const listOf = (v, ...keys) => (Array.isArray(v) ? v : keys.map((k) => v?.[k]).find(Array.isArray) ?? []);
const providerType = (p) => { const t = String(p?.type ?? p?.provider ?? '').toLowerCase(); if (PROVIDER_SPECS[t]) return t; if (p?.bucket) return 's3'; if (p?.path && !p?.host) return 'local'; return null; };

/** Значения из формы по описанию полей: обязательные проверяются, секрет при правке может остаться пустым (берётся прежний). */
function fromSpec(spec, body, old, { editing }) {
  const out = {};
  for (const f of spec.fields) {
    if (f.createOnly && editing) continue;
    let v = body?.[f.name];
    if (f.type === 'int') { v = v === '' || v == null ? undefined : Number(v); if (v != null) need(Number.isInteger(v) && v >= (f.min ?? 0) && v <= (f.max ?? 1e9), `${f.label}: некорректное число`); }
    else { v = v == null ? '' : String(v).trim(); need(v.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), `${f.label}: недопустимое значение`); }
    if (f.type === 'select') need(v === '' || f.options.some(([o]) => o === v), `${f.label}: недопустимое значение`);
    if (f.secret && (v === '' || v == null) && old?.[f.name] != null && old[f.name] !== '') v = old[f.name];
    if (v === '' || v == null) { if (f.required) throw new HttpError(400, `${f.label}: обязательное поле`); if (f.type !== 'int') v = undefined; }
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

export function extrasRoutes(d) {
  const { db, manager, audit, asHttp, panelOr404, assertPanel } = d;
  const lic = makeLicense(d);
  const applied = async (check) => { let ok = false; try { ok = await check(); } catch { ok = true; } if (!ok) throw new HttpError(502, 'Панель не применила изменение — возможно, для него нужна лицензия Easypanel'); };
  const access = (ctx) => { const row = panelOr404(ctx.params.id); assertPanel(ctx, row.id); return { row, c: manager.clientFor(row) }; };
  const call = async (fn) => { try { return await fn(); } catch (e) { throw asHttp(e); } };
  const write = async (ctx, row, action, target, fn, detail) => {
    try { const r = await fn(); audit(ctx, { action, panel: row, target, detail }); manager.invalidate(row.id); return r; }
    catch (e) { audit(ctx, { action, panel: row, target, ok: false, detail: e.message }); throw asHttp(e); }
  };
  const specsOut = (specs) => Object.fromEntries(Object.entries(specs).map(([k, v]) => [k, { label: v.label, fields: v.fields, renameOnly: !!v.renameOnly }]));
  const providers = async (c) => listOf(await call(() => c.query('storageProviders.common.list')));
  const channels = async (c) => listOf(await call(() => c.query('notifications.listNotificationChannels')), 'channels');
  const svcRef = (ctx, src) => {
    const get = (k) => (src instanceof URLSearchParams ? src.get(k) : src?.[k]);
    const project = String(get('project') ?? ''); const name = String(get('name') ?? ''); const type = String(get('type') ?? '');
    need(/^[a-z0-9-_]+$/.test(project) && /^[a-z0-9-_]+$/.test(name), 'Некорректный сервис');
    return { project, name, type };
  };
  const DB_TYPES = ['postgres', 'mysql', 'mariadb', 'mongo'];

  /* ---- каналы уведомлений панели: форма → target/events ---- */
  const cleanChannel = (body, old) => {
    const type = String(body?.type ?? old?.target?.type ?? ''); const spec = NOTIFY_SPECS[type]; need(spec, 'Неизвестный тип канала');
    const name = String(body?.name ?? '').trim(); need(name && name.length <= 80, 'Укажите название (до 80 символов)');
    const oldTarget = old?.target?.type === type ? old.target : null;
    const t = fromSpec(spec, body?.target ?? {}, oldTarget, { editing: !!old });
    if (t.url !== undefined) { try { const u = new URL(t.url); need(['http:', 'https:'].includes(u.protocol), 'URL должен быть http(s)'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'URL: некорректный адрес'); } }
    const target = { type, ...t };
    if (type === 'smtp') {
      const list = (Array.isArray(t.recipients) ? t.recipients : String(t.recipients ?? '').split(/[,;\s]+/)).map((x) => x.trim()).filter(Boolean);
      need(list.length > 0 && list.length <= 20 && list.every((x) => EMAIL.test(x)), 'Получатели: корректные e-mail через запятую');
      target.recipients = list; target.port = Number(t.port);
    }
    if (type === 'telegram') need(/^-?\d+$/.test(target.chat_id) || /^@\w+$/.test(target.chat_id), 'Chat ID: число или @канал');
    const ev = body?.events ?? {}; const events = {};
    for (const [k] of EVENTS) {
      if (k === 'diskLoad') {
        const e = ev.diskLoad ?? {}; const min = Number(e.min ?? 80); need(Number.isFinite(min) && min >= 1 && min <= 100, 'Нагрузка на диск: порог от 1 до 100 %');
        const schedule = String(e.schedule ?? '0 2 * * *').trim(); need(CRON.test(schedule) && schedule.length <= 60, 'Расписание проверки диска — cron из 5 полей');
        events.diskLoad = { enabled: !!e.enabled, min, schedule };
      } else events[k] = { enabled: !!ev[k]?.enabled };
    }
    return { name, target, events };
  };
  const maskChannel = (x) => {
    const spec = NOTIFY_SPECS[x.target?.type]; const secret = new Set((spec?.fields ?? []).filter((f) => f.secret).map((f) => f.name));
    const target = Object.fromEntries(Object.entries(x.target ?? {}).map(([k, v]) => [k, secret.has(k) ? (v ? '' : '') : Array.isArray(v) ? v.join(', ') : v]));
    return { id: String(x.id ?? ''), name: x.name ?? '', type: x.target?.type ?? null, target, hasSecret: Object.fromEntries([...secret].map((k) => [k, !!x.target?.[k]])), events: x.events ?? {} };
  };

  /* ---- расписания бэкапов ---- */
  const cleanSchedule = (kind, b) => {
    const schedule = String(b?.schedule ?? '').trim(); need(CRON.test(schedule) && schedule.length <= 60, 'Расписание — cron из 5 полей, например 0 2 * * *');
    const storageProviderId = id(b?.storageProviderId); const path = String(b?.storageProviderPath ?? '').trim(); need(BACKUP_PATH.test(path) && !path.split('/').includes('..'), 'Папка в хранилище: буквы, цифры, / - _ . и пробел, без «..»');
    const base = { enabled: !!b?.enabled, schedule, storageProviderId, storageProviderPath: path };
    if (kind === 'db') {
      need(DB_NAME.test(String(b?.databaseName ?? '')), 'Укажите базу данных');
      const out = { ...base, databaseName: String(b.databaseName) };
      if (b.retention !== undefined && b.retention !== '' && b.retention !== null) { const r = Number(b.retention); need(Number.isInteger(r) && r >= 1 && r <= 3650, 'Хранить копий: от 1 до 3650'); out.retention = r; }
      return out;
    }
    need(/^[A-Za-z0-9_.-]{1,200}$/.test(String(b?.volumeName ?? '')), 'Укажите том');
    return { ...base, volumeName: String(b.volumeName) };
  };
  const kindOf = (type) => (DB_TYPES.includes(type) ? 'db' : type === 'app' || type === 'box' ? 'volume' : null);
  const owned = async (c, kind, r, bid) => {
    const list = listOf(await call(() => c.query(kind === 'db' ? 'databaseBackups.listDatabaseBackups' : 'volumeBackups.listVolumeBackups', { projectName: r.project, serviceName: r.name })));
    need(list.some((x) => String(x.id) === bid), 'Расписание не найдено у этого сервиса'); return list.find((x) => String(x.id) === bid);
  };

  return [
    /* ---------- хранилища бэкапов ---------- */
    ['GET', '/api/panels/:id/pstorage', async (ctx) => {
      const { c } = access(ctx);
      return { providers: (await providers(c)).map((p) => { const type = providerType(p); const spec = PROVIDER_SPECS[type]; const secret = new Set((spec?.fields ?? []).filter((f) => f.secret).map((f) => f.name));
        return { id: String(p.id ?? ''), name: p.name ?? '', type, values: Object.fromEntries((spec?.fields ?? []).filter((f) => !f.secret && !f.createOnly).map((f) => [f.name, p[f.name] ?? ''])), hasSecret: Object.fromEntries([...secret].map((k) => [k, !!p[k]])) }; }), specs: specsOut(PROVIDER_SPECS) };
    }, { admin: true }],
    ['POST', '/api/panels/:id/pstorage', async (ctx) => {
      const { row, c } = access(ctx); const type = String(ctx.body?.type ?? ''); const spec = PROVIDER_SPECS[type]; need(spec && !spec.renameOnly, 'Создать можно S3, SFTP, FTP и папку; Dropbox и Google подключаются в самой панели');
      const v = fromSpec(spec, ctx.body?.values, null, { editing: false });
      if (type === 's3' && !v.subtype) v.subtype = 'other';
      await write(ctx, row, 'storage.provider.create', `${type}/${v.name}`, () => c.mutate(`storageProviders.${type}.createProvider`, v), `тип ${type}`);
      return { ok: true };
    }, { admin: true }],
    ['PUT', '/api/panels/:id/pstorage/:type/:pid', async (ctx) => {
      const { row, c } = access(ctx); const type = ctx.params.type; const spec = PROVIDER_SPECS[type]; need(spec, 'Неизвестный тип хранилища'); const pid = id(ctx.params.pid);
      const old = (await providers(c)).find((p) => String(p.id) === pid); need(old, 'Хранилище не найдено');
      const ot = providerType(old); need(!ot || ot === type, 'Тип хранилища не совпадает');
      const v = fromSpec(spec, ctx.body?.values, old, { editing: true });
      await write(ctx, row, 'storage.provider.update', `${type}/${v.name ?? pid}`, () => c.mutate(`storageProviders.${type}.updateProvider`, { id: pid, ...v }), `поля: ${Object.keys(v).filter((k) => !PROVIDER_SPECS[type].fields.find((f) => f.name === k)?.secret).join(', ')}`);
      return { ok: true };
    }, { admin: true }],

    /* ---------- каналы уведомлений панели ---------- */
    ['GET', '/api/panels/:id/pnotify', async (ctx) => {
      const { c } = access(ctx);
      return { channels: (await channels(c)).map(maskChannel), specs: specsOut(NOTIFY_SPECS), events: EVENTS };
    }, { admin: true }],
    ['POST', '/api/panels/:id/pnotify', async (ctx) => {
      const { row, c } = access(ctx); const v = cleanChannel(ctx.body, null);
      await lic.require(row, c, 'notifications', 'Каналы уведомлений панели');
      const count = (await channels(c)).length;
      await write(ctx, row, 'panel.notify.create', v.name, () => c.mutate('notifications.createNotificationChannel', v), `тип ${v.target.type}`);
      await applied(async () => (await channels(c)).length > count);
      return { ok: true };
    }, { admin: true }],
    ['PUT', '/api/panels/:id/pnotify/:cid', async (ctx) => {
      const { row, c } = access(ctx); const cid = id(ctx.params.cid);
      const old = (await channels(c)).find((x) => String(x.id) === cid); need(old, 'Канал не найден');
      const v = cleanChannel({ ...ctx.body, type: old.target?.type }, old);
      await lic.require(row, c, 'notifications', 'Каналы уведомлений панели');
      await write(ctx, row, 'panel.notify.update', v.name, () => c.mutate('notifications.updateNotificationChannel', { id: cid, ...v }), `тип ${v.target.type}`);
      await applied(async () => (await channels(c)).some((x) => String(x.id) === cid && x.name === v.name));
      return { ok: true };
    }, { admin: true }],
    ['POST', '/api/panels/:id/pnotify/test', async (ctx) => {
      const { row, c } = access(ctx); const old = ctx.body?.id ? (await channels(c)).find((x) => String(x.id) === id(ctx.body.id)) : null;
      const v = cleanChannel(ctx.body, old);
      await write(ctx, row, 'panel.notify.test', v.name, () => c.mutate('notifications.sendTestNotification', v), `тип ${v.target.type}`);
      return { ok: true };
    }, { admin: true }],

    /* ---------- логотипы интерфейса панели ---------- */
    ['GET', '/api/panels/:id/plogos', async (ctx) => {
      const { c } = access(ctx); const r = await call(() => c.query('branding.getLogoSettings'));
      return { logos: Object.fromEntries(LOGO_SLOTS.map((k) => { const v = typeof r?.[k] === 'string' ? r[k] : ''; return [k, { set: !!v, size: v.length, preview: v && v.length <= 400_000 && (DATA_IMG.test(v) || /^https:\/\//.test(v)) ? v : null }]; })) };
    }, { admin: true }],
    ['PUT', '/api/panels/:id/plogos', async (ctx) => {
      const { row, c } = access(ctx); const slot = String(ctx.body?.slot ?? ''); need(LOGO_SLOTS.includes(slot), 'Неизвестный логотип');
      await lic.require(row, c, 'branding', 'Логотипы интерфейса');
      let value = ctx.body?.value; if (value === null || value === '') value = '';
      else { need(typeof value === 'string' && value.length <= 700_000, 'Файл слишком большой (до 500 КБ)'); need(DATA_IMG.test(value) || /^https:\/\/[^\s]{3,500}$/.test(value), 'Нужна картинка PNG, JPEG, GIF, WebP или SVG'); }
      // панель заменяет все логотипы разом — остальные берём текущие
      const cur = await call(() => c.query('branding.getLogoSettings'));
      const next = Object.fromEntries(LOGO_SLOTS.map((k) => [k, k === slot ? value : (typeof cur?.[k] === 'string' ? cur[k] : '')]));
      await write(ctx, row, 'branding.logo', slot, () => c.mutate('branding.setLogoSettings', next), value ? `загружен (${Math.round(value.length / 1024)} КБ)` : 'удалён');
      return { ok: true };
    }, { admin: true }],

    /* ---------- бэкапы сервиса ---------- */
    ['GET', '/api/panels/:id/pbackups', async (ctx) => {
      const { row, c } = access(ctx); const r = svcRef(ctx, ctx.url.searchParams); const kind = kindOf(r.type);
      if (!kind) return { kind: null, schedules: [], providers: [], history: [] };
      const scheduled = kind === 'volume' || await lic.has(row, c, 'databaseBackups'); // расписания баз без лицензии панель не выполняет
      const sel = { projectName: r.project, serviceName: r.name };
      const [schedules, opts, extra, acts] = await Promise.all([
        call(() => c.query(kind === 'db' ? 'databaseBackups.listDatabaseBackups' : 'volumeBackups.listVolumeBackups', sel)),
        c.query('storageProviders.common.listOptions').catch(() => []),
        (kind === 'db' ? c.query('databaseBackups.getServiceDatabases', sel) : c.query('volumeBackups.listVolumeMounts', sel)).catch(() => []),
        c.query('actions.listActions', { limit: 50, ...sel }).catch(() => []),
      ]);
      const history = listOf(acts, 'actions').filter((a) => a?.type === 'backup').slice(0, 20).map((a) => ({ id: String(a.id), status: a.status ?? null, createdAt: a.createdAt ?? a.startedAt ?? null, description: a.description ?? null, restorable: kind === 'db' && a.status === 'done' && !!a.meta?.path, databaseName: a.meta?.databaseName ?? null, path: a.meta?.path ?? null, storageProviderId: a.meta?.storageProviderId ?? null }));
      return { kind, scheduled, schedules: listOf(schedules), providers: listOf(opts).map((o) => ({ id: String(o.value ?? o.id ?? ''), name: o.label ?? o.name ?? '' })),
        databases: kind === 'db' ? listOf(extra, 'databases').map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean) : [], mounts: kind === 'volume' ? listOf(extra, 'mounts').map((m) => ({ name: m.name ?? m.volumeName ?? '', mountPath: m.mountPath ?? m.path ?? '' })).filter((m) => m.name) : [], history };
    }, { admin: true }],
    ['POST', '/api/panels/:id/pbackups', async (ctx) => {
      const { row, c } = access(ctx); const r = svcRef(ctx, ctx.body); const kind = kindOf(r.type); need(kind, 'У этого типа сервиса нет бэкапов');
      const v = cleanSchedule(kind, ctx.body?.schedule);
      if (kind === 'db') await lic.require(row, c, 'databaseBackups', 'Расписания бэкапов баз данных (без лицензии панель их не выполняет)');
      await write(ctx, row, `backup.${kind}.create`, `${r.project}/${r.name}`, () => c.mutate(kind === 'db' ? 'databaseBackups.createDatabaseBackup' : 'volumeBackups.createVolumeBackup', { projectName: r.project, serviceName: r.name, ...v }), `${v.schedule}${v.databaseName ? ` · ${v.databaseName}` : ` · ${v.volumeName}`}`);
      return { ok: true };
    }, { admin: true }],
    ['PUT', '/api/panels/:id/pbackups/:bid', async (ctx) => {
      const { row, c } = access(ctx); const r = svcRef(ctx, ctx.body); const kind = kindOf(r.type); need(kind, 'У этого типа сервиса нет бэкапов'); const bid = id(ctx.params.bid);
      await owned(c, kind, r, bid); const v = cleanSchedule(kind, ctx.body?.schedule);
      if (kind === 'db' && v.enabled) await lic.require(row, c, 'databaseBackups', 'Расписания бэкапов баз данных (без лицензии панель их не выполняет)');
      await write(ctx, row, `backup.${kind}.update`, `${r.project}/${r.name}`, () => c.mutate(kind === 'db' ? 'databaseBackups.updateDatabaseBackup' : 'volumeBackups.updateVolumeBackup', { id: bid, projectName: r.project, serviceName: r.name, ...v }), v.schedule);
      return { ok: true };
    }, { admin: true }],
    ['DELETE', '/api/panels/:id/pbackups/:bid', async (ctx) => {
      const { row, c } = access(ctx); const r = svcRef(ctx, ctx.url.searchParams); const kind = kindOf(r.type); need(kind, 'У этого типа сервиса нет бэкапов'); const bid = id(ctx.params.bid);
      await owned(c, kind, r, bid);
      await write(ctx, row, `backup.${kind}.delete`, `${r.project}/${r.name}`, () => c.mutate(kind === 'db' ? 'databaseBackups.deleteDatabaseBackup' : 'volumeBackups.destroyVolumeBackup', { id: bid }));
      return { ok: true };
    }, { admin: true }],
    ['POST', '/api/panels/:id/pbackups/:bid/run', async (ctx) => {
      const { row, c } = access(ctx); const r = svcRef(ctx, ctx.body); const kind = kindOf(r.type); need(kind, 'У этого типа сервиса нет бэкапов'); const bid = id(ctx.params.bid);
      await owned(c, kind, r, bid);
      await write(ctx, row, `backup.${kind}.run`, `${r.project}/${r.name}`, () => c.mutate(kind === 'db' ? 'databaseBackups.runDatabaseBackup' : 'volumeBackups.runVolumeBackup', { id: bid }));
      return { ok: true };
    }, { admin: true }],
    ['POST', '/api/panels/:id/pbackups/restore', async (ctx) => {
      const { row, c } = access(ctx); const r = svcRef(ctx, ctx.body); need(DB_TYPES.includes(r.type), 'Восстановление есть только у баз данных'); const b = ctx.body ?? {};
      need(DB_NAME.test(String(b.databaseName ?? '')), 'Укажите базу данных');
      const path = String(b.path ?? ''); need(path.length > 0 && path.length <= 500 && !path.split('/').includes('..') && !/[\u0000-\u001f]/.test(path), 'Некорректный путь к копии');
      need(String(b.confirm ?? '') === `${r.project}/${r.name}`, 'Для восстановления введите project/service');
      const history = listOf(await call(() => c.query('actions.listActions', { limit: 100, projectName: r.project, serviceName: r.name })), 'actions');
      need(history.some((a) => a?.type === 'backup' && a.status === 'done' && a.meta?.path === path && String(a.meta?.storageProviderId) === String(b.storageProviderId)), 'Такой копии нет в журнале бэкапов сервиса');
      await write(ctx, row, 'backup.db.restore', `${r.project}/${r.name}`, () => c.mutate('databaseBackups.restoreDatabaseBackup', { databaseName: b.databaseName, path, projectName: r.project, serviceName: r.name, storageProviderId: id(b.storageProviderId) }), `${b.databaseName} ← ${path}`);
      return { ok: true };
    }, { admin: true }],
  ];
}
