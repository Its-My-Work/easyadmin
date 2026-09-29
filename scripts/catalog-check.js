// Проверка каталога на локальной копии репозитория: node scripts/catalog-check.js /path/to/easypanel-templates/templates
import fs from 'node:fs';
import path from 'node:path';
import { createCatalog } from '../src/catalog.js';

const dir = path.resolve(process.argv[2] ?? '/tmp/tpl/templates');
const fetchImpl = async (url) => {
  const rel = url.replace('http://local/', '');
  try { return new Response(fs.readFileSync(path.join(dir, rel)), { status: 200 }); } catch { return new Response('', { status: 404 }); }
};
const cat = createCatalog({ base: 'http://local', fetchImpl });
const { items } = await cat.list();
let ok = 0; let unsupported = 0; let failed = 0; let needs = 0;
const reasons = {}; const errors = [];
for (const it of items) {
  try {
    const d = await cat.details(it.slug);
    if (!d.supported) { unsupported++; reasons[d.reason] = (reasons[d.reason] ?? 0) + 1; continue; }
    const missing = d.fields.filter((f) => f.required && (f.default == null || f.default === '') && f.type !== 'boolean');
    if (missing.length) { needs++; continue; }
    await cat.schemaFor(it.slug, {});
    ok++;
  } catch (e) { failed++; errors.push(`${it.slug}: ${e.message}`); }
}
console.log({ total: items.length, ok, needsInput: needs, unsupported, failed });
console.log(reasons);
console.log(errors.slice(0, 15).join('\n'));
