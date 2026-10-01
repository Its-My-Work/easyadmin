// Скриншоты для README. Требуется: npm i --no-save playwright; npm run demo (в другом терминале). Запуск: node scripts/screenshots.mjs
import { chromium } from 'playwright';
const U = 'http://127.0.0.1:3100/'; const out = 'docs/screenshots';
const b = await chromium.launch({ ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', locale: 'en-US' });
await ctx.addInitScript(() => { try { localStorage.setItem('ea-lang', 'en'); } catch {} });
const p = await ctx.newPage();
await p.goto(U); await p.fill('input[placeholder="Username"]', 'admin'); await p.fill('input[type=password]', 'demo12345'); await p.click('button[type=submit]'); await p.waitForSelector('.panel-card');
await p.waitForTimeout(1500); await p.screenshot({ path: `${out}/overview.png` });
await p.goto(U + '#/panel/1'); await p.waitForSelector('.project'); await p.waitForTimeout(800); await p.screenshot({ path: `${out}/panel.png` });
await p.goto(U + '#/panel/1/load'); await p.waitForSelector('.chart-svg'); await p.waitForTimeout(800); await p.screenshot({ path: `${out}/load.png` });
await p.goto(U + '#/settings'); await p.waitForSelector('.card:has(h3:has-text("Backups"))'); await p.waitForTimeout(800);
await p.locator('.card:has(h3:has-text("Backups"))').screenshot({ path: `${out}/backups.png` });
await b.close();
