import path from 'node:path';

const int = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3100),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.EASYADMIN_DATA || './data'),
    secret: env.EASYADMIN_SECRET || '',
    // true, если сервис стоит за HTTPS-прокси → cookie получит флаг Secure
    secureCookies: env.EASYADMIN_SECURE_COOKIES === 'true',
    sessionDays: int(env.EASYADMIN_SESSION_DAYS, 30),
    cacheTtlMs: int(env.EASYADMIN_CACHE_TTL_MS, 10_000),
    pollIntervalMs: int(env.EASYADMIN_POLL_MS, 60_000),
    requestTimeoutMs: int(env.EASYADMIN_TIMEOUT_MS, 15_000),
  };
}
