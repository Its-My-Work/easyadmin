/** Имитация процедур настроек Easypanel (реальные пути tRPC и формы ответов) с состоянием в памяти. */
const bad = (message) => Object.assign(new Error(message), { code: 'BAD_REQUEST' });

import { entitlements } from '../src/panel-license.js';

const LICENSES = {
  full: { lemon: null, portal: { plan: { name: 'Pro', options: { advanced_monitoring: true, notifications: true, database_backups: true, branding: true, mutiple_users: true, cluster: true } } } },
  free: { lemon: null, portal: null },
  lemon: { lemon: { valid: true, meta: { product_id: 108137 } }, portal: null },
  lemonFull: { lemon: { valid: true, meta: { product_id: 108143 } }, portal: null },
};

export function makePanelSettings({ reject = [], selfUserId = 'u1', version = '2.36.0', license = 'full', portalAvailable = false, hideLicense = false, fresh = false, backups = null } = {}) {
  const st = {
    panelDomain: { customPanelDomain: null, defaultPanelDomain: 'mock.easypanel.host', serveOnIp: true },
    serviceDomain: { customServiceDomain: null, defaultServiceDomain: 'mock.easypanel.host' },
    le: 'ops@example.com', telemetry: false, cleanup: true, ga: null, github: '',
    basic: { name: 'Easypanel', hideIp: null, hideNotes: null, serverColor: null, serverName: null },
    links: { hideChangelogLink: null, hideDiscordLink: null, hideDocumentationLink: null, hideFeedbackLink: null, hideOtherLinks: null },
    errorPage: { customCss: null, hideLinks: null, hideLogo: null }, customCode: { customCode: null },
    metrics: null, logs: null, config: '', env: 'CF_TOKEN=secret-value\n',
    builders: [{ Current: true, Name: 'default', Nodes: [{ Status: 'running' }] }],
    users: fresh ? [] : [{ id: 'u1', email: 'owner@example.com', admin: true, apiToken: 'owner-token', createdAt: 1 }, { id: 'u2', email: 'dev@example.com', admin: false, apiToken: null, createdAt: 2, twoFactorSecret: 'x' }],
    nodes: [{ ID: 'n1', Description: { Hostname: 'main' }, Spec: { Role: 'manager' }, Status: { State: 'ready' }, ManagerStatus: { Leader: true } }, { ID: 'n2', Description: { Hostname: 'w1' }, Spec: { Role: 'worker' }, Status: { State: 'ready' } }],
    providers: [{ id: 'p1', name: 'Backups', type: 's3', bucket: 'b1', region: 'eu', accessKeyId: 'AKIA', secretAccessKey: 'shh' }],
    channels: [{ id: 'c1', name: 'Ops', events: ['deploy'], target: { type: 'slack', url: 'https://hooks.example/x' } }],
    logos: { darkLogo: null, darkLogoMark: null, lightLogo: null, lightLogoMark: null },
    dbBackups: backups?.db ?? [{ id: 'b1', projectName: 'web', serviceName: 'pg', databaseName: 'app', enabled: true, schedule: '0 2 * * *', retention: 7, storageProviderId: 'p1', storageProviderPath: 'pg' }],
    volBackups: backups?.vol ?? [{ id: 'v1', projectName: 'web', serviceName: 'site', volumeName: 'data', enabled: true, schedule: '0 3 * * *', storageProviderId: 'p1', storageProviderPath: 'site', storageProviderName: 'Backups' }],
    actions: backups?.actions ?? [{ id: 'a1', type: 'backup', status: 'done', projectName: 'web', serviceName: 'pg', description: 'Backup app', meta: { path: 'pg/2026-09-30.sql.gz', databaseName: 'app', storageProviderId: 'p1' } }, { id: 'a2', type: 'deploy', status: 'done', projectName: 'web', serviceName: 'pg' }],
    setupComplete: !fresh, setupInput: null, notified: [], twoFactor: false, changed: [], license: structuredClone(typeof license === 'string' ? LICENSES[license] : license), portalAvailable,
  };
  const ent = () => entitlements(st.license.lemon, st.license.portal).features;
  const guard = (name, fn) => (i) => { if (reject.includes(name)) throw bad(`rejected ${name}`); st.changed.push(name); return fn(i ?? {}); };
  const procs = {
    'settings.getPanelDomain': () => st.panelDomain,
    'settings.setPanelDomain': guard('settings.setPanelDomain', (i) => { if (typeof i.serveOnIp !== 'boolean') throw bad('serveOnIp'); st.panelDomain = { ...st.panelDomain, customPanelDomain: i.customPanelDomain || null, serveOnIp: i.serveOnIp }; return null; }),
    'settings.getServiceDomain': () => st.serviceDomain,
    'settings.setServiceDomain': guard('settings.setServiceDomain', (i) => { st.serviceDomain = { ...st.serviceDomain, customServiceDomain: i.customServiceDomain || null }; return null; }),
    'settings.getLetsEncryptEmail': () => st.le,
    'settings.setLetsEncryptEmail': guard('settings.setLetsEncryptEmail', (i) => { if (!/@/.test(i.letsEncryptEmail ?? '')) throw bad('email'); st.le = i.letsEncryptEmail; return null; }),
    'settings.getTelemetryDisabled': () => st.telemetry,
    'settings.setTelemetryDisabled': guard('settings.setTelemetryDisabled', (i) => { if (typeof i.disabled !== 'boolean') throw bad('disabled'); st.telemetry = i.disabled; return null; }),
    'settings.getDailyDockerCleanup': () => st.cleanup,
    'settings.setDailyDockerCleanup': guard('settings.setDailyDockerCleanup', (i) => { if (typeof i.dailyDockerCleanup !== 'boolean') throw bad('dailyDockerCleanup'); st.cleanup = i.dailyDockerCleanup; return null; }),
    'settings.getGoogleAnalyticsMeasurementId': () => st.ga,
    'settings.setGoogleAnalyticsMeasurementId': guard('settings.setGoogleAnalyticsMeasurementId', (i) => { st.ga = i.measurementId || null; return null; }),
    'settings.getGithubToken': () => st.github,
    'settings.setGithubToken': guard('settings.setGithubToken', (i) => { st.github = i.githubToken ?? ''; return null; }),
    'settings.getServerIp': () => '203.0.113.7',
    'settings.refreshServerIp': guard('settings.refreshServerIp', () => null),
    'settings.checkForUpdates': () => false,
    'settings.checkDockerUpdate': () => ({ latestVersion: '29.8.2', showDockerUpdateBanner: false, updateAvailable: true, version: '29.7.0' }),
    'settings.getDockerVersion': () => '29.7.0',
    'settings.cleanupDockerBuilder': guard('settings.cleanupDockerBuilder', () => null),
    'settings.changeCredentials': guard('settings.changeCredentials', (i) => { if (i.oldPassword === 'wrongpass') throw bad('Wrong password'); return null; }),
    'update.getStatus': () => ({ available: false, releaseTag: 'latest', version }),
    'update.update': guard('update.update', () => null),
    'branding.getBasicSettings': () => st.basic, 'branding.setBasicSettings': guard('branding.setBasicSettings', (i) => { st.basic = { ...i }; return null; }),
    'branding.getLinksSettings': () => st.links, 'branding.setLinksSettings': guard('branding.setLinksSettings', (i) => { st.links = { ...i }; return null; }),
    'branding.getErrorPageSettings': () => st.errorPage, 'branding.setErrorPageSettings': guard('branding.setErrorPageSettings', (i) => { st.errorPage = { ...i }; return null; }),
    'branding.getCustomCodeSettings': () => st.customCode, 'branding.setCustomCodeSettings': guard('branding.setCustomCodeSettings', (i) => { st.customCode = { ...i }; return null; }),
    'metrics.getSettings': () => st.metrics, 'metrics.updateSettings': guard('metrics.updateSettings', (i) => { if (!['days', 'gb'].includes(i.retentionType)) throw bad('retentionType'); st.metrics = { ...i }; return null; }),
    'logs.getSettings': () => st.logs, 'logs.updateSettings': guard('logs.updateSettings', (i) => { if (!['hours', 'days'].includes(i.retentionType)) throw bad('retentionType'); st.logs = { ...i }; return null; }),
    'dockerBuilders.listDockerBuilders': () => st.builders,
    'dockerBuilders.createDockerBuilder': guard('dockerBuilders.createDockerBuilder', (i) => { st.builders.push({ Current: false, Name: i.name, Nodes: [{ Status: 'running' }] }); return null; }),
    'dockerBuilders.useDockerBuilder': guard('dockerBuilders.useDockerBuilder', (i) => { st.builders.forEach((b) => { b.Current = b.Name === i.name; }); return null; }),
    'dockerBuilders.stopDockerBuilder': guard('dockerBuilders.stopDockerBuilder', () => null),
    'dockerBuilders.removeDockerBuilder': guard('dockerBuilders.removeDockerBuilder', (i) => { st.builders = st.builders.filter((b) => b.Name !== i.name); return null; }),
    'auth.getUser': () => ({ user: { id: selfUserId, email: 'owner@example.com' } }),
    'users.listUsers': () => ({ users: st.users }),
    'users.createUser': guard('users.createUser', (i) => { st.users.push({ id: `u${st.users.length + 1}`, email: i.email, admin: i.admin, apiToken: null, createdAt: 3 }); return null; }),
    'users.updateUser': guard('users.updateUser', (i) => { const u = st.users.find((x) => x.id === i.id); if (!u) throw bad('no user'); u.admin = i.admin; if (i.password) u.passwordChanged = true; return null; }),
    'users.destroyUser': guard('users.destroyUser', (i) => { st.users = st.users.filter((u) => u.id !== i.id); return null; }),
    'users.generateApiToken': guard('users.generateApiToken', (i) => { const t = `tok-${i.id}-new`; st.users.find((u) => u.id === i.id).apiToken = t; return t; }),
    'users.revokeApiToken': guard('users.revokeApiToken', (i) => { st.users.find((u) => u.id === i.id).apiToken = null; return null; }),
    'twoFactor.configure': guard('twoFactor.configure', () => ({ secret: 'JBSWY3DPEHPK3PXP', qr: 'data:image/png;base64,AAAA' })),
    'twoFactor.enable': guard('twoFactor.enable', (i) => { if (i.code !== '123456') throw bad('bad code'); st.twoFactor = true; return null; }),
    'twoFactor.disable': guard('twoFactor.disable', () => { st.twoFactor = false; return null; }),
    'traefik.getCustomConfig': () => st.config, 'traefik.setCustomConfig': guard('traefik.setCustomConfig', (i) => { st.config = i.config; return null; }),
    'traefik.getEnv': () => st.env, 'traefik.setEnv': guard('traefik.setEnv', (i) => { st.env = i.env; return null; }),
    'traefik.restart': guard('traefik.restart', () => null),
    'cluster.listNodes': () => st.nodes, 'cluster.addWorkerCommand': () => 'docker swarm join --token SWMTKN-x 203.0.113.7:2377',
    'cluster.removeNode': guard('cluster.removeNode', (i) => { st.nodes = st.nodes.filter((n) => n.ID !== i.id); return null; }),
    'storageProviders.common.list': () => st.providers,
    'storageProviders.s3.deleteProvider': guard('storageProviders.s3.deleteProvider', (i) => { st.providers = st.providers.filter((p) => p.id !== i.id); return null; }),
    'notifications.listNotificationChannels': () => st.channels,
    'notifications.destroyNotificationChannel': guard('notifications.destroyNotificationChannel', (i) => { st.channels = st.channels.filter((c) => c.id !== i.id); return null; }),
    'actions.listActions': (i) => (i.projectName ? st.actions.filter((a) => a.projectName === i.projectName && a.serviceName === i.serviceName) : []),
    'storageProviders.common.listOptions': () => st.providers.map((p) => ({ label: p.name, value: p.id })),
    ...Object.fromEntries(['s3', 'sftp', 'ftp', 'local'].flatMap((t) => [
      [`storageProviders.${t}.createProvider`, guard(`storageProviders.${t}.createProvider`, (i) => { if (!i.name) throw bad('name'); st.providers.push({ id: `p${st.providers.length + 10}`, type: t, ...i }); return null; })],
      [`storageProviders.${t}.updateProvider`, guard(`storageProviders.${t}.updateProvider`, (i) => { const p = st.providers.find((x) => x.id === i.id); if (!p) throw bad('no provider'); Object.assign(p, i); return null; })],
      [`storageProviders.${t}.deleteProvider`, guard(`storageProviders.${t}.deleteProvider`, (i) => { st.providers = st.providers.filter((p) => p.id !== i.id); return null; })],
    ])),
    'notifications.createNotificationChannel': guard('notifications.createNotificationChannel', (i) => { if (!i.target?.type) throw bad('target'); st.channels.push({ id: `c${st.channels.length + 10}`, ...i }); return null; }),
    'notifications.updateNotificationChannel': guard('notifications.updateNotificationChannel', (i) => { const c = st.channels.find((x) => x.id === i.id); if (!c) throw bad('no channel'); Object.assign(c, i); return null; }),
    'notifications.sendTestNotification': guard('notifications.sendTestNotification', (i) => { st.notified.push(i); return null; }),
    'branding.getLogoSettings': () => st.logos,
    'branding.setLogoSettings': guard('branding.setLogoSettings', (i) => { st.logos = { ...i }; return null; }),
    'databaseBackups.listDatabaseBackups': (i) => st.dbBackups.filter((b) => b.projectName === i.projectName && b.serviceName === i.serviceName),
    'databaseBackups.getServiceDatabases': () => ['app', 'analytics'],
    'databaseBackups.createDatabaseBackup': guard('databaseBackups.createDatabaseBackup', (i) => { st.dbBackups.push({ id: `b${st.dbBackups.length + 10}`, ...i }); return null; }),
    'databaseBackups.updateDatabaseBackup': guard('databaseBackups.updateDatabaseBackup', (i) => { const b = st.dbBackups.find((x) => x.id === i.id); if (!b) throw bad('no backup'); Object.assign(b, i); return null; }),
    'databaseBackups.deleteDatabaseBackup': guard('databaseBackups.deleteDatabaseBackup', (i) => { st.dbBackups = st.dbBackups.filter((b) => b.id !== i.id); return null; }),
    'databaseBackups.runDatabaseBackup': guard('databaseBackups.runDatabaseBackup', () => null),
    'databaseBackups.restoreDatabaseBackup': guard('databaseBackups.restoreDatabaseBackup', (i) => { st.restored = i; return null; }),
    'volumeBackups.listVolumeBackups': (i) => st.volBackups.filter((b) => b.projectName === i.projectName && b.serviceName === i.serviceName),
    'volumeBackups.listVolumeMounts': () => [{ type: 'volume', name: 'data', mountPath: '/data' }],
    'volumeBackups.createVolumeBackup': guard('volumeBackups.createVolumeBackup', (i) => { st.volBackups.push({ id: `v${st.volBackups.length + 10}`, ...i }); return null; }),
    'volumeBackups.updateVolumeBackup': guard('volumeBackups.updateVolumeBackup', (i) => { const b = st.volBackups.find((x) => x.id === i.id); if (!b) throw bad('no backup'); Object.assign(b, i); return null; }),
    'volumeBackups.destroyVolumeBackup': guard('volumeBackups.destroyVolumeBackup', (i) => { st.volBackups = st.volBackups.filter((b) => b.id !== i.id); return null; }),
    'volumeBackups.runVolumeBackup': guard('volumeBackups.runVolumeBackup', () => null),
    'actions.getAction': (i) => ({ id: i.id, status: 'running', log: 'step 1\nstep 2' }),
    'actions.killAction': guard('actions.killAction', () => null),
  };
  // поведение панели без лицензии: одни процедуры отвечают ошибкой, другие молча ничего не делают
  const silent = (name, feature) => { const f = procs[name]; procs[name] = (i) => (ent()[feature] ? f(i) : null); };
  const thrown = (name, feature, msg, when = () => true) => { const f = procs[name]; procs[name] = (i) => { if (!ent()[feature] && when(i ?? {})) throw bad(msg); return f(i); }; };
  for (const n of ['users.createUser', 'users.updateUser', 'users.destroyUser']) silent(n, 'multipleUsers');
  for (const n of ['notifications.createNotificationChannel', 'notifications.updateNotificationChannel', 'notifications.destroyNotificationChannel']) silent(n, 'notifications');
  for (const n of ['branding.setLinksSettings', 'branding.setErrorPageSettings', 'branding.setCustomCodeSettings', 'branding.setLogoSettings']) thrown(n, 'branding', 'You need a license that supports white-labeling.');
  for (const n of ['metrics.updateSettings', 'logs.updateSettings']) thrown(n, 'advancedMonitoring', 'A license with advanced monitoring support is required.', (i) => i.enabled);
  thrown('settings.setServiceDomain', 'customServiceDomain', 'Custom service domain feature requires a valid license');
  const nodes = procs['cluster.listNodes']; procs['cluster.listNodes'] = () => (ent().cluster ? nodes() : null);
  const wc = procs['cluster.addWorkerCommand']; procs['cluster.addWorkerCommand'] = () => (ent().cluster ? wc() : null);
  Object.assign(procs, {
    'setup.getStatus': () => ({ isComplete: st.setupComplete }),
    'setup.setup': (i) => {
      if (st.setupComplete) throw bad('Setup is already completed');
      if (i.terms !== true) throw bad('You need to agree with our Terms and Conditions');
      if (!i.email || String(i.password ?? '').length < 8 || !i.source) throw bad('Invalid input');
      st.setupComplete = true; st.setupInput = { email: i.email, source: i.source, subscribe: i.subscribe, passwordLength: i.password.length };
      st.users.push({ id: 's1', email: i.email, admin: true, apiToken: null, createdAt: Date.now() });
      return { token: 'sess-token' };
    },
    'lemonLicense.getLicensePayload': () => { if (hideLicense) throw Object.assign(new Error('No procedure'), { code: 'NOT_FOUND' }); return st.license.lemon; },
    'portalLicense.getLicensePayload': () => { if (hideLicense) throw Object.assign(new Error('No procedure'), { code: 'NOT_FOUND' }); return st.license.portal; },
    'lemonLicense.activate': guard('lemonLicense.activate', (i) => { if (String(i.licenseKey).startsWith('GOOD')) st.license.lemon = { valid: true, meta: { product_id: 108139 } }; return null; }), // неверный ключ панель молча игнорирует
    'lemonLicense.activateByOrder': guard('lemonLicense.activateByOrder', (i) => { if (i.orderId === '1001') st.license.lemon = { valid: true, meta: { product_id: 108137 } }; return null; }),
    'lemonLicense.deactivate': guard('lemonLicense.deactivate', () => { st.license.lemon = null; return null; }),
    'portalLicense.activate': guard('portalLicense.activate', () => { if (!st.portalAvailable) throw bad('License is not valid'); st.license.portal = LICENSES.full.portal; return null; }),
    'portalLicense.deactivate': guard('portalLicense.deactivate', () => { st.license.portal = null; return null; }),
  });
  return { procs, state: st };
}
