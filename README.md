<div align="center">

# 🐴 EasyAdmin

### Unified Multi-Server Control Plane for [Easypanel](https://easypanel.io)

**Manage 10–50+ Easypanel servers, Docker clusters, databases, and host files from a single, blazing-fast web console.**  
Zero runtime dependencies • Zero frontend build • 100% self-hosted • Boots in 100ms • Uses < 30MB RAM

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-brightgreen.svg)](package.json)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-orange.svg)](#-zero-build-architecture)
[![Status: Beta](https://img.shields.io/badge/Status-Beta_0.9-blueviolet.svg)](#)
[![Русская документация](https://img.shields.io/badge/🇷🇺_Документация-Русский-red)](README.ru.md)

[**Live Demo**](#-interactive-demo) • [**Quick Start**](#-quick-start-in-60-seconds) • [**Features**](#-features) • [**Host File Manager**](#-host-file-manager--ide-editor) • [**Server Doctor**](#-server-doctor--disk-optimizer) • [**Screenshots**](#-screenshots) • [**Security**](#-security)

</div>

---

## 📸 Screenshots

| Overview Dashboard | Host File Manager & IDE Editor |
|:---:|:---:|
| ![Overview](docs/screenshots/overview.png) | ![Files](docs/screenshots/files.png) |

| Server Doctor & Disk Optimizer | Command Palette 2.0 (`Ctrl + K`) |
|:---:|:---:|
| ![Server Doctor](docs/screenshots/server-doctor.png) | ![Command Palette](docs/screenshots/palette.png) |

| AI Doctor (1-Click Crash Diagnosis) | Public Status Page (Uptime Kuma Alt) |
|:---:|:---:|
| ![AI Doctor](docs/screenshots/ai-doctor.png) | ![Status Page](docs/screenshots/status-page.png) |

| 1-Click Server Migration | 6 Built-in Themes (Dark & Light) |
|:---:|:---:|
| ![Migration](docs/screenshots/migration.png) | ![Themes](docs/screenshots/themes.png) |

| Scheduled Encrypted Backups | Live Fleet Load Monitoring |
|:---:|:---:|
| ![Backups](docs/screenshots/backups.png) | ![Load](docs/screenshots/load.png) |

---

## ⚡ Why EasyAdmin?

Easypanel is fantastic for managing a single VPS. But when you run **3, 10, or 25+ servers**, switching browser tabs, checking separate login sessions, and repeating maintenance tasks across panels becomes tedious.

**EasyAdmin connects all your Easypanel instances into one command center:**
- 🖥️ **Centralized Management**: Aggregate services, CPU/RAM/Disk metrics, and container states from all panels in one live dashboard.
- 📁 **Host File Manager**: Browse server files, edit configs with sidebar tree & `Ctrl+F` search, download tarballs, and upload files without opening SSH ports.
- 🧹 **Server Doctor**: Instant A–F host health score with 1-click `journalctl` vacuum, Docker image/build prune, and Swap configuration.
- 🤖 **AI Doctor**: 1-click crash analysis with zero-leak secret sanitization, root-cause detection, and recommended fixes via any LLM.
- 🚦 **Public Status Page**: Built-in public `/status` replacement for Uptime Kuma with 90-day history bars and live SVG badges.
- ⌨️ **Command Palette 2.0**: Raycast-style keyboard launcher (`Ctrl+K`) with prefixes for commands (`>`), files (`/`), servers (`@`), and logs (`!`).
- 🚀 **1-Click Server Migration**: Migrate an entire Easypanel instance to a fresh VPS in minutes via SSH or an automated one-liner.
- 💾 **Encrypted Multi-Target Backups**: Automatic encrypted backups (`AES-256-GCM`) to S3, SFTP, or local storage.
- 🌍 **6 Languages & 6 Themes**: Full localization (RU, EN, ZH, DE, ES, PT) with 3 dark and 3 light switchable themes.
- 🪶 **Zero Build & Zero Deps**: Powered by native Node.js and vanilla ES modules. Starts in 100ms, consumes < 30MB RAM.

---

## ⏱️ Quick Start in 60 Seconds

### Option 1: Run with Docker Compose (Recommended)

Create a `docker-compose.yml`:

```yaml
services:
  easyadmin:
    image: ghcr.io/its-my-work/easyadmin:latest
    container_name: easyadmin
    restart: unless-stopped
    ports:
      - "3100:3100"
    environment:
      - PORT=3100
      - DATABASE_PATH=/data/easyadmin.db
    volumes:
      - easyadmin_data:/data

volumes:
  easyadmin_data:
```

Launch the container:

```bash
docker compose up -d
```

Open `http://your-server-ip:3100`. The first visitor creates the Master Administrator account.

---

### Option 2: Run directly with Node.js (>= 22.13)

```bash
git clone https://github.com/Its-My-Work/easyadmin.git
cd easyadmin
npm start
```

---

## 🎮 Interactive Demo

Try EasyAdmin locally in a sandboxed environment with mock multi-server data:

```bash
node scripts/demo.js
```

Open `http://localhost:3100` and log in with:
- **Username:** `admin`
- **Password:** `demo12345`

---

## ✨ Features

### 📁 Host File Manager & IDE Editor
- **Root Host Access**: Operates over Easypanel's secure `/ws/hostShell` tunnel. No public SSH port 22 exposure required.
- **Quick Volume Bookmarks**: 1-click jumps to Easypanel project volumes (`/etc/easypanel/projects`), Docker volumes, `/etc`, `/var/log`, and `/`.
- **IDE Split View**: Clicking a file opens a split layout with a **File Tree Explorer** on the left and a full-featured code editor on the right. Switch files in 1 click without closing the editor.
- **Find & Replace (`Ctrl + F` / `Ctrl + H`)**: In-file search with match counter (`1 of 12`), previous/next navigation (`Enter` / `Shift+Enter`), case matching (`Aa`), and automatic line jumping.
- **Sysadmin Essentials**: Line numbers, Word Wrap toggle, Go to line (`Ctrl + G`), Fullscreen mode, and unsaved changes warnings.
- **Archives & Uploads**: Download any directory or file as a `.tar.gz` archive in 1 click. Drag-and-drop file uploading.
- **Safety Guardrails**: Critical system directories (`/`, `/bin`, `/boot`, `/etc`, `/usr`, `/var/lib/docker`) are strictly protected against accidental deletion.

### 🧹 Server Doctor & Disk Optimizer
- **Host Health Score (A–F)**: Automated audit of disk utilization, inode exhaustion, memory deficits, and Docker build cache.
- **1-Click Remediation**:
  - `journalctl --vacuum-size=100M` — instantly frees up 5–20 GB of bloated system logs.
  - `Docker Prune` — removes dangling image layers and stopped containers safely.
  - `Swap in 1-Click` — provisions and activates a 1G, 2G, or 4G swapfile to prevent OOM panics.
- **Live Execution Feedback**: Spinning progress indicators during execution and an output card detailing stdout logs and freed bytes.

### 🤖 AI Doctor (1-Click Crash Diagnosis)
- **Instant Crash Analysis**: Diagnose crashed containers (`Exited (137)`, CrashLoopBackOff, OOM) with one click.
- **Zero-Leak Secret Sanitizer**: Automatically masks passwords, API tokens, JWTs, IPs, and `.env` values before sending logs to LLMs.
- **BYOK (Bring Your Own Key)**: Connects to any OpenAI-compatible API (OmniRoute, DeepSeek, OpenAI, Groq, Ollama).
- **SSE Streaming & Action Buttons**: Real-time streaming verdict with 1-click resolution buttons (*Restart Service*, *Add Swap*, *Clean Logs*).
- **SQLite Fingerprint Caching**: Error hashes are cached for 1 hour to prevent redundant LLM token usage.

### 🚦 Public Status Page (Uptime Kuma Alternative)
- **Public & Autonomous**: Standalone status page at `/status` for users and clients without login prompts.
- **90-Day Uptime History**: Interactive daily status bars with uptime percentages and incident callouts.
- **Incident Management**: Publish maintenance notices and operational incident reports (*Investigating*, *Identified*, *Resolved*).
- **Dynamic SVG Badges**: Embed live status badges directly in GitHub repos and docs (`/status/badge/:slug.svg`).
- **DoS Protected**: 15-second in-memory caching with ETag validation and IP rate limiting.

### ⌨️ Command Palette 2.0 (`Ctrl + K`)
- **Keyboard-Driven Launcher**: Multi-step fuzzy command palette inspired by Raycast and Linear.
- **Context Prefixes**:
  - `>` Run commands (`> restart`, `> logs`, `> backup`, `> doctor`)
  - `/` Jump to host directories in File Manager (`/ /var/log`)
  - `@` Select server / panel
  - `#` Filter by project
  - `!` View service logs
  - `:` Switch themes & languages
  - `?` Keyboard shortcut reference

### 🚀 1-Click Server Migration
- **Zero-Friction Server Transfer**: Move from one cloud provider to another or upgrade your VPS in minutes.
- **Two Migration Modes**:
  1. **Direct SSH**: EasyAdmin connects to a clean server, verifies OS requirements, installs Docker & Swarm, transfers encrypted data, and spins up Easypanel automatically.
  2. **One-Liner Command**: EasyAdmin generates a single secure command (`curl -sSL .../bootstrap.sh?token=... | bash`) to execute as root on the target server.
- **Complete Parity**: Preserves all Easypanel configurations, Let's Encrypt SSL certificates, Git SSH deploy keys, persistent volumes, and databases with optional consistency pausing.

### 🔔 Interactive Alerts (Telegram & Discord)
- **Actionable Notifications**: Instant alerts when containers crash or disks exceed capacity.
- **Inline Action Buttons**: Execute `[ 🔄 Restart ]`, `[ 📜 Logs (20 lines) ]`, `[ 🤖 AI Diagnosis ]`, and `[ 🔕 Mute 1h ]` right from your messenger.
- **Cryptographic Security**: Every button is protected by an HMAC-SHA256 signature with nonce protection and a 15-minute expiration window.

### 🎨 6 Built-in Themes (Dark & Light)
- **3 Dark Themes**: Midnight (Indigo), Emerald (Conifer), and Deep Ocean (Cyan).
- **3 Light Themes**: Classic (Slate), Warm Sand (Amber), and Mint Breeze (Teal).
- **Instant Switcher**: Click the palette icon in the top header or press `Ctrl+K` -> `:`.

### 🌍 6 Languages
- Fully localized in **English**, **Русский**, **简体中文**, **Deutsch**, **Español**, and **Português**.
- Automatically adapts to your browser language preference with 1-click manual override.

---

## 🔒 Security Architecture

- **No Public SSH Ports**: File browsing and host commands operate strictly through Easypanel's authenticated root WebSocket channel (`/ws/hostShell`).
- **Secret Masking**: Sensitive variables, private keys, database passwords, and Bearer tokens are scrubbed from all logs and AI payloads.
- **Encrypted Credentials**: Panel tokens and remote credentials are encrypted at rest using AES-256-GCM.
- **Role-Based Access Control (RBAC)**: Support for Administrator, Operator, and Viewer roles with granular panel assignments.
- **Session Protection**: Signed HTTP-only session cookies with configurable TTL and CSRF verification.

---

## 🛠️ Zero-Build Architecture

EasyAdmin follows a strict zero-build philosophy:

```
┌────────────────────────────────────────────────────────┐
│                      EasyAdmin                         │
│                                                        │
│  Backend:   Node.js (node:http, node:fs, node:sqlite)  │
│  Frontend:  Vanilla ES Modules + Native CSS Variables │
│  Runtime:   Zero NPM dependencies                      │
│  Build:     Zero build step (no Vite, no Webpack)      │
└────────────────────────────────────────────────────────┘
```

- **Boot Time**: ~100 ms
- **Memory Footprint**: ~28 MB RAM under typical load
- **Distribution**: Single lightweight Docker image

---

## 📄 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more details.
