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
- the system backup (`.eabak`) contains the application key and panel configurations (environment variables) — it is encrypted with the backup password, which cannot be recovered;
- database and volume copies (EasyAdmin data copies and Easypanel schedules) are **not** encrypted by EasyAdmin: restrict access to their storage (folder permissions, S3-side or disk encryption).

EasyAdmin даёт права на серверы: доступ к нему равен доступу к серверам. Что важно:

- Не выставляйте EasyAdmin в открытый интернет без HTTPS-прокси; включите `EASYADMIN_SECURE_COOKIES=true`.
- Включите 2FA для администраторов, ограничьте доступ по сети или через SSO.
- Храните `EASYADMIN_SECRET` и пароль копии системы отдельно от самих копий; копии баз и томов паролем не шифруются — ограничьте доступ к их хранилищу.
- Роль `viewer` не видит секреты; `operator` не управляет пользователями и системными настройками.

## Supported versions / Поддерживаемые версии

Beta (0.9.x): only the latest release receives fixes. / Бета (0.9.x): исправления выходят только для последней версии.
