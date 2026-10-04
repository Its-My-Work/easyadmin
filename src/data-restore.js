import { DB_ENGINES, HOLD_LINES, deployJob, shq } from './data-backup.js';
import { runOnHost } from './host-exec.js';

/**
 * Восстановление данных баз и томов из архива сервиса (`проект__сервис__метка.tar[.enc]`) прямо из EasyAdmin.
 * Как и копирование, работает на сервере панели отдельным процессом (systemd-run, юнит ea-data-restore) через консоль хоста:
 *  - архив читается потоком (с диска сервера или по временной подписанной ссылке S3), расшифровывается паролем копий и распаковывается
 *    только в нужные части; пароль живёт на сервере только на время запуска;
 *  - перед перезаписью каждой части делается страховочная копия текущего состояния (папка before-restore рядом с копиями);
 *  - тома: сервис останавливается на время распаковки и всегда запускается обратно; базы восстанавливаются внутри их контейнера;
 *  - сам EasyAdmin остановить нельзя — его собственный том так не восстанавливается.
 * Режимы: «заменить» (clean — базы и папки сначала очищаются) и «дописать» (merge — поверх имеющегося).
 * Целью может быть тот же сервис, другой существующий или только что созданный: части подбираются по тегам (db-postgres, vol-имя, …).
 */
export const RESTORE_UNIT = 'ea-data-restore';
export const MODES = ['clean', 'merge'];
const MEMBER_RE = /^((?:db|vol|bind)-[A-Za-z0-9_.-]+|(?:cdb|cvol|cbind)~[A-Za-z0-9_.~-]+)\.(sql|archive|tar|rdb)\.gz$/;

/** Разбор имени файла части внутри архива. */
export function parseMember(member) {
  const m = MEMBER_RE.exec(String(member)); if (!m) return null;
  const tag = m[1]; const p = tag.split('~');
  let kind = 'volume'; let compose = false; let bind = false;
  if (tag.startsWith('db-')) kind = tag.slice(3);
  else if (p[0] === 'cdb') { kind = p[1]; compose = true; }
  else if (p[0] === 'cvol') compose = true;
  else if (p[0] === 'cbind') { compose = true; bind = true; }
  else if (tag.startsWith('bind-')) bind = true;
  if (kind !== 'volume' && !DB_ENGINES.includes(kind)) return null;
  return { member, tag, kind, compose, bind };
}

/** Ключ сопоставления части копии и части цели: у томов compose имя тома начинается с «проект_сервис_», его отбрасываем. */
export function tagKey(tag, ref) {
  const p = tag.split('~');
  if (p[0] === 'cvol') { const prefix = `${ref.project}_${ref.service}_`; const vol = p.slice(2).join('~'); return `cvol~${p[1]}~${vol.startsWith(prefix) ? vol.slice(prefix.length) : vol}`; }
  return tag;
}

/** Какие части копии куда попадут. targetParts — части цели из resolveTargets (режим stop, чтобы были условия заморозки). */
export function planMembers(members, srcRef, tgtRef, targetParts) {
  const byKey = new Map(targetParts.map((x) => [tagKey(x.tag, tgtRef), x]));
  return members.map((member) => {
    const pm = parseMember(member); if (!pm) return { member, status: 'unknown', tag: member, kind: 'volume' };
    const part = byKey.get(tagKey(pm.tag, srcRef));
    if (!part) return { ...pm, status: 'nomatch' };
    if (pm.kind === 'redis' && pm.compose) return { ...pm, status: 'unsupported' };
    return { ...pm, status: 'ok', part };
  });
}

const HDR = (c) => `BASE=${shq(c.baseDir)}; RUN=${shq(c.runId)}; MINFREE=${Number(c.minFreeKb)}; MODE=${shq(c.mode)}; SNAP=${c.snapshot ? 1 : 0}; HOLDMODE=stop; SELF_FAIL=1`;
const sc = (s) => String(s).replace(/\|/g, '/');
const segments = (p) => String(p).split('/').filter(Boolean).length;

/** Команды в контейнер базы: очистка и восстановление. Тексты внутри контейнера идут в heredoc с кавычками — без экранирования. */
function dbRestoreLines(kind, fn, filter, svc) {
  const L = [];
  const cid = `  C=$(docker ps -q ${filter} | head -n1); [ -n "$C" ] || { echo EA_NOCONT >&2; return 3; }`;
  if (kind === 'postgres') {
    L.push(`${fn}() {`, '  local f=$1 C', cid, '  if [ "$MODE" = clean ]; then docker exec -i "$C" sh -s <<\'EA_CLEAN\' || return 1',
      'export PGPASSWORD="$POSTGRES_PASSWORD"; U="${POSTGRES_USER:-postgres}"',
      'for d in $(psql -U "$U" -d postgres -Atc "select datname from pg_database where not datistemplate and datname <> \'postgres\'"); do',
      '  case "$d" in *[!A-Za-z0-9_.-]*) continue;; esac',
      '  psql -U "$U" -d postgres -qAtc "select pg_terminate_backend(pid) from pg_stat_activity where datname = \'$d\' and pid <> pg_backend_pid()" >/dev/null',
      '  psql -U "$U" -d postgres -q -c "DROP DATABASE \\"$d\\"" || exit 1',
      'done',
      'psql -U "$U" -d postgres -q -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public" || exit 1',
      'EA_CLEAN', '  fi',
      '  gunzip -c "$f" | docker exec -i "$C" sh -c \'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "${POSTGRES_USER:-postgres}" -d postgres -q\' 2>"$LOGD/$RUN.warn"; local p0=${PIPESTATUS[0]} p1=${PIPESTATUS[1]} rc',
      '  grep -E "ERROR" "$LOGD/$RUN.warn" | grep -v "already exists" | head -n3 | tr \'\\n|\' \'  \' > "$LOGD/$RUN.warn2"; [ -s "$LOGD/$RUN.warn2" ] && printf \'WARN|%s|%s\\n\' "$MEMBER" "$(cat "$LOGD/$RUN.warn2")" >> "$ST"',
      '  rc=$p1; [ "$p0" -ne 0 ] && rc=$p0; return $rc', '}');
  } else if (kind === 'mysql' || kind === 'mariadb') {
    L.push(`${fn}() {`, '  local f=$1 C', cid, '  if [ "$MODE" = clean ]; then docker exec -i "$C" sh -s <<\'EA_CLEAN\' || return 1',
      'M=$(command -v mariadb || command -v mysql); P="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"',
      'for d in $("$M" -uroot -p"$P" -N -e "show databases" 2>/dev/null | grep -Ev "^(information_schema|performance_schema|mysql|sys)$"); do',
      '  case "$d" in *[!A-Za-z0-9_$-]*) continue;; esac',
      '  "$M" -uroot -p"$P" -e "DROP DATABASE \\`$d\\`" 2>/dev/null || exit 1',
      'done',
      'EA_CLEAN', '  fi',
      '  gunzip -c "$f" | docker exec -i "$C" sh -c \'M=$(command -v mariadb || command -v mysql); "$M" -uroot -p"${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"\'', '}');
  } else if (kind === 'mongo') {
    L.push(`${fn}() {`, '  local f=$1 C', cid,
      '  gunzip -c "$f" | docker exec -i "$C" sh -c "mongorestore --archive ${DROPFLAG} -u \\"\\$MONGO_INITDB_ROOT_USERNAME\\" -p \\"\\$MONGO_INITDB_ROOT_PASSWORD\\" --authenticationDatabase admin"', '}');
  } else if (kind === 'redis') {
    L.push(`${fn}() {`, '  local f=$1 dir', `  dir=$(redis_dir ${shq(svc)}) || { echo EA_NOREDISDATA >&2; return 3; }`,
      '  for x in appendonly.aof appendonlydir; do [ -e "$dir/$x" ] && mv "$dir/$x" "$dir/$x.before-restore.$RUN"; done',
      '  gunzip -c "$f" > "$dir/dump.rdb.new" && mv -f "$dir/dump.rdb.new" "$dir/dump.rdb" && chown --reference="$dir" "$dir/dump.rdb"', '}');
  }
  return L;
}

/** Страховочная копия текущего состояния части: аргумент — файл, куда писать. Нет данных — ничего не пишем (код 0). */
function snapLines(part, fn, filter, svc) {
  const L = [];
  if (part.kind === 'volume' && part.bind) { const pd = part.hostPath.replace(/\/[^/]*$/, '') || '/'; const bn = part.hostPath.split('/').filter(Boolean).pop(); L.push(`${fn}() { [ -e ${shq(part.hostPath)} ] || return 0; tar -C ${shq(pd)} -czf "$1" ${shq(bn)}; }`); }
  else if (part.kind === 'volume') L.push(`${fn}() { [ -d ${shq(part.hostPath)} ] || return 0; tar -C ${shq(part.hostPath)} -czf "$1" .; }`);
  else if (part.kind === 'redis') L.push(`${fn}() { local d; d=$(redis_dir ${shq(svc)}) || return 0; [ -f "$d/dump.rdb" ] && gzip -c "$d/dump.rdb" > "$1"; return 0; }`);
  else {
    const dump = {
      postgres: `sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dumpall -U "\${POSTGRES_USER:-postgres}"'`,
      mysql: `sh -c 'M=$(command -v mariadb-dump || command -v mysqldump); "$M" --all-databases --single-transaction --routines --events -uroot -p"\${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"'`,
      mongo: `sh -c 'mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'`,
    }[part.kind === 'mariadb' ? 'mysql' : part.kind];
    L.push(`${fn}() { local C; C=$(docker ps -q ${filter} | head -n1); [ -n "$C" ] || { echo EA_NOCONT >&2; return 3; }; ( set -o pipefail; docker exec "$C" ${dump} | gzip -c > "$1" ); }`);
  }
  return L;
}

function volumeRestoreLines(part, fn) {
  if (part.bind) {
    const pd = part.hostPath.replace(/\/[^/]*$/, '') || '/'; const bn = part.hostPath.split('/').filter(Boolean).pop();
    return [`${fn}() { local f=$1; mkdir -p ${shq(pd)} || return 1; if [ "$MODE" = clean ]; then rm -rf -- ${shq(`${pd.replace(/\/$/, '')}/${bn}`)} || return 1; fi; gunzip -c "$f" | tar -xpf - -C ${shq(pd)}; }`];
  }
  return [`${fn}() { local f=$1; mkdir -p ${shq(part.hostPath)} || return 1; if [ "$MODE" = clean ]; then find ${shq(part.hostPath)} -mindepth 1 -delete || return 1; fi; gunzip -c "$f" | tar -xpf - -C ${shq(part.hostPath)}; }`];
}

/** Общая шапка: каталоги, пароль, статус, заморозка, проверка места. */
function head(c, { password, needBytes }) {
  return [
    '#!/bin/bash', HDR(c),
    'LOGD="$BASE/.runs"; ST="$LOGD/$RUN.status"; TMPD="$BASE/.work"; STAGE="$TMPD/$RUN.stage"; SNAPD="$BASE/before-restore/$RUN"; HOLDS=(); PASSF=""',
    'umask 077; mkdir -p "$LOGD" "$TMPD" || exit 1',
    'find "$LOGD" -type f -mtime +7 -delete 2>/dev/null; find "$BASE/before-restore" -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} + 2>/dev/null',
    /^[A-Za-z0-9_.-]{1,64}$/.test(c.selfId ?? '') ? `SELFID=${shq(c.selfId)}; SELFSVC=$(docker inspect -f '{{index .Config.Labels "com.docker.swarm.service.name"}}' "$SELFID" 2>/dev/null)` : 'SELFID=""; SELFSVC=""',
    ...HOLD_LINES,
    'trap \'hold_end; rm -f "$LOGD/$RUN.pw" "$0"; rm -rf "${STAGE:?}"\' EXIT',
    password ? `PASSF="$LOGD/$RUN.pw"; printf %s ${shq(Buffer.from(password).toString('base64'))} | base64 -d > "$PASSF"` : '',
    'echo START > "$ST"',
    'fail() { printf \'FAIL|%s|%s|%s\\n\' "$1" "$2" "$3" >> "$ST"; }',
    `avail=$(df -Pk "$BASE" | awk 'NR==2{print $4}')`,
    `if [ "\${avail:-0}" -lt "$((MINFREE + ${Math.ceil(Number(needBytes || 0) / 1024)}))" ]; then fail "*" NOSPACE "$((avail/1024))"; echo DONE >> "$ST"; exit 1; fi`,
  ];
}

/** Поток архива: файл на сервере или S3 → расшифровка → tar. */
function streamCmd({ source, encrypted }) {
  const src = source.url ? `curl -sSf ${shq(source.url)}` : `cat ${shq(source.file)}`;
  return `${src} | ${encrypted ? 'openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass file:"$PASSF"' : 'cat'}`;
}
const XFAIL = [
  'xfail() { # args: stderr-file',
  '  if grep -qE "curl: \\([0-9]+\\)" "$1"; then fail "*" S3GET "$(grep -o "curl: .*" "$1" | head -n1 | tr \'|\' \' \')"; elif grep -qiE "bad decrypt|bad magic|not look like a tar|skipping to next header|checksum" "$1"; then fail "*" BADPASS ""; else fail "*" CMD "$(tail -c 300 "$1" | tr \'\\n|\' \'  \')"; fi',
  '  echo DONE >> "$ST"; exit 1',
  '}',
];

/** Скрипт просмотра архива: список частей и их размеров (без записи данных). */
export function buildInspectScript(c) {
  return [...head({ ...c, mode: 'merge', snapshot: false, minFreeKb: 0 }, { password: c.password, needBytes: 0 }), ...XFAIL,
    'XE="$LOGD/$RUN.xerr"',
    `( set -o pipefail; ${streamCmd(c)} | tar -tvf - ) > "$LOGD/$RUN.list" 2>"$XE" || xfail "$XE"`,
    `awk '$NF != "RESTORE.txt" && NF >= 6 { print "M|" $3 "|" $NF }' "$LOGD/$RUN.list" >> "$ST"`,
    'rm -f "$LOGD/$RUN.list"',
    'echo DONE >> "$ST"', ''].filter(Boolean).join('\n');
}

/** Скрипт восстановления. parts: [{ member, label, kind, bind?, hostPath?, filter?, svc?, hold? }] — уже сопоставленные с целью. */
export function buildRestoreScript(c) {
  const { parts, source, encrypted } = c;
  const members = parts.map((x) => x.member);
  const L = [...head(c, { password: c.password, needBytes: c.needBytes }), ...XFAIL,
    // каталог данных Redis: монтирование /data сервиса swarm (том или папка на сервере)
    'redis_dir() { local r t s; r=$(docker service inspect -f \'{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{if eq .Target "/data"}}{{.Type}} {{.Source}}{{end}}{{end}}\' "$1" 2>/dev/null); t=${r%% *}; s=${r#* }; case "$t" in volume) echo "/var/lib/docker/volumes/$s/_data";; bind) echo "$s";; *) return 1;; esac; }',
    '[ "$MODE" = clean ] && DROPFLAG=--drop || DROPFLAG=""',
    'do_restore() { # args: member fn snapfn hold',
    '  local member=$1 fn=$2 snapfn=$3 hold=$4 rc perr="$LOGD/$RUN.perr"; MEMBER=$member; LABEL=$member',
    '  printf \'RUN|%s|%s\\n\' "$member" "$member" >> "$ST"',
    '  hold_start "$hold"; rc=$?',
    '  if [ $rc -eq 9 ]; then fail "$member" EA_SELF ""; hold_end; return; fi',
    '  if [ "$SNAP" = 1 ] && [ "$snapfn" != - ]; then mkdir -p "$SNAPD"; "$snapfn" "$SNAPD/$member" 2>"$perr" || { fail "$member" SNAP "$(tail -c 300 "$perr" | tr \'\\n|\' \'  \')"; rm -f "$SNAPD/$member"; hold_end; return; }; [ -s "$SNAPD/$member" ] && printf \'SNAP|%s|%s\\n\' "$member" "$SNAPD" >> "$ST"; fi',
    '  "$fn" "$STAGE/$member" 2>"$perr"; rc=$?',
    '  hold_end',
    '  if [ $rc -ne 0 ]; then fail "$member" CMD "$(tail -c 300 "$perr" | tr \'\\n|\' \'  \')"; return; fi',
    '  rm -f "$STAGE/$member"; printf \'OK|%s\\n\' "$member" >> "$ST"',
    '}',
    'XE="$LOGD/$RUN.xerr"; mkdir -p "$STAGE"',
    `( set -o pipefail; ${streamCmd({ source, encrypted })} | tar -xf - -C "$STAGE" -- ${members.map(shq).join(' ')} ) 2>"$XE" || { { grep -q "Not found in archive" "$XE" && ! grep -qiE "bad decrypt|not look like a tar|curl: \\(" "$XE"; } || xfail "$XE"; }`,
  ];
  parts.forEach((x, i) => {
    const rf = `rp${i}`; const sf = `sp${i}`;
    if (x.kind === 'volume') {
      L.push(...volumeRestoreLines(x, rf), ...snapLines(x, sf));
    } else {
      L.push(...dbRestoreLines(x.kind, rf, x.filter, x.svc), ...snapLines(x, sf, x.filter, x.svc));
    }
    L.push(`if [ -f "$STAGE"/${shq(x.member)} ]; then do_restore ${shq(x.member)} ${rf} ${sf} ${shq(x.hold ?? '-')}; else fail ${shq(x.member)} NOTINARCHIVE ""; fi`);
  });
  L.push('echo DONE >> "$ST"');
  return L.filter(Boolean).join('\n') + '\n';
}

/** Коды ошибок скрипта восстановления → понятные сообщения. */
export function describeRestoreFail(code, arg) {
  switch (code) {
    case 'NOSPACE': return `Мало места на диске сервера: свободно ${arg} МБ`;
    case 'BADPASS': return 'Не удалось расшифровать архив: неверный пароль копии или файл повреждён';
    case 'S3GET': return `Не удалось скачать архив из S3: ${arg}`;
    case 'NOTINARCHIVE': return 'Этой части нет в архиве';
    case 'SNAP': if (/EA_NOCONT/.test(arg)) return describeRestoreFail('CMD', arg); return `Не удалось сделать страховочную копию текущих данных (восстановление этой части не начиналось): ${arg}`;
    case 'EA_SELF': return 'Это сам EasyAdmin: его собственные данные так восстановить нельзя — используйте «Восстановить систему»';
    default: {
      if (/EA_NOCONT/.test(arg)) return 'Контейнер сервиса не запущен: запустите сервис и повторите';
      if (/EA_NOREDISDATA/.test(arg)) return 'Не найдена папка данных Redis (монтирование /data): восстановите dump.rdb вручную';
      return String(arg).trim() || 'Команда завершилась с ошибкой';
    }
  }
}
export function parseRestoreStatus(text) {
  const members = []; const parts = {}; const warns = {}; let snapDir = null; let done = false; let started = false; let current = null; let general = null;
  for (const raw of String(text).split('\n')) {
    const l = raw.replace(/\r/g, '').trim();
    if (l === 'DONE') done = true; else if (l === 'START') started = true;
    else if (/^M\|/.test(l)) { const [, size, ...n] = l.split('|'); members.push({ member: n.join('|'), size: Number(size) || 0 }); }
    else if (/^RUN\|/.test(l)) current = l.split('|')[2];
    else if (/^OK\|/.test(l)) { parts[l.split('|')[1]] = { ok: true }; current = null; }
    else if (/^FAIL\|/.test(l)) { const [, m, code, ...rest] = l.split('|'); const error = describeRestoreFail(code, rest.join('|')); if (m === '*') general = error; else parts[m] = { ok: false, error }; current = null; }
    else if (/^WARN\|/.test(l)) { const [, m, ...rest] = l.split('|'); warns[m] = rest.join('|').trim(); }
    else if (/^SNAP\|/.test(l)) snapDir = l.split('|')[2];
  }
  return { members, parts, warns, snapDir, done, started, current: done ? null : current, general };
}

export async function readRestoreStatus(c, row, baseDir, runId, host = runOnHost) {
  const r = await host(c, row, `cat ${shq(`${baseDir}/.runs/${runId}.status`)} 2>/dev/null || true`, { timeoutMs: 20_000 });
  return parseRestoreStatus(r.output);
}
export const startRestoreJob = (c, row, { baseDir, runId, script }, host = runOnHost) => deployJob(c, row, { baseDir, runId, script, unit: RESTORE_UNIT }, host);
export { sc as safeLabel, segments };
