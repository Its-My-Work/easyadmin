import { lang } from './i18n.js';

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

// Когда Easypanel запускает/останавливает контейнеры, он перечитывает конфиг Traefik — на 1–3 секунды ВСЕ маршруты (и сам
// EasyAdmin) отвечают 404/502/503 страницей прокси, а не JSON. Наш сервер всегда отвечает JSON с полем error, поэтому ответ без него —
// это прокси: запрос до нас не дошёл, его безопасно повторить (504 не повторяем для записи — запрос мог выполниться).
const PROXY_WAIT = [700, 1500, 3000];
const proxyGlitch = (method, status, data) => !data?.error && (status === 404 || status === 502 || status === 503 || (status === 504 && method === 'GET'));

export async function api(method, path, body, attempt = 0) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'X-Requested-With': 'easyadmin', 'X-Lang': lang, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch { throw new ApiError('Нет связи с сервером EasyAdmin', 0); }
  let data = null;
  try { data = await res.json(); } catch { /* пусто */ }
  if (!res.ok && attempt < PROXY_WAIT.length && proxyGlitch(method, res.status, data)) {
    await new Promise((r) => setTimeout(r, PROXY_WAIT[attempt]));
    return api(method, path, body, attempt + 1);
  }
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/session')) window.dispatchEvent(new Event('ea:unauth'));
  if (!res.ok) throw new ApiError(data?.error || `Ошибка ${res.status}`, res.status, data);
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p, {});
