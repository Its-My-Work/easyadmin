try { const t = localStorage.getItem('ea-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* без localStorage — тема системная */ }
try {
  const l = localStorage.getItem('ea-lang');
  const LANGS = ['ru', 'en', 'zh', 'de', 'es', 'pt'];
  const n = (navigator.language || 'ru').toLowerCase();
  const def = n.startsWith('ru') ? 'ru' : n.startsWith('zh') ? 'zh' : n.startsWith('de') ? 'de' : n.startsWith('es') ? 'es' : n.startsWith('pt') ? 'pt' : 'en';
  document.documentElement.lang = LANGS.includes(l) ? l : def;
} catch { /* язык по умолчанию */ }
