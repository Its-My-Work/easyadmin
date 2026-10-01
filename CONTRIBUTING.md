# Contributing / Участие в разработке

Thanks for helping! / Спасибо за интерес к проекту!

## Setup / Запуск

```bash
node -v            # >= 22.13
npm test           # unit tests (node:test), no dependencies
npm run demo       # demo with mock Easypanel panels: http://localhost:3100 (admin / demo12345)
```

Browser checks (optional): `npm i --no-save playwright`, run `npm run demo`, then `node e2e/ui.mjs` and `node e2e/i18n.mjs`.
Some tests need `bash`, `curl` and `openssl` (they are skipped when absent).

## Rules / Правила

- **No dependencies and no frontend build.** Plain Node ESM and plain browser JS.
- **Every Russian string must have an English entry** in `public/js/i18n-dict.js` (`test/i18n.test.js` and `e2e/i18n.mjs` check this). Nested strings inside template literals are caught by the e2e check.
- Add a test for each change. The Easypanel API is internal and changes between versions: keep parsing defensive and cover both old and new shapes in `test/mock-easypanel.js`.
- Never put secrets, tokens or personal data in code, tests or screenshots.
- Dangerous actions (anything that changes servers) need confirmation in the UI, an audit-log entry and admin rights.
- Keep commits focused; describe the *why*.

## Reporting bugs / Сообщения об ошибках

Open an issue with the version, the Easypanel version and the **diagnostic report** (panel page → «Диагностика» → «Копировать отчёт»; secrets are masked). Security issues: see [SECURITY.md](SECURITY.md).
