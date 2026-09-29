import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');
const loopback = (h) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);

export class OidcError extends Error {}

/** Вход через OpenID Connect (Authorization Code + PKCE). Подпись id_token проверяется по JWKS издателя. */
export function createOidc({ config, fetchImpl = globalThis.fetch }) {
  const c = config.oidc;
  const enabled = !!(c.issuer && c.clientId && config.publicUrl);
  const pending = new Map(); // state → { verifier, nonce, exp }
  let meta = null, metaAt = 0, jwks = null, jwksAt = 0;

  const getJson = async (url, opts) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !loopback(u.hostname)) throw new OidcError('OIDC-провайдер должен работать по HTTPS');
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), ...opts });
    if (!r.ok) throw new OidcError(`OIDC: HTTP ${r.status} от ${u.host}`);
    return r.json();
  };
  async function discover() {
    if (meta && Date.now() - metaAt < 3600_000) return meta;
    const m = await getJson(`${c.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!m[k]) throw new OidcError(`В discovery нет ${k}`);
    meta = m; metaAt = Date.now();
    return m;
  }
  async function keys(force = false) {
    if (!force && jwks && Date.now() - jwksAt < 3600_000) return jwks;
    jwks = (await getJson((await discover()).jwks_uri)).keys ?? []; jwksAt = Date.now();
    return jwks;
  }

  const redirectUri = () => `${config.publicUrl.replace(/\/+$/, '')}/api/oidc/callback`;

  async function begin() {
    const m = await discover();
    for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
    const state = b64u(crypto.randomBytes(24)), nonce = b64u(crypto.randomBytes(24)), verifier = b64u(crypto.randomBytes(48));
    pending.set(state, { verifier, nonce, exp: Date.now() + 10 * 60_000 });
    const url = new URL(m.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: c.clientId, redirect_uri: redirectUri(), scope: 'openid email profile', state, nonce,
      code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async function verifyIdToken(idToken, nonce) {
    const [h, p, s] = String(idToken).split('.');
    if (!h || !p || !s) throw new OidcError('Некорректный id_token');
    const header = JSON.parse(fromB64u(h)), claims = JSON.parse(fromB64u(p));
    if (!['RS256', 'ES256'].includes(header.alg)) throw new OidcError(`Алгоритм подписи ${header.alg} не поддерживается`);
    let jwk = (await keys()).find((k) => k.kid === header.kid && (!k.alg || k.alg === header.alg)) ?? (await keys(true)).find((k) => k.kid === header.kid);
    if (!jwk && !header.kid) jwk = (await keys())[0];
    if (!jwk) throw new OidcError('Ключ подписи не найден в JWKS');
    const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const okSig = crypto.verify('sha256', Buffer.from(`${h}.${p}`), header.alg === 'ES256' ? { key: pub, dsaEncoding: 'ieee-p1363' } : pub, fromB64u(s));
    if (!okSig) throw new OidcError('Подпись id_token неверна');
    if (claims.iss !== (meta.issuer ?? c.issuer)) throw new OidcError('Неверный издатель (iss)');
    const aud = [].concat(claims.aud ?? []);
    if (!aud.includes(c.clientId)) throw new OidcError('id_token выдан для другого клиента (aud)');
    if (aud.length > 1 && claims.azp !== c.clientId) throw new OidcError('Неверный azp');
    if (!claims.exp || claims.exp * 1000 < Date.now() - 60_000) throw new OidcError('id_token просрочен');
    if (claims.nonce !== nonce) throw new OidcError('Неверный nonce');
    if (!claims.sub) throw new OidcError('В id_token нет sub');
    return claims;
  }

  async function complete(code, state) {
    const st = pending.get(state);
    pending.delete(state);
    if (!st || st.exp < Date.now()) throw new OidcError('Сессия входа истекла или недействительна — попробуйте снова');
    const m = await discover();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: c.clientId, code_verifier: st.verifier });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (c.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString('base64')}`;
    const tok = await getJson(m.token_endpoint, { method: 'POST', headers, body });
    if (!tok.id_token) throw new OidcError('Провайдер не вернул id_token');
    const claims = await verifyIdToken(tok.id_token, st.nonce);
    const email = claims.email ? String(claims.email).toLowerCase() : null;
    if (c.allowedDomains.length && !(email && c.allowedDomains.includes(email.split('@')[1]))) throw new OidcError('Ваш домен не допущен к входу');
    return { sub: claims.sub, email, emailVerified: claims.email_verified !== false, name: claims.name ?? claims.preferred_username ?? email ?? claims.sub };
  }

  return { enabled, begin, complete, verifyIdToken, redirectUri };
}
