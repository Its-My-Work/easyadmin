import { HttpError } from './http.js';
import { inspectService, runAction } from './easypanel.js';

/**
 * Переименование сервиса и перенос в другой проект средствами самой Easypanel (services.common.renameService:
 * «переименовывает и переносит сервис, его образ, записи, файлы и домены»). Панель делает это только над остановленным сервисом,
 * поэтому порядок такой: остановить → (создать проект) → переименовать/перенести → запустить снова.
 * Если переименование не удалось, прежний сервис запускается обратно. После успеха ссылки на сервис в данных EasyAdmin переписываются.
 * Compose-стеки не поддерживаются: у них имена томов и сетей завязаны на проект и сервис.
 */
export const MOVABLE = ['app', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (r) => `${r.project}/${r.name}`;

/** Данные EasyAdmin, где сервис указан по имени: метрики нагрузки, вебхуки, расписания, охват копий и расписания Easypanel под управлением EasyAdmin. */
export function repointLocal(db, backups, panelId, from, to) {
  const changed = {};
  changed.metrics = db.prepare('UPDATE svc_metrics SET project = ?, service = ? WHERE panel_id = ? AND project = ? AND service = ?').run(to.project, to.name, panelId, from.project, from.name).changes;
  changed.hooks = db.prepare('UPDATE hooks SET project = ?, name = ? WHERE panel_id = ? AND project = ? AND name = ?').run(to.project, to.name, panelId, from.project, from.name).changes;
  let schedules = 0;
  for (const s of db.prepare('SELECT id, target FROM schedules').all()) {
    let t; try { t = JSON.parse(s.target); } catch { continue; }
    let hit = false;
    for (const it of t.items ?? []) if (it.panelId === panelId && it.project === from.project && it.name === from.name) { it.project = to.project; it.name = to.name; hit = true; }
    if (hit) { db.prepare('UPDATE schedules SET target = ? WHERE id = ?').run(JSON.stringify(t), s.id); schedules++; }
  }
  changed.schedules = schedules;
  backups?.repoint(panelId, from, to);
  return changed;
}

export async function moveService({ manager, alerts, row, ref, to, createProject, projects }) {
  if (ref.type === 'compose') throw new HttpError(400, 'Compose-сервисы переименовать и перенести нельзя');
  if (!MOVABLE.includes(ref.type)) throw new HttpError(400, 'Этот тип сервиса переименовать и перенести нельзя');
  if (ref.project === to.project && ref.name === to.name) throw new HttpError(400, 'Имя и проект не изменились');
  if (projects.some((p) => p.name === to.project && p.services.some((s) => s.name === to.name))) throw new HttpError(400, `В проекте ${to.project} уже есть сервис ${to.name}`);
  const projectExists = projects.some((p) => p.name === to.project);
  if (!projectExists && !createProject) throw new HttpError(400, `Проекта ${to.project} нет — отметьте «создать проект»`);
  const client = manager.clientFor(row); const warnings = [];
  const wasRunning = (await inspectService(client, ref)).service?.enabled !== false;
  alerts?.expect(row.id, label(ref)); alerts?.expect(row.id, label(to));
  if (wasRunning) {
    await runAction(client, { ...ref, action: 'stop' });
    for (let i = 0; i < 15; i++) { // ждём, пока панель отметит сервис остановленным
      if ((await inspectService(client, ref).catch(() => null))?.service?.enabled === false) break;
      await sleep(i < 3 ? 300 : 1000);
    }
  }
  try {
    if (!projectExists) await client.mutate('projects.createProject', { name: to.project });
    await client.mutate('services.common.renameService', { oldProjectName: ref.project, oldServiceName: ref.name, newProjectName: to.project, newServiceName: to.name });
  } catch (e) {
    if (wasRunning) await runAction(client, { ...ref, action: 'start' }).catch(() => warnings.push('Сервис остановлен и не запущен обратно — запустите его вручную'));
    manager.invalidate(row.id);
    throw Object.assign(e, { warnings });
  }
  manager.invalidate(row.id);
  let started = !wasRunning;
  if (wasRunning) {
    try { await runAction(client, { type: ref.type, project: to.project, name: to.name, action: 'start' }); started = true; }
    catch (e) { warnings.push(`Сервис перенесён, но не запущен: ${e.message}. Запустите его или сделайте деплой`); }
  }
  return { started, wasRunning, warnings, createdProject: !projectExists };
}

export function moveRoutes(d) {
  const { db, manager, alerts, backups, audit, need, nameOf, asHttp, panelOr404, svcRef, treeOf } = d;
  return [
    ['POST', '/api/panels/:id/service/move', async (ctx) => {
      const row = panelOr404(ctx.params.id); const b = ctx.body ?? {}; const ref = svcRef(b);
      need(b.confirm === label(ref), 'Для подтверждения введите project/service');
      const to = { project: nameOf(b.newProject ?? ref.project, 'newProject'), name: nameOf(b.newName ?? ref.name, 'newName') };
      const what = `${label(ref)} → ${label(to)}`;
      try {
        const r = await moveService({ manager, alerts, row, ref, to, createProject: b.createProject === true, projects: await treeOf(row) });
        const updated = repointLocal(db, backups, row.id, ref, to);
        audit(ctx, { action: 'service.move', panel: row, target: what, detail: r.warnings.join('; ') || undefined });
        return { ok: true, project: to.project, name: to.name, ...r, updated };
      } catch (e) {
        audit(ctx, { action: 'service.move', panel: row, target: what, ok: false, detail: e.message });
        throw e instanceof HttpError ? e : asHttp(e);
      }
    }, { admin: true }],
  ];
}
