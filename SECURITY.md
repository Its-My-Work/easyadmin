# Security policy / Политика безопасности

## Reporting a vulnerability / Как сообщить об уязвимости

Please **do not open a public issue**. Use GitHub's private reporting:
**Security → Report a vulnerability** in this repository (private vulnerability reporting).
Include the version (commit or tag), steps to reproduce and the impact. We aim to reply within a week.

Пожалуйста, **не создавайте публичный issue**. Используйте закрытую отправку GitHub:
**Security → Report a vulnerability** в этом репозитории. Укажите версию (коммит или тег), шаги воспроизведения и последствия.

## Threat model / Модель угроз

EasyAdmin is an administration tool with powerful access. Access to EasyAdmin is equivalent to access to the servers it manages:

- it stores Easypanel API tokens (encrypted with AES-256-GCM using `EASYADMIN_SECRET` or `data/secret.key`);
- the **host console**, **panel installation over SSH**, **Docker updates** and **data backups** run commands as root on managed servers;
- backups contain the application key and panel configurations (environment variables) — they are encrypted with the backup password, which cannot be recovered.

EasyAdmin даёт права на серверы: доступ к нему равен доступу к серверам. Что важно:

- Не выставляйте EasyAdmin в открытый интернет без HTTPS-прокси; включите `EASYADMIN_SECURE_COOKIES=true`.
- Включите 2FA для администраторов, ограничьте доступ по сети или через SSO.
- Храните `EASYADMIN_SECRET` и пароль резервных копий отдельно от самих копий.
- Роль `viewer` не видит секреты; `operator` не управляет пользователями и системными настройками.

## Supported versions / Поддерживаемые версии

Beta (0.9.x): only the latest release receives fixes. / Бета (0.9.x): исправления выходят только для последней версии.
