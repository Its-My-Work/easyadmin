import { clear, h, icon, modal } from './dom.js';
import { t } from './i18n.js';

export const THEMES = [
  // 3 Тёмные темы
  { id: 'dark', mode: 'dark', label: 'Полночь', hint: 'Индиго', bg: '#0b0d12', panel: '#13161e', accent: '#7c83ff' },
  { id: 'dark-emerald', mode: 'dark', label: 'Изумруд', hint: 'Нефрит', bg: '#080f0c', panel: '#111e19', accent: '#10b981' },
  { id: 'dark-slate', mode: 'dark', label: 'Океан', hint: 'Слейт', bg: '#070d18', panel: '#101a2e', accent: '#38bdf8' },
  // 3 Светлые темы
  { id: 'light', mode: 'light', label: 'Классическая', hint: 'Лаванда', bg: '#f4f5f9', panel: '#ffffff', accent: '#5a62ee' },
  { id: 'light-sand', mode: 'light', label: 'Песок', hint: 'Янтарь', bg: '#f8f6f0', panel: '#ffffff', accent: '#d97706' },
  { id: 'light-teal', mode: 'light', label: 'Мята', hint: 'Лагуна', bg: '#edf6f5', panel: '#ffffff', accent: '#0d9488' },
];

export function getCurTheme() {
  try { return localStorage.getItem('ea-theme') || ''; } catch { return ''; }
}

export function applyTheme(id) {
  try {
    if (id) localStorage.setItem('ea-theme', id);
    else localStorage.removeItem('ea-theme');
  } catch {}
  if (id) document.documentElement.dataset.theme = id;
  else delete document.documentElement.dataset.theme;
  window.dispatchEvent(new CustomEvent('ea:theme', { detail: { theme: id } }));
}

/** Создает интерфейс выбора темы (карточки и превью) */
export function themeSelectorGrid(onSelect) {
  const container = h('div', { class: 'theme-section' });
  const draw = () => {
    clear(container);
    const cur = getCurTheme();
    const isAuto = !cur;

    const autoBtn = h('button', {
      type: 'button',
      class: `btn ${isAuto ? 'primary' : 'ghost'}`,
      onclick: () => { applyTheme(''); draw(); if (onSelect) onSelect(''); }
    }, icon('refresh', 14), ' ', t('Как в системе'));

    const autoRow = h('div', { class: 'theme-auto-row' },
      h('div', null,
        h('b', null, t('Тема оформления')),
        h('div', { class: 'muted small' }, t('Автоматически подстраивается под настройки вашей ОС'))
      ),
      autoBtn
    );

    const makeCard = (th) => {
      const active = cur === th.id || (!cur && th.id === 'dark' && !window.matchMedia?.('(prefers-color-scheme: light)').matches) || (!cur && th.id === 'light' && window.matchMedia?.('(prefers-color-scheme: light)').matches);
      const isSelected = cur === th.id;
      const preview = h('span', { class: 'theme-preview', style: `background: ${th.bg}; border-color: ${th.panel};` },
        h('span', { class: 'theme-preview-accent', style: `background: ${th.accent};` })
      );
      return h('button', {
        type: 'button',
        class: `theme-choice ${isSelected ? 'active' : ''}`,
        onclick: () => { applyTheme(th.id); draw(); if (onSelect) onSelect(th.id); }
      },
        preview,
        h('div', { class: 'theme-info' },
          h('div', { class: 'theme-title' }, t(th.label)),
          h('div', { class: 'theme-hint' }, t(th.hint))
        ),
        isSelected ? icon('check', 16) : null
      );
    };

    const darkGrid = h('div', { class: 'theme-grid' },
      ...THEMES.filter((th) => th.mode === 'dark').map(makeCard)
    );
    const lightGrid = h('div', { class: 'theme-grid' },
      ...THEMES.filter((th) => th.mode === 'light').map(makeCard)
    );

    container.append(
      autoRow,
      h('div', { class: 'stack-sm' },
        h('div', { class: 'theme-group-title' }, icon('moon', 13), ' ', t('Тёмные темы')),
        darkGrid
      ),
      h('div', { class: 'stack-sm' },
        h('div', { class: 'theme-group-title' }, icon('sun', 13), ' ', t('Светлые темы')),
        lightGrid
      )
    );
  };
  draw();
  return container;
}

export function themeCard() {
  return h('section', { class: 'card stack' },
    h('div', { class: 'card-head', style: 'margin: 0;' }, h('h3', null, t('Оформление'))),
    themeSelectorGrid()
  );
}

export function themePickerModal() {
  const body = themeSelectorGrid();
  return modal({
    title: t('Оформление'),
    wide: true,
    body: h('div', { class: 'stack' }, body),
    actions: [{ label: t('Закрыть'), kind: 'primary' }]
  });
}
