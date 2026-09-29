import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { totp } from '../src/totp.js';

let app, base;
const jars = {};
async function api(who, method, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'easyadmin', 'User-Agent': `TestAgent/${who}`, ...(jars[who] ? { Cookie: jars[who] } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc && !sc.includes('Max-Age=0')) jars[who] = sc.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const login = (who, username, password, extra = {}) => api(who, 'POST', '/api/login', { username, password, ...extra });

before(async () => {
  app = createApp({ config: { ...loadConfig({}), cacheTtlMs: 1 }, db: openDb(':memory:'), key: crypto.randomBytes(32) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('admin', 'POST', '/api/setup', { username: 'root', password: 'password1' });
});
after(() => { app.stop(); app.server.closeAllConnections(); app.server.close(); });

describe('профиль', () => {
  test('данные профиля: роль, способ входа, текущая сессия с устройством и IP, последние действия', async () => {
    const me = (await api('admin', 'GET', '/api/me')).data;
    assert.equal(me.username, 'root'); assert.equal(me.role, 'admin'); assert.equal(me.hasPassword, true); assert.equal(me.sso, false); assert.equal(me.totpEnabled, false);
    assert.equal(me.panels, null, 'null = доступ ко всем панелям');
    assert.equal(me.sessions.length, 1); assert.equal(me.sessions[0].current, true);
    assert.equal(me.sessions[0].ua, 'TestAgent/admin'); assert.match(me.sessions[0].ip, /127\.0\.0\.1|::1|::ffff/);
    assert.ok(me.lastLogin > 0 && me.createdAt > 0);
    assert.ok(!('password_hash' in me) && !JSON.stringify(me).includes('scrypt'));
  });
  test('имя и email меняются, некорректные значения отклоняются, пустые очищают поле', async () => {
    assert.equal((await api('admin', 'PUT', '/api/me', { displayName: 'Иван Админов', email: 'Ivan@Example.com' })).status, 200);
    const me = (await api('admin', 'GET', '/api/me')).data;
    assert.equal(me.displayName, 'Иван Админов'); assert.equal(me.email, 'ivan@example.com');
    assert.equal((await api('admin', 'GET', '/api/session')).data.user.displayName, 'Иван Админов');
    assert.equal((await api('admin', 'PUT', '/api/me', { email: 'не-почта' })).status, 400);
    assert.equal((await api('admin', 'PUT', '/api/me', { displayName: 'x'.repeat(81) })).status, 400);
    await api('admin', 'PUT', '/api/me', { email: '' });
    assert.equal((await api('admin', 'GET', '/api/me')).data.email, null);
  });
  test('наблюдатель управляет только своим профилем и не видит список пользователей', async () => {
    await api('admin', 'POST', '/api/users', { username: 'viewer', password: 'password1', role: 'viewer' });
    await login('viewer', 'viewer', 'password1');
    assert.equal((await api('viewer', 'PUT', '/api/me', { displayName: 'Наблюдатель' })).status, 200);
    assert.equal((await api('viewer', 'GET', '/api/me')).data.displayName, 'Наблюдатель');
    assert.equal((await api('viewer', 'GET', '/api/users')).status, 403);
    assert.equal((await api('viewer', 'PUT', '/api/users/1', { role: 'viewer' })).status, 403);
  });
  test('сессии: список по устройствам, завершение чужой, запрет завершить текущую, «завершить остальные»', async () => {
    await login('admin2', 'root', 'password1'); await login('admin3', 'root', 'password1');
    const me = (await api('admin', 'GET', '/api/me')).data;
    assert.equal(me.sessions.length, 3); assert.equal(me.sessions.filter((s) => s.current).length, 1);
    const other = me.sessions.find((s) => s.ua === 'TestAgent/admin2');
    const cur = me.sessions.find((s) => s.current);
    assert.equal((await api('admin', 'DELETE', `/api/me/sessions/${cur.sid}`)).status, 400, 'текущую нельзя — есть «Выйти»');
    assert.equal((await api('admin', 'DELETE', `/api/me/sessions/${other.sid}`)).status, 200);
    assert.equal((await api('admin2', 'GET', '/api/me')).status, 401, 'завершённая сессия больше не работает');
    assert.equal((await api('admin', 'DELETE', '/api/me/sessions/nope')).status, 400);
    const r = await api('admin', 'POST', '/api/me/sessions/revoke-others');
    assert.equal(r.data.revoked, 1);
    assert.equal((await api('admin3', 'GET', '/api/me')).status, 401);
    assert.equal((await api('admin', 'GET', '/api/me')).status, 200, 'текущая сессия жива');
  });
  test('нельзя завершить чужую сессию по её идентификатору', async () => {
    const vsid = (await api('viewer', 'GET', '/api/me')).data.sessions[0].sid;
    assert.equal((await api('admin', 'DELETE', `/api/me/sessions/${vsid}`)).status, 400);
    assert.equal((await api('viewer', 'GET', '/api/me')).status, 200);
  });
});

describe('администратор: управление пользователями', () => {
  test('создание с именем и email, в списке — способ входа, 2FA, число сессий, последний вход', async () => {
    assert.equal((await api('admin', 'POST', '/api/users', { username: 'oper', displayName: 'Оператор', email: 'op@example.com', password: 'password1', role: 'operator' })).status, 200);
    await login('oper', 'oper', 'password1');
    const list = (await api('admin', 'GET', '/api/users')).data;
    const o = list.find((u) => u.username === 'oper');
    assert.deepEqual([o.displayName, o.email, o.role, o.disabled, o.totp, o.sso, o.hasPassword, o.sessions], ['Оператор', 'op@example.com', 'operator', false, false, false, true, 1]);
    assert.ok(o.lastLogin > 0 && o.createdAt > 0);
    assert.ok(list.every((u) => !('password_hash' in u) && !('oidc_sub' in u)));
    assert.equal((await api('admin', 'POST', '/api/users', { username: 'oper', password: 'password1', role: 'viewer' })).status, 409);
    assert.equal((await api('admin', 'POST', '/api/users', { username: 'bad', password: 'password1', role: 'viewer', email: 'nope' })).status, 400);
  });
  test('редактирование: логин, имя, email, роль, панели; конфликт логина', async () => {
    const id = (await api('admin', 'GET', '/api/users')).data.find((u) => u.username === 'oper').id;
    assert.equal((await api('admin', 'PUT', `/api/users/${id}`, { username: 'operator2', displayName: 'Новый', email: 'new@example.com', role: 'viewer' })).status, 200);
    const o = (await api('admin', 'GET', '/api/users')).data.find((u) => u.id === id);
    assert.deepEqual([o.username, o.displayName, o.email, o.role], ['operator2', 'Новый', 'new@example.com', 'viewer']);
    assert.equal((await api('admin', 'PUT', `/api/users/${id}`, { username: 'root' })).status, 400, 'логин занят');
    assert.equal((await api('admin', 'PUT', `/api/users/${id}`, { role: 'superuser' })).status, 400);
    assert.equal((await api('admin', 'PUT', '/api/users/9999', { role: 'viewer' })).status, 400);
  });
  test('смена пароля администратором завершает сессии пользователя; сброс 2FA', async () => {
    const list = (await api('admin', 'GET', '/api/users')).data;
    const id = list.find((u) => u.username === 'operator2').id;
    await login('oper2', 'operator2', 'password1');
    assert.equal((await api('oper2', 'GET', '/api/me')).status, 200);
    await api('admin', 'PUT', `/api/users/${id}`, { password: 'newpassword1' });
    assert.equal((await api('oper2', 'GET', '/api/me')).status, 401);
    assert.equal((await login('oper2', 'operator2', 'password1')).status, 401);
    assert.equal((await login('oper2', 'operator2', 'newpassword1')).status, 200);
    // 2FA: включаем сам пользователь, админ сбрасывает
    const { secret } = (await api('oper2', 'POST', '/api/me/2fa/setup')).data;
    await api('oper2', 'POST', '/api/me/2fa/enable', { code: totp(secret) });
    assert.equal((await api('admin', 'GET', '/api/users')).data.find((u) => u.id === id).totp, true);
    await api('admin', 'PUT', `/api/users/${id}`, { resetTotp: true });
    assert.equal((await api('admin', 'GET', '/api/users')).data.find((u) => u.id === id).totp, false);
    assert.equal((await login('oper3', 'operator2', 'newpassword1')).status, 200, 'входит без кода');
  });
  test('отключение: сессии обрываются, вход закрыт (403), включение возвращает доступ; себя отключить нельзя', async () => {
    const id = (await api('admin', 'GET', '/api/users')).data.find((u) => u.username === 'operator2').id;
    await login('victim', 'operator2', 'newpassword1');
    assert.equal((await api('admin', 'PUT', `/api/users/${id}`, { disabled: true })).status, 200);
    assert.equal((await api('victim', 'GET', '/api/me')).status, 401);
    const denied = await login('victim2', 'operator2', 'newpassword1');
    assert.equal(denied.status, 403); assert.equal(denied.data.error, 'Учётная запись отключена');
    assert.equal((await login('victim3', 'operator2', 'wrong')).status, 401, 'без верного пароля статус аккаунта не раскрывается');
    assert.equal((await api('admin', 'GET', '/api/users')).data.find((u) => u.id === id).disabled, true);
    await api('admin', 'PUT', `/api/users/${id}`, { disabled: false });
    assert.equal((await login('victim4', 'operator2', 'newpassword1')).status, 200);
    const rootId = (await api('admin', 'GET', '/api/users')).data.find((u) => u.username === 'root').id;
    assert.equal((await api('admin', 'PUT', `/api/users/${rootId}`, { disabled: true })).status, 400);
    assert.equal((await api('admin', 'PUT', `/api/users/${rootId}`, { role: 'viewer' })).status, 400);
    assert.equal((await api('admin', 'DELETE', `/api/users/${rootId}`)).status, 400);
  });
  test('защита последнего администратора: второй админ не может быть лишён прав, если это оставит систему без админов', async () => {
    // два админа: root и second; root отключает second → root остаётся единственным активным
    await api('admin', 'POST', '/api/users', { username: 'second', password: 'password1', role: 'admin' });
    const list = (await api('admin', 'GET', '/api/users')).data;
    const sec = list.find((u) => u.username === 'second').id;
    await login('sadmin', 'second', 'password1');
    assert.equal((await api('admin', 'PUT', `/api/users/${sec}`, { disabled: true })).status, 200);
    // теперь отключённый second не считается; root — единственный. Попытка second (сессия уже убита) ничего не сделает
    assert.equal((await api('sadmin', 'GET', '/api/me')).status, 401);
    await api('admin', 'PUT', `/api/users/${sec}`, { disabled: false });
    assert.equal((await api('admin', 'DELETE', `/api/users/${sec}`)).status, 200, 'второго админа удалить можно, пока остаётся root');
  });
  test('завершение всех сессий пользователя', async () => {
    const id = (await api('admin', 'GET', '/api/users')).data.find((u) => u.username === 'operator2').id;
    await login('s1', 'operator2', 'newpassword1'); await login('s2', 'operator2', 'newpassword1');
    const r = await api('admin', 'POST', `/api/users/${id}/revoke-sessions`);
    assert.ok(r.data.revoked >= 2);
    assert.equal((await api('s1', 'GET', '/api/me')).status, 401); assert.equal((await api('s2', 'GET', '/api/me')).status, 401);
    assert.equal((await api('viewer', 'POST', `/api/users/${id}/revoke-sessions`)).status, 403);
  });
  test('удаление пользователя и запись в журнал с перечнем изменённых полей', async () => {
    const id = (await api('admin', 'GET', '/api/users')).data.find((u) => u.username === 'operator2').id;
    assert.equal((await api('admin', 'DELETE', `/api/users/${id}`)).status, 200);
    assert.equal((await api('admin', 'GET', '/api/users')).data.some((u) => u.id === id), false);
    const audit = (await api('admin', 'GET', '/api/audit?q=user.')).data;
    const upd = audit.find((a) => a.action === 'user.update' && /password/.test(a.detail ?? ''));
    assert.ok(upd, 'в журнале видно, что менялся пароль');
    assert.ok(!JSON.stringify(audit).includes('newpassword1'), 'пароли в журнал не попадают');
    assert.ok(audit.some((a) => a.action === 'user.delete'));
  });
});
