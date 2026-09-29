// Сквозная проверка интерфейса в браузере. Требуется: npm i --no-save playwright; npm run demo (в другом терминале).
// Запуск: node e2e/ui.mjs   (PW_CHROMIUM=/путь/к/chromium — если браузер уже установлен)
import { chromium } from 'playwright';
import { totp } from '../src/totp.js';
const b = await chromium.launch({ ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', locale: 'ru-RU' });
await ctx.addInitScript(() => { try { localStorage.setItem('ea-lang', 'ru'); } catch {} });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: 'e2e-fail.png' }); } };
const U = 'http://127.0.0.1:3100/';
await p.goto(U);
await p.fill('input[placeholder="Логин"]', 'admin'); await p.fill('input[type=password]', 'demo12345'); await p.click('button[type=submit]');
await p.waitForSelector('.panel-card');
await step('dashboard tags + health', async () => {
  await p.click('.chip-btn:has-text("prod")'); await p.waitForTimeout(300);
  const n = await p.locator('.panel-card').count(); if (n !== 2) throw new Error('tag filter count ' + n);
  await p.click('.chip-btn:has-text("Все")'); await p.waitForTimeout(200);
  await p.waitForSelector('.list-item:has-text("Сбой")'); await p.screenshot({ path: 'v2-dash.png' });
});
await step('panel history sparklines', async () => { await p.click('.nav-panel >> nth=0'); await p.waitForSelector('.sparks svg', { timeout: 5000 }); await p.screenshot({ path: 'v2-panel.png' }); });
await step('clean-all modal', async () => { await p.goto(U + '#/'); await p.click('button:has-text("Очистка Docker")'); await p.waitForSelector('.modal .checklist'); await p.click('.modal-foot button:has-text("Отмена")'); });
await step('bulk env modal', async () => {
  await p.goto(U + '#/services'); await p.waitForSelector('.tbl');
  await p.locator('tr.row', { hasText: 'api' }).first().locator('input[type=checkbox]').check();
  await p.click('.bulkbar button:has-text("Env…")'); await p.waitForSelector('.modal textarea');
  await p.fill('.modal textarea', 'REGION=eu'); await p.click('.modal-foot button:has-text("Применить")');
  await p.waitForSelector('.modal .result-list'); await p.screenshot({ path: 'v2-bulk.png' }); await p.keyboard.press('Escape');
});
await step('clone via drawer', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'web' }).first().click(); await p.waitForSelector('.drawer.in');
  await p.click('.drawer button:has-text("Клонировать")'); await p.waitForSelector('.modal');
  await p.selectOption('.modal select', { label: 'Стейджинг' }); await p.fill('.modal input[placeholder="имя сервиса"]', 'web-clone'); await p.fill('.modal input[placeholder^="проект"]', 'shop');
  await p.click('.modal-foot button:has-text("Клонировать")'); await p.waitForSelector('.modal .result-list li'); await p.screenshot({ path: 'v2-clone.png' });
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
});
await step('save template + templates page', async () => {
  await p.click('.drawer button:has-text("Сохранить как шаблон")'); await p.click('.modal-foot button:has-text("Сохранить")'); await p.waitForSelector('.toast.success:has-text("Шаблон")');
  await p.keyboard.press('Escape'); await p.goto(U + '#/templates'); await p.waitForSelector('.tbl tbody tr'); await p.screenshot({ path: 'v2-templates.png' });
});
await step('automation tab: webhook', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'web' }).first().click(); await p.waitForSelector('.drawer.in');
  await p.click('.drawer .dtab:has-text("Автоматизация")'); await p.click('.drawer button:has-text("Вебхук деплоя")');
  await p.waitForSelector('.modal .secret:has-text("curl -X POST")'); await p.keyboard.press('Escape');
});
await step('schedule create + run', async () => {
  await p.goto(U + '#/schedules'); await p.click('button:has-text("Новое расписание")'); await p.waitForSelector('.modal .checklist');
  await p.fill('.modal input[placeholder="Ночной рестарт"]', 'Ночной рестарт');
  await p.locator('.modal .checklist label', { hasText: 'worker' }).first().locator('input').check();
  await p.click('.modal-foot button:has-text("Создать")'); await p.waitForSelector('.list-item:has-text("Ночной рестарт")');
  await p.click('button:has-text("Запустить сейчас")'); await p.waitForSelector('.toast.success:has-text("Выполнено")'); await p.waitForTimeout(500);
  await p.screenshot({ path: 'v2-schedules.png' });
});
await step('inventory images + certs', async () => {
  await p.goto(U + '#/inventory'); await p.waitForSelector('.diff-row', { timeout: 15000 }); await p.screenshot({ path: 'v2-images.png' });
  await p.click('.seg button:has-text("Сертификаты")'); await p.waitForSelector('.badge:has-text("дн.")'); await p.screenshot({ path: 'v2-certs.png' });
});
await step('settings: channel + 2FA + backup', async () => {
  await p.goto(U + '#/settings'); await p.waitForSelector('.card');
  await p.click('button:has-text("Добавить канал")'); await p.selectOption('.modal select', 'webhook');
  await p.fill('.modal input[placeholder="Команда DevOps"]', 'CI'); await p.fill('.modal input[placeholder="https://example.com/hook"]', 'http://127.0.0.1:9/x');
  await p.click('.modal-foot button:has-text("Сохранить")'); await p.waitForSelector('.list-item:has-text("CI")');
  await p.click('button:has-text("Включить 2FA")'); await p.waitForSelector('.modal .secret');
  const secret = (await p.textContent('.modal .secret')).trim();
  await p.fill('.modal input[placeholder="123456"]', totp(secret)); await p.click('.modal-foot button:has-text("Включить")');
  await p.waitForSelector('.badge:has-text("Включена")'); await p.screenshot({ path: 'v2-settings.png', fullPage: true });
  const [dl] = await Promise.all([p.waitForEvent('download').catch(() => null), p.click('button:has-text("Скачать бэкап")')]);
  await p.waitForTimeout(500);
  // выход и вход с 2FA
  await p.click('.side-foot button[title="Выйти"]'); await p.waitForSelector('input[placeholder="Логин"]');
  await p.fill('input[placeholder="Логин"]', 'admin'); await p.fill('input[type=password]', 'demo12345'); await p.click('button[type=submit]');
  await p.waitForSelector('input[placeholder^="Код 2FA"]:visible');
  await p.fill('input[placeholder^="Код 2FA"]', totp(secret)); await p.click('button[type=submit]'); await p.waitForSelector('.panel-card');
});
await step('drawer nav: вертикальное меню без горизонтальной прокрутки, цифры переключают разделы', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'web' }).first().click(); await p.waitForSelector('.drawer.in');
  const overflow = await p.evaluate(() => { const n = document.querySelector('.dnav'); return n.scrollWidth > n.clientWidth + 1; });
  if (overflow) throw new Error('у меню есть горизонтальная прокрутка');
  await p.keyboard.press('4'); await p.waitForSelector('.dtab.active:has-text("Домены")');
  await p.click('.drawer .section-head button'); await p.waitForSelector('.modal');
  await p.fill('.modal input[placeholder="app.example.com"]', 'edit.example.com'); await p.click('.modal-foot button:has-text("Сохранить")');
  await p.waitForSelector('.drawer .list-item:has-text("edit.example.com")');
  await p.click('.drawer .list-item:has-text("edit.example.com") button[title="Изменить"]'); await p.waitForSelector('.modal');
  await p.fill('.modal input[placeholder="app.example.com"]', 'renamed.example.com'); await p.click('.modal-foot button:has-text("Сохранить")');
  await p.waitForSelector('.drawer .list-item:has-text("renamed.example.com")');
  await p.keyboard.press('5'); await p.waitForSelector('.dtab.active:has-text("Порты и тома")');
  await p.locator('.drawer .section-head button').nth(1).click(); await p.waitForSelector('.modal'); await p.fill('.modal input[placeholder="/var/lib/data"]', '/data1'); await p.fill('.modal input[placeholder="data"]', 'vol1'); await p.click('.modal-foot button:has-text("Сохранить")');
  await p.waitForSelector('.drawer .list-item:has-text("/data1")');
  await p.click('.drawer .list-item:has-text("/data1") button[title="Изменить"]'); await p.waitForSelector('.modal'); await p.fill('.modal input[placeholder="/var/lib/data"]', '/data2'); await p.click('.modal-foot button:has-text("Сохранить")');
  await p.waitForSelector('.drawer .list-item:has-text("/data2")');
  await p.screenshot({ path: 'v4-drawer.png' }); await p.keyboard.press('Escape');
});
await step('новый сервис со страницы «Все сервисы» (с новым проектом)', async () => {
  await p.goto(U + '#/services'); await p.waitForSelector('.tbl');
  await p.click('button:has-text("Новый сервис")'); await p.waitForSelector('.modal');
  await p.selectOption('.modal select >> nth=0', { label: 'Стейджинг' });
  await p.fill('.modal input[placeholder="my-project"]', 'e2e-new'); await p.waitForSelector('.modal .hint:has-text("будет создан")');
  await p.selectOption('.modal select >> nth=1', 'redis'); await p.fill('.modal input[placeholder="my-service"]', 'e2e-cache');
  await p.click('.modal-foot button:has-text("Создать")');
  await p.waitForSelector('tr.row:has-text("e2e-cache")', { timeout: 10000 });
});
await step('live logs tab', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'web' }).first().click(); await p.waitForSelector('.drawer.in');
  await p.click('.drawer .dtab:has-text("Логи")');
  await p.waitForSelector('.logview .ll:has-text("line one")', { timeout: 8000 });
  await p.waitForSelector('.logview .ll:has-text("tick")');
  await p.fill('.drawer input[placeholder="Фильтр…"]', 'json'); await p.waitForTimeout(200);
  const n = await p.locator('.logview .ll').count(); if (n !== 1) throw new Error('filter shows ' + n);
  await p.fill('.drawer input[placeholder="Фильтр…"]', ''); await p.click('.drawer button:has-text("Пауза")'); await p.waitForTimeout(150);
  await p.screenshot({ path: 'v3-logs.png' }); await p.keyboard.press('Escape');
});
await step('email channel form', async () => {
  await p.goto(U + '#/settings'); await p.waitForSelector('.card');
  await p.click('button:has-text("Добавить канал")'); await p.selectOption('.modal select', 'email');
  await p.waitForSelector('.modal input[placeholder="smtp.example.com"]:visible'); await p.screenshot({ path: 'v3-email.png' }); await p.keyboard.press('Escape');
});
await step('audit search', async () => { await p.goto(U + '#/audit'); await p.waitForSelector('.tbl tbody tr'); await p.fill('.input.search', 'clone'); await p.waitForTimeout(600); await p.screenshot({ path: 'v2-audit.png' }); });
await step('palette favorites', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'cache' }).first().click(); await p.waitForSelector('.drawer.in'); await p.click('.drawer .star'); await p.keyboard.press('Escape');
  await p.keyboard.press('Control+k'); await p.waitForSelector('.pal-item'); const first = await p.textContent('.pal-item >> nth=0'); if (!first.includes('cache')) throw new Error('first=' + first); await p.keyboard.press('Escape');
});
console.log(errors.join('\n') || 'no console errors');
await b.close();
if (failed) { console.error(`${failed} шаг(ов) не прошли`); process.exit(1); }
