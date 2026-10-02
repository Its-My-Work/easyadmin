// Демо: несколько имитаций Easypanel + EasyAdmin с готовыми данными. Логин: admin / demo12345
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import http from 'node:http';
import { createMockPanel } from '../test/mock-easypanel.js';
import { FILES as CATALOG_FILES } from '../test/catalog-fixtures.js';

// DEMO_NAMES=en — английские названия панелей (для скриншотов в README); DEMO_BACKUPS=1 — заполненный раздел «Бэкапы»
const EN_NAMES = { 'Прод · EU': 'Prod · EU', 'Прод · US': 'Prod · US', 'Стейджинг': 'Staging', 'Клиент Acme': 'Acme client', 'Старый сервер': 'Old server' };
const shown = (n) => (process.env.DEMO_NAMES === 'en' ? EN_NAMES[n] ?? n : n);
const soon = (d) => new Date(Date.now() + d * 86400000).toISOString();
const seeds = [
  ['Прод · EU', { shop: [{ name: 'web', image: 'ghcr.io/acme/shop:1.8.2', env: 'NODE_ENV=production\nDATABASE_URL=postgres://x' }, { name: 'api', image: 'ghcr.io/acme/api:2.4.0' }, { name: 'worker', enabled: false }, { name: 'db', type: 'postgres' }, { name: 'cache', type: 'redis' }], blog: [{ name: 'wordpress' }, { name: 'mysql', type: 'mysql' }] }, { cpu: 34, mem: 58, disk: 41 }],
  ['Прод · US', { crm: [{ name: 'app', image: 'ghcr.io/acme/crm:3.1' }, { name: 'db', type: 'mariadb' }], analytics: [{ name: 'metabase' }, { name: 'pg', type: 'postgres' }] }, { cpu: 72, mem: 81, disk: 66 }],
  ['Стейджинг', { shop: [{ name: 'web', image: 'ghcr.io/acme/shop:1.9.0-rc1' }, { name: 'api', enabled: false, image: 'ghcr.io/acme/api:2.5.0-rc' }, { name: 'mongo', type: 'mongo' }] }, { cpu: 12, mem: 30, disk: 22 }],
  ['Клиент Acme', { acme: [{ name: 'site', crash: true }, { name: 'stack', type: 'compose', parts: ['web', 'db'] }] }, { cpu: 91, mem: 88, disk: 93 }],
];
const port = Number(process.env.PORT || 3100);
const panels = [];
for (const [name, seed, stats] of seeds) {
  const m = createMockPanel({ deployMs: Number(process.env.DEMO_DEPLOY_MS || 0), psettings: { license: name.includes('Стейджинг') ? 'free' : name.includes('Клиент') ? 'lemon' : 'full', portalAvailable: true }, consolePath: '/ws/terminal', consoleFraming: 'json-input', token: 'demo-' + name.length, seed, stats, certs: [{ domain: `${name.length}.shop.example.com`, expiresAt: soon(name.length * 7) }, { domain: 'www.example.com', expiresAt: soon(name.length % 2 ? 4 : 75) }] });
  panels.push({ name: shown(name), m, url: await m.listen() });
}
// демо-каталог шаблонов Easypanel из нескольких образцов — чтобы вкладка «Каталог» работала без интернета
const catalogSrv = http.createServer((req, res) => { const body = CATALOG_FILES[decodeURIComponent(req.url.slice(1))]; if (body === undefined) { res.writeHead(404); return res.end(); } res.writeHead(200); res.end(body); });
await new Promise((r) => catalogSrv.listen(0, '127.0.0.1', r));
const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyadmin-demo-'));
const config = { ...loadConfig({ EASYADMIN_CATALOG_URL: process.env.EASYADMIN_CATALOG_URL || `http://127.0.0.1:${catalogSrv.address().port}` }), dataDir: demoDir, port };
const db = openDb(demoDir);
const app = createApp({ config, db, key: crypto.randomBytes(32) });
await new Promise((r) => app.server.listen(port, '0.0.0.0', r));
app.start();

const base = `http://127.0.0.1:${port}`;
let cookie = '';
const call = async (method, path, body) => {
  const send = () => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', Cookie: cookie }, body: JSON.stringify(body) });
  const res = await send().catch(() => send()); // сервер закрывает простаивающее соединение — повторяем один раз
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return res.json();
};
await call('POST', '/api/setup', { username: 'admin', password: 'demo12345' });
const colors = ['#7c83ff', '#22c55e', '#f59e0b', '#ec4899'];
for (const [i, p] of panels.entries()) await call('POST', '/api/panels', { name: p.name, url: p.url, token: p.m.token, color: colors[i], tags: i < 2 ? 'prod' : 'test' });
await call('POST', '/api/panels', { name: shown('Старый сервер'), url: 'http://127.0.0.1:1', token: 'x', color: '#64748b', tags: 'legacy' });
// синтетическая история нагрузки за сутки, чтобы графики не были пустыми
for (const { id } of db.prepare('SELECT id FROM panels').all()) {
  const ins = db.prepare('INSERT INTO stats_history (panel_id, ts, cpu, mem, disk) VALUES (?,?,?,?,?)');
  for (let i = 288; i >= 1; i--) ins.run(id, Date.now() - i * 300_000, 30 + 25 * Math.sin(i / 20 + id) + Math.random() * 8, 55 + 10 * Math.sin(i / 50) + Math.random() * 3, 40 + (288 - i) / 30);
}
// история по сервисам и хосту для вкладки «Нагрузка»
{
  const ins = db.prepare('INSERT INTO svc_metrics (panel_id, ts, res, project, service, containers, cpu, cpu_max, mem, mem_max, rx, tx, cores) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const t0 = Math.floor(Date.now() / 60_000) * 60_000;
  for (const { id } of db.prepare("SELECT id FROM panels WHERE status = 'online'").all()) {
    for (let i = 360; i >= 0; i--) {
      const ts = t0 - i * 60_000; const w = 1 + Math.sin(i / 30 + id);
      const svc = [['shop', 'web', 18 * w + 4, 420], ['shop', 'db', 9 * w + 3, 780], ['blog', 'app', 5 * w + 1, 210], ['easypanel', 'traefik', 3, 60]];
      let cpu = 0, mem = 0;
      for (const [pr, sv, c, m] of svc) { cpu += c; mem += m; ins.run(id, ts, 60, pr, sv, 1, c, c * 1.2, m * 1048576, m * 1048576, 20000 * w, 9000 * w, null); }
      ins.run(id, ts, 60, '', '', 0, cpu / 2 + 6 + 4 * Math.random(), cpu / 2 + 10, (mem + 700) * 1048576, 4096 * 1048576, null, null, 2);
    }
  }
}
if (process.env.DEMO_BACKUPS) { // копии EasyAdmin: две панели в копиях, результаты прошлых запусков — в основном успешные, одна ошибка и одна давняя копия
  const keys = seeds.slice(0, 2).flatMap(([, seed], i) => Object.entries(seed).flatMap(([pr, svcs]) => svcs.map((x) => `${i + 1}|${pr}|${x.name}`)));
  await call('PUT', '/api/backups/settings', { password: 'demo-backup-pass', enabled: true, every: 'daily', hour: 3, data: { mode: 'selected', keys } });
  const ago = (h) => Date.now() - h * 3600e3; const svc = {};
  keys.forEach((k, i) => { svc[k] = { ts: ago(3 + (i % 3)), ok: true, size: (4 + i * 7) * 1048576 }; });
  svc['1|shop|cache'] = { ts: ago(4), ok: false, error: 'Мало места на диске сервера: свободно 312 МБ' };
  svc['1|blog|mysql'] = { ts: ago(12 * 24), ok: true, size: 38 * 1048576 };
  svc['1|shop|api'] = { ts: ago(4), ok: true, empty: true }; svc['1|shop|worker'] = { ts: ago(4), ok: true, empty: true }; delete svc['1|blog|wordpress'];
  db.prepare("INSERT INTO settings (k, v) VALUES ('backup_data_svc', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(svc));
  db.prepare("INSERT INTO settings (k, v) VALUES ('backup_data_last', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify({ ts: ago(4), ok: false, files: keys.length - 1, failed: 1, dest: 'host', reason: 'schedule', panels: [] }));
  try { await call('POST', '/api/backups/run', {}); } catch (e) { console.error('Демо: системная копия не создана —', e.message); }
}
console.log(`Демо запущено: ${base}  (логин admin / пароль demo12345)`);
