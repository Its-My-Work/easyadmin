#!/bin/bash
# EasyAdmin — переезд на этот сервер. Запускать от root на ЧИСТОМ сервере (Ubuntu 22.04+ / Debian 11+).
# Что делает: ставит Docker → скачивает слепок (по одноразовой ссылке) → распаковывает /etc/easypanel и тома →
# запускает Easypanel → восстанавливает базы. Ход виден в EasyAdmin; подробный журнал — /var/log/easyadmin-migration.log.
# Пароль слепка (если он зашифрован): переменная EA_MIGRATION_PASSWORD, файл EA_MIGRATION_PASSWORD_FILE или запрос в терминале.
set -uo pipefail

EA_URL='__EA_URL__'
EA_TOKEN='__EA_TOKEN__'
EA_ENC='__EA_ENC__'
WORK=/var/lib/easyadmin-migration
KEEP=/root/easyadmin-migration
LOG=/var/log/easyadmin-migration.log
export DEBIAN_FRONTEND=noninteractive
umask 077

jesc() { printf %s "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-400; }
# report шаг статус [подробности] — в журнал и в EasyAdmin (если он недоступен, переезд продолжается)
report() {
  local step=$1 status=$2 detail=${3:-}
  printf '%s [%s] %s %s\n' "$(date '+%F %T')" "$step" "$status" "$detail" >> "$LOG"
  printf '[%s] %s %s\n' "$step" "$status" "$detail"
  curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
    --data "{\"step\":\"$(jesc "$step")\",\"status\":\"$(jesc "$status")\",\"detail\":\"$(jesc "$detail")\"}" \
    "$EA_URL/api/migration/report?token=$EA_TOKEN" >/dev/null 2>&1 || true
}
die() { report "$1" error "$2"; exit 1; }
note() { report log info "$1"; }

[ "$(id -u)" = 0 ] || { echo "Запустите от root (sudo -i)" >&2; exit 1; }
mkdir -p "$WORK" "$KEEP"; : >> "$LOG"; chmod 600 "$LOG"

# ---------- 1. проверка сервера ----------
report precheck running "Проверяю сервер"
. /etc/os-release 2>/dev/null
case "${ID:-}" in ubuntu|debian) ;; *) die precheck "Поддерживаются Ubuntu 22.04+ и Debian 11+ (здесь: ${ID:-unknown})";; esac
command -v apt-get >/dev/null 2>&1 || die precheck "Нужен apt-get"
case "$(uname -m)" in x86_64|aarch64) ;; *) die precheck "Архитектура $(uname -m) не поддерживается";; esac
mem=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[ "${mem:-0}" -ge 1700 ] || die precheck "Мало памяти: ${mem} МБ (нужно не меньше 2 ГБ)"
if [ -d /etc/easypanel ] && [ -n "$(ls -A /etc/easypanel 2>/dev/null)" ] && [ "${EA_FORCE:-0}" != 1 ]; then
  die precheck "Каталог /etc/easypanel уже не пуст: на этом сервере уже стоит Easypanel. Переезд нужен на ЧИСТЫЙ сервер (принудительно: EA_FORCE=1)"
fi
busy=""
for p in 80 443 3000; do (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' | grep -qE "[:.]$p$" && busy="$busy $p"; done
[ -z "$busy" ] || [ "${EA_FORCE:-0}" = 1 ] || die precheck "Заняты порты:$busy — освободите их"
apt-get update -y >> "$LOG" 2>&1
apt-get install -y curl ca-certificates openssl tar gzip iproute2 >> "$LOG" 2>&1 || die precheck "Не удалось установить curl/openssl/tar"
CURL=(curl -fsSL ${EA_CURL_OPTS:-})
HEAD=$("${CURL[@]}" -I -m 30 "$EA_URL/api/migration/snapshot?token=$EA_TOKEN" 2>/dev/null | tr -d '\r') || die precheck "Не достучался до EasyAdmin ($EA_URL) или ссылка устарела"
SIZE=$(printf '%s\n' "$HEAD" | awk 'tolower($1)=="content-length:" {print $2}' | tail -n1)
SHA=$(printf '%s\n' "$HEAD" | awk 'tolower($1)=="x-snapshot-sha256:" {print $2}' | tail -n1)
[ -n "$SIZE" ] || die precheck "EasyAdmin не отдал слепок (ссылка устарела или слепок удалён)"
mkdir -p "$WORK" && avail=$(df -Pk "$WORK" | awk 'NR==2{print $4}')
need=$(( SIZE / 1024 * 3 ))
[ "${avail:-0}" -ge "$need" ] || die precheck "Мало места на диске: свободно $((avail/1024)) МБ, нужно около $((need/1024)) МБ"
PW=""
if [ "$EA_ENC" = 1 ]; then
  if [ -n "${EA_MIGRATION_PASSWORD:-}" ]; then PW=$EA_MIGRATION_PASSWORD
  elif [ -n "${EA_MIGRATION_PASSWORD_FILE:-}" ] && [ -r "$EA_MIGRATION_PASSWORD_FILE" ]; then PW=$(cat "$EA_MIGRATION_PASSWORD_FILE")
  elif [ -r /dev/tty ]; then read -rsp "Пароль резервных копий EasyAdmin (слепок зашифрован): " PW </dev/tty; echo
  fi
  [ -n "$PW" ] || die precheck "Слепок зашифрован: задайте EA_MIGRATION_PASSWORD или запустите в терминале"
fi
report precheck ok "$ID $VERSION_ID, ${mem} МБ ОЗУ, слепок $((SIZE/1048576)) МБ"

# ---------- 2. Docker ----------
report install_docker_swarm running "Проверяю Docker"
if ! command -v docker >/dev/null 2>&1; then
  "${CURL[@]}" https://get.docker.com | sh >> "$LOG" 2>&1 || die install_docker_swarm "Не удалось установить Docker (журнал: $LOG)"
fi
systemctl enable --now docker >> "$LOG" 2>&1 || true
docker info >/dev/null 2>&1 || die install_docker_swarm "Docker не запустился"
report install_docker_swarm ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null); Swarm создаст установщик Easypanel"

# ---------- 3. скачивание ----------
report transfer running "Скачиваю слепок"
SNAP="$WORK/snapshot"
curl -fL --retry 8 --retry-delay 3 --retry-all-errors -C - ${EA_CURL_OPTS:-} -sS -o "$SNAP" "$EA_URL/api/migration/snapshot?token=$EA_TOKEN" &
cpid=$!
while kill -0 "$cpid" 2>/dev/null; do
  sleep 5; cur=$(stat -c %s "$SNAP" 2>/dev/null || echo 0)
  report transfer running "$((cur/1048576)) из $((SIZE/1048576)) МБ"
done
wait "$cpid" || die transfer "Скачивание не удалось (проверьте, что сервер видит $EA_URL)"
[ "$(stat -c %s "$SNAP")" = "$SIZE" ] || die transfer "Размер скачанного файла не совпал"
if [ -n "$SHA" ]; then [ "$(sha256sum "$SNAP" | awk '{print $1}')" = "$SHA" ] || die transfer "Контрольная сумма слепка не совпала"; fi
if [ "$EA_ENC" = 1 ]; then
  printf %s "$PW" > "$WORK/pw"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass file:"$WORK/pw" -in "$SNAP" -out "$SNAP.tgz" 2>>"$LOG"; rc=$?
  shred -u "$WORK/pw" 2>/dev/null || rm -f "$WORK/pw"
  [ $rc -eq 0 ] && gzip -t "$SNAP.tgz" 2>/dev/null || die transfer "Не удалось расшифровать слепок: неверный пароль копий?"
  rm -f "$SNAP"; mv "$SNAP.tgz" "$SNAP"
else
  gzip -t "$SNAP" 2>/dev/null || die transfer "Слепок повреждён (не gzip)"
fi
report transfer ok "Слепок получен и проверен"

# ---------- 4. распаковка ----------
report unpack_and_start running "Проверяю состав слепка"
bad=$(tar -tzf "$SNAP" | grep -vE '^(etc/easypanel(/|$)|manifest\.json$|data(/|$))' | head -n1)
[ -z "$bad" ] || die unpack_and_start "В слепке посторонний путь: $bad"
tar -tzf "$SNAP" | grep -qE '(^|/)\.\.(/|$)' && die unpack_and_start "В слепке недопустимые пути"
rm -rf "$KEEP/data"; mkdir -p "$KEEP"
tar -xzf "$SNAP" -C "$KEEP" manifest.json data 2>>"$LOG"
tar -xzf "$SNAP" -C / etc/easypanel 2>>"$LOG" || die unpack_and_start "Не удалось распаковать /etc/easypanel"
[ -d /etc/easypanel ] || die unpack_and_start "В слепке нет /etc/easypanel"
rm -f "$SNAP"
report unpack_and_start running "/etc/easypanel распакован"

# restore_archives vol|db — команды из RESTORE.txt каждого архива сервиса: тома (tar -xf - -C …) или базы (docker exec …)
restore_archives() {
  local mode=$1 a w line dir fails=0 tries ok
  for a in "$KEEP"/data/*.tar; do
    [ -e "$a" ] || continue
    w=$(mktemp -d "$WORK/r.XXXXXX"); tar -xf "$a" -C "$w" 2>>"$LOG" || { fails=$((fails+1)); continue; }
    while IFS= read -r line; do
      case "$line" in ''|'#'*) continue;; esac
      case "$line" in
        *'tar -xf - -C '*) [ "$mode" = vol ] || continue
          dir=$(printf '%s' "$line" | sed -n "s/.*tar -xf - -C '\([^']*\)'.*/\1/p"); [ -n "$dir" ] && mkdir -p "$dir";;
        *'> dump.rdb'*) [ "$mode" = db ] && note "Redis ($(basename "$a")): положите dump.rdb вручную — см. RESTORE.txt в $a"; continue;;
        *) [ "$mode" = db ] || continue;;
      esac
      ok=0
      for tries in $(seq 1 20); do
        if (cd "$w" && bash -c "$line" </dev/null) >>"$LOG" 2>&1; then ok=1; break; fi
        [ "$mode" = vol ] && break
        sleep 15 # база после развёртывания поднимается не сразу
      done
      [ "$ok" = 1 ] || { fails=$((fails+1)); note "Не удалось восстановить часть из $(basename "$a")"; }
    done < "$w/RESTORE.txt"
    rm -rf "$w"
  done
  return "$fails"
}

if ls "$KEEP"/data/*.tar >/dev/null 2>&1; then
  restore_archives vol || note "Часть томов восстановить не удалось — подробности в $LOG"
  report unpack_and_start running "Тома восстановлены"
fi

# ---------- 5. запуск Easypanel ----------
report unpack_and_start running "Запускаю Easypanel"
docker run --rm -v /etc/easypanel:/etc/easypanel -v /var/run/docker.sock:/var/run/docker.sock:rw easypanel/easypanel setup >> "$LOG" 2>&1 \
  || die unpack_and_start "Установщик Easypanel завершился с ошибкой (журнал: $LOG)"
up=0
for i in $(seq 1 60); do
  if curl -s -o /dev/null -m 5 http://127.0.0.1:3000/; then up=1; break; fi
  sleep 5
done
[ "$up" = 1 ] || die unpack_and_start "Easypanel не отвечает на порту 3000 (журнал: $LOG)"
report unpack_and_start ok "Easypanel запущен"

# ---------- 6. проверка и базы ----------
report verify running "Проверяю сервисы"
swarm=$(docker info -f '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo unknown)
for i in $(seq 1 24); do n=$(docker service ls -q 2>/dev/null | wc -l); [ "${n:-0}" -gt 1 ] && break; sleep 5; done
ip=$(curl -fsS -m 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
if [ "${n:-0}" -le 1 ]; then
  note "Сервисы ещё не развёрнуты: EasyAdmin запустит их (deploy) после проверки. Базы: bash $KEEP/restore-databases.sh"
else
  restore_archives db && note "Базы восстановлены" || note "Часть баз восстановить не удалось — подробности в $LOG"
fi
{ echo '#!/bin/bash'; echo "KEEP=$KEEP; WORK=$WORK; LOG=$LOG; EA_URL=; EA_TOKEN="; echo 'note() { echo "$1"; }'; declare -f restore_archives; echo 'restore_archives db'; } > "$KEEP/restore-databases.sh"
chmod 700 "$KEEP/restore-databases.sh"
report verify ok "Swarm: $swarm; сервисов: ${n:-0}; панель: http://$ip:3000"
report done ok "http://$ip:3000"
echo
echo "Готово. Откройте http://$ip:3000 — учётные записи и токены перенесены из старой панели."
