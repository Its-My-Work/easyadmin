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
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, process.env.E2E_VERBOSE ? e.message : e.message.split('\n')[0]); await p.screenshot({ path: 'e2e-fail.png' }); } };
// Playwright waitForFunction выполняет код в странице через eval, а CSP приложения запрещает unsafe-eval (иногда ловится как EvalError) — ждём опросом через evaluate
const until = async (fn, arg = null, { timeout = 8000 } = {}) => { const t0 = Date.now(); for (;;) { if (await p.evaluate(fn, arg)) return; if (Date.now() - t0 > timeout) throw new Error('until: таймаут ' + timeout + ' мс'); await p.waitForTimeout(100); } };
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
await step('panel page opens', async () => { await p.click('.nav-panel >> nth=0'); await p.waitForSelector('.project', { timeout: 5000 }); });
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
  await p.locator('button[aria-label="Перевыпустить"]').first().click(); await p.waitForSelector('.modal:has-text("Let’s Encrypt")'); await p.keyboard.press('Escape');
  await p.locator('button[aria-label="Удалить сертификат"]').first().click(); await p.waitForSelector('.modal:has-text("Удалить сертификат?")'); await p.click('.modal-foot button:has-text("Отмена")'); // кнопки без текста, рядом
});
await step('settings: канал уведомлений + бэкап', async () => {
  await p.goto(U + '#/settings'); await p.waitForSelector('.card');
  await p.click('button:has-text("Добавить канал")'); await p.selectOption('.modal select', 'webhook');
  await p.fill('.modal input[placeholder="Команда DevOps"]', 'CI'); await p.fill('.modal input[placeholder="https://example.com/hook"]', 'http://127.0.0.1:9/x');
  await p.click('.modal-foot button:has-text("Сохранить")'); await p.waitForSelector('.list-item:has-text("CI")');
  await p.screenshot({ path: 'v2-settings.png', fullPage: true });
});
await step('бэкапы: пароль, включение сервиса, копия EasyAdmin, настройки, вкладка сервиса', async () => {
  await p.goto(U + '#/backups'); await p.waitForSelector('.kpis .kpi'); await p.waitForSelector('.tbl tbody tr');
  const rows = await p.locator('.tbl tbody tr.row').count(); if (rows < 5) throw new Error('в обзоре мало сервисов: ' + rows);
  await p.click('button:has-text("Задать пароль")'); await p.waitForSelector('.modal #bk-pass'); await p.fill('.modal #bk-pass', 'correct horse battery');
  await p.click('.modal-foot button:has-text("Сохранить")'); await p.waitForSelector('.modal', { state: 'detached' }); await p.waitForSelector('.callout:has-text("зашифрованы паролем")');
  await p.locator('tbody tr.row.dim .toggle').first().click();
  await until((x) => document.querySelectorAll('tbody tr.row:not(.dim)').length > 0);
  await p.screenshot({ path: 'v2-backups.png' });
  await p.click('button:has-text("История"), button:has-text("Журнал копий")'); await p.waitForSelector('.modal:has-text("История"), .modal:has-text("Журнал")'); await p.keyboard.press('Escape');
  await p.click('button:has-text("Создать копию")'); await p.waitForSelector('button:has-text("Копии (1)")', { timeout: 15000 });
  await p.click('button:has-text("Копии (1)")'); await p.waitForSelector('.modal .list-item .mono');
  await p.click('.modal button[aria-label="Проверить копию"]'); await p.click('.modal-foot button:has-text("Продолжить")');
  await p.waitForSelector('.modal:has-text("Копия в порядке")'); await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await p.click('button:has-text("Настройки")'); await p.waitForSelector('.modal .seg-btn:text-is("В S3")'); await p.click('.modal .seg-btn:text-is("В S3")'); await p.waitForSelector('.modal input[placeholder="https://s3.example.com"]'); await p.keyboard.press('Escape');
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project'); await p.locator('tr.row', { hasText: 'web' }).first().click(); await p.waitForSelector('.drawer.in');
  await p.click('.drawer .dtab:has-text("Бэкапы")'); await p.waitForSelector('.drawer :text("Копировать этот сервис")'); await p.keyboard.press('Escape');
});
await step('drawer nav: вертикальное меню без горизонтальной прокрутки, цифры переключают разделы', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'web' }).first().click(); await p.waitForSelector('.drawer.in');
  const overflow = await p.evaluate(() => { const n = document.querySelector('.dnav'); return n.scrollWidth > n.clientWidth + 1; });
  if (overflow) throw new Error('у меню есть горизонтальная прокрутка');
  const tabKey = async (name) => String((await p.locator('.drawer .dtab').allInnerTexts()).findIndex((x) => x.includes(name)) + 1); // номер вкладки зависит от набора вкладок сервиса
  await p.keyboard.press(await tabKey('Домены')); await p.waitForSelector('.dtab.active:has-text("Домены")');
  await p.click('.drawer .section-head button'); await p.waitForSelector('.modal');
  await p.fill('.modal input[placeholder="app.example.com"]', 'edit.example.com'); await p.click('.modal-foot button:has-text("Сохранить")');
  await p.waitForSelector('.drawer .list-item:has-text("edit.example.com")');
  await p.click('.drawer .list-item:has-text("edit.example.com") button[title="Изменить"]'); await p.waitForSelector('.modal');
  await p.fill('.modal input[placeholder="app.example.com"]', 'renamed.example.com'); await p.click('.modal-foot button:has-text("Сохранить")');
  await p.waitForSelector('.drawer .list-item:has-text("renamed.example.com")');
  await p.keyboard.press(await tabKey('Порты и тома')); await p.waitForSelector('.dtab.active:has-text("Порты и тома")');
  await p.locator('.drawer .section-head button').nth(1).click(); await p.waitForSelector('.modal'); await p.fill('.modal input[placeholder="/var/lib/data"]', '/data1'); await p.fill('.modal input[placeholder="data"]', 'vol1'); await p.click('.modal-foot button:has-text("Сохранить")');
  await p.waitForSelector('.drawer .list-item:has-text("/data1")');
  await p.click('.drawer .list-item:has-text("/data1") button[title="Изменить"]'); await p.waitForSelector('.modal'); await p.fill('.modal input[placeholder="/var/lib/data"]', '/data2'); await p.click('.modal-foot button:has-text("Сохранить")');
  await p.waitForSelector('.drawer .list-item:has-text("/data2")');
  await p.screenshot({ path: 'v4-drawer.png' }); await p.keyboard.press('Escape');
});
await step('новый сервис со страницы «Сервисы» (с новым проектом)', async () => {
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
await step('вкладки «Логи» и «Консоль»: логи идут и фильтруются, терминал подключается по кнопке, вывод в своём окне', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'worker' }).first().click(); await p.waitForSelector('.drawer.in');
  await p.click('.drawer .dtab:has-text("Логи")');
  await p.waitForSelector('.logview .ll:has-text("line one")', { timeout: 8000 }); // логи потекли
  if ((await p.locator('.term-input').count()) !== 0) throw new Error('терминал не должен быть на вкладке «Логи»');
  await p.click('.drawer .dtab:has-text("Консоль")'); await p.waitForSelector('.xterm-wrap .xterm-rows', { timeout: 8000 });
  await p.click('.drawer button:has-text("Подключить терминал")'); await p.waitForSelector('.drawer :text("Подключено")', { timeout: 12000 }); // подключение по кнопке
  await p.click('.xterm-wrap'); await p.keyboard.type('echo hi-e2e-console'); await p.keyboard.press('Enter');
  await until(() => { const t = document.querySelector('.xterm-rows')?.innerText ?? ''; return t.split('\n').some((l) => l.trim() === 'hi-e2e-console'); }, null, { timeout: 6000 });
  await p.selectOption('.term-quick', 'pwd'); await until(() => document.querySelector('.xterm-rows')?.innerText.includes('pwd: not found'), null, { timeout: 6000 }); // быстрая команда выполнилась
  await p.keyboard.type('ls 123'); await p.keyboard.press('Enter'); await until(() => document.querySelector('.xterm-rows')?.innerText.includes('ls 123: not found'), null, { timeout: 6000 });
  if (!(await p.locator('.drawer .dtab.active').innerText()).includes('Консоль')) throw new Error('ввод цифр переключил вкладку');
  await p.click('.drawer .dtab:has-text("Логи")'); await p.waitForSelector('.logview .ll:has-text("tick")'); // логи на месте
  await p.click('.drawer .dtab:has-text("Консоль")'); await p.waitForSelector('.xterm-wrap .xterm-rows');
  if (!(await p.locator('.xterm-rows').innerText()).includes('hi-e2e-console')) throw new Error('вывод консоли пропал при переключении вкладок');
  await p.keyboard.press('Escape');
});
await step('настройки панели Easypanel: разделы и сохранение', async () => {
  await p.goto(U + '#/panel/1/settings'); await p.waitForSelector('.psf-nav');
  await p.waitForSelector('.psf:has-text("Состояние панели")', { timeout: 8000 });
  await p.click('.psf-nav .chip-btn:has-text("Общее")'); await p.waitForSelector('.psf:has-text("Телеметрия")');
  await p.locator('.psf:has-text("Телеметрия") input[type=checkbox]').check(); await p.locator('.psf:has-text("Телеметрия") .btn.primary').click();
  await p.waitForSelector('.psf:has-text("Телеметрия"):has-text("Сохранено")', { timeout: 6000 });
  await p.click('.psf-nav .chip-btn:has-text("Адреса")'); await p.waitForSelector('.psf:has-text("Домен панели")');
  await p.locator('.psf:has-text("Домен панели") input[type=text]').first().fill('panel.example.com'); await p.locator('.psf:has-text("Домен панели") .btn.primary').click();
  await p.waitForSelector('.modal input[placeholder]'); await p.keyboard.press('Escape'); // опасная настройка требует подтверждения
  await p.click('.psf-nav .chip-btn:has-text("Пользователи")'); await p.waitForSelector('.psf:has-text("Пользователи Easypanel") .list-item');
});
await step('консоль сервера: пункт меню, подключение, команда, вывод, отключение', async () => {
  await p.goto(U + '#/'); await p.waitForSelector('.panel-card');
  await p.click('.nav-item:has-text("Консоль")'); await p.waitForSelector('.xterm-wrap .xterm-rows', { timeout: 8000 });
  await p.click('.page button:has-text("Подключить терминал")'); await p.waitForSelector('.page :text("Подключено")', { timeout: 12000 });
  await p.click('.xterm-wrap'); await p.keyboard.type('echo host-e2e'); await p.keyboard.press('Enter');
  await until(() => (document.querySelector('.xterm-rows')?.innerText ?? '').split('\n').some((l) => l.trim() === 'host-e2e'), null, { timeout: 6000 });
  await p.waitForTimeout(300);
  await p.click('.nav-item:has-text("Обзор")'); await p.click('.nav-item:has-text("Консоль")'); await p.waitForSelector('.xterm-wrap .xterm-rows');
  if (!(await p.locator('.xterm-rows').innerText()).includes('host-e2e')) throw new Error('вывод консоли пропал после перехода по страницам');
  await p.click('.page button:has-text("Отключить терминал")'); await p.waitForSelector('.page :text("Терминал отключён")');
});
await step('live logs tab', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'web' }).first().click(); await p.waitForSelector('.drawer.in');
  await p.click('.drawer .dtab:has-text("Логи")');
  await p.waitForSelector('.logview .ll:has-text("line one")', { timeout: 8000 });
  await p.waitForSelector('.logview .ll:has-text("tick")');
  await p.fill('.drawer input[placeholder="Фильтр логов…"]', 'json'); await p.waitForTimeout(200);
  const n = await p.locator('.logview .ll').count(); if (n !== 1) throw new Error('filter shows ' + n);
  await p.fill('.drawer input[placeholder="Фильтр логов…"]', ''); await p.click('.drawer button:has-text("Обновить")'); await p.waitForSelector('.logview .ll:has-text("line one")', { timeout: 8000 });
  await p.screenshot({ path: 'v3-logs.png' }); await p.keyboard.press('Escape');
});
await step('email channel form', async () => {
  await p.goto(U + '#/settings'); await p.waitForSelector('.card');
  await p.click('button:has-text("Добавить канал")'); await p.selectOption('.modal select', 'email');
  await p.waitForSelector('.modal input[placeholder="smtp.example.com"]:visible'); await p.screenshot({ path: 'v3-email.png' }); await p.keyboard.press('Escape');
});
await step('профиль: данные, сессии, имя, 2FA и вход с кодом', async () => {
  await p.click('.topbar a.user'); await p.waitForSelector('.profile-hero'); await p.waitForSelector('.list-item:has-text("Это устройство")');
  await p.fill('input[placeholder="admin"]', 'Главный админ'); await p.click('button:has-text("Сохранить")'); await p.waitForSelector('.toast.success:has-text("Профиль сохранён")');
  await p.waitForSelector('.profile-hero h2:has-text("Главный админ")'); await p.waitForSelector('.topbar .user b:has-text("Главный админ")');
  await p.click('button:has-text("Включить 2FA")'); await p.waitForSelector('.modal .secret');
  const secret = (await p.textContent('.modal .secret')).trim();
  await p.fill('.modal input[placeholder="123456"]', totp(secret)); await p.click('.modal-foot button:has-text("Включить")');
  await p.waitForSelector('.badge:has-text("Включена")'); await p.screenshot({ path: 'v5-profile.png', fullPage: true });
  // выход и вход с 2FA
  await p.click('.topbar button[title="Выйти"]'); await p.waitForSelector('input[placeholder="Логин"]');
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
  await p.fill('.modal input', 'e2e-user'); await p.click('.modal-foot .btn.danger'); await p.waitForSelector('tr.row:has-text("e2e-user")', { state: 'detached' });
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
await step('вкладка «Нагрузка»: графики, таблица, настройки', async () => {
  await p.goto(U + '#/panel/1/load'); await p.waitForSelector('.chart-svg'); await p.waitForSelector('.tbl tbody tr');
  const n = await p.locator('.chart-svg').count(); if (n < 2) throw new Error('ожидалось два графика, найдено ' + n);
  await p.click('.seg-btn:text-is("6 ч")'); await p.waitForSelector('.chart-svg');
  await p.hover('.chart-svg >> nth=0'); await p.waitForSelector('.chart-tip:not([hidden])');
  await p.click('.card-head label.check input'); await p.waitForTimeout(200);
  await p.goto(U + '#/settings'); await p.waitForSelector('.card:has(h3:has-text("Мониторинг нагрузки"))');
  await p.click('.card:has(h3:has-text("Мониторинг нагрузки")) .seg-btn:text-is("Чувствительные")'); await p.waitForTimeout(400);
  const act = await p.textContent('.card:has(h3:has-text("Мониторинг нагрузки")) .seg-btn.active >> nth=2'); if (!act.includes('Чувствительные')) throw new Error('уровень не сохранился: ' + act);
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
await step('меню: порядок пунктов, «Сервисы», время сервера в шапке', async () => {
  await p.goto(U + '#/'); await p.waitForSelector('.nav-item');
  const nav = (await p.locator('.nav-item').allInnerTexts()).map((x) => x.trim()).join(',');
  if (nav !== 'Обзор,Консоль,Сервисы,Инвентарь,Шаблоны,Расписания,Журнал,Бэкапы,Пользователи,Настройки') throw new Error('меню: ' + nav);
  const t0 = await p.locator('.server-clock b').innerText(); await p.waitForTimeout(1300);
  const t1 = await p.locator('.server-clock b').innerText(); if (t0 === t1) throw new Error('часы не идут: ' + t0);
});
await step('настройки: часовой пояс сервера и интервал замеров нагрузки', async () => {
  await p.goto(U + '#/settings'); await p.waitForSelector('.tz-now');
  await p.selectOption('.card:has(.tz-now) select', 'Asia/Vladivostok'); await p.click('.card:has(.tz-now) button:has-text("Сохранить")'); await p.waitForTimeout(1200);
  const title = await p.locator('.server-clock').getAttribute('title'); if (!/Vladivostok/.test(title)) throw new Error('пояс не применился: ' + title);
  await p.selectOption('.card:has(.tz-now) select', 'UTC'); await p.click('.card:has(.tz-now) button:has-text("Сохранить")'); await p.waitForTimeout(800);
  await p.click('.card:has-text("Как часто замерять") .seg-btn:text-is("5 мин")'); await p.waitForTimeout(500);
  const on = await p.textContent('.card:has-text("Как часто замерять") .seg-btn.active >> nth=0'); if (!on.includes('5 мин')) throw new Error('интервал не сохранился: ' + on);
  await p.click('.card:has-text("Как часто замерять") .seg-btn:text-is("1 мин")');
});
await step('канал уведомлений: список событий не пустой', async () => {
  await p.goto(U + '#/settings'); await p.waitForSelector('.card:has(h3:has-text("Уведомления"))');
  await p.click('button:has-text("Добавить канал")'); await p.waitForSelector('.modal .checklist label');
  const n = await p.locator('.modal .checklist label').count(); if (n < 5) throw new Error('событий: ' + n);
  await p.keyboard.press('Escape');
});
await step('«Добавить панель»: переключатель «Подключить» / «Установить и подключить»', async () => {
  await p.goto(U + '#/'); await p.waitForSelector('.panel-card'); await p.click('button:has-text("Добавить панель")'); await p.waitForSelector('.modal .seg-wide');
  const fits = await p.evaluate(() => [...document.querySelectorAll('.seg-wide .seg-btn')].every((b) => b.scrollWidth <= b.clientWidth + 1)); if (!fits) throw new Error('подпись обрезана');
  await p.waitForSelector('.modal input[placeholder="Прод EU"]');
  await p.click('.modal .seg-btn:has-text("Установить и подключить")'); await p.waitForSelector('.modal :text("Адрес сервера")');
  if (!(await p.locator('.modal-foot').isHidden())) throw new Error('кнопки подключения видны в режиме установки');
  await p.click('.modal .seg-btn:has-text("Подключить Easypanel")'); await p.waitForSelector('.modal input[placeholder="Прод EU"]'); await p.keyboard.press('Escape');
});
await step('история сервиса: деплой, лог; на кнопках кружок, пока действие идёт', async () => {
  await p.goto(U + '#/services'); await p.waitForSelector('.tbl');
  const row = p.locator('tr.row', { hasText: 'shop' }).filter({ hasText: 'api' }).first();
  await row.locator('.qa button[aria-label="Деплой"]').click(); await p.waitForSelector('.qa .spinner', { timeout: 3000 });
  await p.waitForSelector('.qa .spinner', { state: 'detached', timeout: 20000 });
  await row.click(); await p.waitForSelector('.drawer.in'); await p.click('.drawer .dtab:has-text("История")'); await p.waitForSelector('.hist-row');
  await p.locator('.hist-row.link').first().click(); await p.waitForSelector('.hist-log'); await p.waitForTimeout(400);
  const log = await p.locator('.hist-log').innerText(); if (!/Pulling image/.test(log)) throw new Error('лог: ' + log);
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
});
await step('журнал: текст ошибки виден целиком', async () => {
  await p.evaluate(() => fetch('/api/panels/1/service/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin' }, body: JSON.stringify({ type: 'app', project: 'no', name: 'such', action: 'deploy' }) }));
  await p.goto(U + '#/audit'); await p.waitForSelector('.audit-tbl'); await p.click('.seg-btn:has-text("Ошибки")'); await p.waitForTimeout(500);
  const d = p.locator('.audit-detail.open').first(); const clipped = await d.evaluate((el) => getComputedStyle(el).whiteSpace !== 'pre-wrap' || getComputedStyle(el).textOverflow === 'ellipsis');
  if (clipped) throw new Error('ошибка обрезана');
});
await step('страница не прыгает вверх при фоновом обновлении', async () => {
  await p.setViewportSize({ width: 1440, height: 520 });
  await p.goto(U + '#/services'); await p.waitForSelector('.tbl'); await p.evaluate(() => window.scrollTo(0, 250)); await p.waitForTimeout(200);
  const y0 = await p.evaluate(() => window.scrollY); if (y0 < 100) throw new Error('страница не прокрутилась: ' + y0);
  await p.evaluate(() => { window.__ys = []; const f = () => { window.__ys.push(window.scrollY); requestAnimationFrame(f); }; f(); });
  for (let i = 0; i < 3; i++) { await p.click('.topbar .btn.icon[aria-label="Обновить"]'); await p.waitForTimeout(500); }
  const min = Math.min(...(await p.evaluate(() => window.__ys))); if (min < y0 - 2) throw new Error(`прокрутка сбросилась: ${y0} → ${min}`);
  await p.setViewportSize({ width: 1440, height: 900 });
});
console.log(errors.join('\n') || 'no console errors');
await b.close();
if (failed) { console.error(`${failed} шаг(ов) не прошли`); process.exit(1); }
