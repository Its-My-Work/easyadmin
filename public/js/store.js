import { get } from './api.js';

export const store = {
  user: null,
  panels: [],
  loadedAt: 0,
  loading: false,
  error: null,
  selection: new Map(), // key → target
};

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const notify = () => listeners.forEach((fn) => fn());

let last = '';
export async function refresh(force = false, { silent = false } = {}) {
  if (store.loading) return;
  store.loading = true; if (!silent) notify();
  try {
    const data = await get(`/api/overview${force ? '?force=1' : ''}`);
    store.error = null;
    const sig = JSON.stringify(data);
    store.loadedAt = Date.now();
    if (sig !== last) { last = sig; store.panels = data; }
  } catch (e) { store.error = e.message; }
  finally { store.loading = false; notify(); }
}

export const panelById = (id) => store.panels.find((p) => p.id === Number(id));

/** Плоский список сервисов всех панелей. */
export function allServices() {
  const out = [];
  for (const p of store.panels) for (const pr of p.tree?.projects ?? []) for (const s of pr.services) out.push({ ...s, panelId: p.id, panel: p });
  return out;
}

export const svcKey = (s) => [s.panelId, s.type, s.project, s.name].join('\u0000');
export const STATUS = {
  online: ['Онлайн', 'ok'], degraded: ['Частично', 'warn'], offline: ['Недоступна', 'err'],
  auth_error: ['Ошибка токена', 'err'], unknown: ['Проверка…', 'muted'],
};
export const TYPE_LABEL = { app: 'App', postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', redis: 'Redis', compose: 'Compose' };
export const isDb = (t) => ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'].includes(t);
