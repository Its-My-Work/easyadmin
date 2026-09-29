import fs from 'node:fs';
import { loadConfig } from './config.js';
import { loadKey } from './crypto.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDb(config.dataDir);
const key = loadKey(config.dataDir, config.secret);
const app = createApp({ config, db, key });
const { server } = app;

server.listen(config.port, config.host, () => {
  console.log(`EasyAdmin запущен: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  app.start();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.stop(); server.close(() => process.exit(0)); });
