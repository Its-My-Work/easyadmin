import { HttpError } from './http.js';

/**
 * Лицензия Easypanel и то, что она открывает. Правила повторяют проверки самой панели (2.36.0):
 *  - Portal-лицензия: флаги plan.options (advanced_monitoring, notifications, database_backups, branding, mutiple_users, cluster);
 *  - Lemon Squeezy: valid=true открывает мониторинг, уведомления, бэкапы баз и свой домен сервисов; брендинг и кластер — продукт 108143,
 *    несколько пользователей — продукты 108139 и 108143.
 * Без лицензии панель либо возвращает ошибку, либо молча ничего не делает — поэтому EasyAdmin проверяет заранее и не пишет «сохранено» зря.
 */
export const FEATURES = {
  advancedMonitoring: 'Расширенные метрики и сбор логов',
  notifications: 'Каналы уведомлений панели',
  databaseBackups: 'Бэкапы баз данных по расписанию',
  branding: 'Брендинг интерфейса',
  multipleUsers: 'Несколько пользователей Easypanel',
  cluster: 'Кластер Docker Swarm',
  customServiceDomain: 'Свой базовый домен сервисов',
};
const PRODUCT_FULL = 108143;

/** lemon/portal — ответы панели (или null). known=false — панель не отдаёт лицензию (старая версия): ничего не блокируем. */
export function entitlements(lemon, portal, known = true) {
  const opts = portal?.plan?.options ?? {};
  const valid = lemon?.valid === true; const product = lemon?.meta?.product_id ?? null;
  const features = {
    advancedMonitoring: opts.advanced_monitoring === true || valid,
    notifications: opts.notifications === true || valid,
    databaseBackups: opts.database_backups === true || valid,
    branding: opts.branding === true || product === PRODUCT_FULL,
    multipleUsers: opts.mutiple_users === true || [108139, PRODUCT_FULL].includes(product),
    cluster: opts.cluster === true || product === PRODUCT_FULL,
    customServiceDomain: portal != null || valid,
  };
  const tier = portal != null ? 'portal' : valid ? 'lemon' : 'free';
  return {
    known, tier, features: known ? features : Object.fromEntries(Object.keys(features).map((k) => [k, true])),
    lemon: lemon ? { valid, productId: product } : null,
    portal: portal ? { plan: portal.plan?.name ?? portal.plan?.id ?? null, options: Object.keys(opts).filter((k) => opts[k] === true) } : null,
  };
}

const TTL = 60_000;
const kits = new WeakMap();
export function makeLicense(d) {
  if (kits.has(d.manager)) return kits.get(d.manager);
  const cache = new Map(); // panelId → { at, value }
  async function load(row, c) {
    const hit = cache.get(row.id);
    if (hit && Date.now() - hit.at < TTL) return hit.value;
    const [lemon, portal] = await Promise.allSettled([c.query('lemonLicense.getLicensePayload'), c.query('portalLicense.getLicensePayload')]);
    const bothFailed = lemon.status === 'rejected' && portal.status === 'rejected';
    const value = entitlements(lemon.status === 'fulfilled' ? lemon.value ?? null : null, portal.status === 'fulfilled' ? portal.value ?? null : null, !bothFailed);
    cache.set(row.id, { at: Date.now(), value });
    return value;
  }
  const kit = {
    entitlementsOf: load,
    forget: (row) => cache.delete(row.id),
    /** Бросает 403, если функции нет в лицензии панели. */
    async require(row, c, feature, detail) {
      const e = await load(row, c);
      if (!e.features[feature]) throw new HttpError(403, `${detail ?? FEATURES[feature]}: нужна лицензия Easypanel`, { license: true, feature });
      return e;
    },
    async has(row, c, feature) { return (await load(row, c)).features[feature]; },
  };
  kits.set(d.manager, kit);
  return kit;
}

const KEY = /^[A-Za-z0-9-]{16,100}$/;
export function licenseRoutes(d) {
  const { manager, audit, asHttp, panelOr404, assertPanel } = d;
  const lic = makeLicense(d);
  const access = (ctx) => { const row = panelOr404(ctx.params.id); assertPanel(ctx, row.id); return { row, c: manager.clientFor(row) }; };
  const write = async (ctx, row, action, fn, detail) => {
    try { const r = await fn(); audit(ctx, { action, panel: row, target: row.name, detail }); return r; }
    catch (e) { audit(ctx, { action, panel: row, target: row.name, ok: false, detail: e.message }); throw asHttp(e); }
    finally { lic.forget(row); }
  };
  const status = async (row, c) => { lic.forget(row); const e = await lic.entitlementsOf(row, c); return { ...e, featureLabels: FEATURES }; };
  return [
    ['GET', '/api/panels/:id/plicense', async (ctx) => { const { row, c } = access(ctx); return { ...(await lic.entitlementsOf(row, c)), featureLabels: FEATURES }; }, { admin: true }],
    // activate у панели молча игнорирует неверный ключ — поэтому результат проверяется перечитыванием лицензии
    ['POST', '/api/panels/:id/plicense/lemon', async (ctx) => {
      const { row, c } = access(ctx); const key = String(ctx.body?.licenseKey ?? '').trim();
      if (!KEY.test(key)) throw new HttpError(400, 'Ключ лицензии: 16–100 символов, буквы, цифры и дефисы');
      await write(ctx, row, 'license.lemon.activate', () => c.mutate('lemonLicense.activate', { licenseKey: key }), 'ключ не записывается');
      const s = await status(row, c); if (s.known && s.lemon?.valid !== true) throw new HttpError(400, 'Панель не приняла ключ: проверьте его и число активаций');
      return s;
    }, { admin: true }],
    ['POST', '/api/panels/:id/plicense/order', async (ctx) => {
      const { row, c } = access(ctx); const identifier = String(ctx.body?.identifier ?? '').trim(); const orderId = String(ctx.body?.orderId ?? '').trim();
      if (!identifier || identifier.length > 200 || !/^[A-Za-z0-9._@+-]+$/.test(orderId) || orderId.length > 100) throw new HttpError(400, 'Укажите e-mail или идентификатор заказа и номер заказа');
      await write(ctx, row, 'license.lemon.order', () => c.mutate('lemonLicense.activateByOrder', { identifier, orderId }), 'по номеру заказа');
      const s = await status(row, c); if (s.known && s.lemon?.valid !== true) throw new HttpError(400, 'Панель не нашла заказ или лицензия не активна');
      return s;
    }, { admin: true }],
    ['POST', '/api/panels/:id/plicense/portal', async (ctx) => {
      const { row, c } = access(ctx);
      await write(ctx, row, 'license.portal.activate', () => c.mutate('portalLicense.activate'));
      return await status(row, c);
    }, { admin: true }],
    ['DELETE', '/api/panels/:id/plicense/:kind', async (ctx) => {
      const { row, c } = access(ctx); const kind = ctx.params.kind;
      if (!['lemon', 'portal'].includes(kind)) throw new HttpError(400, 'Неизвестный вид лицензии');
      await write(ctx, row, `license.${kind}.deactivate`, () => c.mutate(`${kind}License.deactivate`));
      return await status(row, c);
    }, { admin: true }],
  ];
}
