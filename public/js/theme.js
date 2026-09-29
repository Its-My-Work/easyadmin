try { const t = localStorage.getItem('ea-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* без localStorage — тема системная */ }
try { const l = localStorage.getItem('ea-lang'); document.documentElement.lang = l === 'en' || l === 'ru' ? l : ((navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en'); } catch { /* язык по умолчанию */ }
