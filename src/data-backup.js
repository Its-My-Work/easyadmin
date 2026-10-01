import zlib from 'node:zlib';
import { runOnHost } from './host-exec.js';
import { inspectService } from './easypanel.js';

/**
 * Копии данных: дампы баз (postgres, mysql, mariadb, mongo) и тома сервисов снимаются на самом сервере панели скриптом, который
 * запускается отдельным процессом (systemd-run) через консоль хоста. Данные не проходят через EasyAdmin:
 *  - «на сервер»: файл остаётся в папке на сервере панели;
 *  - «в S3»: сервер сам загружает файл по временной подписанной ссылке (ключи S3 на сервер не передаются).
 * Пароли баз не покидают контейнер: дамп запускается внутри него и берёт пароль из его собственных переменных окружения.
 */
export const DB_ENGINES = ['postgres', 'mysql', 'mariadb', 'mongo'];
export const DEFAULT_DIR = '/var/backups/easyadmin';
const SAFE = /^[A-Za-z0-9_.-]+$/;

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const slugOf = (row) => `p${row.id}-${String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'panel'}`;
export const validDir = (d) => typeof d === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(d) && !d.includes('..') && d !== '/';
export const stampOf = (ts) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/** Что именно внутри контейнера выполнить для дампа. Пароль берётся из окружения контейнера. */
const DUMP = {
  postgres: `sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dumpall -U "\${POSTGRES_USER:-postgres}"'`,
  mysql: `sh -c 'mysqldump --all-databases --single-transaction --routines --events -uroot -p"$MYSQL_ROOT_PASSWORD"'`,
  mariadb: `sh -c 'D=$(command -v mariadb-dump || command -v mysqldump); "$D" --all-databases --single-transaction --routines --events -uroot -p"\${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"'`,
  mongo: `sh -c 'mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'`,
};
const EXT = { postgres: 'sql', mysql: 'sql', mariadb: 'sql', mongo: 'archive', volume: 'tar' };

/** Цели копирования панели: базы и тома (тома баз не копируем — для них есть дамп; compose — без томов). */
export async function resolveTargets(client, row, projects, { mode, keys }, stamp) {
  const wanted = (p, s) => mode === 'all' || keys.includes(`${row.id}|${p}|${s}`);
  const items = []; const services = projects.flatMap((p) => p.services.map((s) => ({ ...s, project: p.name }))).filter((s) => wanted(s.project, s.name));
  const slug = slugOf(row);
  const add = (it) => { it.file = `${it.project}__${it.service}__${it.tag}__${stamp}.${EXT[it.kind]}.gz${it.encrypt ? '.enc' : ''}`; it.prefix = `${it.project}__${it.service}__${it.tag}__`; it.slug = slug; items.push(it); };
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(3, services.length) }, async () => {
    while (i < services.length) {
      const s = services[i++];
      if (DB_ENGINES.includes(s.type)) { add({ kind: s.type, tag: `db-${s.type}`, project: s.project, service: s.name, label: `${s.project}/${s.name} · ${s.type}` }); continue; }
      if (s.type === 'compose') continue;
      try {
        const { mounts } = await inspectService(client, { type: s.type, project: s.project, name: s.name });
        for (const m of Array.isArray(mounts) ? mounts : []) {
          const type = m.type ?? m.mountType;
          if (type === 'volume' && SAFE.test(String(m.name ?? ''))) add({ kind: 'volume', tag: `vol-${m.name}`, project: s.project, service: s.name, volume: m.name, hostPath: `/etc/easypanel/projects/${s.project}/${s.name}/volumes/${m.name}`, label: `${s.project}/${s.name} · ${m.name}` });
          else if (type === 'bind' && typeof m.hostPath === 'string' && validDir(m.hostPath)) add({ kind: 'volume', tag: `bind-${m.hostPath.split('/').filter(Boolean).pop().replace(/[^A-Za-z0-9_.-]/g, '_')}`, project: s.project, service: s.name, volume: m.hostPath, hostPath: m.hostPath, label: `${s.project}/${s.name} · ${m.hostPath}` });
        }
      } catch { /* сервис недоступен — пропускаем, ошибка конфигурации уже отражена в копии конфигураций */ }
    }
  }));
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

/** Скрипт для сервера панели (bash). Один элемент — одна запись в файле статуса: OK|метка|файл|байт или FAIL|метка|причина. */
export function buildScript({ runId, baseDir, dest, keep, passB64, minFreeKb, items }) {
  const lines = [
    '#!/bin/bash',
    `BASE=${shq(baseDir)}; RUN=${shq(runId)}; DEST=${shq(dest)}; KEEP=${Number(keep)}; MINFREE=${Number(minFreeKb)}`,
    'LOGD="$BASE/.runs"; ST="$LOGD/$RUN.status"; TMPD="$BASE/.work"; PASSF=""',
    'umask 077; mkdir -p "$LOGD" "$TMPD" || exit 1',
    'trap \'rm -f "$LOGD/$RUN.pw" "$TMPD/$RUN".*\' EXIT',
    'echo START > "$ST"',
    'fail() { printf \'FAIL|%s|%s|%s\\n\' "$1" "$2" "$3" >> "$ST"; }',
    passB64 ? `PASSF="$LOGD/$RUN.pw"; printf %s ${shq(passB64)} | base64 -d > "$PASSF"` : '',
    'avail=$(df -Pk "$BASE" | awk \'NR==2{print $4}\')',
    'if [ "${avail:-0}" -lt "$MINFREE" ]; then fail "*" NOSPACE "$((avail/1024))"; echo DONE >> "$ST"; exit 1; fi',
    'run_item() {',
    '  local label=$1 name=$2 url=$3 sub=$4 prefix=$5 fn=$6; local tmp="$TMPD/$RUN.$RANDOM" err="$LOGD/$RUN.err" rc size out',
    '  if [ -n "$PASSF" ]; then ( set -o pipefail; "$fn" | gzip -c | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass file:"$PASSF" > "$tmp" ) 2>"$err"; rc=$?',
    '  else ( set -o pipefail; "$fn" | gzip -c > "$tmp" ) 2>"$err"; rc=$?; fi',
    '  if [ $rc -ne 0 ]; then fail "$label" CMD "$(tail -c 300 "$err" | tr \'\\n|\' \'  \')"; rm -f "$tmp"; return; fi',
    '  size=$(stat -c %s "$tmp" 2>/dev/null || echo 0)',
    '  if [ "$size" -lt 30 ]; then fail "$label" EMPTY ""; rm -f "$tmp"; return; fi',
    '  if [ "$DEST" = s3 ]; then',
    '    if [ "$size" -gt 5368709120 ]; then fail "$label" S3BIG ""; rm -f "$tmp"; return; fi',
    '    out=$(curl -sS -f -o /dev/null -T "$tmp" "$url" 2>&1) || { fail "$label" S3UP "$(printf %s "$out" | tail -c 200 | tr \'\\n|\' \'  \')"; rm -f "$tmp"; return; }',
    '    rm -f "$tmp"',
    '  else',
    '    mkdir -p "$BASE/$sub" && mv "$tmp" "$BASE/$sub/$name" || { fail "$label" SAVE "$BASE/$sub"; rm -f "$tmp"; return; }',
    '    ls -1t "$BASE/$sub/$prefix"* 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f --',
    '  fi',
    '  printf \'OK|%s|%s|%s\\n\' "$label" "$name" "$size" >> "$ST"',
    '}',
  ];
  items.forEach((it, n) => {
    const fn = `p${n}`;
    if (it.kind === 'volume') lines.push(`${fn}() { [ -d ${shq(it.hostPath)} ] || { echo "EA_NODIR:${it.hostPath}" >&2; return 3; }; tar -C ${shq(it.hostPath)} -cf - .; }`);
    else lines.push(`${fn}() { local C; C=$(docker ps -q --filter ${shq(`name=^${it.project}_${it.service}\\.`)} | head -n1); [ -n "$C" ] || { echo EA_NOCONT >&2; return 3; }; docker exec "$C" ${DUMP[it.kind]}; }`);
    lines.push(`run_item ${shq(it.label.replace(/\|/g, '/'))} ${shq(it.file)} ${shq(it.url ?? '-')} ${shq(it.slug)} ${shq(it.prefix)} ${fn}`);
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
    + `elif command -v systemd-run >/dev/null 2>&1; then systemd-run --unit=ea-data-backup --collect --description='EasyAdmin: data backup' bash ${shq(`${f}.sh`)} >/dev/null 2>&1 && echo EA_STARTED; `
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

const NAME_RE = /^([a-z0-9_-]+)__([a-z0-9_-]+)__(db-(?:postgres|mysql|mariadb|mongo)|vol-[A-Za-z0-9_.-]+|bind-[A-Za-z0-9_.-]+)__(\d{8}-\d{6})\.(sql|archive|tar)\.gz(\.enc)?$/;
export const parseName = (n) => { const m = NAME_RE.exec(n); return m ? { project: m[1], service: m[2], tag: m[3], stamp: m[4], ext: m[5], encrypted: !!m[6] } : null; };
export const groupKey = (n) => n.replace(/__\d{8}-\d{6}\..*$/, '');

/** Команды восстановления для копии. Пароль копии не подставляется. */
export function restoreHint(name, where) {
  const p = parseName(name); if (!p) throw new Error('Некорректное имя файла');
  const stream = p.encrypted ? `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass pass:'YOUR_BACKUP_PASSWORD' -in ${shq(name)} | gunzip -c` : `gunzip -c ${shq(name)}`;
  const C = `"$(docker ps -q --filter ${shq(`name=^${p.project}_${p.service}\\.`)} | head -n1)"`;
  const kind = p.tag.startsWith('db-') ? p.tag.slice(3) : 'volume';
  const run = {
    postgres: `${stream} | docker exec -i ${C} sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "\${POSTGRES_USER:-postgres}"'`,
    mysql: `${stream} | docker exec -i ${C} sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'`,
    mariadb: `${stream} | docker exec -i ${C} sh -c 'mysql -uroot -p"\${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"'`,
    mongo: `${stream} | docker exec -i ${C} sh -c 'mongorestore --archive --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'`,
    volume: `${stream} | tar -xf - -C ${p.tag.startsWith('vol-') ? shq(`/etc/easypanel/projects/${p.project}/${p.service}/volumes/${p.tag.slice(4)}`) : "'SOURCE_FOLDER'"}`,
  }[kind];
  const steps = [];
  if (where?.url) steps.push(`curl -fL -o ${shq(name)} ${shq(where.url)}`);
  else if (where?.dir) steps.push(`cd ${shq(where.dir)}`);
  steps.push(run);
  return { text: steps.join('\n'), notes: [kind === 'volume' ? 'Остановите сервис в Easypanel перед восстановлением томов.' : 'Восстановление дописывает данные в работающую базу; для чистого восстановления сначала очистите её.', ...(p.encrypted ? ['Подставьте пароль копии вместо YOUR_BACKUP_PASSWORD.'] : []), ...(p.tag.startsWith('bind-') ? ['Замените SOURCE_FOLDER на папку, из которой копировали том.'] : [])] };
}
