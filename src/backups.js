import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decrypt, encrypt } from './crypto.js';
import { HttpError, RawResponse } from './http.js';
import { runOnHost } from './host-exec.js';
import { inspectService, normalizeTree } from './easypanel.js';
import { applyConfig, configFromService } from './templates.js';
import { createRestorer } from './restore-runner.js';
import { CONSISTENCY, DEFAULT_DIR, DISCOVER_CMD, buildScript, cleanupJob, deployJob, groupKey, jobVolumeBytes, listHostFiles, measureVolumes, needsDiscovery, parseDiscovery, readStatus, resolveTargets, restoreHint, slugOf, stampOf, validDir } from './data-backup.js';

/**
 * Резервные копии EasyAdmin: зашифрованный паролем файл (.eabak) с базой (без истории нагрузки и сессий) и ключом приложения.
 * Хранилище: папка data/backups или S3-совместимое (SigV4 на встроенном crypto). Расписание, ротация, проверка и восстановление.
 * Восстановление: копия кладётся в data/restore-pending, сервис перезапускается и подменяет базу при старте (applyPendingRestore).
 */
const NAME_RE = /^easyadmin-\d{8}-\d{6}\.eabak$/;
const DAY = 86400e3;
const DATA_DEFAULTS = { mode: 'none', keys: [], dest: 'host', dir: DEFAULT_DIR, keep: 3, minFreeMb: 1024, consistency: 'none' };
const DEFAULTS = { enabled: false, data: DATA_DEFAULTS, system: true, panels: 'all', panelIds: [], every: 'daily', hour: 3, keep: 7, storage: 'local', s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: 'easyadmin/', accessKey: '', secretKey: '', pathStyle: true }, password: '' };
const stamp = (ts) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/* ---------- формат файла ---------- */
export function sealBackup({ dbBytes, appKey, password, createdAt, panels = [] }) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const k = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const plain = JSON.stringify({ db: dbBytes ? dbBytes.toString('base64') : null, key: dbBytes && appKey ? appKey.toString('hex') : null, panels });
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.from(JSON.stringify({ format: 'easyadmin-backup', v: 2, createdAt, kdf: { name: 'scrypt', N: 16384, r: 8, p: 1, salt: salt.toString('base64') }, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: ct.toString('base64') }));
}
export function openBackup(file, password) {
  let env;
  try { env = JSON.parse(file.toString('utf8')); } catch { throw new Error('Это не файл копии EasyAdmin'); }
  if (env?.format !== 'easyadmin-backup' || env.v !== 2) throw new Error('Это не файл копии EasyAdmin (или формат новее)');
  try {
    const k = crypto.scryptSync(password, Buffer.from(env.kdf.salt, 'base64'), 32, { N: env.kdf.N, r: env.kdf.r, p: env.kdf.p });
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(env.iv, 'base64'));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    const plain = JSON.parse(Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8'));
    return { createdAt: env.createdAt, db: plain.db ? Buffer.from(plain.db, 'base64') : null, key: plain.key ? Buffer.from(plain.key, 'hex') : null, panels: plain.panels ?? [] };
  } catch { throw new Error('Неверный пароль или файл повреждён'); }
}
/** Проверяет, что внутри рабочая база: целостность и основные таблицы. Возвращает счётчики. */
export function inspectDb(bytes) {
  const tmp = path.join(os.tmpdir(), `ea-inspect-${crypto.randomBytes(6).toString('hex')}.db`);
  fs.writeFileSync(tmp, bytes);
  let d;
  try {
    d = new DatabaseSync(tmp);
    const ok = d.prepare('PRAGMA integrity_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error('База в копии повреждена');
    const n = (t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    return { panels: n('panels'), users: n('users'), channels: n('channels'), templates: n('templates') };
  } catch (e) { throw new Error(e.message.includes('повреждена') ? e.message : 'В копии нет базы EasyAdmin'); } finally { try { d?.close(); } catch { /* ignore */ } fs.rmSync(tmp, { force: true }); }
}

/** При старте: если подготовлено восстановление, подменяет базу (старая сохраняется в before-restore-*). */
export function applyPendingRestore(dataDir) {
  const dir = path.join(dataDir, 'restore-pending');
  const db = path.join(dir, 'easyadmin.db');
  if (!fs.existsSync(db)) return null;
  const saved = path.join(dataDir, `before-restore-${stamp(Date.now())}`);
  fs.mkdirSync(saved, { recursive: true });
  for (const f of ['easyadmin.db', 'easyadmin.db-wal', 'easyadmin.db-shm', 'secret.key']) {
    const from = path.join(dataDir, f);
    if (fs.existsSync(from) && (f !== 'secret.key' || fs.existsSync(path.join(dir, 'secret.key')))) fs.renameSync(from, path.join(saved, f));
  }
  fs.renameSync(db, path.join(dataDir, 'easyadmin.db'));
  if (fs.existsSync(path.join(dir, 'secret.key'))) fs.renameSync(path.join(dir, 'secret.key'), path.join(dataDir, 'secret.key'));
  fs.rmSync(dir, { recursive: true, force: true });
  return saved;
}

/* ---------- S3 (SigV4) ---------- */
export function s3Client(cfg, fetchImpl = globalThis.fetch) {
  const u = new URL(cfg.endpoint);
  const host = cfg.pathStyle ? u.host : `${cfg.bucket}.${u.host}`;
  const pathOf = (key) => (cfg.pathStyle ? `/${cfg.bucket}${key ? `/${key.split('/').map(enc).join('/')}` : ''}` : `/${key.split('/').map(enc).join('/')}`);
  /** Временная ссылка: ею можно выполнить один запрос (PUT/GET) без ключей доступа. */
  function presign(method, key, expires = 43200, extra = {}) {
    const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); const day = amz.slice(0, 8); const scope = `${day}/${cfg.region}/s3/aws4_request`;
    const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${cfg.accessKey}/${scope}`, 'X-Amz-Date': amz, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host', ...extra };
    const qs = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&'); const pathPart = pathOf(key);
    const canonical = [method, pathPart, qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const sk = hmac(hmac(hmac(hmac(`AWS4${cfg.secretKey}`, day), cfg.region), 's3'), 'aws4_request');
    const sig = crypto.createHmac('sha256', sk).update(['AWS4-HMAC-SHA256', amz, scope, sha(canonical)].join('\n')).digest('hex');
    return `${u.protocol}//${host}${pathPart}?${qs}&X-Amz-Signature=${sig}`;
  }
  async function call(method, key, { body = Buffer.alloc(0), query = {} } = {}) {
    const pathPart = pathOf(key);
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); const day = amz.slice(0, 8);
    const payload = sha(body);
    const headers = { host, 'x-amz-content-sha256': payload, 'x-amz-date': amz };
    const names = Object.keys(headers).sort();
    const canonical = [method, pathPart, qs, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payload].join('\n');
    const scope = `${day}/${cfg.region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canonical)].join('\n');
    const sk = hmac(hmac(hmac(hmac(`AWS4${cfg.secretKey}`, day), cfg.region), 's3'), 'aws4_request');
    const auth = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${crypto.createHmac('sha256', sk).update(sts).digest('hex')}`;
    const res = await fetchImpl(`${u.protocol}//${host}${pathPart}${qs ? `?${qs}` : ''}`, { method, headers: { ...headers, Authorization: auth }, body: method === 'PUT' ? body : undefined, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) { const t = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); throw new Error(`Хранилище S3: HTTP ${res.status}${t ? ` — ${t}` : ''}`); }
    return res;
  }
  return {
    presign,
    put: (key, body) => call('PUT', key, { body }),
    /** Загрузка частями: создаёт upload и возвращает UploadId (части, завершение и отмена выполняются по временным ссылкам). */
    async createMultipart(key) { const x = await (await call('POST', key, { query: { uploads: '' } })).text(); const id = /<UploadId>([^<]+)<\/UploadId>/.exec(x)?.[1]; if (!id) throw new Error('Хранилище S3 не вернуло UploadId'); return id; },
    abortMultipart: (key, uploadId) => call('DELETE', key, { query: { uploadId } }),
    get: async (key) => Buffer.from(await (await call('GET', key)).arrayBuffer()),
    del: (key) => call('DELETE', key),
    /** Список объектов с префиксом; хранилище отдаёт не больше 1000 за запрос — читаем страницы, пока они есть. */
    async list(prefix) {
      const out = []; let token = '';
      for (let page = 0; page < 200; page++) {
        const x = await (await call('GET', '', { query: { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) } })).text();
        for (const m of x.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) out.push({ key: /<Key>([^<]*)<\/Key>/.exec(m[1])?.[1], size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0), ts: Date.parse(/<LastModified>([^<]*)<\/LastModified>/.exec(m[1])?.[1] ?? '') || 0 });
        token = /<IsTruncated>true<\/IsTruncated>/.test(x) ? (/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(x)?.[1] ?? '') : '';
        if (!token) break;
      }
      return out.filter((o) => o.key);
    },
  };
}

export function createBackups({ db, key, config, alerts, manager, audit, fetchImpl = globalThis.fetch, now = () => Date.now(), restart = () => process.exit(0), dataPollMs = 10_000, hostRun, mpMin = 5 * 1024 ** 3 - 1, partMb = 1024 }) {
  const getRaw = (k) => db.prepare('SELECT v FROM settings WHERE k = ?').get(k)?.v;
  const setRaw = (k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  const freshData = (x = {}) => { const { encrypt: _legacy, methods: _m, providers: _p, ...rest } = x; return { ...DATA_DEFAULTS, ...rest }; }; // methods/providers — остатки прежних версий (расписания Easypanel убраны)
  const load = () => { try { const c = JSON.parse(decrypt(key, getRaw('backup_cfg'))); return { ...DEFAULTS, ...c, data: freshData(c.data), s3: { ...DEFAULTS.s3, ...(c.s3 ?? {}) } }; } catch { return { ...DEFAULTS, data: freshData(), s3: { ...DEFAULTS.s3 } }; } };
  const save = (c) => setRaw('backup_cfg', encrypt(key, JSON.stringify(c)));
  const lastRun = () => { try { return JSON.parse(getRaw('backup_last') ?? 'null'); } catch { return null; } };
  const dir = () => path.join(config.dataDir, 'backups');
  let timer = null; let busy = false; let dataBusy = false;
  let dataState = { running: false, panels: {} };
  const svcResults = () => { try { return JSON.parse(getRaw('backup_data_svc') ?? '{}'); } catch { return {}; } };
  const lastData = () => { try { return JSON.parse(getRaw('backup_data_last') ?? 'null'); } catch { return null; } };

  // каналам, получающим «диск заполнен», сообщаем и об ошибках копирования — один раз
  if (getRaw('backup_migrated') !== '1') {
    for (const c of db.prepare('SELECT id, events FROM channels').all()) {
      const ev = String(c.events ?? '').split(',').filter(Boolean);
      if (ev.includes('disk_high') && !ev.includes('backup_failed')) db.prepare('UPDATE channels SET events = ? WHERE id = ?').run([...ev, 'backup_failed'].join(','), c.id);
    }
    setRaw('backup_migrated', '1');
  }

  const view = () => {
    const c = load(); const l = lastRun();
    return { serverTime: { now: now(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', hour: new Date(now()).getHours(), minute: new Date(now()).getMinutes() }, enabled: c.enabled, where: c.storage === 's3' ? 's3' : 'server', data: c.data, dataLast: lastData(), system: c.system, panels: c.panels, panelIds: c.panelIds, every: c.every, hour: c.hour, keep: c.keep, storage: c.storage, hasPassword: !!c.password, s3: { ...c.s3, secretKey: '', hasSecret: !!c.s3.secretKey }, last: l, local: config.dataDir !== ':memory:' };
  };
  function update(b) {
    const c = load();
    if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw new Error('Включено — да или нет'); c.enabled = b.enabled; }
    if (b.system !== undefined) { if (typeof b.system !== 'boolean') throw new Error('Система — да или нет'); c.system = b.system; }
    if (b.panels !== undefined) { if (!['none', 'all', 'selected'].includes(b.panels)) throw new Error('Панели: none, all или selected'); c.panels = b.panels; }
    if (b.panelIds !== undefined) { if (!Array.isArray(b.panelIds) || b.panelIds.some((x) => !Number.isInteger(x))) throw new Error('Список панелей — числа'); c.panelIds = [...new Set(b.panelIds)]; }
    if (b.every !== undefined) { if (!['daily', 'weekly'].includes(b.every)) throw new Error('Периодичность: daily или weekly'); c.every = b.every; }
    if (b.hour !== undefined) { if (!Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23) throw new Error('Час: от 0 до 23'); c.hour = b.hour; }
    if (b.keep !== undefined) { if (!Number.isInteger(b.keep) || b.keep < 1 || b.keep > 60) throw new Error('Сколько копий хранить: от 1 до 60'); c.keep = b.keep; }
    if (b.storage !== undefined) { if (!['local', 's3'].includes(b.storage)) throw new Error('Хранилище: local или s3'); c.storage = b.storage; }
    if (b.where !== undefined) { if (!['server', 's3'].includes(b.where)) throw new Error('Куда сохранять: server или s3'); c.storage = b.where === 's3' ? 's3' : 'local'; c.data.dest = b.where === 's3' ? 's3' : 'host'; } // одно место для копий EasyAdmin и копий данных
    if (b.password) { if (String(b.password).length < 8) throw new Error('Пароль копии: не короче 8 символов'); c.password = String(b.password); }
    if (b.s3) {
      for (const k of ['endpoint', 'region', 'bucket', 'prefix', 'accessKey']) if (b.s3[k] !== undefined) c.s3[k] = String(b.s3[k]).trim();
      if (b.s3.secretKey) c.s3.secretKey = String(b.s3.secretKey);
      if (b.s3.pathStyle !== undefined) c.s3.pathStyle = !!b.s3.pathStyle;
      if (c.s3.endpoint) { try { const u = new URL(c.s3.endpoint); if (!/^https?:$/.test(u.protocol)) throw new Error(); c.s3.endpoint = `${u.protocol}//${u.host}`; } catch { throw new Error('Адрес S3 — URL вида https://s3.example.com'); } }
      if (c.s3.prefix && (c.s3.prefix.includes('..') || c.s3.prefix.startsWith('/'))) throw new Error('Папка в бакете: без «..» и ведущего «/»');
      if (c.s3.prefix && !c.s3.prefix.endsWith('/')) c.s3.prefix += '/';
    }
    if (b.data) {
      const x = b.data;
      if (x.mode !== undefined) { if (!['none', 'all', 'selected'].includes(x.mode)) throw new Error('Данные: none, all или selected'); c.data.mode = x.mode; }
      if (x.keys !== undefined) { if (!Array.isArray(x.keys) || x.keys.some((k) => !/^\d+\|[a-z0-9_-]+\|[a-z0-9_-]+$/.test(String(k)))) throw new Error('Список сервисов для копирования некорректен'); c.data.keys = [...new Set(x.keys)]; }
      if (x.dest !== undefined) { if (!['host', 's3'].includes(x.dest)) throw new Error('Куда сохранять данные: host или s3'); c.data.dest = x.dest; }
      if (x.dir !== undefined) { if (!validDir(x.dir)) throw new Error('Папка на сервере: абсолютный путь без «..»'); c.data.dir = x.dir.replace(/\/$/, ''); }
      if (x.keep !== undefined) { if (!Number.isInteger(x.keep) || x.keep < 1 || x.keep > 30) throw new Error('Сколько копий данных хранить: от 1 до 30'); c.data.keep = x.keep; }
      if (x.consistency !== undefined) { if (!CONSISTENCY.includes(x.consistency)) throw new Error('Согласованность томов: none, pause или stop'); c.data.consistency = x.consistency; }
      if (x.minFreeMb !== undefined) { if (!Number.isInteger(x.minFreeMb) || x.minFreeMb < 0 || x.minFreeMb > 1_000_000) throw new Error('Минимум свободного места: МБ'); c.data.minFreeMb = x.minFreeMb; }
      if (c.data.mode === 'selected' && !c.data.keys.length) throw new Error('Отметьте хотя бы один сервис для копирования данных');
      if (c.data.dest === 's3' && c.data.mode !== 'none' && !(c.s3.endpoint && c.s3.bucket && c.s3.accessKey && c.s3.secretKey)) throw new Error('Для данных в S3 заполните данные хранилища S3');
    }
    if (c.panels === 'selected' && !c.panelIds.length) throw new Error('Отметьте хотя бы одну панель');
    if (c.storage === 's3' && c.enabled && !(c.s3.endpoint && c.s3.bucket && c.s3.accessKey && c.s3.secretKey)) throw new Error('Заполните данные хранилища S3');
    if (b.where === 's3' && !(c.s3.endpoint && c.s3.bucket && c.s3.accessKey && c.s3.secretKey)) throw new Error('Для хранения в S3 заполните данные хранилища S3');
    if ((c.enabled || c.data.mode !== 'none') && !c.password) throw new Error('Сначала задайте пароль копий: им шифруются все копии EasyAdmin');
    save(c); return view();
  }

  const store = (c) => {
    if (c.storage === 's3') {
      const s3 = s3Client(c.s3, fetchImpl);
      return {
        put: (name, buf) => s3.put(`${c.s3.prefix}${name}`, buf),
        get: (name) => s3.get(`${c.s3.prefix}${name}`),
        del: (name) => s3.del(`${c.s3.prefix}${name}`),
        list: async () => (await s3.list(c.s3.prefix)).map((o) => ({ name: o.key.slice(c.s3.prefix.length), size: o.size, ts: o.ts })),
      };
    }
    return {
      put: async (name, buf) => { fs.mkdirSync(dir(), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(dir(), name), buf, { mode: 0o600 }); },
      get: async (name) => fs.readFileSync(path.join(dir(), name)),
      del: async (name) => fs.rmSync(path.join(dir(), name), { force: true }),
      list: async () => (fs.existsSync(dir()) ? fs.readdirSync(dir()).filter((f) => NAME_RE.test(f)).map((f) => { const s = fs.statSync(path.join(dir(), f)); return { name: f, size: s.size, ts: s.mtimeMs }; }) : []),
    };
  };
  const validName = (n) => { if (!NAME_RE.test(String(n))) throw new Error('Некорректное имя файла копии'); return n; };

  /** Снимок базы без истории нагрузки и сессий. */
  function dumpDb() {
    if (config.dataDir === ':memory:') throw new Error('Копия недоступна для базы в памяти');
    const tmp = path.join(os.tmpdir(), `ea-dump-${crypto.randomBytes(6).toString('hex')}.db`);
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const d = new DatabaseSync(tmp);
      try { d.exec('DELETE FROM svc_metrics; DELETE FROM stats_history; DELETE FROM sessions; VACUUM;'); } finally { d.close(); }
      return fs.readFileSync(tmp);
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  /** Конфигурация панели: проекты и сервисы с полным описанием (env, источник, домены, порты, тома). Недоступные места записываются в errors. */
  async function collectPanelConfig(row) {
    const out = { id: row.id, name: row.name, url: row.url, at: now(), projects: [], errors: [] };
    try {
      const client = manager.clientFor(row);
      const tree = normalizeTree(await client.query('projects.listProjectsAndServices'));
      for (const pr of tree.projects) {
        const services = [];
        for (const sv of pr.services) {
          try { services.push({ type: sv.type, name: sv.name, ...(await inspectService(client, { type: sv.type, project: pr.name, name: sv.name })) }); }
          catch (e) { out.errors.push(`${pr.name}/${sv.name}: ${e.message}`); }
        }
        out.projects.push({ name: pr.name, services });
      }
    } catch (e) { out.errors.push(e.message); }
    return out;
  }
  async function collectPanels(c) {
    if (c.panels === 'none' || !manager) return [];
    const rows = db.prepare('SELECT * FROM panels ORDER BY id').all().filter((r) => c.panels === 'all' || c.panelIds.includes(r.id));
    const res = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => { while (i < rows.length) { const row = rows[i++]; res.push(await collectPanelConfig(row)); } }));
    return res.sort((a, b) => a.id - b.id);
  }
  const summarize = (panels) => panels.map((p) => ({ id: p.id, name: p.name, url: p.url, projects: p.projects.length, services: p.projects.reduce((n, x) => n + x.services.length, 0), errors: p.errors }));

  async function prune(c, st) {
    const files = (await st.list()).filter((f) => NAME_RE.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
    for (const f of files.slice(c.keep)) await st.del(f.name);
  }

  async function run({ reason = 'manual' } = {}) {
    if (busy) throw new Error('Копия уже создаётся');
    const c = load();
    if (!c.password) throw new Error('Задайте пароль копий (Бэкапы → Настройки): им шифруются все копии EasyAdmin');
    if (!c.system && c.panels === 'none') throw new Error('Копирование настроек EasyAdmin выключено');
    busy = true;
    const t = now();
    try {
      const name = `easyadmin-${stamp(t)}.eabak`;
      const panels = await collectPanels(c);
      const buf = sealBackup({ dbBytes: c.system ? dumpDb() : null, appKey: key, password: c.password, createdAt: t, panels });
      const st = store(c);
      await st.put(name, buf);
      await prune(c, st);
      const res = { ts: t, ok: true, name, size: buf.length, storage: c.storage, reason, system: c.system, panels: summarize(panels).map((p) => ({ name: p.name, services: p.services, errors: p.errors.length })) };
      setRaw('backup_last', JSON.stringify(res)); return res;
    } catch (e) {
      const res = { ts: t, ok: false, error: e.message, storage: c.storage, reason };
      setRaw('backup_last', JSON.stringify(res));
      alerts?.emit({ type: 'backup_failed', icon: '💾', text: `Не удалось создать резервную копию EasyAdmin: ${e.message}` }).catch?.(() => {});
      throw e;
    } finally { busy = false; }
  }

  const list = async () => { const c = load(); return (await store(c).list()).filter((f) => NAME_RE.test(f.name)).sort((a, b) => b.name.localeCompare(a.name)); };
  const download = async (name) => store(load()).get(validName(name));
  const remove = async (name) => { await store(load()).del(validName(name)); };
  const passwordOr = (p) => { const pw = p || load().password; if (!pw) throw new Error('Укажите пароль копии'); return pw; };

  async function verify(name, password) {
    const opened = openBackup(await download(name), passwordOr(password));
    const { panels: dbPanels, ...counts } = opened.db ? inspectDb(opened.db) : {};
    return { createdAt: opened.createdAt, hasSystem: !!opened.db, dbPanels, ...counts, hasKey: !!opened.key, keyMatches: opened.key ? opened.key.equals(key) : null, size: opened.db?.length ?? 0, panels: summarize(opened.panels) };
  }
  /** Готовит восстановление и перезапускает сервис; база подменяется при старте. */
  async function restore(name, password) {
    const opened = openBackup(await download(name), passwordOr(password));
    if (!opened.db) throw new Error('В этой копии нет системы EasyAdmin — только конфигурации панелей');
    inspectDb(opened.db);
    const pend = path.join(config.dataDir, 'restore-pending');
    fs.rmSync(pend, { recursive: true, force: true }); fs.mkdirSync(pend, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(pend, 'easyadmin.db'), opened.db, { mode: 0o600 });
    const keyFile = !config.secret && opened.key && !opened.key.equals(key);
    if (keyFile) fs.writeFileSync(path.join(pend, 'secret.key'), opened.key.toString('hex'), { mode: 0o600 });
    const warn = config.secret && opened.key && !opened.key.equals(key) ? 'Ключ шифрования в копии отличается от EASYADMIN_SECRET: токены панелей не расшифруются, пока не вернёте прежнее значение EASYADMIN_SECRET.' : null;
    setTimeout(restart, 700).unref?.();
    return { restarting: true, keyReplaced: !!keyFile, warn };
  }

  /* ---------- данные баз и томов ---------- */
  const hostFn = (c, row, script, o) => (hostRun ?? runOnHost)(c, row, script, o);
  const panelsInScope = (c) => db.prepare('SELECT * FROM panels ORDER BY id').all().filter((r) => c.data.mode === 'all' || c.data.keys.some((k) => k.startsWith(`${r.id}|`)));
  const s3Of = (c) => s3Client(c.s3, fetchImpl);

  /* ---- служебное состояние копирования данных (всё, что нужно пережить перезапуск EasyAdmin) ---- */
  const readJson = (k, d) => { try { return JSON.parse(getRaw(k) ?? 'null') ?? d; } catch { return d; } };
  const pendingRuns = () => readJson('backup_data_pending', {});
  const setPending = (m) => setRaw('backup_data_pending', JSON.stringify(m));
  /** Результат одного сервиса сразу по готовности: переживает перезапуск, обзор видит его не дожидаясь конца запуска. */
  const recordItem = (panelId, label, rec) => { const m = svcResults(); m[`${panelId}|${label.replace('/', '|')}`] = rec; setRaw('backup_data_svc', JSON.stringify(m)); };
  const LOG_MAX = 30;
  const dataLog = () => readJson('backup_data_log', []);
  const pushLog = (entry) => setRaw('backup_data_log', JSON.stringify([entry, ...dataLog()].slice(0, LOG_MAX)));

  /** Ротация в S3: у каждого сервиса остаются keepN последних архивов (список читается постранично). */
  async function rotateS3(c, row, keepN) {
    const s3 = s3Of(c); const all = (await s3.list(`${c.s3.prefix}data/${slugOf(row)}/`)).map((o) => ({ name: o.key.split('/').pop(), key: o.key }));
    const groups = new Map(); for (const f of all) { const g = groupKey(f.name); groups.set(g, [...(groups.get(g) ?? []), f]); }
    let n = 0; for (const list of groups.values()) for (const f of list.sort((a, b) => b.name.localeCompare(a.name)).slice(keepN)) { await s3.del(f.key); n++; }
    return n;
  }

  /** Следит за запущенным на сервере скриптом: обновляет ход, записывает результаты по мере готовности, в конце убирает за собой и делает ротацию. */
  async function followRun({ c, row, runId, labels, state, opened = [], startedAt = now() }) {
    const client = manager.clientFor(row); const done = new Set(); const t0 = now(); let st = { items: [], done: false, started: false };
    for (let polls = 0; !st.done; polls++) {
      await new Promise((r) => setTimeout(r, dataPollMs));
      try { st = await readStatus(client, row, c.data.dir, runId, hostFn); } catch { /* консоль может отвечать с задержкой — пробуем ещё */ }
      state.items = labels.map((label) => {
        const r = st.items.find((x) => x.label === label); const note = (st.warns ?? []).filter((w) => w.label === label).map((w) => w.text).join('; ');
        if (r && !done.has(label)) { done.add(label); recordItem(row.id, label, r.ok ? { ts: now(), ok: true, size: r.size ?? null, name: r.name ?? null, ...(note ? { note } : {}) } : { ts: now(), ok: false, error: r.error ?? 'ошибка' }); }
        const running = !r && st.current?.label === label;
        return { label, status: r ? (r.ok ? 'ok' : 'fail') : running ? 'run' : 'wait', ...(running ? { part: st.current.part } : {}), file: r?.name, size: r?.size, error: r?.error, ...(note ? { note } : {}) };
      });
      if (!st.started && now() - t0 > 180_000) throw new Error('Скрипт на сервере не стартовал');
      if (now() - startedAt > 6 * 3600e3) throw new Error('Копирование идёт слишком долго (больше 6 часов)');
    }
    cleanupJob(client, row, c.data.dir, runId, hostFn);
    const s3 = c.data.dest === 's3' ? s3Of(c) : null;
    for (const o of opened) if (!st.items.some((x) => x.ok && x.label === o.label.replace(/\|/g, '/'))) await s3.abortMultipart(o.key, o.uploadId).catch(() => {});
    const general = st.items.find((x) => !x.ok && x.label === '*');
    if (general) throw new Error(general.error);
    if (s3) { try { await rotateS3(c, row, c.data.keep); } catch (e) { state.note = `Ротация в S3 не выполнена: ${e.message}`; } }
    state.status = state.items.some((x) => x.status === 'fail') ? 'partial' : 'done';
  }

  async function runDataPanel(c, row, stamp, state) {
    const client = manager.clientFor(row); const projects = (await manager.snapshot(row.id))?.tree?.projects ?? [];
    const compose = needsDiscovery(projects, c.data, row.id) ? parseDiscovery((await hostFn(client, row, DISCOVER_CMD, { timeoutMs: 60_000 }).catch(() => ({ output: '' }))).output) : [];
    const targets = await resolveTargets(client, row, projects, c.data, stamp, { compose, encrypt: !!c.password }); state.empty = targets.empty ?? [];
    const items = targets.map((it) => ({ ...it }));
    if (!items.length) { state.status = 'done'; state.note = 'Нет баз и томов для копирования'; return; }
    const s3 = c.data.dest === 's3' ? s3Of(c) : null; const keyOf = (it) => `${c.s3.prefix}data/${it.slug}/${it.file}`;
    const opened = []; // начатые загрузки частями: незавершённые отменяем
    if (s3) {
      try { const n = await rotateS3(c, row, Math.max(1, c.data.keep - 1)); if (n) state.note = `Перед копированием удалено старых архивов в S3: ${n}`; } catch (e) { state.note = `Ротация в S3 не выполнена: ${e.message}`; } // освобождаем место заранее
      const sizes = await measureVolumes(client, row, items, hostFn);
      for (const it of items) {
        it.url = s3.presign('PUT', keyOf(it), 12 * 3600);
        const bytes = jobVolumeBytes(it, sizes);
        if (bytes > mpMin) { // тома сервиса вместе больше порога: готовим загрузку архива частями
          const uploadId = await s3.createMultipart(keyOf(it)); opened.push({ key: keyOf(it), uploadId, label: it.label });
          const n = Math.min(100, Math.ceil(bytes / (partMb * 1048576)) + 2);
          it.mp = { complete: s3.presign('POST', keyOf(it), 12 * 3600, { uploadId }), abort: s3.presign('DELETE', keyOf(it), 12 * 3600, { uploadId }), parts: Array.from({ length: n }, (_, i) => s3.presign('PUT', keyOf(it), 12 * 3600, { partNumber: String(i + 1), uploadId })) };
        }
      }
    }
    const labels = items.map((it) => it.label.replace(/\|/g, '/'));
    state.items = labels.map((label) => ({ label, status: 'wait' }));
    const runId = `r${stamp}-${row.id}`;
    const script = buildScript({ runId, baseDir: c.data.dir, dest: c.data.dest, keep: c.data.keep, minFreeKb: c.data.minFreeMb * 1024, items, consistency: c.data.consistency, mpMin, partMb, password: c.password, selfId: process.env.HOSTNAME });
    state.status = 'running';
    try { await deployJob(client, row, { baseDir: c.data.dir, runId, script }, hostFn); }
    catch (e) { for (const o of opened) await s3.abortMultipart(o.key, o.uploadId).catch(() => {}); throw e; }
    // запуск записан: если EasyAdmin перезапустится до конца копирования, он подхватит этот запуск (resumeRuns)
    const pend = pendingRuns(); pend[runId] = { panelId: row.id, labels, startedAt: now(), reason: dataState.reason, dest: c.data.dest, dir: c.data.dir, keep: c.data.keep, empty: state.empty }; setPending(pend);
    try { await followRun({ c, row, runId, labels, state, opened, startedAt: now() }); }
    finally { const p2 = pendingRuns(); delete p2[runId]; setPending(p2); }
  }

  /**
   * Итог запуска — в журнал действий: по строке на каждый сервис (так копии видны и во вкладке «История» сервиса) и общая сводка.
   * Автор — тот, кто запустил копирование, а у расписания — «расписание».
   */
  function journalRun({ reason, panels, failed, okCount, dest, only }) {
    const user = { username: dataState.by ?? (reason === 'schedule' ? 'расписание' : reason === 'resume' ? 'EasyAdmin' : null) };
    const mb = (n) => (n ? `${Math.round((n / 1048576) * 10) / 10} МБ` : '');
    try {
      for (const [id, p] of Object.entries(dataState.panels)) {
        const panel = { id: Number(id), name: p.name };
        if (p.error && !(p.items ?? []).length) audit?.({ user }, { action: 'backup.panel_failed', panel, target: p.name, ok: false, detail: p.error });
        for (const x of p.items ?? []) {
          if (x.status !== 'ok' && x.status !== 'fail') continue;
          audit?.({ user }, { action: 'backup.service', panel, target: x.label, ok: x.status === 'ok', detail: x.status === 'ok' ? [mb(x.size), dest === 's3' ? 'S3' : 'на сервере', x.note].filter(Boolean).join(' · ') : x.error });
        }
      }
      if (!only) audit?.({ user }, { action: 'backup.data_done', target: 'данные баз и томов', ok: failed === 0, detail: [`Скопировано сервисов: ${okCount}`, failed ? `ошибок: ${failed}` : null, dest === 's3' ? 'S3' : 'на сервере'].filter(Boolean).join(' · ') });
    } catch { /* журнал не должен ломать завершение копирования */ }
  }

  /** Итог запуска: сводка, журнал, уведомление об ошибках. */
  function finishData({ t, reason, only, dest }) {
    const panels = Object.values(dataState.panels);
    const failed = panels.reduce((n, p) => n + (p.error ? 1 : 0) + (p.items ?? []).filter((x) => x.status === 'fail').length, 0);
    const okCount = panels.reduce((n, p) => n + (p.items ?? []).filter((x) => x.status === 'ok').length, 0);
    const res = { ts: t, ok: failed === 0, files: okCount, failed, dest, reason, panels: panels.map((p) => ({ name: p.name, status: p.status, error: p.error ?? null, failed: (p.items ?? []).filter((x) => x.status === 'fail').map((x) => `${x.label}: ${x.error}`) })) };
    for (const [id, p] of Object.entries(dataState.panels)) for (const label of p.empty ?? []) recordItem(id, label, { ts: t, ok: true, empty: true });
    if (!only) setRaw('backup_data_last', JSON.stringify(res)); // «последний запуск» — только полный; запуск одного сервиса его не затирает
    pushLog({ id: `${t}`, ts: t, endedAt: now(), reason, only: !!only, dest, ok: failed === 0, files: okCount, failed,
      panels: panels.map((p) => ({ name: p.name, status: p.status, error: p.error ?? null, note: p.note ?? null, items: (p.items ?? []).map((x) => ({ label: x.label, status: x.status, size: x.size ?? null, error: x.error ?? null, note: x.note ?? null, file: x.file ?? null })), empty: p.empty ?? [] })) });
    journalRun({ reason, panels, failed, okCount, dest, only });
    dataState.running = false; dataState.result = res;
    if (failed) alerts?.emit({ type: 'backup_failed', icon: '💾', text: `Копирование данных: ошибок ${failed}${res.panels.filter((p) => p.error || p.failed.length).slice(0, 2).map((p) => ` — ${p.name}: ${p.error ?? p.failed[0]}`).join('')}` }).catch?.(() => {});
    return res;
  }

  async function runData({ reason = 'manual', only = null, by = null } = {}) { // only: { panelId, project, service } — копия одного сервиса
    if (dataBusy) throw new Error('Копирование данных уже идёт');
    let c = load();
    if (only) { const k = `${Number(only.panelId)}|${only.project}|${only.service}`; if (!/^\d+\|[a-z0-9_-]+\|[a-z0-9_-]+$/.test(k)) throw new Error('Некорректный сервис'); c = { ...c, data: { ...c.data, mode: 'selected', keys: [k] } }; }
    if (!c.password) throw new Error('Задайте пароль копий (Бэкапы → Настройки): им шифруются все копии EasyAdmin');
    if (c.data.mode === 'none') throw new Error('Копирование данных выключено: отметьте сервисы, которые нужно копировать');
    if (c.data.dest === 's3' && !(c.s3.endpoint && c.s3.bucket && c.s3.accessKey && c.s3.secretKey)) throw new Error('Заполните данные хранилища S3');
    if (!manager) throw new Error('Менеджер панелей недоступен');
    const rows = panelsInScope(c); if (!rows.length) throw new Error('Нет панелей для копирования данных');
    dataBusy = true; const t = now(); const stamp = stampOf(t);
    setRaw('backup_data_attempt', String(t)); // попытка записана сразу: если EasyAdmin упадёт или перезапустится, расписание не запустит копирование заново в тот же день
    dataState = { running: true, startedAt: t, reason, by, only: !!only, dest: c.data.dest, panels: Object.fromEntries(rows.map((r) => [r.id, { name: r.name, status: 'wait', items: [] }])) };
    const run = (async () => {
      let idx = 0;
      await Promise.all(Array.from({ length: Math.min(2, rows.length) }, async () => {
        while (idx < rows.length) {
          const row = rows[idx++]; const st = dataState.panels[row.id]; st.status = 'prepare';
          try { await runDataPanel(c, row, stamp, st); } catch (e) { st.status = 'error'; st.error = e.message; }
        }
      }));
      finishData({ t, reason, only, dest: c.data.dest });
    })().catch((e) => { dataState.running = false; dataState.error = e.message; }).finally(() => { dataBusy = false; });
    return { started: true, panels: rows.length, wait: run };
  }

  /** После перезапуска EasyAdmin: запуски, которые шли на серверах панелей, дослеживаются до конца (результаты, уборка, ротация). */
  async function resumeRuns() {
    const pend = pendingRuns(); const ids = Object.keys(pend);
    if (!ids.length || dataBusy || !manager) return 0;
    dataBusy = true; const c = load(); const t = Math.min(...ids.map((i) => pend[i].startedAt));
    dataState = { running: true, startedAt: t, reason: 'resume', only: false, dest: c.data.dest, panels: {} };
    (async () => {
      await Promise.all(ids.map(async (runId) => {
        const p = pend[runId]; const row = db.prepare('SELECT * FROM panels WHERE id = ?').get(p.panelId);
        const st = dataState.panels[p.panelId] = { name: row?.name ?? `#${p.panelId}`, status: 'running', items: p.labels.map((label) => ({ label, status: 'wait' })), empty: p.empty ?? [] };
        try { if (!row) throw new Error('Панель удалена'); await followRun({ c: { ...c, data: { ...c.data, dest: p.dest, dir: p.dir, keep: p.keep } }, row, runId, labels: p.labels, state: st, startedAt: p.startedAt }); }
        catch (e) { st.status = 'error'; st.error = e.message; }
        const p2 = pendingRuns(); delete p2[runId]; setPending(p2);
      }));
      finishData({ t, reason: 'resume', only: false, dest: c.data.dest });
    })().catch((e) => { dataState.running = false; dataState.error = e.message; }).finally(() => { dataBusy = false; });
    return ids.length;
  }
  const dataStatus = () => ({ ...dataState, panels: Object.entries(dataState.panels).map(([id, p]) => ({ id: Number(id), ...p })) });

  async function listData({ panelId = null, project = null, service = null } = {}) {
    const c = load(); const out = [];
    const prefix = project && service ? `${project}__${service}__` : null;
    if (c.data.dest === 's3') {
      const s3 = s3Of(c);
      const files = await s3.list(`${c.s3.prefix}data/`);
      for (const rowDb of db.prepare('SELECT * FROM panels').all().filter((r) => !panelId || r.id === Number(panelId))) {
        const slug = slugOf(rowDb);
        for (const o of files.filter((f) => f.key.startsWith(`${c.s3.prefix}data/${slug}/`))) out.push({ panelId: rowDb.id, panel: rowDb.name, name: o.key.split('/').pop(), size: o.size, ts: o.ts });
      }
    } else {
      for (const row of (panelId ? db.prepare('SELECT * FROM panels WHERE id = ?').all(Number(panelId)) : panelsInScope(c))) {
        try { for (const f of await listHostFiles(manager.clientFor(row), row, c.data.dir, slugOf(row), hostFn)) out.push({ panelId: row.id, panel: row.name, ...f }); }
        catch (e) { out.push({ panelId: row.id, panel: row.name, error: e.message }); }
      }
    }
    return out.filter((f) => f.error || !prefix || f.name.startsWith(prefix)).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  }
  function dataHint(panelId, name) {
    const c = load(); const row = db.prepare('SELECT * FROM panels WHERE id = ?').get(Number(panelId)); if (!row) throw new Error('Панель не найдена');
    const where = c.data.dest === 's3' ? { url: s3Of(c).presign('GET', `${c.s3.prefix}data/${slugOf(row)}/${name}`, 3600) } : { dir: `${c.data.dir}/${slugOf(row)}` };
    return { ...restoreHint(name, where), encrypted: name.endsWith('.enc') };
  }

  const restorer = createRestorer({ load, getRaw, setRaw, manager, hostFn, s3Of, now, audit, pollMs: Math.min(dataPollMs, 3000), busy: () => dataBusy });

  const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  async function tick(ts = now()) {
    const c = load(); if (!c.enabled || !c.password || busy || (!c.system && c.panels === 'none')) return null;
    const l = lastRun();
    if (l && ts - l.ts < 3600e3 && !l.ok) return null; // после ошибки пробуем не чаще раза в час
    const lastOk = l?.ok ? l.ts : 0;
    const due = !lastOk || (c.every === 'weekly' ? ts - lastOk >= 6.5 * DAY : dayKey(ts) !== dayKey(lastOk));
    if (!due || new Date(ts).getHours() < c.hour) return null;
    try { return await run({ reason: 'schedule' }); } catch { return null; }
  }
  async function tickData(ts = now()) {
    const c = load(); if (c.data.mode === 'none' || !c.password || dataBusy) return null;
    const l = lastData(); if (l && !l.ok && ts - l.ts < 3600e3) return null;
    const lastOk = l?.ok ? l.ts : 0; const attempt = Number(getRaw('backup_data_attempt') ?? 0); const last = Math.max(lastOk, attempt); // незавершённая попытка тоже считается: иначе при сбое копирование шло бы по кругу
    const due = !last || (c.every === 'weekly' ? ts - last >= 6.5 * DAY : dayKey(ts) !== dayKey(last));
    if (!due || !c.enabled || new Date(ts).getHours() < c.hour) return null;
    try { return await runData({ reason: 'schedule' }); } catch { return null; }
  }
  /** Сервис переименован или перенесён: охват копий данных и накопленные результаты следуют за ним. */
  function repoint(panelId, from, to) {
    const c = load(); const a = `${panelId}|${from.project}|${from.name}`; const b = `${panelId}|${to.project}|${to.name}`;
    if (c.data.keys.includes(a)) { c.data.keys = [...new Set(c.data.keys.map((k) => (k === a ? b : k)))]; save(c); }
    const svc = svcResults(); if (svc[a]) { svc[b] = svc[a]; delete svc[a]; setRaw('backup_data_svc', JSON.stringify(svc)); }
  }

  const start = () => { setTimeout(() => { resumeRuns().catch(() => {}); restorer.resume(); }, 15_000).unref?.(); timer = setInterval(() => { tick().catch(() => {}); tickData().catch(() => {}); }, 60_000); timer.unref(); };
  const stop = () => clearInterval(timer);

  /** Конфигурация одной панели из копии (для скачивания и восстановления сервисов). */
  async function panelFromBackup(name, password, panelId) {
    const opened = openBackup(await download(name), passwordOr(password));
    const p = opened.panels.find((x) => x.id === Number(panelId));
    if (!p) throw new Error('Этой панели нет в копии');
    return p;
  }
  return { view, update, run, panelFromBackup, restorer, runData, dataStatus, listData, dataHint, tickData, repoint, svcResults, lastData, dataLog, resumeRuns, rotateS3, list, download, remove, verify, restore, tick, start, stop, load };
}

export function backupRoutes(d) {
  const { backups, audit, need, manager, panelOr404, asHttp, treeOf } = d;
  const w = (fn) => async (ctx) => { try { return await fn(ctx); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); } };
  const name = (ctx) => ctx.url.searchParams.get('name');
  return [
    ['GET', '/api/backups', w(async () => {
      const settings = backups.view(); let files = []; let filesError = null;
      try { files = await backups.list(); } catch (e) { filesError = e.message; }
      return { settings, files, filesError };
    }), { admin: true }],
    ['PUT', '/api/backups/settings', w((ctx) => { const r = backups.update(ctx.body ?? {}); audit(ctx, { action: 'backup.settings', target: 'резервные копии', detail: JSON.stringify({ enabled: r.enabled, system: r.system, panels: r.panels, every: r.every, storage: r.storage, keep: r.keep }) }); return r; }), { admin: true }],
    ['POST', '/api/backups/run', w(async (ctx) => {
      try { const r = await backups.run({ reason: 'manual' }); audit(ctx, { action: 'backup.run', target: r.name, detail: `${r.size} байт` }); return r; }
      catch (e) { audit(ctx, { action: 'backup.run', target: 'резервная копия', ok: false, detail: e.message }); throw e; }
    }), { admin: true }],
    ['POST', '/api/backups/data/run', w(async (ctx) => {
      const b = ctx.body ?? {}; const only = b.project ? { panelId: b.panelId, project: b.project, service: b.service } : null;
      const r = await backups.runData({ reason: 'manual', only, by: ctx.user?.username }); r.wait.catch(() => {});
      const prow = only ? manager.getRow(Number(only.panelId)) : null; // у запуска одного сервиса есть панель и объект: событие попадает в «Историю» сервиса
      audit(ctx, { action: 'backup.data_run', panel: prow ?? undefined, target: only ? `${only.project}/${only.service}` : 'данные баз и томов', detail: only ? null : `панелей: ${r.panels}` }); return { started: true, panels: r.panels };
    }), { admin: true }],
    ['GET', '/api/backups/data/status', w(() => backups.dataStatus()), { admin: true }],
    ['GET', '/api/backups/data/log', w(() => ({ runs: backups.dataLog() })), { admin: true }],
    ['GET', '/api/backups/data/files', w(async (ctx) => { const q = ctx.url.searchParams; return { files: await backups.listData({ panelId: q.get('panel'), project: q.get('project'), service: q.get('service') }) }; }), { admin: true }],
    // восстановление данных баз и томов: просмотр архива → сопоставление с целью → запуск → ход (задание опрашивается)
    ['POST', '/api/backups/data/inspect', w((ctx) => backups.restorer.inspect({ panelId: ctx.body?.panelId, name: String(ctx.body?.name ?? ''), password: ctx.body?.password })), { admin: true }],
    ['GET', '/api/backups/data/job', w((ctx) => backups.restorer.get(ctx.url.searchParams.get('id')) ?? (() => { throw new HttpError(404, 'Задание не найдено'); })()), { admin: true }],
    ['GET', '/api/backups/data/restores', w(() => ({ jobs: backups.restorer.history() })), { admin: true }],
    ['POST', '/api/backups/data/restore-plan', w((ctx) => backups.restorer.plan({ panelId: ctx.body?.panelId, name: String(ctx.body?.name ?? ''), members: ctx.body?.members ?? [], target: ctx.body?.target })), { admin: true }],
    ['POST', '/api/backups/data/restore', w(async (ctx) => {
      const b = ctx.body ?? {}; need(b.confirm === true, 'Подтвердите восстановление');
      const label = `${b.target?.create ? `${b.target.create.project}/${b.target.create.service ?? b.target.create.name}` : `${b.target?.project ?? ''}/${b.target?.service ?? ''}`}`;
      try {
        const r = await backups.restorer.start({ panelId: b.panelId, name: String(b.name ?? ''), password: b.password, target: b.target, members: b.members, mode: b.mode, snapshot: b.snapshot, by: ctx.user?.username });
        audit(ctx, { action: 'backup.restore_data', panel: manager.getRow(Number(b.target?.panelId ?? b.panelId)) ?? undefined, target: r.target, detail: `${b.name} · ${b.mode === 'merge' ? 'поверх имеющегося' : 'с заменой'}${b.snapshot === false ? ' · без страховочной копии' : ''}` }); return r;
      } catch (e) { audit(ctx, { action: 'backup.restore_data', target: label, ok: false, detail: e.message }); throw e; }
    }), { admin: true }],
    ['POST', '/api/backups/data/hint', w((ctx) => backups.dataHint(ctx.body?.panelId, String(ctx.body?.name ?? ''))), { admin: true }],
    ['GET', '/api/backups/download', w(async (ctx) => {
      const n = name(ctx); const buf = await backups.download(n); audit(ctx, { action: 'backup.download', target: n });
      return new RawResponse(buf, 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${n}"` });
    }), { admin: true }],
    ['DELETE', '/api/backups', w(async (ctx) => { const n = name(ctx); await backups.remove(n); audit(ctx, { action: 'backup.delete', target: n }); return { ok: true }; }), { admin: true }],
    ['POST', '/api/backups/verify', w((ctx) => backups.verify(ctx.body?.name, ctx.body?.password)), { admin: true }],
    ['POST', '/api/backups/restore', w(async (ctx) => {
      need(ctx.body?.confirm === true, 'Подтвердите восстановление');
      const r = await backups.restore(ctx.body.name, ctx.body.password);
      audit(ctx, { action: 'backup.restore', target: ctx.body.name, detail: 'система EasyAdmin' }); return r;
    }), { admin: true }],
    ['POST', '/api/backups/panel-config', w(async (ctx) => {
      const p = await backups.panelFromBackup(ctx.body?.name, ctx.body?.password, ctx.body?.panel);
      audit(ctx, { action: 'backup.panel_config', target: p.name, detail: ctx.body.name });
      return p;
    }), { admin: true }],
    // вернуть один сервис из копии на панель: создаётся новый сервис (env, источник, ресурсы); домены, порты и тома — вручную из конфигурации
    ['POST', '/api/backups/restore-service', w(async (ctx) => {
      const b = ctx.body ?? {};
      const p = await backups.panelFromBackup(b.name, b.password, b.panel);
      const pr = p.projects.find((x) => x.name === b.project); const sv = pr?.services.find((x) => x.name === b.service);
      need(sv, 'Этого сервиса нет в копии');
      const row = panelOr404(b.targetPanelId); const project = String(b.targetProject || b.project); const svcName = String(b.targetName || b.service);
      for (const [v, l] of [[project, 'проекта'], [svcName, 'сервиса']]) need(/^[a-z0-9-_]+$/.test(v), `Имя ${l}: латиница нижнего регистра, цифры, - и _`);
      const existing = await treeOf(row).catch((e) => { throw asHttp(e); });
      need(!existing.some((x) => x.name === project && x.services.some((y) => y.name === svcName)), `В проекте ${project} уже есть сервис ${svcName} — укажите другое имя`);
      const steps = await applyConfig(manager.clientFor(row), { project, name: svcName }, configFromService(sv.type, sv.service), { existingProjects: existing.map((x) => x.name) });
      manager.invalidate(row.id);
      const ok = steps.every((s) => s.ok);
      audit(ctx, { action: 'backup.restore_service', panel: row, target: `${project}/${svcName}`, ok, detail: steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.error}`).join('; ').slice(0, 200) || 'из копии' });
      return { ok, steps };
    }), { admin: true }],
  ];
}
