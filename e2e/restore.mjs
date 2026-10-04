// Мастер восстановления данных: экран за экраном, с подставными ответами сервера (скрипты на хосте проверяются в test/datarestore.test.js).
// Требуется: playwright, npm run demo (DEMO_BACKUPS=1). Запуск: node e2e/restore.mjs   (RESTORE_W=390 — узкий экран)
import { chromium } from 'playwright';
const W = Number(process.env.RESTORE_W || 1280);
const U = 'http://127.0.0.1:3100/';
const b = await chromium.launch({ ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}), args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: W, height: 900 }, colorScheme: 'dark', locale: 'ru-RU', ...(W < 700 ? { isMobile: true, hasTouch: true } : {}) });
await ctx.addInitScript(() => { try { localStorage.setItem('ea-lang', 'ru'); } catch {} });
const p = await ctx.newPage(); const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
let failed = 0; const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: 'restore-fail.png' }); } };
await p.goto(U); await p.fill('input[type=password]', 'demo12345'); await p.fill('input:not([type=password])', 'admin'); await p.click('button[type=submit]'); await p.waitForSelector('.topbar');
const panels = await p.evaluate(async () => (await fetch('/api/overview', { headers: { 'X-Requested-With': 'easyadmin' } })).json());
const pid = panels.find((x) => x.tree?.projects?.length).id;
const NAME = 'shop__db__20261003-030000.tar.enc'; let planned = []; let posted = null; let jobs = 0;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const MEMBERS = [{ member: 'db-postgres.sql.gz', size: 2_400_000 }, { member: 'vol-uploads.tar.gz', size: 15_000_000 }];
await p.route('**/api/backups/data/files*', (r) => json(r, { files: [{ panelId: pid, panel: 'Прод', name: NAME, size: 17_000_000, ts: Date.now() - 3600e3 }] }));
await p.route('**/api/backups/data/inspect', (r) => json(r, { id: 'i1' }));
await p.route('**/api/backups/data/job?id=i1', (r) => json(r, { id: 'i1', status: 'done', members: MEMBERS }));
await p.route('**/api/backups/data/restore-plan', async (r) => { const body = r.request().postDataJSON(); planned.push(body.target); const same = body.target.service === 'db';
  json(r, { type: 'postgres', target: `${body.target.project}/${body.target.service}`, items: MEMBERS.map((m) => ({ member: m.member, status: m.member.startsWith('db-') ? 'ok' : (same ? 'nomatch' : 'nomatch'), kind: m.member.startsWith('db-') ? 'postgres' : 'volume', target: `${body.target.project}/${body.target.service} · postgres` })) }); });
await p.route('**/api/backups/data/restore', async (r) => { posted = r.request().postDataJSON(); json(r, { id: 'x1', target: 'shop/db', parts: 2, restoring: 1, skipped: 1 }); });
await p.route('**/api/backups/data/job?id=x1', (r) => { jobs++; json(r, { id: 'x1', kind: 'restore', status: jobs < 3 ? 'running' : 'done', target: 'shop/db', targetPanel: 'Прод', mode: 'clean', startedAt: Date.now() - 5000, by: 'admin', snapDir: jobs < 3 ? null : '/var/backups/easyadmin/before-restore/x1',
  parts: [{ member: 'db-postgres.sql.gz', result: jobs < 3 ? 'run' : 'ok', target: 'shop/db · postgres', status: 'ok' }, { member: 'vol-uploads.tar.gz', result: 'skip', status: 'nomatch' }] }); });
const overflow = () => p.evaluate(() => { const m = document.querySelector('.modal'); if (!m) return 0; const r = m.getBoundingClientRect(); return Math.max(0, Math.round(r.right - document.documentElement.clientWidth), Math.round(m.scrollWidth - m.clientWidth)); });

await p.goto(U + '#/backups'); await p.waitForSelector('.tbl.compact tr.row');
await step('открыть копии сервиса и мастер', async () => {
  await p.locator('.tbl.compact tr.row').first().click(); await p.waitForSelector('.modal .list-item:has-text("shop__db")');
  await p.click('.modal button:has-text("Восстановить")'); await p.waitForSelector('.modal .rw-part');
  const n = await p.locator('.modal .rw-part').count(); if (n !== 2) throw new Error('частей ' + n);
});
await step('сопоставление: подходящая часть отмечена, неподходящая отключена', async () => {
  await p.waitForSelector('.modal .rw-part.dim'); const dis = await p.locator('.modal .rw-part.dim input').isDisabled(); if (!dis) throw new Error('неподходящая часть доступна');
  if (!await p.locator('.modal .rw-part >> nth=0').locator('input').isChecked()) throw new Error('подходящая часть не отмечена');
  await p.screenshot({ path: `restore-1-${W}.png` });
});
await step('в другой сервис: пересчёт плана', async () => {
  const before = planned.length; await p.click('.modal .seg-btn:has-text("В другой сервис")'); await p.waitForTimeout(600);
  if (planned.length <= before) throw new Error('план не пересчитан'); await p.screenshot({ path: `restore-2-${W}.png` });
});
await step('в новый сервис: поля имени, без плана', async () => {
  await p.click('.modal .seg-btn:has-text("В новый сервис")'); await p.waitForSelector('.modal input[list="rw-projects"]'); await p.fill('.modal input.mono >> nth=1', 'db-copy');
  if (await overflow()) throw new Error('окно выходит за экран'); await p.screenshot({ path: `restore-3-${W}.png` });
});
await step('в тот же сервис: подтверждение вводом имени и запуск', async () => {
  await p.click('.modal .seg-btn:has-text("В тот же сервис")'); await p.waitForTimeout(500); await p.click('.modal .seg-btn:has-text("Дописать поверх")'); await p.click('.modal .seg-btn:has-text("Заменить данные")');
  await p.click('.modal button:has-text("Восстановить (1)")'); await p.waitForSelector('.modal input[placeholder]');
  const btn = p.locator('.modal-foot .btn.danger'); if (!await btn.isDisabled()) throw new Error('кнопка не заблокирована до ввода имени');
  await p.fill('.modal input[placeholder]', await p.locator('.modal code').last().innerText()); await btn.click();
  await p.waitForSelector('.modal .badge:has-text("Восстановлено")', { timeout: 15000 }); await p.screenshot({ path: `restore-4-${W}.png` });
  if (!posted || posted.confirm !== true || posted.mode !== 'clean' || posted.snapshot !== true || posted.members.join() !== 'db-postgres.sql.gz' || posted.target.service !== 'db') throw new Error('неверный запрос: ' + JSON.stringify(posted));
  await p.waitForSelector('.modal:has-text("before-restore")');
});
await b.close(); if (errors.length) { console.log(errors.join('\n')); failed++; } process.exit(failed ? 1 : 0);
