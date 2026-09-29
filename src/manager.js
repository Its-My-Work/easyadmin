import { decrypt, encrypt } from './crypto.js';
import { PanelClient, applyHealth, normalizeStats, normalizeTree } from './easypanel.js';

/** Управляет клиентами панелей, кэшем снимков и статусами. */
export function createManager({ db, key, config }) {
  const cache = new Map();     // panelId → snapshot
  const inflight = new Map();  // panelId → Promise

  const getRow = (id) => db.prepare('SELECT * FROM panels WHERE id = ?').get(id);

  function clientFor(row) {
    return new PanelClient({
      url: row.url, token: decrypt(key, row.token_enc),
      insecure: !!row.insecure_tls, timeoutMs: config.requestTimeoutMs,
    });
  }

  async function fetchSnapshot(row) {
    const t0 = Date.now();
    const client = clientFor(row);
    const [tree, stats, containers] = await Promise.allSettled([
      client.query('projects.listProjectsAndServices'),
      client.query('monitor.getSystemStats'),
      client.query('projects.getDockerContainers'),
    ]);
    const failed = [tree, stats].find((r) => r.status === 'rejected'); // контейнеры — best-effort, их ошибка не считается
    let snap;
    if (tree.status === 'rejected') {
      const e = tree.reason;
      snap = { status: e.kind === 'auth' ? 'auth_error' : 'offline', error: e.message, tree: cache.get(row.id)?.tree ?? null, stats: null };
    } else {
      snap = {
        status: stats.status === 'rejected' ? 'degraded' : 'online',
        error: failed ? failed.reason.message : null,
        tree: applyHealth(normalizeTree(tree.value), containers.status === 'fulfilled' ? containers.value : null),
        stats: stats.status === 'fulfilled' ? normalizeStats(stats.value) : null,
      };
    }
    snap.latencyMs = Date.now() - t0;
    snap.fetchedAt = Date.now();
    cache.set(row.id, snap);
    const online = snap.status === 'online' || snap.status === 'degraded';
    db.prepare('UPDATE panels SET status = ?, last_error = ?, last_seen = COALESCE(?, last_seen) WHERE id = ?')
      .run(snap.status, snap.error, online ? snap.fetchedAt : null, row.id);
    try { manager.onSnapshot?.(row, snap); } catch (e) { console.error('[onSnapshot]', e.message); }
    return snap;
  }

  async function snapshot(id, { force = false } = {}) {
    const row = getRow(id);
    if (!row) return null;
    const hit = cache.get(id);
    if (!force && hit && Date.now() - hit.fetchedAt < config.cacheTtlMs) return hit;
    if (!inflight.has(id)) {
      inflight.set(id, fetchSnapshot(row).finally(() => inflight.delete(id)));
    }
    return inflight.get(id);
  }

  const invalidate = (id) => cache.delete(id);

  async function overview({ force = false } = {}) {
    const rows = db.prepare('SELECT * FROM panels ORDER BY position, id').all();
    const items = await Promise.all(rows.map(async (row) => ({ panel: publicPanel(row), snapshot: await snapshot(row.id, { force }) })));
    return items.map(({ panel, snapshot: s }) => ({ ...panel, ...pickSnap(s) }));
  }

  function pickSnap(s) {
    if (!s) return {};
    return { status: s.status, error: s.error, tree: s.tree, stats: s.stats, latencyMs: s.latencyMs, fetchedAt: s.fetchedAt };
  }

  function publicPanel(row) {
    return {
      id: row.id, name: row.name, url: row.url, color: row.color,
      tags: row.tags ? row.tags.split(',').filter(Boolean) : [], notes: row.notes,
      insecureTls: !!row.insecure_tls, status: row.status, lastSeen: row.last_seen, lastError: row.last_error,
    };
  }

  const sealToken = (t) => encrypt(key, t);

  let timer;
  const startPolling = () => {
    timer = setInterval(() => { overview({ force: true }).catch(() => {}); }, config.pollIntervalMs);
    timer.unref();
  };
  const stop = () => clearInterval(timer);

  const manager = { onSnapshot: null, getRow, clientFor, snapshot, invalidate, overview, publicPanel, sealToken, startPolling, stop, cache };
  return manager;
}
