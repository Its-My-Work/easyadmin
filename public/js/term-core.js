import { del, post } from './api.js';

/** Сеанс терминала: подключение (POST), вывод (SSE), ввод (POST), закрытие. Общее ядро консоли сервиса и консоли сервера. */
// экранирующие последовательности терминала и управляющие символы убираем, \r\n → \n
export const cleanText = (t) => t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/**
 * onState получает { state: 'connecting' | 'on' | 'off' | 'error', message?, path?, framing?, detected?, transcript?, attempts? }.
 * onOut — очищенный текст вывода.
 */
export function createTerminal({ panelId, onOut, onState }) {
  let cid = null; let es = null;
  const stop = async (remote = true) => {
    es?.close(); es = null;
    if (cid && remote) { const id = cid; cid = null; try { await del(`/api/console/${id}`); } catch { /* уже закрыт */ } }
    cid = null;
  };
  const connect = async (body = {}) => {
    await stop(); onState({ state: 'connecting' });
    try {
      const r = await post(`/api/panels/${panelId()}/console`, body);
      cid = r.id; onState({ state: 'on', ...r });
      es = new EventSource(`/api/console/${cid}/stream`);
      es.addEventListener('out', (e) => onOut(cleanText(JSON.parse(e.data).text)));
      es.addEventListener('status', (e) => { const st = JSON.parse(e.data); if (st.state === 'closed' || st.state === 'error') { es?.close(); es = null; cid = null; onState({ state: 'off', message: st.message || 'Соединение закрыто', failed: true }); } });
      es.onerror = () => { if (es && es.readyState === 2) { es = null; cid = null; onState({ state: 'off', message: 'Соединение потеряно', failed: true }); } };
      return r;
    } catch (e) {
      const proxyLike = [502, 503, 504].includes(e.status) && !e.data;
      onState({ state: 'error', message: proxyLike ? `${e.message} — ответ пришёл не от EasyAdmin (прокси панели): сервис мог перезапуститься или запрос занял слишком много времени. Подробности — в логах контейнера EasyAdmin.` : e.message, attempts: e.data?.attempts ?? [] });
      return null;
    }
  };
  const send = async (data) => {
    if (!cid) return false;
    try { await post(`/api/console/${cid}/input`, { data }); return true; } catch (e) {
      if (/не найден|закрыт/.test(e.message)) { cid = null; es?.close(); es = null; onState({ state: 'off', message: 'Сеанс закрыт', failed: true }); }
      return e.message;
    }
  };
  return { connect, stop, send, get connected() { return !!cid; } };
}
