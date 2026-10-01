import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './http.js';

/**
 * Работа с серверами по SSH через системный клиент (openssh-client в образе): без npm-зависимостей.
 *  - отпечаток ключа сервера подтверждает человек; дальше подключение идёт с StrictHostKeyChecking=yes и одноразовым known_hosts;
 *  - пароль и фраза ключа передаются клиенту через SSH_ASKPASS из переменных окружения (не через аргументы), ключ лежит во временном файле 0600;
 *  - всё временное удаляется при close(); секреты нигде не логируются и не сохраняются.
 */
const SSH = () => process.env.EASYADMIN_SSH_BIN || 'ssh';
const KEYSCAN = () => process.env.EASYADMIN_SSH_KEYSCAN_BIN || 'ssh-keyscan';

const HOST = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;

/** Проверка адреса и порта: без петли и метаданных облака (127.0.0.0/8, ::1, localhost, 0.0.0.0, 169.254.0.0/16). */
export function checkTarget(host, port) {
  const h = String(host ?? '').trim();
  const p = Number(port ?? 22);
  if (!HOST.test(h) && !net.isIPv6(h)) throw new HttpError(400, 'Некорректный адрес сервера');
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new HttpError(400, 'Порт — число от 1 до 65535');
  const low = h.toLowerCase();
  if (low === 'localhost' || low.endsWith('.localhost') || /^127\./.test(h) || h === '0.0.0.0' || /^169\.254\./.test(h) || low === '::1' || low === '::') throw new HttpError(400, 'Этот адрес использовать нельзя (локальный или служебный)');
  return { host: h, port: p };
}
export const checkUser = (u) => { const s = String(u ?? '').trim(); if (!USER.test(s)) throw new HttpError(400, 'Некорректное имя пользователя'); return s; };

export const fingerprintOf = (b64) => `SHA256:${crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')}`;
export const knownHostsLine = (host, port, type, b64) => `${port === 22 ? host : `[${host}]:${port}`} ${type} ${b64}`;
const mapSshError = (stderr) => {
  const e = String(stderr ?? '');
  if (/Permission denied|Authentication failed|too many authentication/i.test(e)) return 'Сервер отклонил вход: проверьте пользователя, пароль или ключ';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(e)) return 'Ключ сервера не совпадает с подтверждённым отпечатком';
  if (/Connection refused/i.test(e)) return 'Соединение отклонено: SSH не запущен или порт закрыт';
  if (/timed out|No route|Network is unreachable|Could not resolve/i.test(e)) return 'Сервер недоступен (таймаут, адрес или сеть)';
  if (/passphrase|invalid format|error in libcrypto|incorrect passphrase/i.test(e)) return 'Не удалось прочитать приватный ключ (неверная фраза или формат)';
  return e.trim().split('\n').slice(-2).join(' ').slice(0, 240) || 'Не удалось подключиться по SSH';
};

function run(cmd, args, { input, env, timeoutMs = 20_000, onData } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += '\ntimed out'; finish(124); }, timeoutMs);
    child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; onData?.(s); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { stderr += `\n${e.message}`; finish(127); });
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

/** Ключи сервера и их отпечатки (для подтверждения человеком). */
export async function scanHostKeys(host, port) {
  const t = checkTarget(host, port);
  const r = await run(KEYSCAN(), ['-T', '8', '-p', String(t.port), '-t', 'ed25519,ecdsa,rsa', t.host], { timeoutMs: 15_000 });
  const keys = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\S+\s+(ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-rsa)\s+([A-Za-z0-9+/=]+)/.exec(line.trim());
    if (m) keys.push({ type: m[1], key: m[2], fingerprint: fingerprintOf(m[2]) });
  }
  if (!keys.length) throw new HttpError(502, mapSshError(r.stderr) === 'Не удалось подключиться по SSH' ? 'Сервер не ответил на SSH (порт закрыт или это не SSH)' : mapSshError(r.stderr));
  return { host: t.host, port: t.port, keys };
}

/**
 * Сеанс: описание подключения + временные файлы. auth: { password } или { privateKey, passphrase? }.
 * hostKey — { type, key } из scanHostKeys, отпечаток которого подтвердил человек.
 */
export function openSession({ host, port, user, auth, hostKey }) {
  const t = checkTarget(host, port); const u = checkUser(user);
  if (!hostKey?.key || !hostKey?.type) throw new HttpError(400, 'Сначала подтвердите отпечаток ключа сервера');
  if (auth?.privateKey) {
    const pem = String(auth.privateKey).replace(/\r\n/g, '\n').trim();
    if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem) || pem.length > 20_000) throw new HttpError(400, 'Приватный ключ должен быть в формате OpenSSH или PEM');
  } else if (!auth?.password) throw new HttpError(400, 'Укажите пароль или приватный ключ');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-ssh-'));
  fs.chmodSync(dir, 0o700);
  const kh = path.join(dir, 'known_hosts'); fs.writeFileSync(kh, `${knownHostsLine(t.host, t.port, hostKey.type, hostKey.key)}\n`, { mode: 0o600 });
  const askpass = path.join(dir, 'askpass.sh');
  fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *assphrase*) printf \'%s\' "$EA_PASSPHRASE";; *) printf \'%s\' "$EA_PASSWORD";; esac\n', { mode: 0o700 });
  let keyFile = null;
  if (auth?.privateKey) {
    keyFile = path.join(dir, 'id'); fs.writeFileSync(keyFile, `${String(auth.privateKey).replace(/\r\n/g, '\n').trim()}\n`, { mode: 0o600 });
  }
  const args = (opts = [], remote = []) => [
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${kh}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HashKnownHosts=no',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'LogLevel=ERROR', '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ControlMaster=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    ...(keyFile ? ['-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey'] : ['-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive']),
    '-p', String(t.port), ...opts, `${u}@${t.host}`, ...remote,
  ];
  const env = { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'none:0', EA_PASSWORD: auth?.password ?? '', EA_PASSPHRASE: auth?.passphrase ?? '' };
  const tunnels = new Set(); let closed = false;
  const sudo = u === 'root' ? '' : 'sudo -n ';

  const session = {
    user: u, host: t.host, port: t.port, isRoot: u === 'root',
    /** Скрипт идёт через stdin (`sh -s`), поэтому кавычки и спецсимволы не мешают, а секреты не попадают в аргументы процессов. */
    async run(script, { timeoutMs = 60_000, onData, asRoot = true } = {}) {
      if (closed) throw new HttpError(500, 'Сеанс SSH закрыт');
      const r = await run(SSH(), args([], [`${asRoot ? sudo : ''}sh -s`]), { input: script, env, timeoutMs, onData });
      if (r.code === 255 || r.code === 124 || r.code === 127) throw new HttpError(502, mapSshError(r.stderr));
      return r;
    },
    /** Локальный порт → 127.0.0.1:remotePort сервера через шифрованный SSH-туннель. */
    async tunnel(remotePort) {
      const local = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
      const child = spawn(SSH(), args(['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${local}:127.0.0.1:${remotePort}`]), { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; child.stderr.on('data', (d) => { err += d.toString(); }); let dead = false; child.on('close', () => { dead = true; });
      tunnels.add(child);
      for (let i = 0; i < 80; i++) {
        if (dead) throw new HttpError(502, mapSshError(err));
        if (await new Promise((r) => { const sock = net.connect(local, '127.0.0.1', () => { sock.destroy(); r(true); }); sock.on('error', () => r(false)); })) return { url: `http://127.0.0.1:${local}`, close: () => { child.kill('SIGTERM'); tunnels.delete(child); } };
        await new Promise((r) => setTimeout(r, 250));
      }
      child.kill('SIGKILL'); throw new HttpError(502, 'Не удалось открыть SSH-туннель к панели');
    },
    close() {
      if (closed) return; closed = true;
      for (const c of tunnels) { try { c.kill('SIGKILL'); } catch { /* уже завершён */ } }
      tunnels.clear();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* не критично */ }
    },
  };
  return session;
}

export const realSsh = { scanHostKeys, openSession };
