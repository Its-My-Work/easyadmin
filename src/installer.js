import crypto from 'node:crypto';
import { promises as dns } from 'node:dns';
import { PanelClient } from './easypanel.js';
import { HttpError } from './http.js';
import { checkTarget, checkUser, realSsh } from './ssh.js';

/**
 * Установка Easypanel на новый сервер по SSH и добавление её в EasyAdmin.
 * Секреты (SSH-доступ, пароль администратора) живут только в памяти задания и стираются по завершении; в базу попадает журнал без секретов.
 * Установка идёт на сервере отдельным юнитом systemd (easypanel-install) — обрыв связи или перезапуск EasyAdmin её не прерывают.
 * Первоначальная настройка (создание администратора, токен) выполняется через SSH-туннель к 127.0.0.1:3000: пароль не идёт по открытому интернету.
 */
export const STEPS = [['connect', 'Подключение к серверу'], ['precheck', 'Проверка сервера'], ['install', 'Установка Docker и Easypanel'], ['setup', 'Первоначальная настройка'], ['token', 'API-токен'], ['https', 'Адрес панели и HTTPS'], ['register', 'Добавление панели']];
const MAX_LOG = 400;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PRECHECK = [
  '. /etc/os-release 2>/dev/null',
  'echo "uid=$(id -u)"; echo "os=${ID:-unknown}"; echo "osver=${VERSION_ID:-0}"; echo "arch=$(uname -m)"',
  'echo "mem=$(awk \'/MemTotal/ {print int($2/1024)}\' /proc/meminfo)"; echo "disk=$(df -Pk / | awk \'NR==2 {print int($4/1048576)}\')"',
  'LISTEN=$( (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk \'{print $4}\' )',
  'for p in 80 443 3000; do if echo "$LISTEN" | grep -qE "[:.]$p$"; then echo "port$p=busy"; else echo "port$p=free"; fi; done',
  'echo "systemd=$(command -v systemd-run >/dev/null 2>&1 && echo yes || echo no)"; echo "docker=$(command -v docker >/dev/null 2>&1 && echo yes || echo no)"',
  'echo "swarm=$(docker info --format \'{{.Swarm.LocalNodeState}}\' 2>/dev/null || echo none)"; echo "containers=$(docker ps -q 2>/dev/null | wc -l | tr -d \' \')"',
  'echo "easypanel=$( [ -d /etc/easypanel ] && echo yes || echo no)"',
  'echo "internet=$( ( curl -fsS -m 8 -o /dev/null https://get.easypanel.io || wget -q -T 8 -O /dev/null https://get.easypanel.io ) >/dev/null 2>&1 && echo yes || echo no)"',
].join('; ');

const INSTALL_SCRIPT = [
  'set -e', 'export DEBIAN_FRONTEND=noninteractive',
  'apt-get update -y', 'apt-get install -y curl ca-certificates lsof',
  'if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi',
  'curl -sSL https://get.easypanel.io | sh',
].join('; ');
// запуск отдельным юнитом: сеанс SSH может оборваться, установка продолжится
const START_INSTALL = `if systemctl is-active --quiet easypanel-install 2>/dev/null; then echo EA_RUNNING; exit 1; fi; systemd-run --unit=easypanel-install --collect --description="EasyAdmin: Easypanel install" bash -c '${INSTALL_SCRIPT.replace(/'/g, "'\\''")}' 2>&1`;
const pollScript = (seen) => `journalctl -u easypanel-install --no-pager -o cat 2>/dev/null | tail -n +${seen + 1}; echo "__COUNT__ $(journalctl -u easypanel-install --no-pager -o cat 2>/dev/null | wc -l)"; echo "__STATE__ $(systemctl is-active easypanel-install 2>/dev/null || echo inactive)"; echo "__UP__ $(curl -fsS -m 5 -o /dev/null http://127.0.0.1:3000/api/trpc/setup.getStatus 2>/dev/null && echo yes || echo no)"`;

/** Разбор вывода проверки и оценка пригодности сервера. */
export function evaluate(info) {
  const c = []; const add = (id, label, level, detail) => c.push({ id, label, level, detail });
  const num = (v) => Number(v);
  if (info.uid === undefined) add('root', 'Права root или sudo без пароля', 'error', 'Не удалось выполнить команды от root: нужен root или пользователь с sudo без пароля (NOPASSWD)');
  else add('root', 'Права root', 'ok', info.uid === '0' ? 'есть' : 'есть (через sudo)');
  const ver = parseFloat(info.osver);
  const osOk = (info.os === 'ubuntu' && ver >= 22.04) || (info.os === 'debian' && ver >= 11);
  add('os', 'Система', osOk ? 'ok' : 'error', osOk ? `${info.os} ${info.osver}` : `${info.os} ${info.osver}: Easypanel устанавливается на Ubuntu 22.04+ и Debian 11+`);
  add('arch', 'Архитектура', ['x86_64', 'aarch64'].includes(info.arch) ? 'ok' : 'error', info.arch);
  add('mem', 'Память', num(info.mem) >= 1700 ? 'ok' : 'error', `${info.mem} МБ${num(info.mem) >= 1700 ? '' : ' — нужно не меньше 2 ГБ'}`);
  add('disk', 'Свободное место', num(info.disk) >= 5 ? 'ok' : 'warn', `${info.disk} ГБ${num(info.disk) >= 5 ? '' : ' — рекомендуется от 5 ГБ'}`);
  for (const p of [80, 443, 3000]) add(`port${p}`, `Порт ${p}`, info[`port${p}`] === 'busy' ? 'error' : 'ok', info[`port${p}`] === 'busy' ? 'занят другой программой' : 'свободен');
  add('systemd', 'systemd', info.systemd === 'yes' ? 'ok' : 'error', info.systemd === 'yes' ? 'есть' : 'нужен для фоновой установки');
  add('easypanel', 'Easypanel', info.easypanel === 'yes' ? 'error' : 'ok', info.easypanel === 'yes' ? 'уже установлена — подключите её через «Подключить существующую»' : 'не установлена');
  add('swarm', 'Docker Swarm', ['active', 'pending'].includes(info.swarm) ? 'error' : 'ok', ['active', 'pending'].includes(info.swarm) ? 'уже работает: скрипт Easypanel принудительно выйдет из Swarm и разрушит его' : 'не используется');
  add('docker', 'Docker', 'ok', info.docker === 'yes' ? 'уже установлен' : 'будет установлен автоматически');
  if (info.docker === 'yes' && num(info.containers) > 0) add('containers', 'Запущенные контейнеры', 'warn', `${info.containers} шт. — убедитесь, что это новый сервер`);
  add('internet', 'Доступ в интернет', info.internet === 'yes' ? 'ok' : 'error', info.internet === 'yes' ? 'есть' : 'сервер не достучался до get.easypanel.io');
  return c;
}
export const parseKv = (text) => Object.fromEntries(text.split('\n').map((l) => /^([a-z0-9]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const genPassword = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(20), (b) => a[b % a.length]).join(''); };

export function installRoutes(d) {
  const { db, manager, audit, need, asHttp, addPanelRow, canPanel } = d;
  const ssh = d.ssh ?? realSsh;
  const tickets = new Map(); // ticket → { session, host, port, user, hostKey, userId, at, info }
  const jobs = new Map();
  const now = () => Date.now();
  const sweep = setInterval(() => {
    for (const [id, t] of tickets) if (now() - t.at > 15 * 60_000) { t.session.close(); tickets.delete(id); }
    for (const [id, j] of jobs) if (j.finishedAt && now() - j.finishedAt > 2 * 3600_000) jobs.delete(id);
  }, 60_000); sweep.unref();
  db.prepare("UPDATE panel_installs SET status = 'interrupted' WHERE status = 'running'").run();

  const view = (j, ctx) => ({
    id: j.id, status: j.status, host: j.host, steps: j.steps, log: j.log.slice(-120), error: j.error, panelId: j.panelId, url: j.url, https: j.https, warnings: j.warnings,
    adminEmail: j.admin.email, adminPassword: j.status === 'done' && j.admin.generated && !j.revealed ? (j.revealed = true, j.admin.password) : null,
  });
  const redact = (j, line) => { let s = String(line); for (const secret of [j.admin.password, j.secrets?.password, j.secrets?.passphrase]) if (secret && secret.length > 3) s = s.split(secret).join('***'); return s; };
  const log = (j, line) => { for (const l of String(line).split('\n')) { const t = l.trimEnd(); if (t) { j.log.push(redact(j, t).slice(0, 400)); if (j.log.length > MAX_LOG) j.log.shift(); } } };
  const step = (j, id, status, detail) => { const s = j.steps.find((x) => x.id === id); s.status = status; if (detail !== undefined) s.detail = detail; };

  async function execute(j, session, ctx) {
    let tunnel = null;
    const guard = () => { if (j.abort) throw new HttpError(499, 'Остановлено пользователем'); };
    try {
      /* --- установка на сервере (отдельный юнит) --- */
      step(j, 'install', 'running'); guard();
      const start = await session.run(START_INSTALL, { timeoutMs: 40_000 });
      if (start.stdout.includes('EA_RUNNING')) log(j, 'Установка уже идёт на сервере — подключаюсь к её журналу');
      else if (start.code !== 0) throw new HttpError(502, `Не удалось запустить установку: ${(start.stderr || start.stdout).trim().slice(-200)}`);
      let seen = 0; const t0 = now(); let idle = 0;
      for (;;) {
        guard();
        if (now() - t0 > 30 * 60_000) throw new HttpError(504, 'Установка идёт слишком долго (30 минут)');
        await sleep(j.pollMs ?? 4000);
        let r;
        try { r = await session.run(pollScript(seen), { timeoutMs: 30_000 }); } catch (e) { idle++; if (idle > 8) throw e; continue; }
        idle = 0;
        const cnt = /__COUNT__ (\d+)/.exec(r.stdout); const state = /__STATE__ (\S+)/.exec(r.stdout)?.[1]; const up = /__UP__ (\S+)/.exec(r.stdout)?.[1] === 'yes';
        log(j, r.stdout.replace(/__(COUNT|STATE|UP)__.*\n?/g, '')); if (cnt) seen = Number(cnt[1]);
        if (state !== 'active' && state !== 'activating') {
          if (up) break;
          throw new HttpError(502, 'Установка завершилась, но панель не запустилась. Подробности — в журнале выше');
        }
      }
      step(j, 'install', 'ok', 'Easypanel запущена');

      /* --- первоначальная настройка через туннель --- */
      step(j, 'setup', 'running'); guard();
      tunnel = await session.tunnel(3000);
      const open = new PanelClient({ url: tunnel.url, timeoutMs: 25_000 });
      let status;
      for (let i = 0; i < 20; i++) { try { status = await open.query('setup.getStatus'); break; } catch { await sleep(j.pollMs ?? 3000); guard(); } }
      if (!status) throw new HttpError(502, 'Панель не отвечает через туннель');
      if (status.isComplete) throw new HttpError(409, 'Панель уже настроена (администратор существует): подключите её как существующую');
      let sessionToken = (await open.mutate('setup.setup', { email: j.admin.email, password: j.admin.password, source: 'easyadmin', subscribe: !!j.subscribe, terms: true }))?.token;
      if (!sessionToken) sessionToken = (await open.mutate('auth.login', { email: j.admin.email, password: j.admin.password }))?.token;
      if (!sessionToken) throw new HttpError(502, 'Панель не вернула токен сеанса после настройки');
      step(j, 'setup', 'ok', `Администратор ${j.admin.email} создан`);

      step(j, 'token', 'running'); guard();
      const authed = new PanelClient({ url: tunnel.url, token: sessionToken, timeoutMs: 25_000 });
      const listOf = (v) => (Array.isArray(v) ? v : v?.users ?? []);
      const me = listOf(await authed.query('users.listUsers')).find((u) => String(u.email).toLowerCase() === j.admin.email.toLowerCase());
      if (!me) throw new HttpError(502, 'Не нашёл созданного администратора в панели');
      await authed.mutate('users.generateApiToken', { id: me.id });
      const apiToken = listOf(await authed.query('users.listUsers')).find((u) => u.id === me.id)?.apiToken;
      if (!apiToken) throw new HttpError(502, 'Панель не выдала API-токен');
      await new PanelClient({ url: tunnel.url, token: apiToken, timeoutMs: 25_000 }).query('projects.listProjects');
      step(j, 'token', 'ok', 'Токен выдан и проверен');

      /* --- адрес панели и HTTPS --- */
      step(j, 'https', 'running'); guard();
      const api = new PanelClient({ url: tunnel.url, token: apiToken, timeoutMs: 25_000 });
      const ip = await api.query('settings.getServerIp').catch(() => null);
      const dom = await api.query('settings.getPanelDomain').catch(() => null);
      let domain = dom?.customPanelDomain || dom?.defaultPanelDomain || null;
      if (j.domain) {
        const a = await new dns.Resolver({ timeout: j.dnsTimeoutMs ?? 4000, tries: 1 }).resolve4(j.domain).catch(() => []);
        if (ip && a.includes(ip)) { await api.mutate('settings.setPanelDomain', { customPanelDomain: j.domain, serveOnIp: true }); domain = j.domain; log(j, `Домен ${j.domain} назначен панели`); }
        else j.warnings.push(`DNS-запись домена ${j.domain} не указывает на ${ip ?? 'сервер'} — оставлен сгенерированный домен; задайте домен позже в настройках панели`);
      }
      let url = null;
      if (domain) {
        for (let i = 0; i < (j.httpsTries ?? 36) && !url; i++) {
          guard();
          try { const r = await (d.fetchImpl ?? fetch)(`https://${domain}/`, { signal: AbortSignal.timeout(6000), redirect: 'manual' }); if (r.status < 500) url = `https://${domain}`; } catch { /* сертификат ещё выпускается */ }
          if (!url) await sleep(j.httpsPollMs ?? 5000);
        }
      }
      j.https = !!url;
      if (!url) { url = `http://${ip ?? j.host}:3000`; j.warnings.push('HTTPS пока недоступен (сертификат выпускается или закрыт порт): панель добавлена по HTTP на порт 3000 — переключите адрес на HTTPS позже'); }
      step(j, 'https', 'ok', url);

      /* --- регистрация --- */
      step(j, 'register', 'running'); guard();
      const ext = await new PanelClient({ url, token: apiToken, timeoutMs: j.extTimeoutMs ?? 20_000 }).query('projects.listProjects').then(() => true, () => false);
      if (!ext) j.warnings.push('EasyAdmin пока не достучался до панели по её адресу снаружи — проверьте файрвол и DNS; токен сохранён');
      const row = addPanelRow({ name: j.panel.name, url, token: apiToken, color: j.panel.color, tags: j.panel.tags, notes: `Установлена из EasyAdmin ${new Date().toISOString().slice(0, 10)}` });
      j.panelId = row.id; j.url = url; step(j, 'register', 'ok', `Панель «${row.name}» добавлена`);
      j.status = 'done'; audit(ctx, { action: 'panel.install.done', panel: row, target: j.host, detail: j.https ? 'HTTPS' : 'HTTP :3000' });
    } catch (e) {
      const running = j.steps.find((x) => x.status === 'running'); if (running) step(j, running.id, 'error', e.message);
      j.status = j.abort ? 'aborted' : 'error'; j.error = j.abort ? 'Остановлено. Установка на сервере могла продолжиться (юнит easypanel-install).' : e.message;
      audit(ctx, { action: 'panel.install.failed', target: j.host, ok: false, detail: j.error });
    } finally {
      try { tunnel?.close(); } catch { /* закрыт */ }
      session.close(); j.secrets = null; j.admin.password = j.admin.generated ? j.admin.password : null; j.finishedAt = now();
      db.prepare('UPDATE panel_installs SET status = ?, panel_id = ?, error = ?, log = ?, finished_at = ? WHERE id = ?').run(j.status, j.panelId ?? null, j.error ?? null, j.log.join('\n').slice(-60_000), j.finishedAt, j.id);
    }
  }

  return [
    ['POST', '/api/installs/scan', async (ctx) => {
      const t = checkTarget(ctx.body?.host, ctx.body?.port);
      try { const r = await ssh.scanHostKeys(t.host, t.port); return { host: r.host, port: r.port, keys: r.keys.map((k) => ({ type: k.type, fingerprint: k.fingerprint })) }; } catch (e) { throw asHttp(e); }
    }, { admin: true }],

    ['POST', '/api/installs/check', async (ctx) => {
      const b = ctx.body ?? {}; const t = checkTarget(b.host, b.port); const user = checkUser(b.user);
      need(tickets.size < 8, 'Слишком много незавершённых проверок — подождите несколько минут');
      let scan; try { scan = await ssh.scanHostKeys(t.host, t.port); } catch (e) { throw asHttp(e); }
      const hostKey = scan.keys.find((k) => k.fingerprint === String(b.fingerprint ?? ''));
      need(hostKey, 'Отпечаток ключа сервера не совпадает с подтверждённым — возможна подмена, начните заново');
      let session;
      try {
        session = ssh.openSession({ host: t.host, port: t.port, user, auth: { password: b.auth?.password || undefined, privateKey: b.auth?.privateKey || undefined, passphrase: b.auth?.passphrase || undefined }, hostKey });
        const r = await session.run(PRECHECK, { timeoutMs: 40_000 });
        const info = parseKv(r.stdout);
        if (r.code !== 0 && info.uid === undefined && /sudo/i.test(r.stderr)) { /* нет sudo — evaluate() покажет ошибку прав */ }
        const checks = evaluate(info); const ok = checks.every((c) => c.level !== 'error');
        audit(ctx, { action: 'panel.install.check', target: t.host, ok, detail: ok ? 'сервер подходит' : checks.filter((c) => c.level === 'error').map((c) => c.id).join(', ') });
        if (!ok) { session.close(); return { ok: false, checks }; }
        const ticket = crypto.randomBytes(18).toString('hex');
        tickets.set(ticket, { session, host: t.host, port: t.port, user, userId: ctx.user.id, at: now(), secrets: { password: b.auth?.password, passphrase: b.auth?.passphrase } });
        return { ok: true, checks, ticket, expiresInSec: 900 };
      } catch (e) { session?.close(); audit(ctx, { action: 'panel.install.check', target: t.host, ok: false, detail: e.message }); throw asHttp(e); }
    }, { admin: true }],

    ['POST', '/api/installs', async (ctx) => {
      const b = ctx.body ?? {}; const tk = tickets.get(String(b.ticket ?? ''));
      need(tk && tk.userId === ctx.user.id, 'Проверка сервера устарела — выполните её заново');
      need(b.terms === true, 'Нужно принять условия использования Easypanel');
      const name = String(b.panel?.name ?? '').trim(); need(name && name.length <= 80, 'Укажите название панели (до 80 символов)');
      const email = String(b.admin?.email ?? '').trim(); need(EMAIL.test(email), 'Некорректный e-mail администратора');
      let password = String(b.admin?.password ?? ''); const generated = !password; if (generated) password = genPassword();
      need(password.length >= 8 && password.length <= 200, 'Пароль администратора — не короче 8 символов');
      const domain = b.domain ? String(b.domain).trim().toLowerCase() : ''; need(!domain || DOMAIN.test(domain), 'Некорректный домен');
      need([...jobs.values()].filter((j) => j.status === 'running').length < 2, 'Уже идут две установки — дождитесь завершения');
      tickets.delete(String(b.ticket));
      const id = crypto.randomBytes(8).toString('hex');
      const color = /^#[0-9a-fA-F]{6}$/.test(b.panel?.color ?? '') ? b.panel.color : '#6366f1';
      const j = { id, status: 'running', host: tk.host, port: tk.port, sshUser: tk.user, userId: ctx.user.id, panel: { name, color, tags: b.panel?.tags ?? '' }, admin: { email, password, generated }, subscribe: b.subscribe === true, domain,
        secrets: tk.secrets, steps: STEPS.map(([sid, label]) => ({ id: sid, label, status: sid === 'connect' || sid === 'precheck' ? 'ok' : 'pending', detail: null })), log: [], warnings: [], abort: false, createdAt: now(), panelId: null, url: null, https: false, error: null, revealed: false,
        pollMs: d.installPollMs, dnsTimeoutMs: d.installDnsTimeoutMs, extTimeoutMs: d.installExtTimeoutMs, httpsPollMs: d.installHttpsPollMs, httpsTries: d.installHttpsTries };
      jobs.set(id, j);
      db.prepare('INSERT INTO panel_installs (id, ts, username, host, port, ssh_user, status) VALUES (?,?,?,?,?,?,?)').run(id, now(), ctx.user.username, tk.host, tk.port, tk.user, 'running');
      audit(ctx, { action: 'panel.install.start', target: tk.host, detail: `${name} · домен ${domain || 'сгенерированный'}` });
      execute(j, tk.session, { user: ctx.user });
      return { id };
    }, { admin: true }],

    ['GET', '/api/installs', (ctx) => ({ installs: db.prepare('SELECT id, ts, username, host, status, panel_id panelId, error, finished_at finishedAt FROM panel_installs ORDER BY ts DESC LIMIT 20').all() }), { admin: true }],
    ['GET', '/api/installs/:id', (ctx) => {
      const j = jobs.get(ctx.params.id);
      if (j) { need(j.userId === ctx.user.id, 'Установка запущена другим администратором'); return view(j, ctx); }
      const r = db.prepare('SELECT * FROM panel_installs WHERE id = ?').get(String(ctx.params.id)); if (!r) throw new HttpError(404, 'Установка не найдена');
      return { id: r.id, status: r.status, host: r.host, steps: [], log: String(r.log ?? '').split('\n').slice(-120), error: r.error, panelId: r.panel_id, url: null, https: null, warnings: [], adminEmail: null, adminPassword: null };
    }, { admin: true }],
    ['DELETE', '/api/installs/:id', (ctx) => { const j = jobs.get(ctx.params.id); need(j, 'Установка не найдена'); need(j.userId === ctx.user.id, 'Установка запущена другим администратором'); j.abort = true; return { ok: true }; }, { admin: true }],
    ['DELETE', '/api/installs/ticket/:ticket', (ctx) => { const t = tickets.get(ctx.params.ticket); if (t && t.userId === ctx.user.id) { t.session.close(); tickets.delete(ctx.params.ticket); } return { ok: true }; }, { admin: true }],
  ];
}
