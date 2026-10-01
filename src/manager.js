import { decrypt, encrypt } from './crypto.js';
import { PanelClient, PanelError, applyHealth, discoverProcedures, fuzzyStats, looksLikeStats, normalizeStats, normalizeTree } from './easypanel.js';

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

  /**
   * Статистика сервера. В новых версиях панели monitor.getSystemStats может отсутствовать (404): тогда один раз в 6 часов
   * ищем подходящие процедуры в интерфейсе самой панели, пробуем их и запоминаем рабочую.
   */
  const statsProcs = new Map(); // panelId → { proc | null, at, candidates }
  const is404 = (e) => e.status === 404 || /not found/i.test(e.message);
  const rank = (n) => (/system/i.test(n) ? 3 : 0) + (/stats?|usage|metric/i.test(n) ? 2 : 0) + (/^monitor\./.test(n) ? 1 : 0);
  async function fetchStats(client, row) {
    const st = statsProcs.get(row.id);
    const remember = (v) => statsProcs.set(row.id, { ...(statsProcs.get(row.id) ?? {}), ...v });
    if (st?.proc && st.proc !== 'monitor.getSystemStats') { // найденная ранее процедура
      try { return await client.query(st.proc); } catch (e) { if (!is404(e)) throw e; remember({ proc: null, at: 0 }); }
    }
    for (const name of ['monitor.getSystemStats', 'monitorOld.getSystemStats']) { // в новых Easypanel процедура переехала в monitorOld
      try { const v = await client.query(name); remember({ proc: name, at: Date.now() }); return v; } catch (e) { if (!is404(e)) throw e; }
    } // дешёвый 404 не страшен; обнаружение — не чаще раза в 6 ч
    const cur = statsProcs.get(row.id);
    if (!cur?.at || Date.now() - cur.at > 6 * 3600_000) {
      const found = (await discoverProcedures(row.url, { insecure: !!row.insecure_tls, timeoutMs: config.requestTimeoutMs }).catch(() => []))
        .filter((n) => { const pr = n.split('.')[1]; return /^(get|list|inspect)/.test(pr) && /(system|server|host|resource|usage|metric|stats?|overview|cpu|mem)/i.test(n) && !/(service|project|task|table|storage|database|backup|domain|cert)/i.test(pr) && n !== 'monitor.getSystemStats'; })
        .sort((x, y) => rank(y) - rank(x));
      let chosen = null;
      for (const cand of found.slice(0, 10)) {
        try { const v = await client.query(cand); if (looksLikeStats(fuzzyStats(v)) || looksLikeStats(normalizeStats(v))) { chosen = { cand, v }; break; } } catch { /* пробуем следующую */ }
      }
      remember({ proc: chosen?.cand ?? null, at: Date.now(), candidates: found });
      if (chosen) return chosen.v;
    }
    const names = statsProcs.get(row.id)?.candidates ?? [];
    throw new PanelError(`Панель не поддерживает запрос статистики monitor.getSystemStats (404). Найдено в интерфейсе панели: ${names.length ? names.slice(0, 8).join(', ') : 'ничего похожего'}`, { status: 404 });
  }

  const containersMode = new Map(); // panelId → { mode: 'global' | 'project' | 'none', at }
  async function fetchContainers(client, row, tree) {
    const known = containersMode.get(row.id);
    const mode = known && (known.mode !== 'none' || Date.now() - known.at < 1_800_000) ? known.mode : undefined; // «не поддерживается» перепроверяем раз в 30 мин
    const remember = (m) => containersMode.set(row.id, { mode: m, at: Date.now() });
    if (!mode || mode === 'global') {
      try { const v = await client.query('projects.getDockerContainers'); remember('global'); return v; }
      catch (e) { if (mode === 'global' || e.kind === 'auth' || e.kind === 'network' || e.kind === 'timeout') throw e; }
    }
    if (mode === 'none') return null;
    const names = tree.projects.map((p) => p.name);
    const parts = await Promise.all(names.map((projectName) => client.query('projects.getDockerContainers', { projectName }).catch(() => null)));
    if (!parts.some((x) => x != null)) { remember('none'); return null; }
    remember('project');
    return parts.filter((x) => x != null).flatMap((v) => (Array.isArray(v) ? v : v?.containers ?? []));
  }

  async function fetchSnapshot(row) {
    const t0 = Date.now();
    const client = clientFor(row);
    const [tree, stats] = await Promise.allSettled([
      client.query('projects.listProjectsAndServices'),
      fetchStats(client, row),
    ]);
    // контейнеры — best-effort: сначала по всей панели, а если панель требует projectName — по каждому проекту
    let containers = { status: 'rejected' };
    if (tree.status === 'fulfilled') {
      try { containers = { status: 'fulfilled', value: await fetchContainers(client, row, normalizeTree(tree.value)) }; } catch (e) { containers = { status: 'rejected', reason: e }; }
    }
    let snap;
    if (tree.status === 'rejected') {
      const e = tree.reason;
      snap = { status: e.kind === 'auth' ? 'auth_error' : 'offline', error: e.message, tree: cache.get(row.id)?.tree ?? null, stats: null };
    } else {
      const norm = normalizeTree(tree.value);
      const rawEmpty = tree.value == null || (Array.isArray(tree.value) ? !tree.value.length : typeof tree.value !== 'object' || !Object.keys(tree.value).length);
      const unrecognized = !norm.projects.length && !rawEmpty && !(tree.value?.projects?.length === 0 && (tree.value?.services ?? []).length === 0);
      snap = {
        status: unrecognized ? 'degraded' : 'online', // недоступная статистика — не повод для «Частично»
        error: unrecognized ? 'Панель ответила, но список проектов не распознан. Откройте «Диагностика» на странице панели и пришлите результат разработчику.' : null,
        statsError: stats.status === 'rejected' ? stats.reason.message : null,
        tree: applyHealth(norm, containers.status === 'fulfilled' ? containers.value : null),
        stats: stats.status === 'fulfilled' ? normalizeStats(stats.value) : null,
      };
    }
    if (snap.status === 'online' && stats.status === 'fulfilled' && snap.stats && snap.stats.cpu == null && snap.stats.memPct == null && snap.stats.diskPct == null) {
      snap.statsError = 'Статистика получена, но формат не распознан (см. «Диагностика»)';
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
    return { status: s.status, error: s.error, tree: s.tree, stats: s.stats, statsError: s.statsError, latencyMs: s.latencyMs, fetchedAt: s.fetchedAt };
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
