#!/usr/bin/env bash
set -e

# EasyAdmin — 1-Click Installer
# https://github.com/Its-My-Work/easyadmin

BOLD='\033[1m'
ACCENT='\033[38;2;124;131;255m'
GREEN='\033[38;2;63;185;80m'
YELLOW='\033[38;2;210;153;34m'
RED='\033[38;2;248;81;73m'
RESET='\033[0m'

info() { printf "${ACCENT}==>${RESET} ${BOLD}%s${RESET}\n" "$1"; }
ok()   { printf "${GREEN}✔${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
err()  { printf "${RED}✖${RESET} %s\n" "$1" >&2; exit 1; }

printf "\n"
printf "${ACCENT}  🐴 EasyAdmin Installer${RESET}\n"
printf "  ${BOLD}Unified Multi-Server Control Plane for Easypanel${RESET}\n\n"

# 1. OS check
OS="$(uname -s)"
if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
  err "Unsupported operating system: $OS. EasyAdmin requires Linux or macOS."
fi

# 2. Check Docker
info "Checking prerequisites..."
if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  if [ "$OS" = "Linux" ] && [ "$(id -u)" -eq 0 ]; then
    info "Installing Docker via official get.docker.com script..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
    ok "Docker installed successfully."
  else
    err "Please install Docker first: https://docs.docker.com/get-docker/"
  fi
else
  ok "Docker detected ($(docker --version | cut -d',' -f1))."
fi

# 3. Check Docker Compose
COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  err "Docker Compose plugin (v2) or docker-compose is required. Please install it."
fi
ok "Docker Compose detected ($($COMPOSE_CMD version | head -n1))."

# 4. Target Directory
if [ "$(id -u)" -eq 0 ]; then
  INSTALL_DIR="/opt/easyadmin"
else
  INSTALL_DIR="${HOME}/easyadmin"
fi

PORT="${EASYADMIN_PORT:-3100}"

info "Setting up EasyAdmin in ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}/data"
cd "${INSTALL_DIR}"

# 5. Write docker-compose.yml
cat <<EOF > docker-compose.yml
services:
  easyadmin:
    image: ghcr.io/its-my-work/easyadmin:latest
    container_name: easyadmin
    restart: unless-stopped
    ports:
      - "${PORT}:3100"
    environment:
      - PORT=3100
      - DATABASE_PATH=/data/easyadmin.db
    volumes:
      - ./data:/data

volumes:
  easyadmin_data:
EOF
ok "Created docker-compose.yml"

# 6. Pull and Launch
info "Pulling latest EasyAdmin image..."
$COMPOSE_CMD pull easyadmin || true

info "Starting EasyAdmin container..."
$COMPOSE_CMD up -d

# 7. Wait for health check
info "Waiting for service to boot..."
SUCCESS=0
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    SUCCESS=1
    break
  fi
  sleep 1
done

# Detect Public / Local IP
SERVER_IP=""
if command -v curl >/dev/null 2>&1; then
  SERVER_IP="$(curl -s4 --max-time 2 https://ifconfig.me/ip 2>/dev/null || curl -s4 --max-time 2 https://api.ipify.org 2>/dev/null || true)"
fi
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"
fi

printf "\n"
if [ "$SUCCESS" -eq 1 ]; then
  printf "${GREEN}════════════════════════════════════════════════════════════════${RESET}\n"
  printf "  ${BOLD}${GREEN}✔ EasyAdmin is ready!${RESET}\n"
  printf "${GREEN}════════════════════════════════════════════════════════════════${RESET}\n\n"
  printf "  ${BOLD}Open in your browser:${RESET}\n"
  printf "  👉  ${ACCENT}http://${SERVER_IP}:${PORT}${RESET}\n"
  if [ "$SERVER_IP" != "127.0.0.1" ]; then
    printf "  👉  ${ACCENT}http://localhost:${PORT}${RESET} (local)\n"
  fi
  printf "\n"
  printf "  The first visitor will set up the ${BOLD}Master Admin${RESET} account.\n\n"
  printf "  ${BOLD}Useful commands:${RESET}\n"
  printf "  • Directory:   ${INSTALL_DIR}\n"
  printf "  • View logs:   cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f\n"
  printf "  • Update:      cd ${INSTALL_DIR} && ${COMPOSE_CMD} pull && ${COMPOSE_CMD} up -d\n"
  printf "  • Stop:        cd ${INSTALL_DIR} && ${COMPOSE_CMD} down\n"
  printf "  • Restart:     cd ${INSTALL_DIR} && ${COMPOSE_CMD} restart\n\n"
else
  warn "Container started, but healthcheck didn't respond in 20s. Check logs:"
  printf "  cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs\n\n"
fi
