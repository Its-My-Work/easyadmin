import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FRAMINGS } from '../src/console.js';
import { openDb } from '../src/db.js';
import { createMockPanel } from './mock-easypanel.js';

let app, base, tmp, cfg; const jars = {}; const panels = []; const closers = [];
async function api(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
/** Читает SSE-поток консоли, пока накопленный вывод не удовлетворит условию. */
async function readUntil(cid, pred, timeoutMs = 4000) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(`${base}/api/console/${cid}/stream`, { headers: { Cookie: jars.admin }, signal: ac.signal });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let acc = ''; let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      acc += dec.decode(value, { stream: true });
      let i; while ((i = acc.indexOf('\n\n')) >= 0) { const block = acc.slice(0, i); acc = acc.slice(i + 2); const m = /^event: out\ndata: (.*)$/m.exec(block); if (m) text += JSON.parse(m[1]).text; }
      if (pred(text)) break;
    }
  } catch { /* таймаут */ } finally { clearTimeout(timer); ac.abort(); }
  return text;
}
const addPanel = async (name, opts) => {
  const m = createMockPanel({ token: 'T', seed: { web: [{ name: 'site' }] }, ...opts });
  panels.push(m); const url = await m.listen();
  return (await api('admin', 'POST', '/api/panels', { name, url, token: 'T' })).data.id;
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-con-'));
  cfg = { ...loadConfig({ EASYADMIN_DATA: tmp }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false };
  app = createApp({ config: cfg, db: openDb(tmp), key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
  await api('admin', 'POST', '/api/users', { username: 'op', password: 'password1', role: 'operator' });
  await api('op', 'POST', '/api/login', { username: 'op', password: 'password1' });
});
after(async () => { for (const c of closers) await c(); app.stop(); app.server.closeAllConnections(); app.server.close(); await Promise.all(panels.map((p) => p.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('консоль сервиса', () => {
  for (const framing of ['raw', 'json-input', 'json-stdin', 'json-data']) {
    test(`формат ввода «${framing}» определяется автоматически, команды выполняются, вывод приходит`, async () => {
      const id = await addPanel(`P-${framing}`, { consolePath: '/ws/serviceConsole', consoleFraming: framing });
      const o = await api('admin', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site' });
      assert.equal(o.status, 200, JSON.stringify(o.data));
      // сервер с {"data": …} принимает и {"type":"input","data": …} — любой из этих форматов рабочий
      assert.ok(framing === 'json-data' ? ['json-input', 'json-data'].includes(o.data.framing) : o.data.framing === framing, `определён ${o.data.framing}`); assert.equal(o.data.detected, true); assert.equal(o.data.path, '/ws/serviceConsole');
      const reading = readUntil(o.data.id, (t) => t.includes('hello-world'));
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await api('admin', 'POST', `/api/console/${o.data.id}/input`, { data: 'echo hello-world\n' })).status, 200);
      assert.match(await reading, /hello-world/);
      const c = await api('admin', 'DELETE', `/api/console/${o.data.id}`);
      assert.equal(c.status, 200);
      assert.equal((await api('admin', 'POST', `/api/console/${o.data.id}/input`, { data: 'x\n' })).status, 404, 'сеанс закрыт');
    });
  }

  test('путь терминала находится в интерфейсе панели, если он нестандартный; ручной путь проверяется', async () => {
    const id = await addPanel('P-found', { newStats: true, consolePath: '/ws/custom-terminal', consoleFraming: 'raw' });
    const paths = await api('admin', 'GET', `/api/panels/${id}/console/paths`);
    assert.ok(paths.data.related.includes('/ws/custom-terminal'));
    const o = await api('admin', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site' });
    assert.equal(o.status, 200); assert.equal(o.data.path, '/ws/custom-terminal');
    await api('admin', 'DELETE', `/api/console/${o.data.id}`);
    const manual = await api('admin', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site', path: '/ws/custom-terminal', framing: 'raw' });
    assert.equal(manual.status, 200); assert.equal(manual.data.detected, true);
    await api('admin', 'DELETE', `/api/console/${manual.data.id}`);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site', path: '../etc/passwd' })).status, 400);
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site', framing: 'evil' })).status, 400);
  });

  test('панель без консоли: понятная ошибка со списком попыток; всё в журнале', async () => {
    const id = await addPanel('P-none', {});
    const r = await api('admin', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site' });
    assert.equal(r.status, 502); assert.match(r.data.error, /Не удалось подключиться/); assert.ok(r.data.attempts.length >= 3);
    const audit = (await api('admin', 'GET', '/api/audit?q=console.open')).data;
    assert.ok(audit.some((a) => a.action === 'console.open' && a.ok === 0));
  });

  test('права и лимиты: только админ, чужой сеанс недоступен, не более трёх консолей, ввод ограничен', async () => {
    const id = await addPanel('P-lim', { consolePath: '/ws/serviceConsole', consoleFraming: 'raw' });
    assert.equal((await api('op', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site' })).status, 403);
    assert.equal((await api('op', 'GET', `/api/panels/${id}/console/paths`)).status, 403);
    const sessions = [];
    for (let i = 0; i < 3; i++) { const o = await api('admin', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site', framing: 'raw' }); assert.equal(o.status, 200); sessions.push(o.data.id); }
    assert.equal((await api('admin', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site', framing: 'raw' })).status, 429);
    assert.equal((await api('admin', 'POST', `/api/console/${sessions[0]}/input`, { data: 'x'.repeat(20000) })).status, 400);
    assert.equal((await api('admin', 'POST', `/api/console/${sessions[0]}/input`, {})).status, 400);
    assert.equal((await api('op', 'POST', `/api/console/${sessions[0]}/input`, { data: 'ls\n' })).status, 403);
    assert.equal((await api('admin', 'POST', `/api/console/nope/input`, { data: 'ls\n' })).status, 404);
    assert.equal((await api('admin', 'POST', `/api/console/${sessions[0]}/framing`, { framing: 'json-data' })).data.framing, 'json-data');
    for (const s of sessions) await api('admin', 'DELETE', `/api/console/${s}`);
    const closed = (await api('admin', 'GET', '/api/audit?q=console.close')).data;
    assert.ok(closed.some((a) => /команд/.test(a.detail ?? '')), 'счётчик команд в журнале');
    assert.ok(!JSON.stringify((await api('admin', 'GET', '/api/audit?limit=500')).data).includes('echo hello-world'), 'сами команды в журнал не пишутся');
  });

  test('консоль можно отключить (EASYADMIN_CONSOLE=off)', async () => {
    const id = await addPanel('P-off', { consolePath: '/ws/serviceConsole' });
    cfg.consoleEnabled = false;
    try {
      assert.equal((await api('admin', 'POST', `/api/panels/${id}/console`, { type: 'app', project: 'web', name: 'site' })).status, 404);
      assert.equal((await api('admin', 'GET', `/api/panels/${id}/console/paths`)).status, 404);
    } finally { cfg.consoleEnabled = true; }
  });

  test('настройки панели: процедуры из интерфейса панели, чтение/запись/осторожные, парные get→set; только админ', async () => {
    const id = await addPanel('P-set', { newStats: true });
    const r = await api('admin', 'GET', `/api/panels/${id}/settings/procedures`);
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.data.items.map((x) => [x.name, x]));
    assert.equal(by['branding.getBasicSettings'].kind, 'read');
    assert.equal(by['settings.restartEasypanel'].danger, true); assert.equal(by['settings.restartEasypanel'].kind, 'write');
    assert.equal(by['settings.setPanelDomain'].kind, 'write'); assert.equal(by['settings.setPanelDomain'].danger, false);
    assert.ok(!('dashboard.getOverview' in by), 'посторонние разделы не показываем');
    assert.ok(r.data.discovered > 0);
    assert.equal((await api('op', 'GET', `/api/panels/${id}/settings/procedures`)).status, 403);
    // чтение идёт через существующую консоль API (только админ, мутации в журнале)
    const read = await api('admin', 'POST', `/api/panels/${id}/trpc`, { kind: 'query', procedure: 'branding.getBasicSettings' });
    assert.equal(read.data.result.name, 'Easypanel');
  });

  test('форматы ввода — корректный JSON/текст', () => {
    for (const [name, f] of Object.entries(FRAMINGS)) {
      const out = f('echo "hi"\n');
      if (name === 'raw') assert.equal(out, 'echo "hi"\n'); else assert.equal(Object.values(JSON.parse(out)).at(-1), 'echo "hi"\n');
    }
  });
});
