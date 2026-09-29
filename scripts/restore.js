// Восстановление из бэкапа: node scripts/restore.js backup.json [каталог_данных]
import fs from 'node:fs';
import path from 'node:path';

const [file, dir = process.env.EASYADMIN_DATA || './data'] = process.argv.slice(2);
if (!file) { console.error('Использование: node scripts/restore.js backup.json [каталог_данных]'); process.exit(1); }
const b = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, 'easyadmin.db');
if (fs.existsSync(dbFile)) { console.error(`${dbFile} уже существует — удалите или укажите другой каталог.`); process.exit(1); }
fs.writeFileSync(dbFile, Buffer.from(b.db, 'base64'));
if (b.key) fs.writeFileSync(path.join(dir, 'secret.key'), b.key, { mode: 0o600 });
console.log(`Восстановлено в ${dir}.` + (b.key ? '' : ' Ключ шифрования в бэкап не входил — задайте прежний EASYADMIN_SECRET, иначе токены панелей не расшифруются.'));
