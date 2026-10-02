// Скриншоты для README (на английском, с английскими названиями панелей).
// Требуется: npm i --no-save playwright; DEMO_NAMES=en DEMO_BACKUPS=1 npm run demo (в другом терминале). Запуск: node scripts/screenshots.mjs
import { chromium } from 'playwright';
const U = 'http://127.0.0.1:3100/'; const out = 'docs/screenshots';
const b = await chromium.launch({ ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', locale: 'en-US' });
await ctx.addInitScript(() => { try { localStorage.setItem('ea-lang', 'en'); } catch {} });
const p = await ctx.newPage();
// на скриншотах не должно быть русского текста (названия панелей в демо — через DEMO_NAMES=en)
const shot = async (name, opts = {}) => {
  await p.waitForTimeout(800);
  const ru = await p.evaluate(() => (document.body.innerText.match(/[А-Яа-яЁё][^\n]{0,60}/g) ?? []).slice(0, 5));
  if (ru.length) console.warn(`⚠ ${name}: русский текст на скриншоте →`, ru);
  await p.screenshot({ path: `${out}/${name}.png`, ...opts });
};
await p.goto(U); await p.fill('input[placeholder="Username"]', 'admin'); await p.fill('input[type=password]', 'demo12345'); await p.click('button[type=submit]'); await p.waitForSelector('.panel-card');
await p.click('.topbar button[aria-label="Refresh"]'); await p.waitForTimeout(2500); await shot('overview');
await p.goto(U + '#/panel/1'); await p.waitForSelector('.project'); await shot('panel');
await p.goto(U + '#/panel/1/load'); await p.waitForSelector('.chart-svg'); await shot('load');
await p.goto(U + '#/backups'); await p.waitForSelector('.kpis .kpi'); await p.waitForSelector('.tbl tbody tr'); await shot('backups');
await b.close();
