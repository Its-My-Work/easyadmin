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
- **Rename and move a service** (service card → “Name and project”): uses Easypanel’s own rename (stop → rename/move → start, the original is started back on failure) and updates EasyAdmin’s schedules, webhooks, load history and backup scope. Compose stacks are not supported.
- **Service history** is a single list of all events with a “Log” button on deployments; panel timestamps without a time zone are now read as UTC (they were shifted by the EasyAdmin time zone, so a deployment could show up twice).
- Service card → **Overview** is compact: facts in two columns (panel, project and type are already in the card header), domains as chips, shorter notes box and smaller action buttons.
- **Backups → Overview** is compact: a slim stats strip, one line per service, services grouped by panel.
- Header: language switch, profile and sign-out moved next to the server time; the sidebar footer is gone.
- Settings: removed the informational blocks about backups, personal settings and the CI/CD webhooks card (webhooks live in the service’s “Automation” tab).
- **Backups → Data**: one place to choose what to back up and how. Two methods that can be combined: **Easypanel schedules** (EasyAdmin creates, updates and removes the schedules in the panels itself from a single policy: services, schedule, number of copies, storage per panel; your own schedules are left alone; database schedules are skipped on panels without a license) and **EasyAdmin data copies**. The overview marks schedules maintained by EasyAdmin (“auto”) and the “Set up” dialog turns on both methods for a service in one step.
- Database and volume copies are no longer encrypted with a password (the “Encrypt with the backup password” option is gone); the password now protects only the system copy (`.eabak`). Old `.enc` files can still be restored. Turning on the schedule no longer requires a password.

## 0.9.0 — first public beta

- Multi-panel console: overview, services, deploys, actions, bulk operations, templates, schedules, webhooks, inventory, audit log, roles, 2FA, SSO.
- Service logs and consoles, host console, Easypanel settings (domains, users, builders, Traefik, license, notifications, storage, backups).
- Docker and Easypanel updates (Ubuntu/Debian), panel installation over SSH.
- **Load monitoring**: own history from the free panel API, charts, services table, "What is loading the server?" snapshot, overload alerts.
- **Backups**: encrypted EasyAdmin system and panel configurations, schedule, rotation, local or S3 storage, verify and restore (experimental restore).
- **Data backups** (experimental): database dumps and volumes made on the panel's server, host or S3 destination, compose stacks, Redis, volume consistency (pause/stop), multipart upload for large files.
- Russian and English interface.
- Removed the old unencrypted `GET /api/backup` export (it could include the encryption key); use encrypted backups instead. The backup schedule hour is shown against the EasyAdmin server clock.
