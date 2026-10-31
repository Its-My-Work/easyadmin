// Мобильная вёрстка: ничего не выезжает за экран, шапка помещается в один ряд, окна влезают.
// Требуется: playwright, npm run demo (DEMO_BACKUPS=1). Запуск: node e2e/mobile.mjs   (MOBILE_W=360 — другая ширина)
import { chromium } from 'playwright';
const W = Number(process.env.MOBILE_W || 390);
const U = 'http://127.0.0.1:3100/';
const b = await chromium.launch({ ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: W, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ru-RU' });
await ctx.addInitScript(() => { try { localStorage.setItem('ea-lang', 'ru'); } catch {} });
const p = await ctx.newPage();
let failed = 0;
const sleep = (ms) => p.waitForTimeout(ms);
/** Элементы, выступающие за правый/левый край окна (кроме тех, что внутри прокручиваемых контейнеров). */
const overflow = () => p.evaluate(() => {
  const vw = document.documentElement.clientWidth; const bad = [];
  const scrollable = (el) => { for (let e = el.parentElement; e; e = e.parentElement) { const o = getComputedStyle(e).overflowX; if ((o === 'auto' || o === 'scroll') && e.scrollWidth > e.clientWidth) return true; } return false; };
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.position === 'fixed' && !el.closest('.modal')) continue;
    if ((r.right > vw + 1 || r.left < -1) && !scrollable(el) && !el.closest('.side-back,.sidebar,svg')) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return { page: document.documentElement.scrollWidth > vw + 1 ? document.documentElement.scrollWidth : 0, bad: [...new Set(bad)].slice(0, 6) };
});
const check = async (name) => {
  await sleep(350); const o = await overflow(); await p.screenshot({ path: `mobile-${name}.png` });
  if (o.page || o.bad.length) { failed++; console.log('FAIL', name, o.page ? `страница шире окна: ${o.page}` : '', o.bad.join('; ')); } else console.log('ok  ', name);
};
await p.goto(U); await p.fill('input[type=password]', 'demo12345'); await p.fill('input:not([type=password])', 'admin'); await p.click('button[type=submit]'); await p.waitForSelector('.topbar');
// шапка: один ряд, все кнопки на виду
const top = await p.evaluate(() => { const t = document.querySelector('.topbar'); const kids = [...t.children].filter((e) => e.getBoundingClientRect().width); const mid = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }; const rows = new Set(kids.map((e) => Math.round(mid(e) / 12))); return { rows: rows.size, right: Math.max(...kids.map((e) => e.getBoundingClientRect().right)), search: t.querySelector('.search-trigger').getBoundingClientRect().width, vw: document.documentElement.clientWidth }; });
if (top.rows > 1 || top.right > top.vw || top.search > 48) { failed++; console.log('FAIL шапка', JSON.stringify(top)); } else console.log('ok   шапка', JSON.stringify(top));
await check('dashboard');
await p.click('.search-trigger'); await p.waitForSelector('#palette'); await check('palette'); await p.keyboard.press('Escape');
for (const [name, hash] of [['services', '#/services'], ['inventory', '#/inventory'], ['templates', '#/templates'], ['schedules', '#/schedules'], ['audit', '#/audit'], ['users', '#/users'], ['settings', '#/settings'], ['profile', '#/profile'], ['panel', '#/panel/1'], ['backups', '#/backups']]) {
  await p.goto(U + hash); await sleep(500); await check(name);
}
await p.goto(U + '#/backups'); await p.waitForSelector('.tbl.compact tr.row').catch(() => {});
await p.click('button:has-text("Настройки")'); await p.waitForSelector('.modal'); await check('backups-settings');
await p.click('.modal .seg-btn:has-text("В S3")'); await check('backups-settings-s3'); await p.keyboard.press('Escape');
await p.click('button:has-text("История"), button:has-text("Журнал копий")'); await p.waitForSelector('.modal'); await check('backups-log'); await p.keyboard.press('Escape');
if (await p.locator('.tbl.compact tr.row').count()) { await p.locator('.tbl.compact tr.row').first().click(); await p.waitForSelector('.modal'); await check('backups-copies'); }
await b.close(); process.exit(failed ? 1 : 0);
