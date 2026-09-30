import { decrypt, encrypt } from './crypto.js';
import { HttpError } from './http.js';

/**
 * Настройки самой панели Easypanel: типизированный реестр одиночных настроек (формы строятся из него и на сервере проверяются тем же описанием)
 * + маршруты для списков и действий (пользователи, билдеры, Traefik, кластер, хранилища бэкапов, журнал действий).
 * Имена процедур — реальные пути tRPC панели (router.procedure), проверены по её интерфейсу и API.
 */
export const SECTIONS = [
  ['overview', 'Обзор'], ['address', 'Адреса'], ['general', 'Общее'], ['branding', 'Оформление'], ['system', 'Обновления и Docker'],
  ['users', 'Пользователи'], ['monitoring', 'Мониторинг'], ['traefik', 'Traefik'], ['infra', 'Кластер и хранилища'], ['actions', 'Журнал панели'], ['advanced', 'Расширенные'],
];

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const B = (name, label, hint) => ({ name, type: 'bool', label, hint });

/** Реестр одиночных настроек. bulk: можно применить сразу к нескольким панелям; danger: нужно подтверждение. */
export const SETTINGS = [
  { key: 'panelDomain', section: 'address', title: 'Домен панели', danger: true, hint: 'Адрес, по которому открывается Easypanel. Неверный домен может закрыть доступ к панели — проверьте, что DNS указывает на сервер.',
    fields: [{ name: 'customPanelDomain', type: 'domain', label: 'Свой домен', placeholder: 'panel.example.com', hint: 'Пусто — только сгенерированный домен.' }, B('serveOnIp', 'Открывать панель по IP-адресу сервера', 'Запасной вход, если домен перестанет работать.')],
    get: 'settings.getPanelDomain', read: (r) => ({ customPanelDomain: r?.customPanelDomain ?? '', serveOnIp: !!r?.serveOnIp, _info: { defaultPanelDomain: r?.defaultPanelDomain ?? null } }),
    set: 'settings.setPanelDomain', build: (v) => ({ customPanelDomain: v.customPanelDomain || '', serveOnIp: !!v.serveOnIp }) },
  { key: 'serviceDomain', section: 'address', title: 'Базовый домен сервисов', danger: true, hint: 'Поддомены сервисов создаются от этого домена. Нужна DNS-запись *.домен на сервер.',
    fields: [{ name: 'customServiceDomain', type: 'domain', label: 'Свой домен', placeholder: 'apps.example.com', hint: 'Пусто — сгенерированный домен.' }],
    get: 'settings.getServiceDomain', read: (r) => ({ customServiceDomain: r?.customServiceDomain ?? '', _info: { defaultServiceDomain: r?.defaultServiceDomain ?? null } }),
    set: 'settings.setServiceDomain', build: (v) => ({ customServiceDomain: v.customServiceDomain || '' }) },
  { key: 'letsEncryptEmail', section: 'address', title: 'E-mail для Let’s Encrypt', bulk: true, hint: 'На этот адрес приходят уведомления об истекающих сертификатах.',
    fields: [{ name: 'email', type: 'email', label: 'E-mail', required: true, placeholder: 'admin@example.com' }],
    get: 'settings.getLetsEncryptEmail', read: (r) => ({ email: typeof r === 'string' ? r : '' }),
    set: 'settings.setLetsEncryptEmail', build: (v) => ({ letsEncryptEmail: v.email }) },
  { key: 'telemetry', section: 'general', title: 'Телеметрия', bulk: true, hint: 'Анонимная статистика, которую Easypanel отправляет разработчикам.',
    fields: [B('disabled', 'Отключить телеметрию')],
    get: 'settings.getTelemetryDisabled', read: (r) => ({ disabled: !!r }), set: 'settings.setTelemetryDisabled', build: (v) => ({ disabled: !!v.disabled }) },
  { key: 'dailyCleanup', section: 'general', title: 'Ночная очистка Docker', bulk: true, hint: 'Каждую ночь в 02:00 удаляются неиспользуемые образы и данные Docker.',
    fields: [B('enabled', 'Очищать Docker автоматически каждую ночь')],
    get: 'settings.getDailyDockerCleanup', read: (r) => ({ enabled: !!r }), set: 'settings.setDailyDockerCleanup', build: (v) => ({ dailyDockerCleanup: !!v.enabled }) },
  { key: 'googleAnalytics', section: 'general', title: 'Google Analytics', bulk: true, hint: 'Идентификатор для интерфейса панели. Обычно не нужен.',
    fields: [{ name: 'measurementId', type: 'text', label: 'Measurement ID', placeholder: 'G-XXXXXXXXXX', max: 40 }],
    get: 'settings.getGoogleAnalyticsMeasurementId', read: (r) => ({ measurementId: r ?? '' }), set: 'settings.setGoogleAnalyticsMeasurementId', build: (v) => ({ measurementId: v.measurementId ?? '' }) },
  { key: 'githubToken', section: 'general', title: 'Токен GitHub', hint: 'Нужен панели для доступа к приватным репозиториям. Сохранённый токен не показывается; панель проверяет новый при сохранении.',
    fields: [{ name: 'token', type: 'secret', label: 'Новый токен', placeholder: 'ghp_…', hint: 'Пустое значение удалит сохранённый токен.', max: 255 }],
    get: 'settings.getGithubToken', read: (r) => ({ token: '', _info: { hasToken: !!r } }), set: 'settings.setGithubToken', build: (v) => ({ githubToken: v.token ?? '' }) },
  { key: 'brandingBasic', section: 'branding', title: 'Название и цвет сервера', hint: 'Отображается в интерфейсе панели.',
    fields: [{ name: 'serverName', type: 'text', label: 'Название сервера', max: 60 }, { name: 'serverColor', type: 'color', label: 'Цвет' }, B('hideIp', 'Скрыть IP-адрес сервера'), B('hideNotes', 'Скрыть заметки')],
    get: 'branding.getBasicSettings', read: (r) => ({ serverName: r?.serverName ?? '', serverColor: r?.serverColor ?? '', hideIp: !!r?.hideIp, hideNotes: !!r?.hideNotes }),
    set: 'branding.setBasicSettings', build: (v) => ({ serverName: v.serverName ?? '', serverColor: v.serverColor ?? '', hideIp: !!v.hideIp, hideNotes: !!v.hideNotes }) },
  { key: 'brandingLinks', section: 'branding', title: 'Ссылки в интерфейсе', bulk: true, hint: 'Какие ссылки Easypanel скрыть.',
    fields: [B('hideDocumentationLink', 'Документация'), B('hideChangelogLink', 'Список изменений'), B('hideDiscordLink', 'Discord'), B('hideFeedbackLink', 'Обратная связь'), B('hideOtherLinks', 'Прочие ссылки')],
    get: 'branding.getLinksSettings', read: (r) => ({ hideDocumentationLink: !!r?.hideDocumentationLink, hideChangelogLink: !!r?.hideChangelogLink, hideDiscordLink: !!r?.hideDiscordLink, hideFeedbackLink: !!r?.hideFeedbackLink, hideOtherLinks: !!r?.hideOtherLinks }),
    set: 'branding.setLinksSettings', build: (v) => ({ hideDocumentationLink: !!v.hideDocumentationLink, hideChangelogLink: !!v.hideChangelogLink, hideDiscordLink: !!v.hideDiscordLink, hideFeedbackLink: !!v.hideFeedbackLink, hideOtherLinks: !!v.hideOtherLinks }) },
  { key: 'errorPages', section: 'branding', title: 'Страницы ошибок', bulk: true, hint: 'Оформление страниц ошибок, которые видят посетители ваших сервисов.',
    fields: [B('hideLogo', 'Скрыть логотип'), B('hideLinks', 'Скрыть ссылки'), { name: 'customCss', type: 'textarea', label: 'Свой CSS', max: 20000, mono: true }],
    get: 'branding.getErrorPageSettings', read: (r) => ({ hideLogo: !!r?.hideLogo, hideLinks: !!r?.hideLinks, customCss: r?.customCss ?? '' }),
    set: 'branding.setErrorPageSettings', build: (v) => ({ hideLogo: !!v.hideLogo, hideLinks: !!v.hideLinks, customCss: v.customCss ?? '' }) },
  { key: 'customCode', section: 'branding', title: 'Свой код в интерфейсе', danger: true, bulk: true, hint: 'HTML/JS, который подставляется в интерфейс панели. Выполняется в браузере каждого, кто открывает панель.',
    fields: [{ name: 'customCode', type: 'textarea', label: 'Код', max: 50000, mono: true }],
    get: 'branding.getCustomCodeSettings', read: (r) => ({ customCode: r?.customCode ?? '' }), set: 'branding.setCustomCodeSettings', build: (v) => ({ customCode: v.customCode ?? '' }) },
  { key: 'metrics', section: 'monitoring', title: 'Расширенные метрики', hint: 'Prometheus собирает историю нагрузки сервисов. Включение запускает дополнительные контейнеры.', danger: true,
    fields: [B('enabled', 'Собирать метрики'), { name: 'retentionType', type: 'select', label: 'Хранить', options: [['days', 'дней'], ['gb', 'ГБ']] }, { name: 'retentionValue', type: 'int', label: 'Срок или объём', min: 1, max: 3650 }, { name: 'scrapeInterval', type: 'number', label: 'Интервал опроса, с', min: 1, max: 3600 }],
    get: 'metrics.getSettings', read: (r) => ({ enabled: !!r?.enabled, retentionType: r?.retentionType ?? 'days', retentionValue: r?.retentionValue ?? 7, scrapeInterval: r?.scrapeInterval ?? 15 }),
    set: 'metrics.updateSettings', build: (v) => ({ enabled: !!v.enabled, retentionType: v.retentionType, retentionValue: v.retentionValue, scrapeInterval: v.scrapeInterval }) },
  { key: 'logsAgg', section: 'monitoring', title: 'Сбор логов', hint: 'Loki хранит логи сервисов, в том числе после перезапуска. Включение запускает дополнительные контейнеры.', danger: true,
    fields: [B('enabled', 'Собирать логи'), { name: 'retentionType', type: 'select', label: 'Хранить', options: [['hours', 'часов'], ['days', 'дней']] }, { name: 'retentionValue', type: 'int', label: 'Срок', min: 1, max: 3650 }],
    get: 'logs.getSettings', read: (r) => ({ enabled: !!r?.enabled, retentionType: r?.retentionType ?? 'days', retentionValue: r?.retentionValue ?? 7 }),
    set: 'logs.updateSettings', build: (v) => ({ enabled: !!v.enabled, retentionType: v.retentionType, retentionValue: v.retentionValue }) },
];
export const settingByKey = (k) => SETTINGS.find((s) => s.key === k);

/** Проверка значения по описанию полей: лишние поля отбрасываются, типы приводятся, ошибки — 400 с понятным текстом. */
export function cleanValue(def, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Ожидается объект со значениями полей');
  const out = {};
  for (const f of def.fields) {
    let v = value[f.name];
    const bad = (msg) => { throw new HttpError(400, `${f.label}: ${msg}`); };
    if (f.type === 'bool') { out[f.name] = !!v; continue; }
    if (f.type === 'int' || f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || (f.type === 'int' && !Number.isInteger(n))) bad('нужно число');
      if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) bad(`от ${f.min ?? '−∞'} до ${f.max ?? '∞'}`);
      out[f.name] = n; continue;
    }
    v = v == null ? '' : String(v);
    if (f.type !== 'textarea') v = v.trim();
    if (f.required && !v) bad('обязательное поле');
    if (v.length > (f.max ?? 255)) bad(`не длиннее ${f.max ?? 255} символов`);
    if (f.type === 'domain' && v && !DOMAIN.test(v)) bad('некорректный домен');
    if (f.type === 'email' && v && !EMAIL.test(v)) bad('некорректный e-mail');
    if (f.type === 'color' && v && !COLOR.test(v)) bad('цвет в формате #RRGGBB');
    if (f.type === 'select' && !f.options.some(([o]) => o === v)) bad('недопустимое значение');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) bad('недопустимые символы');
    out[f.name] = v;
  }
  return out;
}

const secretFields = (def) => new Set(def.fields.filter((f) => f.type === 'secret').map((f) => f.name));
/** Краткое описание изменения для журнала: секреты маскируются, длинные тексты сокращаются. */
export function diffText(def, before, after) {
  const secret = secretFields(def); const parts = [];
  const show = (name, v) => (secret.has(name) ? (v ? '••••' : '—') : typeof v === 'string' && v.length > 40 ? `${v.slice(0, 37)}…` : v === '' || v == null ? '—' : String(v));
  for (const f of def.fields) if (JSON.stringify(before?.[f.name]) !== JSON.stringify(after[f.name])) parts.push(`${f.name}: ${show(f.name, before?.[f.name])} → ${show(f.name, after[f.name])}`);
  return parts.join('; ') || 'без изменений';
}

const SECRET_KEY = /pass|secret|token|key|credential|private|config/i;
const maskDeep = (v, d = 0) => {
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, d + 1));
  if (v && typeof v === 'object' && d < 5) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && typeof x === 'string' && x ? '••••••' : maskDeep(x, d + 1)]));
  return v;
};
const listOf = (v, ...keys) => (Array.isArray(v) ? v : keys.map((k) => v?.[k]).find(Array.isArray) ?? []);
const firstString = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? Object.values(v).map(firstString).find(Boolean) ?? null : null);
const PROVIDER_TYPES = ['s3', 'sftp', 'ftp', 'local', 'dropbox', 'google'];
const providerType = (p) => { const t = String(p?.type ?? p?.provider ?? '').toLowerCase(); if (PROVIDER_TYPES.includes(t)) return t; if (p?.bucket) return 's3'; if (p?.path && !p?.host) return 'local'; return null; };
const BUILDER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const id = (v) => { const s = String(v ?? ''); if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new HttpError(400, 'Некорректный идентификатор'); return s; };

export function psettingsRoutes(d) {
  const { db, key, manager, audit, need, asHttp, panelOr404, assertPanel, canPanel } = d;
  const now = () => Date.now();
  const access = (ctx) => { const row = panelOr404(ctx.params.id); assertPanel(ctx, row.id); return { row, c: manager.clientFor(row) }; };
  const call = async (fn) => { try { return await fn(); } catch (e) { throw asHttp(e); } };
  const write = async (ctx, row, action, target, fn, detail) => {
    try { const r = await fn(); audit(ctx, { action, panel: row, target, detail }); manager.invalidate(row.id); return r; }
    catch (e) { audit(ctx, { action, panel: row, target, ok: false, detail: e.message }); throw asHttp(e); }
  };
  const readSetting = async (c, def) => def.read(await c.query(def.get));

  /* ---- история конфигурации Traefik: перед каждой записью сохраняем прежний текст (зашифрованным) ---- */
  const keepVersion = (panelId, kind, user, text) => {
    db.prepare('INSERT INTO panel_config_history (panel_id, kind, ts, username, content_enc) VALUES (?,?,?,?,?)').run(panelId, kind, now(), user ?? null, encrypt(key, text ?? ''));
    db.prepare('DELETE FROM panel_config_history WHERE panel_id = ? AND kind = ? AND id NOT IN (SELECT id FROM panel_config_history WHERE panel_id = ? AND kind = ? ORDER BY id DESC LIMIT 20)').run(panelId, kind, panelId, kind);
  };
  const history = (panelId, kind) => db.prepare('SELECT id, ts, username, length(content_enc) size FROM panel_config_history WHERE panel_id = ? AND kind = ? ORDER BY id DESC').all(panelId, kind);
  const TRAEFIK = { config: { get: 'traefik.getCustomConfig', set: 'traefik.setCustomConfig', field: 'config', label: 'конфигурация' }, env: { get: 'traefik.getEnv', set: 'traefik.setEnv', field: 'env', label: 'переменные окружения' } };

  return [
    /* ---------- реестр и значения ---------- */
    ['GET', '/api/psettings/schema', () => ({ sections: SECTIONS, settings: SETTINGS.map(({ key: k, section, title, hint, danger, bulk, fields }) => ({ key: k, section, title, hint, danger: !!danger, bulk: !!bulk, fields })) }), { admin: true }],
    ['GET', '/api/panels/:id/psettings', async (ctx) => {
      const { c } = access(ctx);
      const only = ctx.url.searchParams.get('section');
      const defs = SETTINGS.filter((s) => !only || s.section === only);
      const values = {}; const errors = {};
      await Promise.all(defs.map(async (def) => { try { values[def.key] = await readSetting(c, def); } catch (e) { errors[def.key] = e.message; } }));
      return { values, errors };
    }, { admin: true }],
    ['PUT', '/api/panels/:id/psettings/:key', async (ctx) => {
      const { row, c } = access(ctx); const def = settingByKey(ctx.params.key);
      need(def, 'Неизвестная настройка');
      const value = cleanValue(def, ctx.body.value);
      const before = await call(() => readSetting(c, def));
      await write(ctx, row, `psettings.${def.key}`, row.name, () => c.mutate(def.set, def.build(value)), diffText(def, before, value));
      return { value: await call(() => readSetting(c, def)).catch(() => ({ ...value })) };
    }, { admin: true }],

    /* ---------- обзор ---------- */
    ['GET', '/api/panels/:id/pstatus', async (ctx) => {
      const { c } = access(ctx);
      const q = (p) => c.query(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, error: e.message }));
      const [update, panelUpdate, docker, dockerUpdate, ip, users, builders, nodes, certs] = await Promise.all(['update.getStatus', 'settings.checkForUpdates', 'settings.getDockerVersion', 'settings.checkDockerUpdate', 'settings.getServerIp', 'users.listUsers', 'dockerBuilders.listDockerBuilders', 'cluster.listNodes', 'certificates.listCertificates'].map(q));
      const pick = (r, f) => (r.ok ? f(r.v) : null);
      return {
        version: pick(update, (v) => v?.version ?? null), releaseTag: pick(update, (v) => v?.releaseTag ?? null),
        updateAvailable: pick(update, (v) => !!v?.available) ?? pick(panelUpdate, (v) => !!v),
        dockerVersion: pick(docker, (v) => (typeof v === 'string' ? v : null)),
        dockerUpdate: pick(dockerUpdate, (v) => (v && typeof v === 'object' ? { available: !!v.updateAvailable, latest: v.latestVersion ?? null } : null)),
        serverIp: pick(ip, (v) => (typeof v === 'string' ? v : null)),
        users: pick(users, (v) => listOf(v, 'users').length), builders: pick(builders, (v) => listOf(v).length), nodes: pick(nodes, (v) => listOf(v, 'nodes').length),
        certificates: pick(certs, (v) => listOf(v, 'certificates').length),
      };
    }, { admin: true }],

    /* ---------- Docker: билдеры ---------- */
    ['GET', '/api/panels/:id/pbuilders', async (ctx) => { const { c } = access(ctx); return { builders: listOf(await call(() => c.query('dockerBuilders.listDockerBuilders'))).map((b) => ({ name: b.Name ?? b.name, current: !!(b.Current ?? b.current), status: b.Nodes?.[0]?.Status ?? b.status ?? null })) }; }, { admin: true }],
    ['POST', '/api/panels/:id/pbuilders', async (ctx) => {
      const { row, c } = access(ctx); const b = ctx.body ?? {};
      need(BUILDER_NAME.test(String(b.name ?? '')), 'Имя билдера: латиница, цифры, - _ .');
      if (b.op === 'create') {
        const cpus = Number(b.cpus ?? 2); const memory = Number(b.memory ?? 2048); const memorySwap = Number(b.memorySwap ?? 4096);
        need(cpus > 0 && cpus <= 128 && memory >= 256 && memory <= 1_048_576 && memorySwap >= memory && memorySwap <= 1_048_576, 'Проверьте лимиты: CPU 1–128, память от 256 МБ, swap не меньше памяти');
        await write(ctx, row, 'builder.create', b.name, () => c.mutate('dockerBuilders.createDockerBuilder', { name: b.name, cpus, memory, memorySwap }));
      } else {
        const proc = { use: 'useDockerBuilder', stop: 'stopDockerBuilder', remove: 'removeDockerBuilder' }[b.op];
        need(proc, 'Неизвестное действие');
        await write(ctx, row, `builder.${b.op}`, b.name, () => c.mutate(`dockerBuilders.${proc}`, { name: b.name }));
      }
      return { ok: true };
    }, { admin: true }],

    /* ---------- пользователи Easypanel ---------- */
    ['GET', '/api/panels/:id/pusers', async (ctx) => {
      const { c } = access(ctx);
      const [users, me] = await Promise.all([call(() => c.query('users.listUsers')), c.query('auth.getUser').catch(() => null)]);
      const meId = me?.user?.id ?? me?.id ?? null;
      return { users: listOf(users, 'users').map((u) => ({ id: String(u.id), email: u.email ?? '', admin: !!u.admin, hasToken: !!u.apiToken, twoFactor: !!(u.twoFactorSecret || u.twoFactorEnabled), createdAt: u.createdAt ?? null, self: meId != null && String(u.id) === String(meId) })), selfKnown: meId != null };
    }, { admin: true }],
    ['POST', '/api/panels/:id/pusers', async (ctx) => {
      const { row, c } = access(ctx); const b = ctx.body ?? {};
      need(EMAIL.test(String(b.email ?? '')), 'Некорректный e-mail');
      need(typeof b.password === 'string' && b.password.length >= 8 && b.password.length <= 200, 'Пароль — не короче 8 символов');
      await write(ctx, row, 'panel.user.create', String(b.email), () => c.mutate('users.createUser', { email: b.email, password: b.password, admin: !!b.admin }), b.admin ? 'администратор' : 'пользователь');
      return { ok: true };
    }, { admin: true }],
    ['PUT', '/api/panels/:id/pusers/:uid', async (ctx) => {
      const { row, c } = access(ctx); const b = ctx.body ?? {}; const uid = id(ctx.params.uid);
      need(typeof b.admin === 'boolean', 'Укажите, администратор ли пользователь');
      if (b.password !== undefined && b.password !== '') need(typeof b.password === 'string' && b.password.length >= 8 && b.password.length <= 200, 'Пароль — не короче 8 символов');
      const input = { id: uid, admin: b.admin, ...(b.password ? { password: b.password } : {}) };
      await write(ctx, row, 'panel.user.update', b.email ? String(b.email) : uid, () => c.mutate('users.updateUser', input), `admin=${b.admin}${b.password ? '; пароль изменён' : ''}`);
      return { ok: true };
    }, { admin: true }],
    ['DELETE', '/api/panels/:id/pusers/:uid', async (ctx) => {
      const { row, c } = access(ctx); const uid = id(ctx.params.uid);
      const me = await c.query('auth.getUser').catch(() => null);
      need(String(me?.user?.id ?? me?.id ?? '') !== uid, 'Нельзя удалить пользователя, от имени которого EasyAdmin работает с панелью');
      await write(ctx, row, 'panel.user.destroy', ctx.url.searchParams.get('email') || uid, () => c.mutate('users.destroyUser', { id: uid }));
      return { ok: true };
    }, { admin: true }],
    ['POST', '/api/panels/:id/pusers/:uid/token', async (ctx) => {
      const { row, c } = access(ctx); const uid = id(ctx.params.uid);
      const me = await c.query('auth.getUser').catch(() => null);
      const meId = String(me?.user?.id ?? me?.id ?? '');
      need(meId && meId !== uid, 'Токен пользователя, от имени которого работает EasyAdmin, не меняется — доступ к панели пропадёт');
      const r = await write(ctx, row, 'panel.user.token.generate', ctx.url.searchParams.get('email') || uid, () => c.mutate('users.generateApiToken', { id: uid }));
      return { token: firstString(r) }; // показывается один раз и нигде не сохраняется
    }, { admin: true }],
    ['DELETE', '/api/panels/:id/pusers/:uid/token', async (ctx) => {
      const { row, c } = access(ctx); const uid = id(ctx.params.uid);
      const me = await c.query('auth.getUser').catch(() => null);
      need(String(me?.user?.id ?? me?.id ?? '') !== uid, 'Токен пользователя, от имени которого работает EasyAdmin, не отзывается — доступ к панели пропадёт');
      await write(ctx, row, 'panel.user.token.revoke', ctx.url.searchParams.get('email') || uid, () => c.mutate('users.revokeApiToken', { id: uid }));
      return { ok: true };
    }, { admin: true }],
    ['POST', '/api/panels/:id/paccount/credentials', async (ctx) => {
      const { row, c } = access(ctx); const b = ctx.body ?? {};
      need(EMAIL.test(String(b.email ?? '')), 'Некорректный e-mail');
      need(typeof b.oldPassword === 'string' && b.oldPassword.length >= 8, 'Введите текущий пароль');
      need(typeof b.newPassword === 'string' && b.newPassword.length >= 8 && b.newPassword.length <= 200, 'Новый пароль — не короче 8 символов');
      await write(ctx, row, 'panel.account.credentials', String(b.email), () => c.mutate('settings.changeCredentials', { email: b.email, oldPassword: b.oldPassword, newPassword: b.newPassword }), 'e-mail и пароль');
      return { ok: true };
    }, { admin: true }],
    ['POST', '/api/panels/:id/paccount/2fa', async (ctx) => {
      const { row, c } = access(ctx); const b = ctx.body ?? {};
      if (b.op === 'configure') { const r = await write(ctx, row, 'panel.2fa.configure', row.name, () => c.mutate('twoFactor.configure')); return { secret: r?.secret ?? firstString(r?.secret) ?? null, qr: typeof r?.qr === 'string' ? r.qr : typeof r?.qrCode === 'string' ? r.qrCode : null }; }
      if (b.op === 'enable') { need(/^\d{6}$/.test(String(b.code ?? '')), 'Код — 6 цифр'); await write(ctx, row, 'panel.2fa.enable', row.name, () => c.mutate('twoFactor.enable', { code: String(b.code) })); return { ok: true }; }
      if (b.op === 'disable') { await write(ctx, row, 'panel.2fa.disable', row.name, () => c.mutate('twoFactor.disable')); return { ok: true }; }
      throw new HttpError(400, 'Неизвестное действие');
    }, { admin: true }],

    /* ---------- Traefik ---------- */
    ['GET', '/api/panels/:id/ptraefik', async (ctx) => {
      const { row, c } = access(ctx);
      const withEnv = ctx.url.searchParams.get('env') === '1';
      const config = await call(() => c.query('traefik.getCustomConfig'));
      const env = withEnv ? await call(() => c.query('traefik.getEnv')) : undefined; // env-файл может содержать токены — читается только по запросу
      return { config: typeof config === 'string' ? config : firstString(config) ?? '', ...(withEnv ? { env: typeof env === 'string' ? env : firstString(env) ?? '' } : {}), history: { config: history(row.id, 'config'), env: history(row.id, 'env') } };
    }, { admin: true }],
    ['PUT', '/api/panels/:id/ptraefik/:kind', async (ctx) => {
      const { row, c } = access(ctx); const t = TRAEFIK[ctx.params.kind]; need(t, 'Неизвестный раздел');
      const text = ctx.body?.content;
      need(typeof text === 'string' && text.length <= 200_000 && !/\u0000/.test(text), 'Содержимое — текст до 200 КБ');
      const old = await call(() => c.query(t.get)); const oldText = typeof old === 'string' ? old : firstString(old) ?? '';
      keepVersion(row.id, ctx.params.kind, ctx.user?.username, oldText);
      await write(ctx, row, `traefik.${ctx.params.kind}.set`, row.name, () => c.mutate(t.set, { [t.field]: text }), `${t.label}: ${oldText.length} → ${text.length} символов (прежняя версия сохранена)`);
      return { ok: true, history: history(row.id, ctx.params.kind) };
    }, { admin: true }],
    ['GET', '/api/panels/:id/ptraefik/:kind/history/:hid', (ctx) => {
      const { row } = access(ctx); need(TRAEFIK[ctx.params.kind], 'Неизвестный раздел');
      const r = db.prepare('SELECT * FROM panel_config_history WHERE id = ? AND panel_id = ? AND kind = ?').get(Number(ctx.params.hid), row.id, ctx.params.kind);
      if (!r) throw new HttpError(404, 'Версия не найдена');
      return { id: r.id, ts: r.ts, content: decrypt(key, r.content_enc) };
    }, { admin: true }],

    /* ---------- кластер, хранилища бэкапов, каналы уведомлений панели ---------- */
    ['GET', '/api/panels/:id/pcluster', async (ctx) => {
      const { c } = access(ctx);
      const [nodes, cmd] = await Promise.all([c.query('cluster.listNodes').catch((e) => ({ error: e.message })), c.query('cluster.addWorkerCommand').catch(() => null)]);
      return { nodes: nodes?.error ? [] : listOf(nodes, 'nodes').map((n) => ({ id: String(n.ID ?? n.id ?? ''), host: n.Description?.Hostname ?? n.hostname ?? n.name ?? '', role: n.Spec?.Role ?? n.role ?? null, state: n.Status?.State ?? n.status ?? null, manager: !!(n.ManagerStatus ?? n.manager) })), error: nodes?.error ?? null, workerCommand: typeof cmd === 'string' ? cmd : firstString(cmd) };
    }, { admin: true }],
    ['DELETE', '/api/panels/:id/pcluster/:nid', async (ctx) => { const { row, c } = access(ctx); const nid = id(ctx.params.nid); await write(ctx, row, 'cluster.node.remove', nid, () => c.mutate('cluster.removeNode', { id: nid })); return { ok: true }; }, { admin: true }],
    ['GET', '/api/panels/:id/pstorage', async (ctx) => {
      const { c } = access(ctx);
      const list = listOf(await call(() => c.query('storageProviders.common.list')));
      return { providers: list.map((p) => ({ id: String(p.id ?? ''), name: p.name ?? '', type: providerType(p), details: maskDeep(Object.fromEntries(Object.entries(p).filter(([k, v]) => !['id', 'name', 'type'].includes(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')))) })) };
    }, { admin: true }],
    ['DELETE', '/api/panels/:id/pstorage/:type/:pid', async (ctx) => {
      const { row, c } = access(ctx); const type = ctx.params.type; need(PROVIDER_TYPES.includes(type), 'Неизвестный тип хранилища'); const pid = id(ctx.params.pid);
      await write(ctx, row, 'storage.provider.delete', `${type}/${pid}`, () => c.mutate(`storageProviders.${type}.deleteProvider`, { id: pid }));
      return { ok: true };
    }, { admin: true }],
    ['GET', '/api/panels/:id/pnotify', async (ctx) => {
      const { c } = access(ctx);
      return { channels: listOf(await call(() => c.query('notifications.listNotificationChannels')), 'channels').map((x) => ({ id: String(x.id ?? ''), name: x.name ?? '', type: x.target?.type ?? null, events: Array.isArray(x.events) ? x.events : [] })) };
    }, { admin: true }],
    ['DELETE', '/api/panels/:id/pnotify/:cid', async (ctx) => { const { row, c } = access(ctx); const cid = id(ctx.params.cid); await write(ctx, row, 'panel.notify.destroy', ctx.url.searchParams.get('name') || cid, () => c.mutate('notifications.destroyNotificationChannel', { id: cid })); return { ok: true }; }, { admin: true }],

    /* ---------- журнал действий панели ---------- */
    ['GET', '/api/panels/:id/pactions', async (ctx) => {
      const { c } = access(ctx);
      const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit')) || 20, 1), 100);
      return { actions: listOf(await call(() => c.query('actions.listActions', { limit })), 'actions') };
    }, { admin: true }],
    ['GET', '/api/panels/:id/pactions/:aid', async (ctx) => { const { c } = access(ctx); return await call(() => c.query('actions.getAction', { id: id(ctx.params.aid) })); }, { admin: true }],
    ['POST', '/api/panels/:id/pactions/:aid/kill', async (ctx) => { const { row, c } = access(ctx); const aid = id(ctx.params.aid); await write(ctx, row, 'panel.action.kill', aid, () => c.mutate('actions.killAction', { id: aid })); return { ok: true }; }, { admin: true }],

    /* ---------- сравнение панелей и массовое применение ---------- */
    ['GET', '/api/psettings/compare', async (ctx) => {
      const rows = db.prepare('SELECT * FROM panels ORDER BY position, id').all().filter((p) => canPanel(ctx.user, p.id));
      const keys = SETTINGS.filter((s) => s.bulk || ['panelDomain', 'serviceDomain'].includes(s.key)).map((s) => s.key);
      const panels = await Promise.all(rows.map(async (row) => {
        const c = manager.clientFor(row); const values = {}; const errors = {};
        await Promise.all(keys.map(async (k) => { try { values[k] = await readSetting(c, settingByKey(k)); } catch (e) { errors[k] = e.message; } }));
        const ver = await c.query('update.getStatus').then((v) => v?.version ?? null, () => null);
        return { id: row.id, name: row.name, status: row.status, version: ver, values, errors };
      }));
      return { keys, panels };
    }, { admin: true }],
    ['POST', '/api/psettings/apply', async (ctx) => {
      const b = ctx.body ?? {}; const def = settingByKey(b.key);
      need(def?.bulk, 'Эту настройку нельзя применить сразу к нескольким панелям');
      const value = cleanValue(def, b.value);
      need(Array.isArray(b.panelIds) && b.panelIds.length > 0 && b.panelIds.length <= 50, 'Выберите панели (до 50)');
      const results = [];
      for (const pid of [...new Set(b.panelIds.map(Number))]) {
        const row = manager.getRow(pid);
        if (!row) { results.push({ panelId: pid, name: '—', ok: false, error: 'Панель не найдена' }); continue; }
        if (!canPanel(ctx.user, row.id)) { results.push({ panelId: pid, name: row.name, ok: false, error: 'Нет доступа к этой панели' }); continue; }
        try {
          const c = manager.clientFor(row);
          const before = await readSetting(c, def).catch(() => null);
          await write(ctx, row, `psettings.${def.key}`, row.name, () => c.mutate(def.set, def.build(value)), `массовое применение · ${diffText(def, before, value)}`);
          results.push({ panelId: pid, name: row.name, ok: true });
        } catch (e) { results.push({ panelId: pid, name: row.name, ok: false, error: e.message }); }
      }
      return { results, ok: results.every((r) => r.ok) };
    }, { admin: true }],
  ];
}
