import fs from 'node:fs';
import { loadConfig } from './config.js';
import { loadKey } from './crypto.js';
import { openDb } from './db.js';
import { applyPendingRestore } from './backups.js';
import { createApp } from './app.js';
import { translate } from '../public/js/i18n-dict.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const restored = applyPendingRestore(config.dataDir);
if (restored) console.log(config.lang === 'en' ? translate(`База восстановлена из копии, прежняя сохранена в ${restored}`) : `База восстановлена из копии, прежняя сохранена в ${restored}`);
const db = openDb(config.dataDir);
const key = loadKey(config.dataDir, config.secret);
const app = createApp({ config, db, key });
const { server } = app;

server.listen(config.port, config.host, () => {
  const msg = `EasyAdmin запущен: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(config.lang === 'en' ? translate(msg) : msg);
  app.start();
});
// сбой в одном соединении (например, WebSocket панели) не должен ронять весь сервис: логируем и продолжаем
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.stop(); server.close(() => process.exit(0)); });
