import fs from 'node:fs';
import { loadConfig } from './config.js';
import { loadKey } from './crypto.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDb(config.dataDir);
const key = loadKey(config.dataDir, config.secret);
const { server, manager } = createApp({ config, db, key });

server.listen(config.port, config.host, () => {
  console.log(`EasyAdmin запущен: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  manager.startPolling();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { manager.stop(); server.close(() => process.exit(0)); });
