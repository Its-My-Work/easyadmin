// Проверка полноты локализации: обходит экраны в английском режиме и ищет непереведённые русские строки.
// Требуется: npm i --no-save playwright; npm run demo (в другом терминале). Запуск: node e2e/i18n.mjs
import { chromium } from 'playwright';

const U = 'http://127.0.0.1:3100/';
// данные пользователя (названия из демо), которые переводить не нужно
const DATA = /Прод · (EU|US)|Стейджинг|Клиент Acme|Старый сервер|^Русский$|Language \/ Язык|^Панели?$/;
const b = await chromium.launch({ ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', locale: 'en-US' });
await ctx.addInitScript(() => { try { localStorage.setItem('ea-lang', 'en'); } catch {} });
const p = await ctx.newPage();
const found = new Map();
const scan = async (where) => {
  const items = await p.evaluate(() => {
    const out = [], cy = /[А-Яа-яЁё]/;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { const t = n.nodeValue.trim(); if (t && cy.test(t) && n.parentElement && !['SCRIPT', 'STYLE'].includes(n.parentElement.tagName)) out.push(t); }
    for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) for (const a of ['placeholder', 'title', 'aria-label']) { const v = el.getAttribute(a); if (v && cy.test(v)) out.push(`[${a}] ${v}`); }
    for (const el of document.querySelectorAll('option')) if (cy.test(el.textContent)) out.push(el.textContent.trim());
    return out;
  });
  for (const t of items) if (!DATA.test(t.replace(/^\[[^\]]+\]\s*/, ''))) { if (!found.has(t)) found.set(t, where); }
};
const step = async (name, fn) => { try { await fn(); await scan(name); } catch (e) { console.log('STEP FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `i18n-fail-${name.replace(/\W+/g, '_')}.png` }); await scan(name + ' (failed)'); } };
const esc = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(150); };

await p.goto(U);
await step('login', async () => { await p.waitForSelector('input[type=password]'); });
await p.fill('input[placeholder="Username"]', 'admin').catch(() => {});
await p.fill('input[type=password]', 'demo12345'); await p.click('button[type=submit]');
await p.waitForSelector('.panel-card');
await step('dashboard', async () => { await p.waitForTimeout(600); });
await step('cleanup modal', async () => { await p.click('button:has-text("Docker cleanup")'); await p.waitForSelector('.modal'); await scan('cleanup'); await esc(); });
await step('add panel modal', async () => { await p.click('button:has-text("Add panel") >> nth=0'); await p.waitForSelector('.modal'); await scan('add-panel'); await p.click('.modal .linkbtn'); await p.click('.modal-foot button:has-text("Test")'); await p.waitForTimeout(400); await scan('add-panel-test'); await esc(); });
await step('panel page', async () => { await p.click('.nav-panel >> nth=0'); await p.waitForSelector('.project'); await p.waitForTimeout(400); });
await step('diagnostics', async () => { await p.click('button[title^="Diagnostics"]'); await p.waitForSelector('.diag'); await p.waitForTimeout(400); await scan('diag'); await esc(); });
await step('system menu', async () => { await p.click('button[title="System"]'); await p.waitForSelector('.modal'); await scan('system'); await esc(); });
await step('new project modal + error', async () => { await p.click('button:has-text("Project") >> nth=0'); await p.fill('.modal input', 'bad name!'); await p.click('.modal-foot button:has-text("Create")'); await p.waitForSelector('.toast'); await scan('new-project-error'); await esc(); });
await step('new service modal', async () => { await p.click('button:has-text("Service") >> nth=0'); await p.waitForSelector('.modal'); await scan('new-service'); await esc(); });
await step('activity/console tabs', async () => { await p.click('.tab:has-text("Activity")'); await p.waitForTimeout(400); await scan('activity'); await p.click('.tab:has-text("API console")'); await p.click('button:has-text("Run")'); await p.waitForTimeout(500); await scan('console'); await p.click('.tab:has-text("Services")'); });
await step('drawer tabs', async () => {
  await p.locator('tr.row', { hasText: 'web' }).first().click(); await p.waitForSelector('.drawer.in'); await p.waitForTimeout(500); await scan('drawer overview');
  for (const t of await p.locator('.drawer .dtab .lbl').allTextContents()) {
    await p.click(`.drawer .dtab:has(.lbl:text-is("${t}"))`); await p.waitForTimeout(t === 'Logs' ? 900 : 250); await scan(`drawer ${t}`);
    if (t === 'Environment') { await p.click('.drawer button:has-text("Show values")'); await scan('drawer env shown'); await p.click('.drawer button:has-text("Hide")'); }
  }
  for (const [tab, btn] of [['Domains', 'Add domain'], ['Ports and volumes', 'Expose port'], ['Ports and volumes', 'Add mount']]) {
    await p.click(`.drawer .dtab:has(.lbl:text-is("${tab}"))`); await p.click(`.drawer .section-head button:has-text("${btn}")`); await p.waitForSelector('.modal'); await scan(`form ${btn}`);
    await p.click('.modal-foot button:has-text("Save")'); await p.waitForTimeout(300); await scan(`form ${btn} error`); await esc();
  }
  await p.click('.drawer .dtab:has(.lbl:text-is("Overview"))'); await p.click('.drawer button:has-text("Clone")'); await p.waitForSelector('.modal'); await scan('clone modal'); await esc();
  await p.click('.drawer button:has-text("Save as template")'); await p.waitForSelector('.modal'); await scan('template modal'); await esc();
  await p.click('.drawer .dtab:has(.lbl:text-is("Automation"))'); await p.click('.drawer button:has-text("Deploy webhook")'); await p.waitForSelector('.modal'); await scan('webhook modal'); await esc();
  await p.click('.drawer .dtab:has(.lbl:text-is("Delete"))'); await scan('danger tab'); await p.click('.drawer button:has-text("Delete service")'); await p.waitForSelector('.modal'); await scan('delete confirm'); await esc();
  await p.keyboard.press('Escape');
});
await step('service action toasts', async () => { const row = p.locator('tr.row', { hasText: 'worker' }).first(); await row.hover(); await row.locator('button[title="Restart"]').click(); await p.waitForSelector('.toast.success'); await scan('toast'); });
await step('all services + bulk', async () => {
  await p.goto(U + '#/services'); await p.waitForSelector('.tbl'); await p.click('thead input[type=checkbox]'); await scan('bulkbar');
  await p.click('.bulkbar button:has-text("Env…")'); await p.waitForSelector('.modal'); await scan('bulk env'); await esc();
  await p.click('.bulkbar button:has-text("Image…")'); await p.waitForSelector('.modal'); await scan('bulk image'); await esc();
  await p.click('.bulkbar button:has-text("Restart")'); await p.waitForSelector('.modal'); await scan('bulk confirm'); await p.click('.modal-foot .btn.primary'); await p.waitForSelector('.modal .result-list, .toast.success', { timeout: 15000 }); await scan('bulk result'); await esc();
  await p.click('.bulkbar button:has-text("Clear selection")', { timeout: 1500 }).catch(() => {});
});
await step('new service from All services', async () => { await p.click('button:has-text("New service")'); await p.waitForSelector('.modal'); await scan('new service (global)'); await p.fill('.modal input[placeholder="my-project"]', 'brand-new'); await scan('new service (new project hint)'); await p.click('.modal-foot button:has-text("Create")'); await p.waitForTimeout(300); await scan('new service error'); await esc(); });
await step('templates', async () => { await p.goto(U + '#/templates'); await p.waitForTimeout(400); });
await step('templates catalog', async () => {
  await p.goto(U + '#/templates'); await p.click('.seg-btn:has-text("Easypanel catalog")'); await p.waitForSelector('.cat-card'); await scan('catalog');
  await p.locator('.cat-card', { hasText: 'Demo' }).first().click(); await p.waitForSelector('.modal .cat-head'); await scan('catalog template'); await esc();
  await p.fill('.cat-bar input.search', 'uses fs'); await p.locator('.cat-card').first().click(); await p.waitForSelector('.modal .callout.warn'); await scan('catalog unsupported'); await esc();
  await p.click('.seg-btn:has-text("My templates")'); await p.click('button:has-text("Import Easypanel schema")'); await p.waitForSelector('.modal textarea'); await scan('import schema'); await esc();
});
await step('service console + panel settings', async () => {
  await p.goto(U + '#/panel/1'); await p.waitForSelector('.project');
  await p.locator('tr.row', { hasText: 'worker' }).first().click(); await p.waitForSelector('.drawer.in');
  await p.click('.drawer .dtab:has-text("Logs and console")'); await p.waitForSelector('.logview .ll', { timeout: 8000 }); await scan('logs and console idle');
  await p.click('.drawer summary:has-text("Connection settings")'); await scan('console settings');
  await p.fill('.term-input', 'echo hi'); await p.press('.term-input', 'Enter'); await p.waitForSelector('.drawer :text("Terminal connected")', { timeout: 12000 }); await p.waitForTimeout(400); await scan('console connected');
  await p.click('.drawer button:has-text("Disconnect terminal")'); await p.keyboard.press('Escape');
  await p.goto(U + '#/panel/1/settings'); await p.waitForSelector('.set-group'); await scan('panel settings');
  await p.fill('.page input.search', 'listUsers'); await p.click('.set-group .list-item:has-text("listUsers") button:has-text("Read")'); await p.waitForSelector('.modal table.tbl'); await scan('settings table'); await esc();
  await p.fill('.page input.search', 'systemPrune'); await p.click('.set-group .list-item:has-text("systemPrune") button:has-text("Run")'); await p.waitForSelector('.modal'); await scan('settings one-click'); await esc();
  await p.fill('.page input.search', 'generateApiToken'); await p.click('.set-group .list-item:has-text("generateApiToken") button:has-text("Change")'); await p.waitForSelector('.modal textarea'); await scan('settings edit'); await esc();
});
await step('schedules', async () => { await p.goto(U + '#/schedules'); await p.waitForTimeout(300); await scan('schedules empty'); await p.click('button:has-text("New schedule")'); await p.waitForSelector('.modal'); await scan('schedule modal'); await p.selectOption('.modal select >> nth=0', 'system'); await scan('schedule system'); await p.selectOption('.modal select >> nth=2', 'interval').catch(() => {}); await scan('schedule interval'); await p.click('.modal-foot button:has-text("Create")'); await p.waitForTimeout(400); await scan('schedule error'); await esc(); });
await step('inventory', async () => { await p.goto(U + '#/inventory'); await p.waitForSelector('.diff-row, .tbl', { timeout: 15000 }); await scan('images'); await p.click('.seg button:has-text("Certificates")'); await p.waitForSelector('.badge', { timeout: 8000 }); await scan('certs'); await p.locator('button:has-text("Reissue")').first().click(); await p.waitForSelector('.modal'); await scan('reissue confirm'); await esc(); });
await step('audit', async () => { await p.goto(U + '#/audit'); await p.waitForSelector('.tbl tbody tr'); });
await step('settings', async () => {
  await p.goto(U + '#/settings'); await p.waitForSelector('.card'); await p.waitForTimeout(500);
  await p.click('button:has-text("Add channel")'); await p.waitForSelector('.modal'); await scan('channel telegram'); await p.selectOption('.modal select', 'email'); await scan('channel email'); await p.selectOption('.modal select', 'webhook'); await scan('channel webhook'); await p.click('.modal-foot button:has-text("Save")'); await p.waitForTimeout(300); await scan('channel error'); await esc();
});
await step('profile', async () => { await p.click('.side-foot a.user'); await p.waitForSelector('.profile-hero'); await p.waitForSelector('.list-item:has-text("This device")'); await scan('profile'); await p.click('button:has-text("Change password")'); await p.waitForTimeout(300); await scan('profile password error'); });
await step('users', async () => {
  await p.click('.nav-item:has-text("Users")'); await p.waitForSelector('.tbl'); await scan('users');
  await p.click('button:has-text("Add user")'); await p.waitForSelector('.modal'); await scan('user form (new)'); await p.click('.modal-foot button:has-text("Save")'); await p.waitForTimeout(300); await scan('user form error'); await esc();
  await p.locator('tr.row').first().click(); await p.waitForSelector('.modal'); await scan('user form (edit)'); await esc();
  await p.locator('tr.row', { hasText: 'Прод' }).count(); await scan('users after');
});
await step('palette', async () => { await p.keyboard.press('Control+k'); await p.waitForSelector('.pal-item'); await scan('palette'); await esc(); });
await step('logout → login page', async () => { await p.click('.side-foot button[title="Sign out"]'); await p.waitForSelector('input[type=password]'); await p.fill('input[type=password]', 'x'); await p.fill('input[placeholder="Username"]', 'nobody'); await p.click('button[type=submit]'); await p.waitForTimeout(600); });

console.log(found.size ? `Непереведено (${found.size}):` : 'Всё переведено ✔');
for (const [t, w] of found) console.log(` - ${JSON.stringify(t)}   [${w}]`);
await b.close();
process.exit(found.size ? 1 : 0);
