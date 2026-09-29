try { const t = localStorage.getItem('ea-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* без localStorage — тема системная */ }
