import { get } from './api.js';
import { clear, h, icon } from './dom.js';
import { advancedTab } from './panel-settings-advanced.js';
import * as S from './psettings-sections.js';

/* Настройки самой панели Easypanel: разделы с обычными формами, остальное — в «Расширенных» (универсальный доступ к процедурам панели). */
const SECTIONS = [['overview', 'Обзор', S.overview], ['address', 'Адреса', S.address], ['general', 'Общее', S.general], ['branding', 'Оформление', S.branding], ['system', 'Обновления и Docker', S.system],
  ['users', 'Пользователи', S.users], ['monitoring', 'Мониторинг', S.monitoring], ['traefik', 'Traefik', S.traefik], ['infra', 'Кластер и хранилища', S.infra], ['actions', 'Журнал панели', S.actions], ['advanced', 'Расширенные', (p) => advancedTab(p)]];
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };

// Страница пересоздаётся при каждом обновлении данных панелей — готовое дерево хранится, иначе несохранённый ввод пропадал бы.
const cache = new Map(); // panelId → { root, at, entry }
const TTL = 120_000;

export function settingsTab(p) {
  const hit = cache.get(p.id);
  if (hit && (hit.entry.dirty > 0 || Date.now() - hit.at < TTL)) return hit.root;
  const entry = { dirty: 0, license: null };
  entry.reloadLicense = async () => { entry.license = await get(`/api/panels/${p.id}/plicense`).catch(() => entry.license); draw(); };
  let current = SECTIONS.some(([id]) => id === lsGet('ea-pset-section')) ? lsGet('ea-pset-section') : 'overview';
  const nav = h('div', { class: 'chips psf-nav', role: 'tablist' });
  const body = h('div', { class: 'psf-body' });
  const go = (id) => { current = id; lsSet('ea-pset-section', id); draw(); };
  const draw = () => {
    entry.dirty = 0;
    clear(nav).append(...SECTIONS.map(([id, label]) => h('button', { class: `chip-btn ${id === current ? 'on' : ''}`, role: 'tab', 'aria-selected': id === current ? 'true' : 'false', onclick: () => go(id) }, label)));
    const fn = SECTIONS.find(([id]) => id === current)[2];
    clear(body).append(fn(p, entry, go));
    cache.get(p.id) && (cache.get(p.id).at = Date.now());
  };
  const root = h('div', { class: 'stack pset' },
    h('div', { class: 'section-head' }, h('div', { class: 'muted small' }, 'Настройки самой Easypanel. Изменения применяются сразу и записываются в журнал.'), h('a', { class: 'btn sm ghost', href: '#/psettings' }, icon('layers', 13), 'Сравнить панели')),
    nav, body);
  cache.set(p.id, { root, at: Date.now(), entry });
  // лицензия нужна, чтобы сразу показать закрытые настройки неактивными; если панель её не отдаёт — ничего не блокируем
  clear(body).append(h('div', { class: 'skeleton', style: { height: '120px' } }));
  get(`/api/panels/${p.id}/plicense`).then((l) => { entry.license = l; }, () => { entry.license = { known: false, features: {}, featureLabels: {} }; }).then(draw);
  return root;
}
