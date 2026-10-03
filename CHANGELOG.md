# Changelog

## Unreleased

- **Backups fix: runaway scheduled backups.** In “stop” mode the backup stopped EasyAdmin's own service while copying its volume, the progress tracking was lost and the schedule started a new run over and over (hundreds of archives, S3 full). Now EasyAdmin never stops or freezes itself during a backup, a started attempt is recorded so the schedule never repeats it the same day, results are saved per service as soon as each is ready, and a run that was in progress when EasyAdmin restarted is followed to the end (results, cleanup, rotation).
- Rotation in S3 reads the listing page by page and runs both before and after a backup, so old archives are really removed.
- The status column shows the queue: "Queued", "Copying…" with the volume or database being copied, then the result. New **Backup log** (every run with the full error text of each service) and a "Latest runs" list in each service's copies window.
- **Backups are EasyAdmin-only and one page.** Easypanel's own backup schedules (service tab, schedule sync, storage providers in the panel settings) are removed from the code. The Backups section is a single page: a table of services with a switch, last backup and status, a switch for EasyAdmin itself, and one Settings dialog (schedule, where to store, how many copies, password). The service's **Backups** tab works with the same data (switch, back up now, copies, how to restore) for every service type.
- **One password for all EasyAdmin backups**: system copies and database/volume archives are encrypted with it (AES-256, PBKDF2); nothing is backed up without it. Data archives are now `*.tar.enc` (older plain `.tar` files still open and restore).
- New: back up a single service now; `where` setting (server/S3) for both kinds of copies.
- **Data backups: one archive per service** (also for compose stacks) instead of one file per database or volume; the archive holds a `.gz` per part and `RESTORE.txt` with restore commands. Fixed: a bind-mounted single file (e.g. `claude.json`) was reported as "folder not found"; a missing volume source is now a warning instead of a failure of the whole service.
- Docs: the English README is now the default (`README.md`), the Russian one moved to `README.ru.md` and is linked from the top of the English one; README screenshots are in English with English panel names (`DEMO_NAMES=en DEMO_BACKUPS=1 npm run demo`, then `node scripts/screenshots.mjs`) and include the new Backups overview.
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
- **Rename and move a service** (the pencil icon next to the service name opens a dialog with the new name and project): uses Easypanel’s own rename (stop → rename/move → start, the original is started back on failure) and updates EasyAdmin’s schedules, webhooks, load history and backup scope. Compose stacks are not supported.
- **Service history** is a single list of all events with a “Log” button on deployments; panel timestamps without a time zone are now read as UTC (they were shifted by the EasyAdmin time zone, so a deployment could show up twice).
- Service card → **Overview** is compact: facts in two columns (panel, project and type are already in the card header), domains as chips, shorter notes box and smaller action buttons.
- **Backups → Overview** is compact: a slim stats strip, one line per service, services grouped by panel.
- Fixed: service action buttons — the spinner now also turns when the system asks to reduce motion, and the new state (status, icons, buttons) appears right when the “started/stopped” notice does instead of after the whole list is reloaded.
- Fixed: compose stacks disappeared from **Backups → Overview** once the scope was “Selected services”; they are always listed now (EasyAdmin data copies cover them). Removed the long explanatory paragraph above the table.
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
