import { lang } from './i18n.js';

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

export async function api(method, path, body) {
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
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/session')) window.dispatchEvent(new Event('ea:unauth'));
  if (!res.ok) throw new ApiError(data?.error || `Ошибка ${res.status}`, res.status, data);
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p, {});
