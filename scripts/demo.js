// Демо: несколько имитаций Easypanel + EasyAdmin с готовыми данными. Логин: admin / demo12345
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import http from 'node:http';
import { createMockPanel } from '../test/mock-easypanel.js';
import { FILES as CATALOG_FILES } from '../test/catalog-fixtures.js';

const soon = (d) => new Date(Date.now() + d * 86400000).toISOString();
const seeds = [
  ['Прод · EU', { shop: [{ name: 'web', image: 'ghcr.io/acme/shop:1.8.2', env: 'NODE_ENV=production\nDATABASE_URL=postgres://x' }, { name: 'api', image: 'ghcr.io/acme/api:2.4.0' }, { name: 'worker', enabled: false }, { name: 'db', type: 'postgres' }, { name: 'cache', type: 'redis' }], blog: [{ name: 'wordpress' }, { name: 'mysql', type: 'mysql' }] }, { cpu: 34, mem: 58, disk: 41 }],
  ['Прод · US', { crm: [{ name: 'app', image: 'ghcr.io/acme/crm:3.1' }, { name: 'db', type: 'mariadb' }], analytics: [{ name: 'metabase' }, { name: 'pg', type: 'postgres' }] }, { cpu: 72, mem: 81, disk: 66 }],
  ['Стейджинг', { shop: [{ name: 'web', image: 'ghcr.io/acme/shop:1.9.0-rc1' }, { name: 'api', enabled: false, image: 'ghcr.io/acme/api:2.5.0-rc' }, { name: 'mongo', type: 'mongo' }] }, { cpu: 12, mem: 30, disk: 22 }],
  ['Клиент Acme', { acme: [{ name: 'site', crash: true }, { name: 'stack', type: 'compose' }] }, { cpu: 91, mem: 88, disk: 93 }],
];
const port = Number(process.env.PORT || 3100);
const panels = [];
for (const [name, seed, stats] of seeds) {
  const m = createMockPanel({ token: 'demo-' + name.length, seed, stats, certs: [{ domain: `${name.length}.shop.example.com`, expiresAt: soon(name.length * 7) }, { domain: 'www.example.com', expiresAt: soon(name.length % 2 ? 4 : 75) }] });
  panels.push({ name, m, url: await m.listen() });
}
// демо-каталог шаблонов Easypanel из нескольких образцов — чтобы вкладка «Каталог» работала без интернета
const catalogSrv = http.createServer((req, res) => { const body = CATALOG_FILES[decodeURIComponent(req.url.slice(1))]; if (body === undefined) { res.writeHead(404); return res.end(); } res.writeHead(200); res.end(body); });
await new Promise((r) => catalogSrv.listen(0, '127.0.0.1', r));
const config = { ...loadConfig({ EASYADMIN_CATALOG_URL: process.env.EASYADMIN_CATALOG_URL || `http://127.0.0.1:${catalogSrv.address().port}` }), dataDir: ':memory:', port };
const db = openDb(':memory:');
const app = createApp({ config, db, key: crypto.randomBytes(32) });
await new Promise((r) => app.server.listen(port, '0.0.0.0', r));
app.start();

const base = `http://127.0.0.1:${port}`;
let cookie = '';
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', Cookie: cookie }, body: JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return res.json();
};
await call('POST', '/api/setup', { username: 'admin', password: 'demo12345' });
const colors = ['#7c83ff', '#22c55e', '#f59e0b', '#ec4899'];
for (const [i, p] of panels.entries()) await call('POST', '/api/panels', { name: p.name, url: p.url, token: p.m.token, color: colors[i], tags: i < 2 ? 'prod' : 'test' });
await call('POST', '/api/panels', { name: 'Старый сервер', url: 'http://127.0.0.1:1', token: 'x', color: '#64748b', tags: 'legacy' });
// синтетическая история нагрузки за сутки, чтобы графики не были пустыми
for (const { id } of db.prepare('SELECT id FROM panels').all()) {
  const ins = db.prepare('INSERT INTO stats_history (panel_id, ts, cpu, mem, disk) VALUES (?,?,?,?,?)');
  for (let i = 288; i >= 1; i--) ins.run(id, Date.now() - i * 300_000, 30 + 25 * Math.sin(i / 20 + id) + Math.random() * 8, 55 + 10 * Math.sin(i / 50) + Math.random() * 3, 40 + (288 - i) / 30);
}
console.log(`Демо запущено: ${base}  (логин admin / пароль demo12345)`);
