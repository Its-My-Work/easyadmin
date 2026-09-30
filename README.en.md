# EasyAdmin

One admin console for all your [Easypanel](https://easypanel.io) panels. Sign in once and manage 10–20 servers from a single interface: status and load, projects and services, deploys, restarts, env, domains, ports, volumes, live logs, bulk operations and an audit log.

Zero dependencies and no frontend build: Node.js ≥ 22.13, SQLite (built-in `node:sqlite`), plain JS in the browser. The interface and server messages are available in **Russian and English** (switch with the RU/EN button in the sidebar or on the sign-in page).

> The Russian README is [README.md](README.md).

## Quick start

```bash
npm start            # http://localhost:3100
```

On first open, create an administrator. Then **Add panel**: the panel address and an API token (Easypanel → *Settings → Users → Generate API Token*), or sign in with the panel's email/password — a token is obtained automatically (the password is not stored).

Docker:

```bash
EASYADMIN_SECRET="$(openssl rand -hex 32)" docker compose up -d --build
```

> Keep `EASYADMIN_SECRET`: it encrypts panel tokens (AES-256-GCM). If unset, a key is created in `data/secret.key` — back up the whole `data/` directory.
> Behind an HTTPS proxy set `EASYADMIN_SECURE_COOKIES=true`. EasyAdmin gives full access to your servers — do not expose it without HTTPS.

Demo without real panels (several Easypanel mocks): `npm run demo` → http://localhost:3100, `admin` / `demo12345`.

## Features

**Management**
- **Overview**: all panels at a glance (online/offline, CPU/RAM/disk), tag filter, "Needs attention" block, Docker cleanup on several panels at once.
- **Panel**: load chart (6 h / 24 h / 7 d), projects and services, quick actions (deploy / restart / start / stop), create and delete projects and services (App, PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Compose), system operations, panel operation history with logs.
- **Service** (side panel): env (values hidden by default), domains, ports, volumes, limits, source (image / GitHub), notes, current usage, favorites, deletion confirmed by typing the name.
- **Live logs**: the "Logs" tab streams in real time with filter, pause, auto-scroll, error highlighting and download (operator and above).
- **Container state** (best effort): "Failed" — service enabled but its container crashed; "No container".
- **All services**: one list across all panels with filters and **bulk operations**: deploy / restart / start / stop, **bulk env editing** (add/change/remove keys, comments preserved), **bulk image change**.
- **Templates and cloning**: move a service (env, source, resources) to another panel in one click; save a service as a template and deploy it on any panel.
- **Schedules**: restart/deploy/start/stop services and Docker cleanup — daily (by weekday) or at an interval; run manually; failures go to notifications.
- **Inventory**: which images run where and **version mismatches** between panels; **certificate** expiry across panels.
- **CI/CD webhooks**: a URL that deploys/restarts a service without signing in (`curl -X POST …`); the token is stored hashed.
- **API console**: call any tRPC procedure of a panel directly (admin only).
- **Search and commands** — `Ctrl/⌘ + K` or `/`; favorites and recent services first.

**Notifications** (Telegram, email over SMTP and webhook): panel unreachable (after two failed checks) and recovered, token error, disk full (configurable threshold), certificate expiring (< 7 days), service stopped/crashed outside EasyAdmin, schedule error. The notification language (RU/EN) is set in *Settings → Notifications*.

**Users and access**
- **Profile** (click your name in the sidebar): name and email, password change (other devices are signed out), 2FA, **active sessions** (device, IP, last activity; end any or all others), language, theme, your recent actions.
- **Users** (administrator): a table with role, sign-in method (password / SSO / 2FA), panel access, last sign-in and status; create, edit (username, name, email, role, panels, password, 2FA reset), **disable an account** (sign-in blocked, sessions ended), end all sessions, delete. The last administrator cannot be demoted, disabled or deleted, and you cannot disable or delete yourself.
- Roles: `admin`; `operator` (deploy, restart, env, domains — no deletion or system operations); `viewer` (read-only, **no env or secrets**).
- Restrict a user to a set of panels (e.g. a contractor sees only "Client Acme").
- **SSO (OpenID Connect)**: sign in via Keycloak, Authentik, Google, Azure AD, Okta, etc. (see below).
- **2FA (TOTP)**, password change, admin-side 2FA reset.
- Audit log with search and **CSV export** (kept for 90 days).

**Operations**: backup from the UI (+ `scripts/restore.js`), Prometheus metrics (`/metrics`), light/dark theme, responsive layout. An unreachable panel does not affect the others.

## Security

- Panel tokens are encrypted (AES-256-GCM) and never returned to the client.
- Passwords use scrypt; sessions are random tokens in an `HttpOnly; SameSite=Strict` cookie (only a hash is stored).
- The `viewer` role never receives env or secret fields; per-panel access is enforced server-side on every request.
- Webhook tokens are stored hashed and shown once; calls are rate-limited.
- CSRF: mandatory header `X-Requested-With` + `Origin` check; login attempt limiting; CSP and security headers.
- Redirects are not followed when talking to panels (a token cannot leak to another host).

## Configuration (environment variables)

See `.env.example`. Schedule time zone — the `TZ` variable (e.g. `TZ=Europe/Berlin`). Notification language default — `EASYADMIN_LANG=en` (changeable in the UI). Metrics: set `EASYADMIN_METRICS_TOKEN` and add `authorization: {credentials: <token>}` for `/metrics` in Prometheus.

## SSO (OpenID Connect)

Set `EASYADMIN_PUBLIC_URL` (e.g. `https://admin.example.com`) and `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`. Register the redirect URI `https://admin.example.com/api/oidc/callback` with your provider. A "Sign in with …" button appears on the sign-in page.

- Authorization Code + PKCE; the `id_token` signature (RS256/ES256) is verified against the JWKS, and `iss`, `aud`, expiry and `nonce` are checked. The provider must use HTTPS.
- A new user is created on first sign-in with the `OIDC_DEFAULT_ROLE` role (default `viewer`); addresses in `OIDC_ADMIN_EMAILS` become `admin`; the very first sign-in into an empty system is also `admin`. Change roles and panel access later in *Settings → Users*.
- An existing local user whose username equals the verified email is linked to the SSO account, keeping their role.
- `OIDC_ALLOWED_DOMAINS` restricts email domains. An SSO user's password is unusable — sign-in only through the provider (the provider handles 2FA).

## Easypanel template catalog

*Templates → Easypanel catalog* shows the same templates Easypanel offers when creating a service (about 850, with search and tags): a card with description and links, a parameter form, a **schema preview** and one-click deployment to the chosen panel (the project is created automatically).

How it works: EasyAdmin reads the public [easypanel-io/templates](https://github.com/easypanel-io/templates) repository (`list.json`, and each template's `meta.yaml` and `index.ts`), obtains a `{services:[{type,data}]}` schema and hands it to the panel through `templates.createFromSchema` — the same as “Create from JSON”.
The `generate` function in `index.ts` is TypeScript code from that repository. **It runs on the EasyAdmin server**, therefore: only admins can trigger it; it runs in an empty, isolated `node:vm` context (no `process`, `require`, network or files; `eval`/`Function` are forbidden; random values are passed in as a string from `crypto`; 2 s timeout; capped result size); templates that need third-party modules or cryptography (keys, hashes) are marked as unsupported. `vm` isolation is not an OS-level security boundary, so if you do not trust the source, use your own mirror (`EASYADMIN_CATALOG_URL`, pinned to a revision) or disable the catalog (`EASYADMIN_CATALOG=off`).
Check the whole catalog: `node scripts/catalog-check.js /path/to/templates` (a local clone of the repository).

Besides the catalog: *Import Easypanel schema* (paste JSON from “Create from JSON” and deploy it to a panel) and export of a saved template as such a schema.

## Service console and panel settings

**Service console** (service card → *Console*, admins only): a terminal inside the container. Command input with history (↑↓), Ctrl+C, quick commands, output download. The Easypanel terminal runs over a WebSocket: `/ws/containerShell` (needs `container` and base64 `command`) and `/ws/hostShell`, messages `{"input":…}` → `{"output":…}`. The panel calls `JSON.parse` on every frame unguarded, so plain text crashes its process — auto-detection sends JSON only, `raw` is manual only. For other panel versions EasyAdmin tries known paths and those found in the panel UI and detects the input format with `echo __EA$((a+b))__`; on failure all attempts are shown; custom paths via `EASYPANEL_CONSOLE_PATHS` / `EASYPANEL_SERVER_CONSOLE_PATHS`. For a multi-container (compose) service pick the container from the list. Up to three consoles per user; they close after 10 minutes without input and after an hour. The log records opening/closing a session and the *number* of commands, never the commands themselves (they may contain passwords). Disable with `EASYADMIN_CONSOLE=off`; custom paths via `EASYPANEL_CONSOLE_PATHS`.

**Server console** (*Console* menu item, admins only): a terminal of the host itself through Easypanel’s built-in console (*Settings → Server → Console*) — no SSH or passwords needed, it works through the panel address (IP or domain). The same path and format auto-detection, the same session limits and audit; the session and its output survive page navigation. Custom paths via `EASYPANEL_SERVER_CONSOLE_PATHS`.

**Easypanel settings** (panel page → *Settings*, admins only): real forms instead of JSON — addresses (panel domain, base service domain, IP, Let's Encrypt e-mail), general (telemetry, nightly Docker cleanup, Google Analytics, GitHub token), branding (name, links, error pages, custom code), updates and Docker (versions, Easypanel update, image and build-cache cleanup, builders), Easypanel users (create, role, password, API tokens, own e-mail/password/2FA), metrics and log collection, Traefik (YAML and env with version history and restore), Swarm cluster, backup storage, notification channels and the panel's activity log. “Advanced” is the previous generic access to the panel's procedures. Backup storage (S3, SFTP, FTP, folder) and the panel's notification channels (Discord, Slack, Telegram, webhook, SMTP) are created and edited right here with a send test; keys and passwords are never shown, and an empty field keeps the current value when editing. Interface logos are uploaded as files (PNG, JPEG, GIF, WebP, SVG up to 500 KB). A service (database or app) has a *Backups* tab: schedules for database or volume copies, run now, a log of copies and restoring a database from a successful copy (confirmed with `project/service`). Every change is written to the audit log with the old and new value (secrets masked); dangerous ones need confirmation, and domains and Traefik require typing the panel name. The user EasyAdmin acts as on the panel can be neither deleted nor given a new token — access would be lost. The **Compare panels** page (*#/psettings*) shows the settings of all panels in one table and applies shared ones (Let's Encrypt e-mail, telemetry, cleanup, links, error pages, custom code) to the selected panels with a per-panel report.

**Panel settings** (panel page → *Settings*, admins only): `settings.*`, `branding.*`, `users.*` and other procedures are taken from the panel's own UI (Easypanel has no public list). Reading is safe and secrets are masked (they can be revealed); writing sends JSON to the procedure as is — the panel validates the format and returns the reason on error; for paired `get…`/`set…` procedures the current values are prefilled, dangerous actions (restart, delete, reset) require typing the name. The *API console* remains for arbitrary calls.

## Live logs

Logs come over the panel's own WebSocket; EasyAdmin proxies them to the browser via SSE. The exact WebSocket path depends on the Easypanel version and is undocumented, so `/ws/serviceLogs`, `/api/ws/serviceLogs` and `/ws/logs` are tried in turn. If your version uses another path, set `EASYPANEL_LOGS_PATHS`; on failure the tab shows which paths were tried.

## Backup and restore

*Settings → Backup* downloads a JSON with the database (panels, users, templates, log). Panel tokens are encrypted, so keep `EASYADMIN_SECRET` (or include the key in the file). Restore into an empty directory: `node scripts/restore.js backup.json ./data`.

## Easypanel compatibility

Easypanel has no public API documentation; its internal tRPC is used (`/api/trpc/...`, `Authorization: Bearer <token>`). The mapping from features to procedures lives in one place — `src/easypanel.js` — and responses are parsed defensively. Check your panel version:

```bash
npm run probe -- https://panel.example.com <API_TOKEN>
```

The script prints the shape of key responses. In the UI, open **Diagnostics** on a panel page for the same report (secrets redacted). Until a field is recognized, that block is simply not shown (or shows "expiry unknown") and everything else keeps working.

## Localization

All UI texts are Russian in the source and translated at render time through the single dictionary `public/js/i18n-dict.js` (shared by the browser and the server, so API errors, notifications and emails are translated too). To add a string, add a `[ru, en]` pair — `npm test` fails if a Russian literal in the code has no translation; `node e2e/i18n.mjs` walks every screen in English and reports anything left untranslated.

## Development

```bash
npm test         # API tests against an Easypanel mock (test/mock-easypanel.js) + localization checks
npm run dev      # run with auto-reload
node e2e/ui.mjs  # end-to-end UI check in a browser (needs playwright and a running npm run demo); runs in CI
```

Layout: `src/` — server (`app.js` routes and permissions, `routes-ext.js` templates/schedules/webhooks/inventory, `easypanel.js` client and operations, `manager.js` cache and statuses, `alerts.js` notifications, `scheduler.js`, `totp.js`, `oidc.js`, `smtp.js`, `ws.js`), `public/` — UI, `test/` — tests and the panel mock, `docs/TZ.md` — specification and plan.
