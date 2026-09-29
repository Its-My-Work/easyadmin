import { PanelError, SERVICE_TYPES, assertType, createService, inspectService, runAction, runServiceOp } from './easypanel.js';

const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return undefined; };

/** Снимает переносимую конфигурацию сервиса (env, источник, ресурсы). Домены/порты/тома не копируются — они привязаны к хосту. */
export async function extractConfig(client, ref) {
  const { service } = await inspectService(client, ref);
  return {
    type: ref.type,
    env: String(pick(service, 'env', 'envs') ?? ''),
    source: service?.source ?? null,
    build: service?.build ?? null,
    resources: service?.resources ?? null,
  };
}

/** Применяет конфигурацию к новому сервису. Каждый шаг независим: отчёт возвращается по всем. */
export async function applyConfig(client, target, cfg, { deploy = false, ensureProject = true, existingProjects = [] } = {}) {
  assertType(cfg.type);
  const steps = [];
  const step = async (name, fn) => { try { await fn(); steps.push({ step: name, ok: true }); return true; } catch (e) { steps.push({ step: name, ok: false, error: e.message }); return false; } };
  const ref = { type: cfg.type, project: target.project, name: target.name };
  if (ensureProject && !existingProjects.includes(target.project)) {
    await step('проект', () => client.mutate('projects.createProject', { name: target.project }));
  }
  const src = cfg.source;
  const image = cfg.type === 'app' && src?.type === 'image' ? src.image : undefined;
  if (!await step('создание сервиса', () => createService(client, { ...ref, image }))) return steps;
  if (cfg.env) await step('переменные окружения', () => runServiceOp(client, 'env', ref, { env: cfg.env }));
  if (cfg.type === 'app' && src?.type === 'image' && image) await step('источник (образ)', () => runServiceOp(client, 'sourceImage', ref, { image }));
  if (cfg.type === 'app' && src?.type === 'dockerfile') await step('источник (Dockerfile)', () => runServiceOp(client, 'sourceDockerfile', ref, { dockerfile: src.dockerfile }));
  if (cfg.type === 'app' && src?.type === 'git') await step('источник (Git)', () => runServiceOp(client, 'sourceGit', ref, { repo: src.repo, branch: src.ref ?? src.branch, path: src.path }));
  if (cfg.type === 'app' && src?.type === 'github') await step('источник (GitHub)', () => runServiceOp(client, 'sourceGithub', ref, { owner: src.owner, repo: src.repo, branch: src.ref ?? src.branch, path: src.path }));
  if (cfg.type === 'app' && ['git', 'github'].includes(src?.type) && cfg.build?.type) await step('способ сборки', () => runServiceOp(client, 'build', ref, { buildType: cfg.build.type, file: cfg.build.file }));
  if (cfg.resources && ['memoryLimit', 'memoryReservation', 'cpuLimit', 'cpuReservation'].some((k) => cfg.resources[k])) await step('ресурсы', () => runServiceOp(client, 'resources', ref, cfg.resources));
  if (deploy && (cfg.type === 'app' || cfg.type === 'compose')) await step('деплой', () => runAction(client, { ...ref, action: 'deploy' }));
  return steps;
}

/** Массовое изменение env: set — KEY=VALUE, remove — список ключей. Комментарии и порядок строк сохраняются. */
export function mergeEnv(current, set = {}, remove = []) {
  const lines = String(current ?? '').split('\n');
  const pending = new Map(Object.entries(set));
  const rm = new Set(remove);
  const out = [];
  for (const line of lines) {
    const i = line.indexOf('=');
    const key = i > 0 && !line.trimStart().startsWith('#') ? line.slice(0, i).trim() : null;
    if (key && rm.has(key)) continue;
    if (key && pending.has(key)) { out.push(`${key}=${pending.get(key)}`); pending.delete(key); continue; }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  return out.join('\n');
}

export const parseEnvLines = (text) => {
  const set = {};
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) throw new PanelError(`Неверная строка: «${t}» (нужно KEY=value)`);
    set[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return set;
};

export { SERVICE_TYPES };
