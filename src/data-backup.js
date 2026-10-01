import zlib from 'node:zlib';
import { runOnHost } from './host-exec.js';
import { inspectService } from './easypanel.js';

/**
 * Копии данных: дампы баз (postgres, mysql, mariadb, mongo, redis) и тома сервисов (в том числе внутри compose-стеков) снимаются на
 * самом сервере панели скриптом, который запускается отдельным процессом (systemd-run) через консоль хоста. Данные не проходят через EasyAdmin:
 *  - «на сервер»: файл остаётся в папке на сервере панели;
 *  - «в S3»: сервер сам загружает файл по временным подписанным ссылкам (ключи S3 на него не передаются); большие файлы — частями (multipart).
 * Пароли баз не покидают контейнер: дамп запускается внутри него и берёт пароль из его окружения.
 * Согласованность томов: «как есть» / «приостановить» (docker pause) / «остановить» на время копирования; сервис всегда возвращается.
 */
export const DB_ENGINES = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
export const DEFAULT_DIR = '/var/backups/easyadmin';
export const CONSISTENCY = ['none', 'pause', 'stop'];
const SAFE = /^[A-Za-z0-9_.-]+$/;
const GIB = 1024 ** 3;

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const slugOf = (row) => `p${row.id}-${String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'panel'}`;
export const validDir = (d) => typeof d === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(d) && !d.includes('..') && d !== '/';
export const stampOf = (ts) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
export const engineOfImage = (image) => {
  const full = String(image).toLowerCase(); const i = full.replace(/^.*\//, '');
  if (/^(postgres|postgis|timescaledb|pgvector|pgvecto)/.test(i) || /timescale|postgres/.test(full)) return 'postgres';
  if (/^mariadb/.test(i)) return 'mariadb';
  if (/^mysql/.test(i)) return 'mysql';
  if (/^mongo/.test(i)) return 'mongo';
  if (/^(redis|valkey|keydb)/.test(i)) return 'redis';
  return null;
};

/** Что выполнить внутри контейнера для дампа. Пароль берётся из окружения контейнера (для Redis — из окружения или из аргументов запуска). */
const DUMP = {
  postgres: `sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dumpall -U "\${POSTGRES_USER:-postgres}"'`,
  mysql: `sh -c 'mysqldump --all-databases --single-transaction --routines --events -uroot -p"$MYSQL_ROOT_PASSWORD"'`,
  mariadb: `sh -c 'D=$(command -v mariadb-dump || command -v mysqldump); "$D" --all-databases --single-transaction --routines --events -uroot -p"\${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"'`,
  mongo: `sh -c 'mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'`,
  redis: `sh -c 'P="$REDIS_PASSWORD"; [ -n "$P" ] || P=$(tr "\\\\0" "\\\\n" </proc/1/cmdline | sed -n "/^--requirepass$/{n;p}"); F=/tmp/ea-$$.rdb; redis-cli \${P:+-a "$P" --no-auth-warning} --rdb "$F" >/dev/null 2>&1 && cat "$F"; rc=$?; rm -f "$F"; exit $rc'`,
};
const EXT = { postgres: 'sql', mysql: 'sql', mariadb: 'sql', mongo: 'archive', redis: 'rdb', volume: 'tar' };
const swarmFilter = (project, service) => `--filter ${shq(`name=^${project}_${service}\\.`)}`;
const composeFilter = (project, service, cs) => `--filter ${shq(`label=com.docker.compose.project=${project}_${service}`)} --filter ${shq(`label=com.docker.compose.service=${cs}`)}`;
const BAD_BIND = /^\/(var\/run|run|proc|sys|dev|etc\/easypanel\/(?!projects\/))/;

/** Обнаружение контейнеров compose-стеков на сервере: C|id|проект_сервис|compose-сервис|образ и M|тип|имя|путь для каждого монтирования. */
export const DISCOVER_CMD = `docker ps --filter label=com.docker.compose.project --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Image}}' 2>/dev/null | while IFS='|' read -r id p s img; do echo "C|$id|$p|$s|$img"; docker inspect -f '{{range .Mounts}}M|{{.Type}}|{{.Name}}|{{.Source}}{{"\\n"}}{{end}}' "$id" 2>/dev/null; done; true`;
export function parseDiscovery(text) {
  const out = []; let cur = null;
  for (const raw of String(text).split('\n')) {
    const l = raw.replace(/\r/g, '').trim();
    if (l.startsWith('C|')) { const [, id, project, svc, ...img] = l.split('|'); cur = { id, project, svc, image: img.join('|'), mounts: [] }; out.push(cur); }
    else if (l.startsWith('M|') && cur) { const [, type, name, ...src] = l.split('|'); cur.mounts.push({ type, name, source: src.join('|') }); }
  }
  return out;
}

/** Цели копирования панели. Тома баз не копируются (есть дамп); compose-стеки разбираются по обнаруженным контейнерам. */
export async function resolveTargets(client, row, projects, { mode, keys, consistency = 'none' }, stamp, { compose = [] } = {}) {
  const wanted = (p, s) => mode === 'all' || keys.includes(`${row.id}|${p}|${s}`);
  const items = []; const services = projects.flatMap((p) => p.services.map((s) => ({ ...s, project: p.name }))).filter((s) => wanted(s.project, s.name));
  const slug = slugOf(row); const hold = (spec) => (consistency === 'none' ? null : spec);
  const add = (it) => { it.prefix = `${it.project}__${it.service}__${it.tag}__`; it.file = `${it.prefix}${stamp}.${EXT[it.kind]}.gz`; it.slug = slug; items.push(it); };
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(3, services.length) }, async () => {
    while (i < services.length) {
      const s = services[i++];
      if (s.type === 'compose') {
        const mine = compose.filter((c) => c.project === `${s.project}_${s.name}`); const seen = new Set();
        for (const c of mine) {
          const eng = engineOfImage(c.image); const csv = String(c.svc).replace(/[^A-Za-z0-9_.-]/g, '_');
          const filter = composeFilter(s.project, s.name, c.svc);
          if (eng) { add({ kind: eng, tag: `cdb~${eng}~${csv}`, project: s.project, service: s.name, filter, label: `${s.project}/${s.name} · ${c.svc} (${eng})` }); continue; }
          for (const m of c.mounts) {
            if (m.type === 'volume' && SAFE.test(m.name) && !seen.has(m.name)) { seen.add(m.name); add({ kind: 'volume', tag: `cvol~${csv}~${m.name}`, project: s.project, service: s.name, volume: m.name, hostPath: `/var/lib/docker/volumes/${m.name}/_data`, hold: hold(`ids:${filter}`), label: `${s.project}/${s.name} · ${c.svc}: ${m.name}` }); }
            else if (m.type === 'bind' && validDir(m.source) && !BAD_BIND.test(m.source) && !seen.has(m.source)) { seen.add(m.source); add({ kind: 'volume', tag: `cbind~${csv}~${m.source.split('/').filter(Boolean).pop().replace(/[^A-Za-z0-9_.-]/g, '_')}`, project: s.project, service: s.name, volume: m.source, hostPath: m.source, hold: hold(`ids:${filter}`), label: `${s.project}/${s.name} · ${c.svc}: ${m.source}` }); }
          }
        }
        continue;
      }
      if (DB_ENGINES.includes(s.type)) { add({ kind: s.type, tag: `db-${s.type}`, project: s.project, service: s.name, filter: swarmFilter(s.project, s.name), label: `${s.project}/${s.name} · ${s.type}` }); continue; }
      try {
        const { mounts } = await inspectService(client, { type: s.type, project: s.project, name: s.name });
        for (const m of Array.isArray(mounts) ? mounts : []) {
          const type = m.type ?? m.mountType; const h = hold(`swarm:${s.project}_${s.name}`);
          if (type === 'volume' && SAFE.test(String(m.name ?? ''))) add({ kind: 'volume', tag: `vol-${m.name}`, project: s.project, service: s.name, volume: m.name, hostPath: `/etc/easypanel/projects/${s.project}/${s.name}/volumes/${m.name}`, hold: h, label: `${s.project}/${s.name} · ${m.name}` });
          else if (type === 'bind' && typeof m.hostPath === 'string' && validDir(m.hostPath)) add({ kind: 'volume', tag: `bind-${m.hostPath.split('/').filter(Boolean).pop().replace(/[^A-Za-z0-9_.-]/g, '_')}`, project: s.project, service: s.name, volume: m.hostPath, hostPath: m.hostPath, hold: h, label: `${s.project}/${s.name} · ${m.hostPath}` });
        }
      } catch { /* сервис недоступен — пропускаем, ошибка конфигурации уже отражена в копии конфигураций */ }
    }
  }));
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

export const needsDiscovery = (projects, { mode, keys }, rowId) => projects.some((p) => p.services.some((s) => s.type === 'compose' && (mode === 'all' || keys.includes(`${rowId}|${p.name}|${s.name}`))));

/** Оценка размера томов (байт, без сжатия): по ней решаем, нужна ли загрузка частями. */
export async function measureVolumes(c, row, items, host = runOnHost) {
  const paths = [...new Set(items.filter((x) => x.kind === 'volume').map((x) => x.hostPath))]; const sizes = new Map();
  for (let i = 0; i < paths.length; i += 12) {
    const batch = paths.slice(i, i + 12);
    const r = await host(c, row, `for p in ${batch.map(shq).join(' ')}; do du -sb "$p" 2>/dev/null | cut -f1 | tr '\\n' ' '; echo "$p"; done; true`, { timeoutMs: 120_000 }).catch(() => ({ output: '' }));
    for (const l of r.output.split('\n')) { const m = /^(\d+)\s+(\/.*)$/.exec(l.trim()); if (m) sizes.set(m[2], Number(m[1])); }
  }
  return sizes;
}

/** Скрипт для сервера панели (bash). Один элемент — одна запись в файле статуса: OK|метка|файл|байт или FAIL|метка|код|аргумент. */
export function buildScript({ runId, baseDir, dest, keep, minFreeKb, items, consistency = 'none', mpMin = 5 * GIB - 1, partMb = 1024 }) {
  const lines = [
    '#!/bin/bash',
    `BASE=${shq(baseDir)}; RUN=${shq(runId)}; DEST=${shq(dest)}; KEEP=${Number(keep)}; MINFREE=${Number(minFreeKb)}; HOLDMODE=${shq(consistency)}; MPMIN=${Number(mpMin)}; PS=$((${Number(partMb)} * 1048576))`,
    'LOGD="$BASE/.runs"; ST="$LOGD/$RUN.status"; TMPD="$BASE/.work"; HOLDS=()',
    'umask 077; mkdir -p "$LOGD" "$TMPD" || exit 1',
    'hold_end() { local h; for h in "${HOLDS[@]}"; do case "$h" in pause:*) docker unpause ${h#pause:} >/dev/null 2>&1;; start:*) docker start ${h#start:} >/dev/null 2>&1;; scale:*) docker service scale -d "${h#scale:}" >/dev/null 2>&1;; esac; done; HOLDS=(); }',
    'trap \'hold_end; rm -f "${TMPD:?}/${RUN:?}".*\' EXIT',
    'echo START > "$ST"',
    'fail() { printf \'FAIL|%s|%s|%s\\n\' "$1" "$2" "$3" >> "$ST"; }',
    'avail=$(df -Pk "$BASE" | awk \'NR==2{print $4}\')',
    'if [ "${avail:-0}" -lt "$MINFREE" ]; then fail "*" NOSPACE "$((avail/1024))"; echo DONE >> "$ST"; exit 1; fi',
    // заморозка владельца тома на время копирования: pause — docker pause, stop — остановка (swarm: scale до 0); возврат гарантирован trap
    'hold_start() {',
    '  local spec=$1 ids svc r n; if [ "$HOLDMODE" = none ] || [ -z "$spec" ] || [ "$spec" = - ]; then return 0; fi',
    '  case "$spec" in',
    '    swarm:*) svc=${spec#swarm:}',
    '      if [ "$HOLDMODE" = pause ]; then ids=$(docker ps -q --filter "name=^${svc}\\."); if [ -n "$ids" ]; then docker pause $ids >/dev/null 2>&1 && HOLDS+=("pause:$ids"); fi',
    '      else r=$(docker service inspect -f \'{{.Spec.Mode.Replicated.Replicas}}\' "$svc" 2>/dev/null); if [ -n "$r" ] && [ "$r" -gt 0 ] 2>/dev/null; then docker service scale -d "$svc=0" >/dev/null 2>&1 && HOLDS+=("scale:$svc=$r"); for n in $(seq 1 60); do [ -z "$(docker ps -q --filter "name=^${svc}\\.")" ] && break; sleep 1; done; fi; fi;;',
    '    ids:*) eval "ids=\\$(docker ps -q ${spec#ids:})"',
    '      if [ -n "$ids" ]; then if [ "$HOLDMODE" = pause ]; then docker pause $ids >/dev/null 2>&1 && HOLDS+=("pause:$ids"); else docker stop -t 30 $ids >/dev/null 2>&1; HOLDS+=("start:$ids"); fi; fi;;',
    '  esac',
    '}',
    'upload_mp() { # args: file size spec; spec lines: 1 complete URL, 2 abort URL, then part URLs; parts of PS bytes',
    '  local tmp=$1 size=$2 spec=$3 total nparts n url skip len hdr="$TMPD/$RUN.h" etags="" etag',
    '  total=$(( (size + PS - 1) / PS )); nparts=$(( $(wc -l < "$spec") - 2 )); [ "$total" -le "$nparts" ] || return 11',
    '  for n in $(seq 1 "$total"); do',
    '    url=$(sed -n "$((n+2))p" "$spec"); skip=$(( (n-1) * PS / 1048576 )); len=$(( size - (n-1) * PS )); [ "$len" -gt "$PS" ] && len=$PS',
    '    dd if="$tmp" bs=1M skip="$skip" count=$(( (len + 1048575) / 1048576 )) 2>/dev/null | head -c "$len" | curl -sS -f -D "$hdr" -o /dev/null -H "Content-Length: $len" -H \'Transfer-Encoding:\' -T - "$url" || { curl -sS -X DELETE "$(sed -n 2p "$spec")" >/dev/null 2>&1; return 12; }',
    '    etag=$(grep -i \'^etag:\' "$hdr" | head -n1 | tr -d \'\\r\' | sed \'s/^[Ee][Tt][Aa][Gg]: *//\'); etags="$etags<Part><PartNumber>$n</PartNumber><ETag>$etag</ETag></Part>"',
    '  done',
    '  curl -sS -f -X POST -H \'Content-Type: application/xml\' --data "<CompleteMultipartUpload>$etags</CompleteMultipartUpload>" -o "$TMPD/$RUN.c" "$(sed -n 1p "$spec")" || return 13',
    '  ! grep -q \'<Error>\' "$TMPD/$RUN.c" || return 14',
    '}',
    'run_item() {',
    '  local label=$1 name=$2 url=$3 sub=$4 prefix=$5 fn=$6 hold=$7 mp=$8; local tmp="$TMPD/$RUN.$RANDOM" err="$LOGD/$RUN.err" rc size out',
    '  hold_start "$hold"',
    '  ( set -o pipefail; "$fn" | gzip -c > "$tmp" ) 2>"$err"; rc=$?',
    '  hold_end',
    '  if [ $rc -ne 0 ]; then fail "$label" CMD "$(tail -c 300 "$err" | tr \'\\n|\' \'  \')"; rm -f "${tmp:?}"; return; fi',
    '  size=$(stat -c %s "$tmp" 2>/dev/null || echo 0)',
    '  if [ "$size" -lt 30 ]; then fail "$label" EMPTY ""; rm -f "${tmp:?}"; return; fi',
    '  if [ "$DEST" = s3 ]; then',
    '    if [ "$size" -gt "$MPMIN" ] && [ -n "$mp" ] && [ -f "$mp" ]; then upload_mp "$tmp" "$size" "$mp"; rc=$?; if [ $rc -ne 0 ]; then fail "$label" S3MP "$rc"; rm -f "${tmp:?}"; return; fi',
    '    else',
    '      if [ "$size" -gt 5368709120 ]; then fail "$label" S3BIG ""; rm -f "${tmp:?}"; return; fi',
    '      out=$(curl -sS -f -o /dev/null -T "$tmp" "$url" 2>&1) || { fail "$label" S3UP "$(printf %s "$out" | tail -c 200 | tr \'\\n|\' \'  \')"; rm -f "${tmp:?}"; return; }',
    '    fi',
    '    rm -f "${tmp:?}"',
    '  else',
    '    mkdir -p "$BASE/$sub" && mv "$tmp" "$BASE/$sub/$name" || { fail "$label" SAVE "$BASE/$sub"; rm -f "${tmp:?}"; return; }',
    '    ls -1t "$BASE/$sub/$prefix"* 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f --',
    '  fi',
    '  printf \'OK|%s|%s|%s\\n\' "$label" "$name" "$size" >> "$ST"',
    '}',
  ];
  items.forEach((it, n) => {
    const fn = `p${n}`;
    if (it.kind === 'volume') lines.push(`${fn}() { [ -d ${shq(it.hostPath)} ] || { echo "EA_NODIR:${it.hostPath}" >&2; return 3; }; tar -C ${shq(it.hostPath)} -cf - .; }`);
    else lines.push(`${fn}() { local C; C=$(docker ps -q ${it.filter} | head -n1); [ -n "$C" ] || { echo EA_NOCONT >&2; return 3; }; docker exec "$C" ${DUMP[it.kind]}; }`);
    let mp = "'-'";
    if (it.mp) { mp = `"$LOGD/$RUN.mp${n}"`; lines.push(`cat > "$LOGD/$RUN.mp${n}" <<'EA_MP'`, it.mp.complete, it.mp.abort, ...it.mp.parts, 'EA_MP'); }
    lines.push(`run_item ${shq(it.label.replace(/\|/g, '/'))} ${shq(it.file)} ${shq(it.url ?? '-')} ${shq(it.slug)} ${shq(it.prefix)} ${fn} ${shq(it.hold ?? '-')} ${mp}`);
  });
  lines.push('echo DONE >> "$ST"');
  return lines.filter(Boolean).join('\n') + '\n';
}

/** Коды ошибок скрипта → понятные сообщения (в самом скрипте русского текста нет). */
function describeFail(code, arg) {
  switch (code) {
    case 'NOSPACE': return `Мало места на диске сервера: свободно ${arg} МБ`;
    case 'EMPTY': return 'Получился пустой файл';
    case 'S3BIG': return 'Файл больше 5 ГБ: S3 принимает одним запросом не больше';
    case 'S3MP': return `Загрузка в S3 частями не удалась (код ${arg})`;
    case 'S3UP': return `Загрузка в S3: ${arg}`;
    case 'SAVE': return `Не удалось сохранить файл в ${arg}`;
    default: {
      if (/EA_NOCONT/.test(arg)) return 'Контейнер сервиса не запущен';
      const d = /EA_NODIR:(\S+)/.exec(arg); if (d) return `Папки ${d[1]} нет на сервере`;
      return arg.trim() || 'Команда завершилась с ошибкой';
    }
  }
}
export function parseStatus(text) {
  const items = []; let done = false; let started = false;
  for (const raw of String(text).split('\n')) {
    const l = raw.replace(/\r/g, '').trim();
    if (l === 'DONE') done = true; else if (l === 'START') started = true;
    else if (/^OK\|/.test(l)) { const [, label, name, size] = l.split('|'); items.push({ ok: true, label, name, size: Number(size) || 0 }); }
    else if (/^FAIL\|/.test(l)) { const [, label, code, ...rest] = l.split('|'); items.push({ ok: false, label, error: describeFail(code, rest.join('|')) }); }
  }
  return { items, done, started };
}

/** Доставка скрипта на сервер (в консоли строка ограничена, поэтому — сжатым и порциями) и запуск отдельным процессом. */
export async function deployJob(c, row, { baseDir, runId, script }, host = runOnHost) {
  const b64 = zlib.gzipSync(Buffer.from(script)).toString('base64');
  const dir = `${baseDir}/.runs`; const f = `${dir}/${runId}`;
  const chunks = b64.match(/.{1,1400}/g) ?? [];
  for (const [i, ch] of chunks.entries()) {
    const r = await host(c, row, `umask 077; mkdir -p ${shq(dir)} && printf %s ${shq(ch)} ${i ? '>>' : '>'} ${shq(`${f}.b64`)}`, { timeoutMs: 20_000 });
    if (!r.ok) throw new Error(`Не удалось записать скрипт на сервер: ${r.output.slice(-200)}`);
  }
  const start = `umask 077; base64 -d ${shq(`${f}.b64`)} | gunzip > ${shq(`${f}.sh`)} && rm -f ${shq(`${f}.b64`)} && `
    + `if systemctl is-active --quiet ea-data-backup 2>/dev/null; then echo EA_RUNNING; false; `
    + `elif command -v systemd-run >/dev/null 2>&1 && systemd-run --unit=ea-data-backup --collect --description='EasyAdmin: data backup' bash ${shq(`${f}.sh`)} >/dev/null 2>&1; then echo EA_STARTED; `
    + `else (nohup bash ${shq(`${f}.sh`)} >/dev/null 2>&1 &) ; echo EA_STARTED; fi`;
  const r = await host(c, row, start, { timeoutMs: 25_000 });
  if (/EA_RUNNING/.test(r.output)) throw new Error('На этом сервере уже идёт копирование данных');
  if (!r.ok || !/EA_STARTED/.test(r.output)) throw new Error(`Не удалось запустить копирование на сервере: ${r.output.slice(-200)}`);
}

export async function readStatus(c, row, baseDir, runId, host = runOnHost) {
  const r = await host(c, row, `cat ${shq(`${baseDir}/.runs/${runId}.status`)} 2>/dev/null || true`, { timeoutMs: 20_000 });
  return parseStatus(r.output);
}
export const cleanupJob = (c, row, baseDir, runId, host = runOnHost) => host(c, row, `rm -f ${shq(`${baseDir}/.runs/${runId}`)}.* 2>/dev/null; true`, { timeoutMs: 15_000 }).catch(() => {});

export async function listHostFiles(c, row, baseDir, slug, host = runOnHost) {
  const r = await host(c, row, `find ${shq(`${baseDir}/${slug}`)} -maxdepth 1 -type f -printf 'F|%f|%s|%T@\\n' 2>/dev/null; true`, { timeoutMs: 20_000 });
  return r.output.split('\n').map((l) => l.trim()).filter((l) => /^F\|/.test(l)).map((l) => { const [, name, size, ts] = l.split('|'); return { name, size: Number(size), ts: Math.round(Number(ts) * 1000) }; });
}

const NAME_RE = /^([a-z0-9_-]+)__([a-z0-9_-]+)__((?:db|vol|bind)-[A-Za-z0-9_.-]+|(?:cdb|cvol|cbind)~[A-Za-z0-9_.~-]+)__(\d{8}-\d{6})\.(sql|archive|tar|rdb)\.gz(\.enc)?$/;
export const parseName = (n) => { const m = NAME_RE.exec(n); return m ? { project: m[1], service: m[2], tag: m[3], stamp: m[4], ext: m[5], encrypted: !!m[6] } : null; };
export const groupKey = (n) => n.replace(/__\d{8}-\d{6}\..*$/, '');

/** Команды восстановления для копии и пояснения. Копии с суффиксом .enc сделаны прежними версиями (с паролем) — для них оставлена расшифровка; пароль не подставляется. */
export function restoreHint(name, where) {
  const p = parseName(name); if (!p) throw new Error('Некорректное имя файла');
  const stream = p.encrypted ? `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass pass:'YOUR_BACKUP_PASSWORD' -in ${shq(name)} | gunzip -c` : `gunzip -c ${shq(name)}`;
  const compose = p.tag.startsWith('c') && p.tag.includes('~'); const parts = p.tag.split('~');
  const composeSvc = compose ? (parts[0] === 'cdb' ? parts[2] : parts[1]) : null;
  const sel = compose ? `--filter ${shq(`label=com.docker.compose.project=${p.project}_${p.service}`)} --filter ${shq(`label=com.docker.compose.service=${composeSvc}`)}` : `--filter ${shq(`name=^${p.project}_${p.service}\\.`)}`;
  const C = `"$(docker ps -q ${sel} | head -n1)"`;
  const kind = p.tag.startsWith('db-') ? p.tag.slice(3) : parts[0] === 'cdb' ? parts[1] : 'volume';
  const dir = p.tag.startsWith('vol-') ? shq(`/etc/easypanel/projects/${p.project}/${p.service}/volumes/${p.tag.slice(4)}`) : parts[0] === 'cvol' ? shq(`/var/lib/docker/volumes/${parts.slice(2).join('~')}/_data`) : "'SOURCE_FOLDER'";
  const run = {
    postgres: `${stream} | docker exec -i ${C} sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "\${POSTGRES_USER:-postgres}"'`,
    mysql: `${stream} | docker exec -i ${C} sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'`,
    mariadb: `${stream} | docker exec -i ${C} sh -c 'mysql -uroot -p"\${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"'`,
    mongo: `${stream} | docker exec -i ${C} sh -c 'mongorestore --archive --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'`,
    redis: `${stream} > dump.rdb`,
    volume: `${stream} | tar -xf - -C ${dir}`,
  }[kind];
  const steps = [];
  if (where?.url) steps.push(`curl -fL -o ${shq(name)} ${shq(where.url)}`);
  else if (where?.dir) steps.push(`cd ${shq(where.dir)}`);
  steps.push(run);
  return { text: steps.join('\n'), notes: [kind === 'volume' ? 'Остановите сервис в Easypanel перед восстановлением томов.' : kind === 'redis' ? 'Остановите Redis, положите dump.rdb в папку его данных и запустите сервис снова.' : 'Восстановление дописывает данные в работающую базу; для чистого восстановления сначала очистите её.', ...(p.encrypted ? ['Подставьте пароль копии вместо YOUR_BACKUP_PASSWORD.'] : []), ...(/^c?bind/.test(p.tag) ? ['Замените SOURCE_FOLDER на папку, из которой копировали том.'] : [])] };
}
