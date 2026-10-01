# Changelog

## Unreleased

- Menu: "Services" (was "All services"); order Overview, Console, Services, Inventory, Templates, Schedules, Log, Users, Settings.
- **Service history** tab in the service card: panel actions (deploys with their logs, updated live while a deploy runs) together with operations made through EasyAdmin.
- Deploy, restart, start and stop buttons show a spinner until the action really finishes (a deploy is followed until the panel reports it done or failed).
- **Server time** in the header; **time zone** is chosen in Settings and applies to schedules, data backups and all timestamps in the interface.
- Load monitoring: choose the measuring interval (1, 2, 5, 10 or 15 minutes).
- Inventory lists every service (databases and compose stacks too, not only apps), with the service type.
- Certificates: compact icon buttons, new "Delete" next to "Reissue".
- Log: the full error text is visible in the Action column.
- Fixed: the notification channel list and the "Events" list in the channel form were empty until the first save.
- Background refresh no longer scrolls pages with their own data (log, settings, schedules, inventory…) back to the top or makes them flicker.
- "Add panel" is one form with a switch: "Connect Easypanel" / "Install and connect Easypanel".
- **Backups** are now a separate menu section: *Overview* (what is backed up where, by service across all panels, with "not set up" and "last run failed" flags), *Data*, *System* and shared *Settings* (schedule, S3, password). The card in Settings is replaced by a link.
- Removed the explanatory banner from the server console page.

## 0.9.0 — first public beta

- Multi-panel console: overview, services, deploys, actions, bulk operations, templates, schedules, webhooks, inventory, audit log, roles, 2FA, SSO.
- Service logs and consoles, host console, Easypanel settings (domains, users, builders, Traefik, license, notifications, storage, backups).
- Docker and Easypanel updates (Ubuntu/Debian), panel installation over SSH.
- **Load monitoring**: own history from the free panel API, charts, services table, "What is loading the server?" snapshot, overload alerts.
- **Backups**: encrypted EasyAdmin system and panel configurations, schedule, rotation, local or S3 storage, verify and restore (experimental restore).
- **Data backups** (experimental): database dumps and volumes made on the panel's server, host or S3 destination, compose stacks, Redis, volume consistency (pause/stop), multipart upload for large files.
- Russian and English interface.
- Removed the old unencrypted `GET /api/backup` export (it could include the encryption key); use encrypted backups instead. The backup schedule hour is shown against the EasyAdmin server clock.
