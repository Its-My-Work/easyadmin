import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runServiceOp } from '../src/easypanel.js';

/* Домены сервиса: назначение (протокол, порт, путь) и сервис compose уходят в serviceDestination так же, как их хранит панель. */
const fake = () => { const calls = []; return { calls, mutate: async (proc, input) => { calls.push({ proc, input }); return null; } }; };
const ref = { type: 'compose', project: 'main', name: 'mcp-tools' };
// домен в том виде, в каком его отдаёт панель (ssh-mcp из реального стека)
const existing = { certificateResolver: '', host: 'mcp-ssh.example.com', https: true, id: 'd1', middlewares: ['auth'], path: '/', wildcard: false, destinationType: 'service',
  serviceDestination: { composeService: 'ssh-mcp', path: '/', port: 3000, projectName: 'main', protocol: 'http', serviceName: 'mcp-tools' } };

describe('домены: создание', () => {
  test('для compose: сервис стека, протокол, порт и путь назначения лежат в serviceDestination', async () => {
    const c = fake();
    await runServiceOp(c, 'domainAdd', ref, { host: 'filemcp.example.com', https: true, path: '/', port: '8080', protocol: 'https', destPath: '/api', composeService: 'desktop-auth' });
    const { proc, input } = c.calls[0];
    assert.equal(proc, 'domains.createDomain');
    assert.deepEqual(input.serviceDestination, { projectName: 'main', serviceName: 'mcp-tools', protocol: 'https', port: 8080, path: '/api', composeService: 'desktop-auth' });
    assert.deepEqual([input.host, input.https, input.path, input.destinationType, input.projectName, input.serviceName, input.port], ['filemcp.example.com', true, '/', 'service', 'main', 'mcp-tools', 8080]);
  });
  test('обычное приложение: без compose-сервиса, значения по умолчанию', async () => {
    const c = fake(); await runServiceOp(c, 'domainAdd', { type: 'app', project: 'p', name: 's' }, { host: 'a.example.com' });
    assert.deepEqual(c.calls[0].input.serviceDestination, { projectName: 'p', serviceName: 's', protocol: 'http', port: 80, path: '/' });
  });
  test('некорректные значения отвергаются до обращения к панели', async () => {
    for (const bad of [{ port: '0' }, { port: '70000' }, { port: 'x' }, { protocol: 'ftp' }, { destPath: 'api' }, { destPath: '/a b' }, { composeService: 'a b' }, { composeService: '../x' }]) {
      const c = fake(); await assert.rejects(async () => runServiceOp(c, 'domainAdd', ref, { host: 'a.example.com', ...bad }), /Порт|Протокол|Путь|Сервис compose/, JSON.stringify(bad)); assert.equal(c.calls.length, 0);
    }
  });
});

describe('домены: изменение', () => {
  test('меняется только заданное; middlewares, сертификат и прочие поля домена сохраняются', async () => {
    const c = fake();
    await runServiceOp(c, 'domainUpdate', ref, { id: 'd1', original: existing, host: 'mcp-ssh.example.com', https: true, path: '/', port: 3001, protocol: 'https', destPath: '/mcp', composeService: 'desktop-auth' });
    const b = c.calls[0].input;
    assert.deepEqual(b.serviceDestination, { composeService: 'desktop-auth', path: '/mcp', port: 3001, projectName: 'main', protocol: 'https', serviceName: 'mcp-tools' });
    assert.deepEqual([b.middlewares, b.wildcard, b.certificateResolver, b.destinationType, b.id, b.domainId, b.path], [['auth'], false, '', 'service', 'd1', 'd1', '/']);
  });
  test('путь домена и путь назначения независимы; незаданные поля назначения остаются прежними', async () => {
    const c = fake();
    await runServiceOp(c, 'domainUpdate', ref, { id: 'd1', original: existing, host: 'x.example.com', https: false, path: '/site', port: 3000 });
    const b = c.calls[0].input;
    assert.deepEqual([b.path, b.https, b.host], ['/site', false, 'x.example.com']);
    assert.deepEqual(b.serviceDestination, existing.serviceDestination, 'сервис compose, протокол и путь назначения не тронуты');
  });
  test('перевыпуск сертификата (без полей назначения) ничего в назначении не меняет', async () => {
    const c = fake(); await runServiceOp(c, 'domainUpdate', ref, { id: 'd1', original: existing, host: existing.host, https: true });
    assert.deepEqual(c.calls[0].input.serviceDestination, existing.serviceDestination);
  });
});
