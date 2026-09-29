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
await step('расписание появляется сразу, даже если страница пересобралась под открытой формой', async () => {
  await p.goto(U + '#/schedules'); await p.click('button:has-text("Новое расписание")'); await p.waitForSelector('.modal .checklist');
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('ea:rerender'))); // как фоновое обновление данных
  await p.fill('.modal input[placeholder="Ночной рестарт"]', 'Пересборка');
  await p.locator('.modal .checklist label', { hasText: 'worker' }).first().locator('input').check();
  await p.click('.modal-foot button:has-text("Создать")'); await p.waitForSelector('.list-item:has-text("Пересборка")', { timeout: 5000 });
});
await step('inventory images + certs', async () => {
  await p.goto(U + '#/inventory'); await p.waitForSelector('.diff-row', { timeout: 15000 }); await p.screenshot({ path: 'v2-images.png' });
  await p.click('.seg button:has-text("Сертификаты")'); await p.waitForSelector('.badge:has-text("дн.")'); await p.screenshot({ path: 'v2-certs.png' });
  await p.locator('button:has-text("Перевыпустить")').first().click(); await p.waitForSelector('.modal:has-text("Let’s Encrypt")'); await p.keyboard.press('Escape');
});
await step('settings: канал уведомлений + бэкап', async () => {
  await p.goto(U + '#/settings'); await p.waitForSelector('.card');
  await p.click('button:has-text("Добавить канал")'); await p.selectOption('.modal select', 'webhook');
  await p.fill('.modal input[placeholder="Команда DevOps"]', 'CI'); await p.fill('.modal input[placeholder="https://example.com/hook"]', 'http://127.0.0.1:9/x');
  await p.click('.modal-foot button:has-text("Сохранить")'); await p.waitForSelector('.list-item:has-text("CI")');
  await p.screenshot({ path: 'v2-settings.png', fullPage: true });
  await Promise.all([p.waitForEvent('download').catch(() => null), p.click('button:has-text("Скачать бэкап")')]);
  await p.waitForTimeout(500);
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
await step('источник Git с deploy-токеном: создание, активный источник сверху, токен скрыт', async () => {
  await p.goto(U + '#/services'); await p.waitForSelector('.tbl');
  await p.click('button:has-text("Новый сервис")'); await p.waitForSelector('.modal');
  await p.selectOption('.modal select >> nth=0', { label: 'Стейджинг' });
  await p.fill('.modal input[placeholder="my-project"]', 'e2e-new');
  await p.fill('.modal input[placeholder="my-service"]', 'e2e-git');
  await p.click('.modal .seg-btn:text-is("Git")');
  await p.fill('.modal input[placeholder^="https://github.com/owner"]', 'https://github.com/o/private.git');
  await p.click('.modal .more summary:has-text("Приватный репозиторий")');
  await p.fill('.modal .more input[type=password]', 'ghp_SECRET123');
  await p.click('.modal-foot button:has-text("Создать")');
  await p.waitForSelector('tr.row:has-text("e2e-git")', { timeout: 10000 });
  await p.locator('tr.row', { hasText: 'e2e-git' }).first().click(); await p.waitForSelector('.drawer.in');
  await p.click('.drawer .dtab:has-text("Источник")');
  await p.waitForSelector('.src-sec.active');
  const first = await p.locator('.src-sec').first().getAttribute('class');
  if (!first.includes('active')) throw new Error('активный источник не первый');
  if ((await p.locator('.src-sec.active h4').innerText()).trim().toLowerCase() !== 'git') throw new Error('активен не Git');
  if ((await p.locator('.src-sec.active input[type=password]').getAttribute('placeholder')).indexOf('сохранён') < 0) throw new Error('токен не определён как сохранённый');
  await p.click('.drawer .dtab:has-text("Данные")');
  const raw = await p.locator('.drawer pre.code').innerText();
  if (raw.includes('ghp_SECRET123')) throw new Error('токен виден во вкладке «Данные»');
  await p.click('.drawer .icon[aria-label="Закрыть"], .drawer button[aria-label="Закрыть"]');
});
await step('шаблоны: создать из действующих сервисов на странице «Шаблоны»', async () => {
  await p.goto(U + '#/templates'); await p.waitForSelector('.page');
  const before = await p.locator('.tbl tbody tr').count();
  await p.click('button:has-text("Создать шаблон")'); await p.waitForSelector('.modal .pick-list');
  await p.fill('.modal input.search', 'worker');
  const visible = await p.locator('.modal .pick-row:visible').count(); if (!visible) throw new Error('фильтр скрыл всё');
  await p.locator('.modal .pick-row:visible').first().locator('input').check();
  await p.fill('.modal input[placeholder="название шаблона"]', 'Из-страницы-шаблонов');
  await p.click('.modal-foot button:has-text("Создать")');
  await p.waitForSelector('tr:has-text("Из-страницы-шаблонов")', { timeout: 8000 });
  if ((await p.locator('.tbl tbody tr').count()) !== before + 1) throw new Error('число шаблонов не выросло на 1');
});
await step('шаблоны: импорт схемы Easypanel и экспорт шаблона', async () => {
  await p.goto(U + '#/templates'); await p.waitForSelector('.page');
  await p.click('button:has-text("Импорт схемы Easypanel")'); await p.waitForSelector('.modal textarea');
  await p.fill('.modal input[placeholder="my-project"]', 'imp-e2e');
  await p.fill('.modal textarea', '{"services":[{"type":"app","data":{"serviceName":"imp-web","source":{"type":"image","image":"nginx:latest"}}},{"type":"redis","data":{"serviceName":"imp-cache"}}]}');
  await p.waitForSelector('.modal :text("Сервисов в схеме: 2")');
  await p.fill('.modal textarea', '{oops'); await p.waitForSelector('.modal .danger-text:has-text("Некорректный JSON")');
  await p.fill('.modal textarea', '{"services":[{"type":"app","data":{"serviceName":"imp-web","source":{"type":"image","image":"nginx:latest"}}},{"type":"redis","data":{"serviceName":"imp-cache"}}]}');
  await p.click('.modal-foot button:has-text("Развернуть")');
  await p.waitForSelector('.toast.success:has-text("Развёрнуто")', { timeout: 8000 });
  await p.goto(U + '#/services'); await p.waitForSelector('tr.row:has-text("imp-web")', { timeout: 8000 });
  await p.goto(U + '#/templates'); await p.waitForSelector('.tbl a[download]');
  const href = await p.locator('.tbl a[download]').first().getAttribute('href'); if (!/\/api\/templates\/\d+\/schema/.test(href)) throw new Error('нет ссылки экспорта: ' + href);
});
await step('каталог Easypanel: поиск, карточка, неподдерживаемый шаблон, развёртывание', async () => {
  await p.goto(U + '#/templates'); await p.waitForSelector('.page');
  await p.click('.seg-btn:has-text("Каталог Easypanel")'); await p.waitForSelector('.cat-card');
  const total = await p.locator('.cat-card').count(); if (total < 5) throw new Error('в каталоге мало карточек: ' + total);
  await p.fill('.cat-bar input.search', 'uses fs'); await p.waitForTimeout(200);
  if ((await p.locator('.cat-card').count()) !== 1) throw new Error('поиск не отфильтровал каталог');
  await p.locator('.cat-card').first().click(); await p.waitForSelector('.modal .callout.warn');
  if (await p.locator('.modal-foot button:has-text("Развернуть")').count()) throw new Error('у неподдерживаемого шаблона есть кнопка развёртывания');
  await p.keyboard.press('Escape');
  await p.fill('.cat-bar input.search', 'demo'); await p.waitForTimeout(200);
  await p.locator('.cat-card', { hasText: 'Demo' }).first().click(); await p.waitForSelector('.modal .cat-head');
  await p.fill('.modal input[placeholder="my-project"]', 'cat-e2e');
  await p.fill('.modal .field:has(.field-label:has-text("App Service Name")) input', 'cat-demo');
  await p.click('.modal-foot button:has-text("Показать схему")'); await p.waitForSelector('.modal pre.code:has-text("cat-demo-db")');
  await p.click('.modal:has(pre.code) .modal-foot button:has-text("Закрыть")');
  await p.click('.modal-foot button:has-text("Развернуть")');
  await p.waitForSelector('.toast.success:has-text("развёрнуто")', { timeout: 8000 });
  await p.goto(U + '#/services'); await p.waitForSelector('tr.row:has-text("cat-demo-db")', { timeout: 8000 });
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
await step('профиль: данные, сессии, имя, 2FA и вход с кодом', async () => {
  await p.click('.side-foot a.user'); await p.waitForSelector('.profile-hero'); await p.waitForSelector('.list-item:has-text("Это устройство")');
  await p.fill('input[placeholder="admin"]', 'Главный админ'); await p.click('button:has-text("Сохранить")'); await p.waitForSelector('.toast.success:has-text("Профиль сохранён")');
  await p.waitForSelector('.profile-hero h2:has-text("Главный админ")'); await p.waitForSelector('.side-foot .user b:has-text("Главный админ")');
  await p.click('button:has-text("Включить 2FA")'); await p.waitForSelector('.modal .secret');
  const secret = (await p.textContent('.modal .secret')).trim();
  await p.fill('.modal input[placeholder="123456"]', totp(secret)); await p.click('.modal-foot button:has-text("Включить")');
  await p.waitForSelector('.badge:has-text("Включена")'); await p.screenshot({ path: 'v5-profile.png', fullPage: true });
  // выход и вход с 2FA
  await p.click('.side-foot button[title="Выйти"]'); await p.waitForSelector('input[placeholder="Логин"]');
  await p.fill('input[placeholder="Логин"]', 'admin'); await p.fill('input[type=password]', 'demo12345'); await p.click('button[type=submit]');
  await p.waitForSelector('input[placeholder^="Код 2FA"]:visible');
  await p.fill('input[placeholder^="Код 2FA"]', totp(secret)); await p.click('button[type=submit]'); await p.waitForSelector('.panel-card');
});
await step('пользователи: создать, отключить, удалить', async () => {
  await p.click('.nav-item:has-text("Пользователи")'); await p.waitForSelector('.tbl');
  await p.click('button:has-text("Добавить пользователя")'); await p.waitForSelector('.modal');
  await p.fill('.modal .field:has(.field-label:text-is("Логин")) input', 'e2e-user'); await p.fill('.modal .field:has(.field-label:text-is("Пароль")) input', 'password1'); await p.click('.modal-foot button:has-text("Сохранить")');
  await p.waitForSelector('tr.row:has-text("e2e-user")');
  await p.locator('tr.row', { hasText: 'e2e-user' }).locator('button[title="Отключить учётную запись"]').click(); await p.waitForSelector('tr.row:has-text("e2e-user") .badge:has-text("Отключён")');
  await p.screenshot({ path: 'v5-users.png' });
  await p.locator('tr.row', { hasText: 'e2e-user' }).locator('button[title="Удалить"]').click(); await p.waitForSelector('.modal');
  await p.fill('.modal input', 'e2e-user'); await p.click('.modal-foot .btn.danger'); await p.waitForFunction(() => !document.body.textContent.includes('e2e-user'));
});
await step('audit search', async () => { await p.goto(U + '#/audit'); await p.waitForSelector('.tbl tbody tr'); await p.fill('.input.search', 'clone'); await p.waitForTimeout(600); await p.screenshot({ path: 'v2-audit.png' }); });
await step('журнал: фильтры период/результат/категория/пользователь и сброс', async () => {
  await p.goto(U + '#/audit'); await p.waitForSelector('.tbl tbody tr');
  const total = await p.locator('.tbl tbody tr').count();
  await p.click('.audit-bar .seg-btn:text-is("Ошибки")'); await p.waitForTimeout(500);
  const bad = await p.locator('.tbl tbody tr .badge.err').count(); const rows = await p.locator('.tbl tbody tr').count();
  if (rows !== bad) throw new Error(`в «Ошибки» есть не ошибки: ${rows}/${bad}`);
  await p.waitForSelector('.audit-bar button:has-text("Сбросить")');
  await p.click('.audit-bar .seg-btn:text-is("Все")'); await p.click('.audit-bar .seg-btn:text-is("Час")'); await p.waitForTimeout(500);
  await p.selectOption('.audit-bar select[aria-label="Категория"]', { label: 'Сертификаты' }); await p.waitForTimeout(500);
  if (await p.locator('.tbl tbody tr').count() && !(await p.locator('.tbl tbody tr').first().innerText()).includes('сертификат')) throw new Error('категория не применилась');
  await p.click('.audit-bar button:has-text("Сбросить")'); await p.waitForTimeout(600);
  if ((await p.locator('.tbl tbody tr').count()) < total) throw new Error('сброс не вернул все записи'); // журнал мог пополниться (расписания пишут в него сами)
  if (await p.locator('.audit-bar button:has-text("Сбросить")').count()) throw new Error('кнопка сброса осталась после сброса');
  const users = await p.locator('.audit-bar select[aria-label="Пользователь"] option').allTextContents(); if (!users.includes('admin')) throw new Error('нет пользователей в фильтре');
});
await step('форма нового сервиса: поля в ряд выровнены', async () => {
  await p.goto(U + '#/services'); await p.waitForSelector('.tbl');
  await p.click('button:has-text("Новый сервис")'); await p.waitForSelector('.modal');
  await p.click('.modal .seg-btn:text-is("Git")');
  await p.fill('.modal input[placeholder^="https://github.com/owner"]', 'https://github.com/o/r.git');
  await p.click('.modal .more summary:has-text("Приватный репозиторий")');
  const tops = await p.locator('.modal .more .grid-2 .input').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  if (new Set(tops).size !== 1) throw new Error('поля токена не на одном уровне: ' + tops);
  const boxes = await p.locator('.modal-body, .modal .modal-body').first().evaluate((e) => ({ over: e.scrollHeight > e.clientHeight + 1 })).catch(() => ({ over: false }));
  await p.keyboard.press('Escape');
});
await step('palette favorites', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'cache' }).first().click(); await p.waitForSelector('.drawer.in'); await p.click('.drawer .star'); await p.keyboard.press('Escape');
  await p.keyboard.press('Control+k'); await p.waitForSelector('.pal-item'); const first = await p.textContent('.pal-item >> nth=0'); if (!first.includes('cache')) throw new Error('first=' + first); await p.keyboard.press('Escape');
});
console.log(errors.join('\n') || 'no console errors');
await b.close();
if (failed) { console.error(`${failed} шаг(ов) не прошли`); process.exit(1); }
