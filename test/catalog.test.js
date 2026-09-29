import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { CatalogError, buildInput, checkSchema, createCatalog, formFields, prepareTemplateSource, runGenerate } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { parseYaml } from '../src/yaml-lite.js';
import { createMockPanel } from './mock-easypanel.js';

import { FILES } from './catalog-fixtures.js';

const fixtureFetch = async (url) => {
  const rel = String(url).replace(/^http:\/\/fixture\//, '');
  const body = FILES[rel];
  return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
};

describe('yaml-lite', () => {
  test('блочные и свёрнутые скаляры, списки, кавычки, вложенность', () => {
    const y = parseYaml(`# комментарий
a: 1
b: "two: 2"
c: 'it''s'
d: [x, "y z", 3]
folded:
  first line
  second line
lit: |
  keep
    indent
  end
fold: >-
  one
  two

  three
items:
  - name: n1
    url: u1
  - name: n2
    tags: [a, b]
same:
- 1
- 2
nested:
  deep:
    k: true
    v: ~
`);
    assert.deepEqual(y, {
      a: 1, b: 'two: 2', c: "it's", d: ['x', 'y z', 3], folded: 'first line second line', lit: 'keep\n  indent\nend\n', fold: 'one two\nthree',
      items: [{ name: 'n1', url: 'u1' }, { name: 'n2', tags: ['a', 'b'] }], same: [1, 2], nested: { deep: { k: true, v: null } },
    });
  });
  test('якоря и flow-словари не поддерживаются — честная ошибка, а не тихая порча', () => {
    assert.throws(() => parseYaml('a: &x 1'));
    assert.throws(() => parseYaml('a: {b: 1}'));
  });
});

describe('каталог: генерация схемы', () => {
  const cat = createCatalog({ base: 'http://fixture', fetchImpl: fixtureFetch });

  test('список: нормализация, теги со счётчиками, некорректные slug отбрасываются', async () => {
    const r = await cat.list();
    assert.equal(r.items.length, 6);
    assert.ok(!r.items.some((x) => x.slug.includes('..')));
    assert.equal(r.items[0].description, 'Demo app with a database');
    assert.deepEqual(r.tags.find((t) => t.name === 'Web'), { name: 'Web', count: 2 });
  });

  test('форма: поля, типы, варианты, обязательность, showIf; небезопасные ссылки скрыты', async () => {
    const d = await cat.details('demo');
    assert.equal(d.supported, true);
    assert.equal(d.description, 'Demo app that needs a database and some words.');
    assert.deepEqual(d.links, [{ label: 'Site', url: 'https://example.com' }]);
    const f = Object.fromEntries(d.fields.map((x) => [x.name, x]));
    assert.equal(f.dbEnabled.type, 'boolean'); assert.equal(f.dbEnabled.default, true);
    assert.equal(f.port.type, 'integer'); assert.equal(f.port.min, 1); assert.equal(f.port.max, 65535);
    assert.deepEqual(f.mode.options, [{ value: 'fast', label: 'Fast mode' }, { value: 'safe', label: 'Safe mode' }]);
    assert.equal(f.appServiceName.required, true);
    assert.equal(f.adminToken.secret, true); assert.deepEqual(f.adminToken.showIf, { field: 'mode', is: 'safe' });
    assert.equal(d._code, undefined, 'код шаблона наружу не отдаётся');
  });

  test('схема: подстановка значений, секреты случайные и общие для сервисов, без секретов в описании', async () => {
    const a = (await cat.schemaFor('demo', { appServiceName: 'my-demo', port: '9000', dbEnabled: true })).schema;
    const b = (await cat.schemaFor('demo', { appServiceName: 'my-demo' })).schema;
    assert.equal(a.services.length, 2);
    assert.equal(a.services[0].data.serviceName, 'my-demo'); assert.equal(a.services[1].data.serviceName, 'my-demo-db');
    const env = Object.fromEntries(a.services[0].data.env.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.equal(env.PORT, '9000'); assert.equal(env.MODE, 'safe');
    assert.match(env.DB_PASSWORD, /^[a-z0-9]{20}$/); assert.equal(a.services[1].data.password, env.DB_PASSWORD);
    assert.notEqual(a.services[1].data.password, b.services[1].data.password, 'каждый раз новые секреты');
    assert.equal(a.services[0].data.domains[0].port, 9000);
    const off = (await cat.schemaFor('demo', { dbEnabled: false })).schema;
    assert.equal(off.services.length, 1);
  });

  test('валидация значений формы', async () => {
    await assert.rejects(cat.schemaFor('demo', { port: 70000 }), /не больше/);
    await assert.rejects(cat.schemaFor('demo', { port: 'abc' }), /числом/);
    await assert.rejects(cat.schemaFor('demo', { mode: 'turbo' }), /недопустимое/);
    await assert.rejects(cat.schemaFor('demo', { appServiceName: 'x'.repeat(5000) }), /слишком длинное/);
    await assert.rejects(cat.schemaFor('needs-input', {}), /обязательно/);
    const ok = (await cat.schemaFor('needs-input', { token: 'secret' })).schema;
    assert.equal(ok.services[0].data.serviceName, 'r-6');
  });

  test('неподдерживаемые шаблоны понятно объясняются и не запускаются', async () => {
    const fsd = await cat.details('uses-fs'); assert.equal(fsd.supported, false); assert.match(fsd.reason, /fs/);
    const ecd = await cat.details('uses-ecdh'); assert.equal(ecd.supported, false); assert.match(ecd.reason, /криптограф/);
    await assert.rejects(cat.schemaFor('uses-fs', {}), (e) => e instanceof CatalogError && e.status === 422);
  });

  test('изоляция: нет process/fetch, eval и Function недоступны', async () => {
    const { schema } = await cat.schemaFor('probe', {});
    const env = schema.services[0].data.env;
    assert.match(env, /ESCAPED=blocked/);
    assert.match(env, /SEEN=undefined undefined undefined undefined/);
  });

  test('таймаут бесконечного цикла и ошибки кода шаблона', () => {
    const loop = prepareTemplateSource('export function generate(input: any) { while (true) {} }');
    assert.throws(() => runGenerate(loop, {}, { timeoutMs: 150 }), /слишком долго/);
    const boom = prepareTemplateSource('export function generate(input: any) { return nope.x; }');
    assert.throws(() => runGenerate(boom, {}), /Ошибка в коде шаблона/);
    const huge = prepareTemplateSource('export function generate(input: any) { return { s: "x".repeat(3000000) }; }');
    assert.throws(() => runGenerate(huge, {}), /некорректный результат/);
  });

  test('совместимость окружения: btoa/atob/Buffer/randomBytes дают те же значения, что Node', async () => {
    const { schema } = await cat.schemaFor('shims', {});
    const env = Object.fromEntries(schema.services[0].data.env.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.match(env.S, /^[a-z0-9]{11}$/);
    assert.equal(env.A, Buffer.from(env.S, 'latin1').toString('base64'));
    assert.equal(env.B, Buffer.from(env.S).toString('base64'));
    assert.equal(env.C, env.S);
    assert.equal(env.D, Buffer.from(env.S).toString('hex'));
    assert.match(env.H, /^[0-9a-f]{32}$/);
  });

  test('проверка схемы результата и вспомогательные функции', () => {
    assert.throws(() => checkSchema({ services: [] }), CatalogError);
    assert.throws(() => checkSchema({ services: [{ type: 'evil', data: { serviceName: 'x' } }] }), CatalogError);
    assert.throws(() => checkSchema({ services: [{ type: 'app', data: { serviceName: '../x' } }] }), CatalogError);
    const fields = formFields({ schema: { required: ['a'], properties: { a: { type: 'string', title: 'A' }, b: { type: 'boolean', title: 'B' } } } });
    assert.deepEqual(buildInput(fields, { a: 'x', b: 'true' }), { a: 'x', b: true });
    assert.throws(() => buildInput(fields, {}), /обязательно/);
  });

  test('некорректные и несуществующие slug; недоступный каталог', async () => {
    await assert.rejects(cat.details('../etc'), (e) => e.status === 400);
    await assert.rejects(cat.details('nope'), (e) => e.status === 404);
    const down = createCatalog({ base: 'http://fixture', fetchImpl: async () => { throw new Error('boom'); } });
    await assert.rejects(down.list(), (e) => e.status === 502 && /Не удалось загрузить каталог/.test(e.message));
  });
});

describe('каталог: API', () => {
  let fx, panel, app, base, tmp, panelId, cfg; const jars = {};
  const api = async (who, method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
    const raw = Buffer.from(await res.arrayBuffer());
    let data; try { data = JSON.parse(raw.toString()); } catch { data = raw; }
    return { status: res.status, data, headers: res.headers };
  };
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-cat-'));
    fx = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.slice(1));
      const body = FILES[rel];
      if (body === undefined) { res.writeHead(404); return res.end(); }
      res.writeHead(200); res.end(body);
    });
    await new Promise((r) => fx.listen(0, '127.0.0.1', r));
    panel = createMockPanel({ token: 'P', seed: { web: [{ name: 'site' }] } });
    const purl = await panel.listen();
    const config = { ...loadConfig({ EASYADMIN_DATA: tmp, EASYADMIN_CATALOG_URL: `http://127.0.0.1:${fx.address().port}` }), cacheTtlMs: 1, requestTimeoutMs: 3000, tlsProbe: false };
    cfg = config;
    app = createApp({ config, db: openDb(tmp), key: crypto.randomBytes(32) });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await api('admin', 'POST', '/api/setup', { username: 'admin', password: 'password1' });
    panelId = (await api('admin', 'POST', '/api/panels', { name: 'P', url: purl, token: 'P' })).data.id;
    await api('admin', 'POST', '/api/users', { username: 'ro', password: 'password1', role: 'viewer' });
    await api('ro', 'POST', '/api/login', { username: 'ro', password: 'password1' });
    await api('admin', 'GET', '/api/overview?force=1');
  });
  after(async () => { app.stop(); app.server.closeAllConnections(); app.server.close(); fx.close(); await panel.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('список, карточка и логотип (безопасные заголовки); чтение доступно наблюдателю', async () => {
    const list = await api('ro', 'GET', '/api/catalog');
    assert.equal(list.status, 200); assert.equal(list.data.items.length, 6); assert.ok(list.data.tags.length);
    const d = await api('ro', 'GET', '/api/catalog/demo');
    assert.equal(d.status, 200); assert.equal(d.data.name, 'Demo'); assert.equal(d.data.fields.length, 6);
    const logo = await api('ro', 'GET', '/api/catalog/logo/demo');
    assert.equal(logo.status, 200); assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.match(logo.headers.get('content-security-policy'), /sandbox/); assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await api('ro', 'GET', '/api/catalog/logo/probe')).status, 404, 'нет логотипа');
    assert.equal((await api('ro', 'GET', '/api/catalog/nope')).status, 404);
    assert.equal((await api('ro', 'GET', '/api/catalog/..%2F..%2Fetc%2Fpasswd')).status >= 400, true);
  });

  test('предпросмотр схемы и развёртывание: только админ, проект создаётся, дубликаты и неподдерживаемое отклоняются', async () => {
    assert.equal((await api('ro', 'POST', '/api/catalog/demo/schema', { values: {} })).status, 403);
    const pv = await api('admin', 'POST', '/api/catalog/demo/schema', { values: { appServiceName: 'pv' } });
    assert.equal(pv.status, 200); assert.equal(pv.data.schema.services[0].data.serviceName, 'pv');
    assert.equal((await api('ro', 'POST', `/api/panels/${panelId}/catalog/demo/deploy`, { project: 'cat', values: {} })).status, 403);
    const dep = await api('admin', 'POST', `/api/panels/${panelId}/catalog/demo/deploy`, { project: 'cat', values: { appServiceName: 'cd', mode: 'fast' } });
    assert.equal(dep.status, 200); assert.equal(dep.data.services, 2);
    const ov = (await api('admin', 'GET', '/api/overview?force=1')).data.find((x) => x.id === panelId);
    const svcs = ov.tree.projects.find((p) => p.name === 'cat')?.services.map((s) => s.name).sort();
    assert.deepEqual(svcs, ['cd', 'cd-db']);
    assert.equal((await api('admin', 'POST', `/api/panels/${panelId}/catalog/demo/deploy`, { project: 'cat', values: { appServiceName: 'cd' } })).status, 400, 'повтор — сервис уже есть');
    assert.equal((await api('admin', 'POST', `/api/panels/${panelId}/catalog/needs-input/deploy`, { project: 'cat', values: {} })).status, 400);
    assert.equal((await api('admin', 'POST', `/api/panels/${panelId}/catalog/uses-fs/deploy`, { project: 'cat', values: {} })).status, 422);
    assert.equal((await api('admin', 'POST', `/api/panels/${panelId}/catalog/nope/deploy`, { project: 'cat', values: {} })).status, 404);
    assert.equal((await api('admin', 'POST', `/api/panels/${panelId}/catalog/demo/deploy`, { project: '../x', values: {} })).status, 400);
    assert.ok((await api('admin', 'GET', '/api/audit?q=template.catalog')).data.some((a) => a.action === 'template.catalog' && a.ok === 1));
  });

  test('каталог можно отключить (EASYADMIN_CATALOG=off): все маршруты отвечают 404', async () => {
    cfg.catalogEnabled = false;
    try {
      for (const [m, p2, b] of [['GET', '/api/catalog'], ['GET', '/api/catalog/demo'], ['GET', '/api/catalog/logo/demo'], ['POST', '/api/catalog/demo/schema', { values: {} }], ['POST', `/api/panels/${panelId}/catalog/demo/deploy`, { project: 'off', values: {} }]]) {
        const r = await api('admin', m, p2, b);
        assert.equal(r.status, 404, `${m} ${p2}`);
      }
    } finally { cfg.catalogEnabled = true; }
    assert.equal((await api('admin', 'GET', '/api/catalog')).status, 200);
  });
});
