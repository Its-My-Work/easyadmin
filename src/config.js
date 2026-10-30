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
    lang: env.EASYADMIN_LANG === 'en' ? 'en' : 'ru',
    publicUrl: env.EASYADMIN_PUBLIC_URL || '',
    consolePaths: (env.EASYPANEL_CONSOLE_PATHS || '/ws/containerShell,/ws/serviceConsole,/api/ws/serviceConsole,/ws/console,/ws/serviceTerminal,/ws/terminal,/ws/serviceExec,/ws/exec').split(',').map((x) => x.trim()).filter(Boolean),
    serverConsolePaths: (env.EASYPANEL_SERVER_CONSOLE_PATHS || '/ws/hostShell,/ws/serverConsole,/api/ws/serverConsole,/ws/serverTerminal,/ws/terminal,/ws/console,/ws/shell,/ws/exec').split(',').map((x) => x.trim()).filter(Boolean),
    consoleEnabled: !['off', 'false', '0'].includes(String(env.EASYADMIN_CONSOLE ?? '').toLowerCase()),
    logsPaths: (env.EASYPANEL_LOGS_PATHS || '/ws/serviceLogs,/api/ws/serviceLogs,/ws/logs').split(',').map((x) => x.trim()).filter(Boolean),
    oidc: {
      issuer: env.OIDC_ISSUER || '', clientId: env.OIDC_CLIENT_ID || '', clientSecret: env.OIDC_CLIENT_SECRET || '',
      name: env.OIDC_NAME || 'SSO',
      defaultRole: ['admin', 'operator', 'viewer'].includes(env.OIDC_DEFAULT_ROLE) ? env.OIDC_DEFAULT_ROLE : 'viewer',
      adminEmails: (env.OIDC_ADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean),
      allowedDomains: (env.OIDC_ALLOWED_DOMAINS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean),
    },
    // каталог шаблонов Easypanel; можно указать своё зеркало (папка templates с list.json и <slug>/meta.yaml, index.ts)
    catalogEnabled: !['off', 'false', '0'].includes(String(env.EASYADMIN_CATALOG ?? '').toLowerCase()),
    catalogUrl: env.EASYADMIN_CATALOG_URL || 'https://raw.githubusercontent.com/easypanel-io/templates/main/templates',
    // Срок сертификата определяем по TLS-рукопожатию с самим доменом (панель его не отдаёт)
    tlsProbe: env.EASYADMIN_TLS_PROBE !== 'false',
    tlsProbePort: int(env.EASYADMIN_TLS_PROBE_PORT, 443),
    // паузы перед проверками нового сертификата после перевыпуска, мс
    reissueDelaysMs: [2500, 4000, 4000],
    diskAlertPct: int(env.EASYADMIN_DISK_ALERT_PCT, 90),
    // предел размера слепка переезда (ГБ) и срок жизни одноразовой ссылки (часов)
    migrationMaxBytes: int(env.EASYADMIN_MIGRATION_MAX_GB, 100) * 1024 ** 3,
    migrationTtlMs: int(env.EASYADMIN_MIGRATION_TTL_HOURS, 24) * 3600_000,
    // глобальный выключатель AI Doctor (данные логов уходят внешнему провайдеру)
    // кнопки действий под алертами (Telegram) и ссылки-действия; EASYADMIN_INTERACTIVE=off отключает
    interactive: !['off', 'false', '0'].includes(String(env.EASYADMIN_INTERACTIVE ?? '').toLowerCase()),
    aiEnabled: !['off', 'false', '0'].includes(String(env.EASYADMIN_AI ?? '').toLowerCase()),
    metricsToken: env.EASYADMIN_METRICS_TOKEN || '',
    requestTimeoutMs: int(env.EASYADMIN_TIMEOUT_MS, 15_000),
  };
}
