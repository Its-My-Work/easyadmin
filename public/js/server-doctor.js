import { get, post } from './api.js';
import { fmtBytes } from './charts.js';
import { clear, confirmDialog, h, icon, modal, toast } from './dom.js';
import { t } from './i18n.js';

/** Server Doctor: оценка здоровья сервера A–F, находки по важности и безопасные исправления в 1 клик. */
const SEV = [
  ['crit', 'Критично', 'alert'],
  ['warn', 'Предупреждения', 'alert'],
  ['info', 'Информация', 'activity']
];
const fill = (s, args = []) => t(s).replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? '');

function topList(top) {
  return h('div', { class: 'dr-top' }, top.map((r) => h('div', { class: 'dr-top-row' },
    h('span', { class: 'mono' }, r.path),
    h('b', null, fmtBytes(r.size))
  )));
}

function fixResultModal({ ok, title, output }) {
  const body = h('div', { class: 'stack' },
    h('div', { class: `callout ${ok ? 'ok' : 'err'}` },
      icon(ok ? 'check' : 'alert', 18),
      h('div', null,
        h('b', null, ok ? t('Успешно выполнено') : t('Завершено с ошибками')),
        h('div', { class: 'small' }, title)
      )
    ),
    output ? h('div', { class: 'stack' },
      h('span', { class: 'muted small' }, t('Вывод сервера:')),
      h('pre', { class: 'mono-box small', style: 'max-height: 220px; overflow-y: auto; background: var(--panel); padding: 10px; border-radius: 6px; font-size: 12px; line-height: 1.4;' }, output)
    ) : null
  );
  modal({
    title: t('Результат выполнения'),
    compact: true,
    body,
    actions: [{ label: t('Отлично'), kind: 'primary' }]
  });
}

function fixButtons(f, data, rerun) {
  return f.fixIds.map((id) => {
    const r = data.recipes[id]; if (!r) return null;
    const btnLabel = t(r.title);
    const btnText = h('span', null, btnLabel);
    const btnIcon = icon('check', 13);
    const btn = h('button', { class: 'btn sm primary dr-fix-btn' }, btnIcon, btnText);

    let sel = null;
    if (id === 'swap.add') {
      sel = h('select', { class: 'input sm', 'aria-label': 'Размер' }, ['1G', '2G', '4G'].map((s) => h('option', { value: s, selected: s === '2G' }, s)));
      sel.addEventListener('change', () => { f.size = sel.value; });
    }

    btn.onclick = async () => {
      const params = {};
      if (id === 'swap.add') params.size = f.size ?? (sel?.value || '2G');
      const ok = await confirmDialog({
        title: r.title,
        message: `${t('Будет выполнено на сервере')}: ${t(r.title)}`,
        confirmText: 'Исправить',
        danger: r.risk !== 'low'
      });
      if (!ok) return;

      btn.disabled = true;
      if (sel) sel.disabled = true;
      btn.classList.add('loading');
      btnText.textContent = t('Выполняется…');
      const spin = icon('refresh', 13);
      spin.classList.add('spin');
      btnIcon.replaceWith(spin);

      try {
        const res = await post(`/api/panels/${data.panelId}/doctor/fix`, { fixId: id, params });
        fixResultModal({ ok: res.ok, title: t(r.title), output: res.output });
        await rerun();
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false;
        if (sel) sel.disabled = false;
        btn.classList.remove('loading');
        btnText.textContent = btnLabel;
        spin.replaceWith(btnIcon);
      }
    };

    if (sel) return h('span', { class: 'inline' }, sel, btn);
    return btn;
  });
}

function findingRow(f, data, rerun) {
  const badgeLabels = { crit: 'Критично', warn: 'Внимание', info: 'Инфо' };
  return h('div', { class: `dr-finding ${f.severity}` },
    h('div', { class: 'dr-ic' }, icon(f.severity === 'info' ? 'activity' : 'alert', 16)),
    h('div', { class: 'dr-body' },
      h('div', { class: 'inline' },
        h('span', { class: `dr-badge ${f.severity}` }, t(badgeLabels[f.severity] || f.severity)),
        h('b', null, fill(f.title, f.args))
      ),
      f.details ? h('div', { class: 'muted small' }, f.details) : null,
      f.id === 'disk.top' ? topList(f.metrics.top ?? []) : null,
      f.id === 'docker.logs' ? topList(f.metrics.files ?? []) : null
    ),
    f.fixIds.length ? h('div', { class: 'dr-fix' }, fixButtons(f, data, rerun)) : null
  );
}

export function doctorTab(p) {
  const box = h('div', { class: 'stack' });
  const draw = (data) => {
    const body = h('div', { class: 'stack' });
    data.panelId = p.id;
    const groups = SEV.map(([sev, label]) => [sev, label, data.findings.filter((f) => f.severity === sev)]).filter(([, , l]) => l.length);
    const scoreVal = Math.min(100, Math.max(0, data.score || 0));

    const refreshBtn = h('button', { class: 'btn', onclick: () => load() }, icon('refresh', 14), t('Проверить заново'));

    body.append(
      h('div', { class: 'card dr-head' },
        h('div', { class: `dr-grade g-${data.grade}`, 'aria-label': `${t('Оценка')} ${data.grade}` }, data.grade),
        h('div', { class: 'dr-sum' },
          h('h3', { class: 'inline' }, icon('stethoscope', 16), ' ', t('Здоровье сервера')),
          h('div', { class: 'dr-score-wrap' },
            h('span', { class: 'muted' }, `${scoreVal} / 100`),
            h('div', { class: 'dr-score-bar' },
              h('div', { class: `dr-score-fill g-${data.grade}`, style: `width: ${scoreVal}%` })
            )
          ),
          h('div', { class: 'muted small' }, `${t('Транспорт')}: ${t('консоль хоста Easypanel')}`)
        ),
        refreshBtn
      ),
      groups.length ? groups.map(([sev, label, list]) => h('section', { class: 'card' },
        h('h3', { class: `dr-title ${sev}` }, `${t(label)} · ${list.length}`),
        h('div', { class: 'dr-list' }, list.map((f) => findingRow(f, data, load)))
      )) : h('div', { class: 'callout ok' }, icon('check', 18), h('div', null, h('b', null, t('Проблем не найдено')), h('div', { class: 'small' }, t('Все проверенные параметры хоста в полной норме.'))))
    );
    clear(box).append(body);
  };

  async function load() {
    clear(box).append(
      h('div', { class: 'skeleton', style: { height: '140px' } }),
      h('p', { class: 'muted pad inline' }, icon('refresh', 14), ' ', t('Проверяем хост…'))
    );
    try {
      const data = await get(`/api/panels/${p.id}/doctor`);
      draw(data);
    } catch (e) {
      clear(box).append(h('div', { class: 'callout err' }, icon('alert'), h('div', null, e.message), h('button', { class: 'btn sm', onclick: () => load() }, t('Повторить'))));
    }
  }

  load();
  return box;
}
