import { get } from './api.js';
import { h, modal, toast } from './dom.js';

/** Диагностика терминала панели: как она отвечает на WebSocket по каждому пути и как её интерфейс создаёт соединение. Копируется одним нажатием. */
export async function showConsoleReport(url) {
  toast('Собираем диагностику…');
  let r;
  try { r = await get(url); } catch (e) { return toast(e.message, 'error', 8000); }
  const text = JSON.stringify(r, null, 2);
  modal({ title: 'Диагностика консоли', wide: true, body: h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Здесь видно, как панель отвечает на подключение по каждому пути и как её интерфейс открывает терминал. Токены не включены. Скопируйте и пришлите разработчику.'), h('pre', { class: 'code' }, text)),
  actions: [{ label: 'Закрыть', kind: 'ghost' }, { label: 'Копировать', kind: 'primary', onClick: async () => { try { await navigator.clipboard.writeText(text); toast('Скопировано', 'success'); } catch { toast('Выделите текст и скопируйте вручную', 'error'); } return false; } }] });
}
