// Демо: несколько имитаций Easypanel + EasyAdmin с готовыми данными. Логин: admin / demo12345
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMockPanel } from '../test/mock-easypanel.js';

const seeds = [
  ['Прод · EU', { shop: [{ name: 'web' }, { name: 'api' }, { name: 'worker', enabled: false }, { name: 'db', type: 'postgres' }, { name: 'cache', type: 'redis' }], blog: [{ name: 'wordpress' }, { name: 'mysql', type: 'mysql' }] }, { cpu: 34, mem: 58, disk: 41 }],
  ['Прод · US', { crm: [{ name: 'app' }, { name: 'db', type: 'mariadb' }], analytics: [{ name: 'metabase' }, { name: 'pg', type: 'postgres' }] }, { cpu: 72, mem: 81, disk: 66 }],
  ['Стейджинг', { staging: [{ name: 'web' }, { name: 'api', enabled: false }, { name: 'mongo', type: 'mongo' }] }, { cpu: 12, mem: 30, disk: 22 }],
  ['Клиент Acme', { acme: [{ name: 'site' }, { name: 'stack', type: 'compose' }] }, { cpu: 91, mem: 88, disk: 93 }],
];
const port = Number(process.env.PORT || 3100);
const panels = [];
for (const [name, seed, stats] of seeds) {
  const m = createMockPanel({ token: 'demo-' + name.length, seed, stats });
  panels.push({ name, m, url: await m.listen() });
}
const config = { ...loadConfig({}), dataDir: ':memory:', port };
const app = createApp({ config, db: openDb(':memory:'), key: crypto.randomBytes(32) });
await new Promise((r) => app.server.listen(port, '0.0.0.0', r));
app.manager.startPolling();

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
console.log(`Демо запущено: ${base}  (логин admin / пароль demo12345)`);
