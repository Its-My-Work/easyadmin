// Проверка совместимости с реальной панелью: node scripts/probe.js https://panel.example.com API_TOKEN
// Печатает форму ответов ключевых процедур (токен не выводится).
import { PanelClient, normalizeTree } from '../src/easypanel.js';

const [url, token] = process.argv.slice(2);
if (!url || !token) { console.error('Использование: npm run probe -- <url> <token>'); process.exit(1); }
const c = new PanelClient({ url, token, insecure: process.env.INSECURE === '1' });
const shape = (v, d = 0) => (v === null ? 'null' : Array.isArray(v) ? `[${v.length ? shape(v[0], d + 1) : ''}]` : typeof v === 'object' ? (d > 2 ? '{…}' : `{${Object.entries(v).map(([k, x]) => `${k}: ${shape(x, d + 1)}`).join(', ')}}`) : typeof v);

const tree = await c.query('projects.listProjectsAndServices').catch((e) => { console.error('projects.listProjectsAndServices:', e.message); process.exit(2); });
console.log('projects.listProjectsAndServices →', shape(tree));
const n = normalizeTree(tree);
console.log(`нормализовано: ${n.projects.length} проектов, ${n.projects.reduce((a, p) => a + p.services.length, 0)} сервисов`);
console.log('monitor.getSystemStats →', shape(await c.query('monitor.getSystemStats').catch((e) => e.message)));
const first = n.projects.flatMap((p) => p.services)[0];
if (first) {
  const ref = { projectName: first.project, serviceName: first.name };
  console.log(`services.${first.type}.inspectService →`, shape(await c.query(`services.${first.type}.inspectService`, ref).catch((e) => e.message)));
  for (const p of ['domains.listDomains', 'ports.listPorts', 'mounts.listMounts']) console.log(p, '→', shape(await c.query(p, ref).catch((e) => e.message)));
}
