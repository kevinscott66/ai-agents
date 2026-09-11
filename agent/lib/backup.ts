/**
 * C17: Nightly automatic backups.
 *
 * - DB snapshot via SQLite VACUUM INTO (atomic, no shell).
 * - Wiki (memory/) snapshot via tar+gzip.
 * - Retention: deletes backup files older than `retainDays` (default 14).
 * - Scheduler: setInterval (default 24h) + one delayed initial run (60s)
 *   so a flapping process does not backup-spam.
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { join, basename, dirname } from "node:path";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./time-constants.ts";
import { resolveDbPath } from "./db-path.ts";
import { resolveMemoryDir } from "./memory-dir.ts";
import { log } from "./log.ts";
import { emitAlert } from "./alerting.ts";

/** fsync по пути — и для файла, и для каталога. Ошибку глушим: на файловых
 * системах без fsync каталога (или в тестовом tmpfs) это не повод валить бэкап,
 * который в остальном прошёл проверку. */
function fsyncPath(path: string, what: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, "r");
    fs.fsyncSync(fd);
  } catch (e) {
    log.debug("backup: fsync skipped", { what, path, e: String(e) });
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* уже закрыт */
      }
    }
  }
}

export interface RunBackupOptions {
  retainDays?: number;
  /** Override "today" for retention/naming (used by tests). */
  now?: Date;
}

export interface BackupResult {
  dbPath: string | null;
  wikiPath: string | null;
  cleaned: number;
  /** Файлов, которые ретеншн не тронул, потому что свежей замены нет. */
  keptUnverified: number;
  /**
   * Брошенных карантинов замка, подобранных этим прогоном.
   *
   * Аудит 2026-08-28: `acquireBackupLock` переименовывает протухший замок в
   * `.backup.lock.stale-<pid>-<uuid>` и тут же его удаляет, но если удаление
   * бросило (права, занятый дескриптор, кончился inode) — оно только пишет
   * log.warn. Каталог остаётся в BACKUP_DIR навсегда: ретеншн ниже смотрит
   * только на префиксы `db-` и `memory-`, больше по этому каталогу не ходит
   * никто. Каждая следующая протухшая блокировка добавляет ещё один.
   */
  staleLocksCleaned: number;
  errors: string[];
  /**
   * Прогон не состоялся, потому что бэкап уже делает кто-то другой.
   *
   * Аудит 2026-08-28: обычная конкуренция сворачивалась в `errors`, а
   * планировщик поднимает `backup_failed` на любом непустом `errors` —
   * то есть здоровый день выглядел провалом. Реальный прогон в этот момент
   * идёт в соседнем процессе и о своих бедах отчитается сам.
   */
  skipped?: boolean;
}

/**
 * Убедиться, что снапшот читается и не пуст.
 *
 * Аудит 2026-08-04: результат `VACUUM INTO` не проверялся вообще — успехом
 * считался сам факт, что вызов не бросил. Обрезанный на середине файл (диск
 * кончился) остаётся на диске и выглядит как валидный бэкап ровно до того дня,
 * когда из него понадобится восстановиться.
 *
 * quick_check дешевле integrity_check и ловит то, что нужно здесь: битые
 * страницы и несогласованные индексы. Пустой файл его проходит, поэтому
 * отдельно смотрим, что таблицы на месте.
 */
function verifySnapshot(path: string): void {
  const snap = new Database(path, { readonly: true });
  try {
    const row = snap.prepare(`PRAGMA quick_check`).get() as
      | Record<string, string>
      | undefined;
    const verdict = row ? Object.values(row)[0] : undefined;
    if (verdict !== "ok") {
      throw new Error(`quick_check: ${verdict ?? "нет результата"}`);
    }
    const { n } = snap
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`)
      .get() as { n: number };
    if (n === 0) throw new Error("в снапшоте нет таблиц");
  } finally {
    snap.close();
  }
}

export interface StartBackupSchedulerOptions {
  dataDir: string;
  backupDir: string;
  intervalMs?: number;
  initialDelayMs?: number;
  retainDays?: number;
}

export interface BackupSchedulerHandle {
  stop(): void;
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

const BACKUP_LOCK_NAME = ".backup.lock";
/** Префикс карантина протухшего замка — см. BackupResult.staleLocksCleaned. */
const STALE_LOCK_PREFIX = `${BACKUP_LOCK_NAME}.stale-`;
const BACKUP_LOCK_EXPIRY_MS = 30 * MINUTE_MS;
/** Абсолютный потолок для замка с известным владельцем. Живой PID — не вечная
 * индульгенция: PID переиспользуются и в пределах одной загрузки. Прогон бэкапа
 * идёт минуты, так что шесть часов — заведомо мёртвый замок. */
const BACKUP_LOCK_MAX_AGE_MS = 6 * HOUR_MS;
/** os.uptime() дрейфует на доли секунды между вызовами; сравниваем метки
 * загрузки с запасом, чтобы дрейф не выглядел как перезагрузка. */
const BOOT_STAMP_TOLERANCE_S = 60;

interface BackupLock {
  path: string;
  token: string;
}

interface BackupLockOwner {
  pid: number;
  token?: string;
  /** Приблизительный момент загрузки машины (epoch, секунды). */
  boot?: number;
}

export function backupLockPath(backupDir: string): string {
  return join(backupDir, BACKUP_LOCK_NAME);
}

function emptyBackupResult(error: string): BackupResult {
  return {
    dbPath: null,
    wikiPath: null,
    cleaned: 0,
    keptUnverified: 0,
    staleLocksCleaned: 0,
    errors: [error],
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but is not signalable by this user.
    return e?.code !== "ESRCH";
  }
}

/** Приблизительный момент загрузки машины (epoch, секунды). После
 * перезагрузки значение меняется, а таблица процессов обнуляется — записанный
 * в замок PID заведомо принадлежит уже другому процессу. */
function bootStamp(): number {
  return Math.round(Date.now() / 1000 - os.uptime());
}

/** Экспортируется для тестов: проверяют, что в owner попадает метка загрузки. */
export function readBackupLockOwner(lockPath: string): BackupLockOwner | null {
  try {
    const ownerPath = join(lockPath, "owner");
    if (!fs.lstatSync(ownerPath).isFile()) return null;
    const raw = fs.readFileSync(ownerPath, "utf8").trim();
    if (!raw) return null;

    // Accept the pre-token PID-only format so a live lock from an older
    // process remains protected during a rolling deploy.
    if (/^\d+$/.test(raw)) {
      const pid = Number(raw);
      return Number.isSafeInteger(pid) && pid > 0 ? { pid } : null;
    }
    const parsed = JSON.parse(raw) as Partial<BackupLockOwner>;
    const pid = parsed.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
    return {
      pid,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
      boot:
        typeof parsed.boot === "number" && Number.isFinite(parsed.boot)
          ? parsed.boot
          : undefined,
    };
  } catch {
    return null;
  }
}

function backupLockIsStale(lockPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (e: any) {
    return e?.code === "ENOENT";
  }

  const ageMs = Date.now() - stat.mtimeMs;
  const owner = stat.isDirectory() ? readBackupLockOwner(lockPath) : null;
  if (owner) {
    // Перезагрузка VPS обнуляет таблицу процессов: PID 900 из замка после неё
    // достаётся постороннему демону, processIsAlive() отвечает «жив», и замок
    // становится бессмертным — бэкапы не делаются больше никогда. Метка
    // загрузки ловит это точно, без эвристик по времени.
    if (
      owner.boot !== undefined &&
      Math.abs(owner.boot - bootStamp()) > BOOT_STAMP_TOLERANCE_S
    ) {
      return true;
    }
    if (!processIsAlive(owner.pid)) return true;
    // Страховка от переиспользования PID в пределах одной загрузки и от
    // замков, записанных версией без метки boot.
    return ageMs > BACKUP_LOCK_MAX_AGE_MS;
  }

  // A crash between mkdir and publishing owner metadata leaves no PID to
  // check. Only reclaim such an anonymous lock after a bounded expiry.
  return ageMs > BACKUP_LOCK_EXPIRY_MS;
}

function removeTempFile(path: string, what: string): void {
  try {
    fs.unlinkSync(path);
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      log.warn("[backup] temporary file cleanup failed", {
        path,
        what,
        error: String(e),
      });
    }
  }
}

/** Atomic mkdir is the inter-process lock; dead owners can be reclaimed.
 *  Экспортируется для тестов замка. */
export function acquireBackupLock(backupDir: string): BackupLock {
  const lockPath = backupLockPath(backupDir);
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
    } catch (e: any) {
      if (e?.code !== "EEXIST" || !backupLockIsStale(lockPath)) throw e;

      // Rename first, then remove the quarantine path. This keeps contenders
      // from deleting a newly acquired lock after they observed the old one.
      const quarantinePath = join(
        backupDir,
        `${STALE_LOCK_PREFIX}${process.pid}-${randomUUID()}`,
      );
      try {
        fs.renameSync(lockPath, quarantinePath);
      } catch (renameError: any) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      try {
        fs.rmSync(quarantinePath, { recursive: true, force: true });
      } catch (cleanupError) {
        log.warn("[backup] stale lock quarantine cleanup failed", {
          quarantinePath,
          error: String(cleanupError),
        });
      }
      continue;
    }

    const token = randomUUID();
    const ownerPath = join(lockPath, "owner");
    const ownerTmpPath = join(lockPath, `.owner-${token}.tmp`);
    try {
      fs.writeFileSync(
        ownerTmpPath,
        JSON.stringify({ pid: process.pid, token, boot: bootStamp() }) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      fs.renameSync(ownerTmpPath, ownerPath);
      return { path: lockPath, token };
    } catch (e) {
      removeTempFile(ownerTmpPath, "lock owner");
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch (cleanupError) {
        log.warn("[backup] lock initialization cleanup failed", {
          lockPath,
          error: String(cleanupError),
        });
      }
      throw e;
    }
  }
}

function releaseBackupLock(lock: BackupLock): void {
  try {
    const owner = readBackupLockOwner(lock.path);
    if (owner?.pid !== process.pid || owner.token !== lock.token) {
      log.warn("[backup] lock owner changed before cleanup", { lockPath: lock.path });
      return;
    }
    fs.rmSync(lock.path, { recursive: true, force: true });
  } catch (e) {
    log.warn("[backup] lock cleanup failed", { lockPath: lock.path, error: String(e) });
  }
}

/**
 * Run a single backup cycle. Returns paths produced + cleanup count.
 * Never throws — failures are logged & collected in `errors`.
 *
 * `dataDir` is expected to be the dir containing `memory.db` (e.g. ./data).
 * The wiki dir is resolved from env MEMORY_DIR or "memory" (relative to cwd).
 */
export async function runBackup(
  dataDir: string,
  backupDir: string,
  opts: RunBackupOptions = {},
): Promise<BackupResult> {
  // Аудит 2026-08-28: этот вызов стоял голым и ДО try — то есть вопреки
  // docstring «Never throws» бросал наружу. Планировщик (`kick` в
  // startBackupScheduler) ловит такой бросок в свой catch, а тот умеет
  // только log.warn: ни backup_failed, ни backup_empty, ни backup_partial
  // не поднимались. Пустой BACKUP_DIR (ENOENT), read-only монтирование
  // (EROFS), кончившийся диск (ENOSPC) — любая из этих причин означала
  // «бэкапов нет вообще» при одной строке в логе раз в сутки. Через
  // emptyBackupResult ошибка попадает в result.errors, а оттуда — в алерт.
  try {
    ensureDir(backupDir);
  } catch (e) {
    const msg = `[backup] cannot create the backup dir ${JSON.stringify(backupDir)}: ${String(e)}`;
    log.warn(msg);
    return emptyBackupResult(msg);
  }
  let lock: BackupLock;
  try {
    lock = acquireBackupLock(backupDir);
  } catch (e) {
    // EEXIST от живого владельца — обычная конкуренция. Всё остальное
    // (EACCES/EROFS/ENOSPC от mkdirSync) — сломанный каталог бэкапов, и
    // сообщение «замок занят» увело бы диагностику в другую сторону.
    const code = (e as { code?: string } | null)?.code;
    if (code === "EEXIST") {
      const msg = `[backup] another process owns the backup lock: ${String(e)}`;
      log.warn(msg);
      return { ...emptyBackupResult(msg), skipped: true };
    }
    const msg = `[backup] cannot acquire the backup lock (${code ?? "unknown"}): ${String(e)}`;
    log.warn(msg);
    emitAlert("error", "backup.lock_unavailable", "backup: не удалось взять замок бэкапа", {
      backupDir,
      code: code ?? null,
      error: String(e),
    });
    return emptyBackupResult(msg);
  }
  try {
    return await runBackupUnlocked(dataDir, backupDir, opts);
  } finally {
    releaseBackupLock(lock);
  }
}

async function runBackupUnlocked(
  dataDir: string,
  backupDir: string,
  opts: RunBackupOptions = {},
): Promise<BackupResult> {
  const result: BackupResult = {
    dbPath: null,
    wikiPath: null,
    cleaned: 0,
    keptUnverified: 0,
    staleLocksCleaned: 0,
    errors: [],
  };
  const now = opts.now ?? new Date();
  const retainDays = opts.retainDays ?? 14;
  const tag = ymd(now);

  ensureDir(backupDir);

  // 1) DB snapshot via VACUUM INTO.
  try {
    // Аудит 2026-08-27: было `process.env.MEMORY_DB_PATH ?? join(...)`. `??`
    // ловит только ОТСУТСТВУЮЩУЮ переменную, а `.env.example` ставит её
    // пустой. Пустой путь давал `fs.existsSync("") === false` — и ночной
    // снапшот БД молча пропускался КАЖДУЮ ночь, оставляя одну строку
    // `db source not found: ` в логах. Разбор — общий с `lib/db.ts`.
    const dbPath = resolveDbPath(
      process.env.MEMORY_DB_PATH,
      join(dataDir, "memory.db"),
    );
    if (!fs.existsSync(dbPath)) {
      log.warn(`[backup] db source not found: ${dbPath} — skipped`);
    } else {
      const outPath = join(backupDir, `db-${tag}.sqlite`);
      // Пишем во временное имя и подменяем только проверенный файл. Раньше
      // сегодняшний снапшот удалялся ПЕРЕД VACUUM INTO (он отказывается
      // перезаписывать) — то есть при любом сбое дальше вчерашнего бэкапа уже
      // не было, а нового ещё не появилось.
      const tmpPath = `${outPath}.tmp-${process.pid}-${randomUUID()}`;
      const t0 = Date.now();
      let published = false;
      try {
        const src = new Database(dbPath, { readonly: true });
        try {
          src.prepare(`VACUUM INTO ?`).run(tmpPath);
        } finally {
          src.close();
        }
        verifySnapshot(tmpPath);
        const size = fs.statSync(tmpPath).size;
        fs.renameSync(tmpPath, outPath);
        published = true;
        // Аудит 2026-08-28: fsync каталога делала только ветка вики
        // (`else` ниже), поэтому ссылка на снапшот БД не синхронизировалась
        // никогда — а в дни, когда каталог вики не найден или архив упал, не
        // синхронизировалась вовсе. VACUUM INTO даёт полноценный коммит
        // SQLite со своим fsync, то есть durable здесь СОДЕРЖИМОЕ, но не
        // запись в каталоге: питание, пропавшее после rename, оставляет файл
        // под временным именем — снапшота за день нет, а `.tmp-*` не подберёт
        // никто (removeTempFile в finally уже не выполнится).
        fsyncPath(dirname(outPath), "backup dir");
        result.dbPath = outPath;
        const ms = Date.now() - t0;
        const kb = Math.max(1, Math.round(size / 1024));
        log.info(`[backup] db -> ${outPath} (${ms}ms, ${kb}KB, quick_check ok)`);
      } finally {
        // Covers VACUUM INTO, verification, stat and rename failures. Once
        // published, the temp name no longer exists and is left untouched.
        if (!published) removeTempFile(tmpPath, "db snapshot");
      }
    }
  } catch (e: any) {
    const msg = `[backup] db failed: ${e?.message ?? e}`;
    log.warn(msg);
    result.errors.push(msg);
  }

  // 2) Wiki tarball.
  //
  // Аудит 2026-08-29: снапшот БД и архив вики снимаются в разные моменты, то
  // есть восстановленная пара заведомо не согласована — страница, записанная
  // между шагами, попадёт в архив, а строки о ней в `wiki_fts` из снапшота не
  // будет; страница, удалённая между шагами, наоборот, оставит в снапшоте
  // строку без файла. Разбирали, чинить не стали, и вот почему.
  //
  // Индекс вики не хранит ничего, чего нет в файлах: `wiki_fts` — вся связь
  // между БД и каталогом памяти, других таблиц с содержимым страниц нет.
  // `rebuildWikiIndex` (lib/memory.ts) зовётся первой строкой старта команды
  // (orchestrator-team.ts) и делает `DELETE FROM wiki_fts` + полный обход
  // каталога в одной транзакции. То есть после восстановления содержимое
  // `wiki_fts` из снапшота отбрасывается ЦЕЛИКОМ и собирается из того, что
  // лежит в архиве — расхождение снимается в обе стороны тем же стартом,
  // который поднимает восстановленный процесс. Инвариант «либо весь индекс с
  // диска, либо прежний» закреплён в tests/wiki-rebuild-atomic.test.ts, там же
  // явно проверено, что строка без файла на диске уходит.
  //
  // Синхронный снимок обоих источников стоил бы блокировки записи в вики на
  // время VACUUM INTO и tar. Платить за то, что чинится само на ближайшем
  // старте, незачем.
  try {
    // Аудит 2026-08-28: переменная читалась через `??` — та же ошибка, что
    // разобрана выше для `MEMORY_DB_PATH`, в шаге снапшота БД этого же файла.
    // `.env.example` ставит переменную пустой, `existsSync("")` ложно, и
    // архив вики пропускался КАЖДУЮ ночь. Разбор — общий с `lib/memory.ts`,
    // иначе бэкап и писатель разъедутся в другую сторону.
    const wikiDir = resolveMemoryDir(process.env.MEMORY_DIR);
    if (!fs.existsSync(wikiDir)) {
      log.warn(`[backup] wiki dir not found: ${wikiDir} — skipped`);
    } else {
      const outPath = join(backupDir, `memory-${tag}.tgz`);
      const parent = dirname(wikiDir) || ".";
      const base = basename(wikiDir);
      // Аудит 2026-08-08: tar писал сразу в outPath. Имя посуточное, так что
      // второй за день прогон начинал с усечения уже готового архива — и если
      // tar падал на середине (кончился диск, процесс убит), на месте рабочего
      // бэкапа оставался обрезанный файл того же имени и того же вида. Снапшот
      // БД строкой выше уже делает tmp → проверка → rename; вики шла мимо.
      const tmpPath = `${outPath}.tmp-${process.pid}-${randomUUID()}`;
      let published = false;
      try {
        const res = Bun.spawnSync(["tar", "-czf", tmpPath, "-C", parent, base]);
        if (res.exitCode !== 0) {
          const stderr = res.stderr ? new TextDecoder().decode(res.stderr) : "";
          throw new Error(`tar exit ${res.exitCode}: ${stderr.trim()}`);
        }
        // Полное чтение архива: gzip-CRC и заголовки записей. Обрезанный файл
        // здесь и отсеивается — код возврата самого tar о нём не сообщает,
        // если его прибили после успешной записи первых блоков.
        const check = Bun.spawnSync(["tar", "-tzf", tmpPath]);
        if (check.exitCode !== 0) {
          const stderr = check.stderr ? new TextDecoder().decode(check.stderr) : "";
          throw new Error(`архив не читается (tar -tzf exit ${check.exitCode}): ${stderr.trim()}`);
        }
        // Проверка выше читала архив через page cache, то есть подтверждала
        // содержимое буфера, а не диска. Питание, пропавшее после rename, оставило
        // бы под сегодняшним именем обрезанный файл — а назавтра ретеншн увидел бы
        // «свежая проверенная замена появилась» и снёс копии старше retainDays.
        // Снапшота БД это не касается: VACUUM INTO — полноценный коммит SQLite со
        // своим fsync. Каталог синхронизируем отдельно: без этого пережить
        // перезагрузку может запись, но не ссылка на неё.
        fsyncPath(tmpPath, "wiki tarball");
        fs.renameSync(tmpPath, outPath);
        published = true;
        fsyncPath(dirname(outPath), "backup dir");
        log.info(`[backup] wiki -> ${outPath} (tar -tzf ok)`);
        result.wikiPath = outPath;
      } finally {
        if (!published) removeTempFile(tmpPath, "wiki tarball");
      }
    }
  } catch (e: any) {
    const msg = `[backup] wiki failed: ${e?.message ?? e}`;
    log.warn(msg);
    result.errors.push(msg);
  }

  // 3) Retention cleanup.
  //
  // Аудит 2026-08-04: ротация шла безусловно, независимо от того, получился ли
  // сегодняшний бэкап. Оба шага выше не бросают наружу — они пишут в
  // `result.errors` и log.warn. То есть если снапшот падает (кончился диск,
  // права, битая БД), единственное, что продолжает исправно работать, — это
  // удаление старых копий: через retainDays дней не остаётся НИ ОДНОЙ, и узнать
  // об этом можно только в момент, когда бэкап понадобился.
  //
  // Теперь удаление каждого вида привязано к появлению свежей проверенной
  // замены этого же вида. Нет замены — старое остаётся лежать и растит диск;
  // это шумно и заметно, в отличие от тихой потери.
  try {
    const cutoff = now.getTime() - retainDays * DAY_MS;
    const kinds = [
      { prefix: "db-", fresh: result.dbPath !== null },
      { prefix: "memory-", fresh: result.wikiPath !== null },
    ];
    const entries = fs.readdirSync(backupDir);
    let cleaned = 0;
    let kept = 0;
    let staleLocks = 0;
    // Карантин замка отцеплён от `.backup.lock` самим переименованием, так что
    // его удаление ни с кем не гонится: если владелец карантина как раз сносит
    // его сам, обе стороны идут с `force: true` и вторая просто ничего не
    // находит. Ошибку пишем в лог, а не в result.errors — планировщик поднимает
    // backup_failed на любом непустом errors, а мусор рядом с копиями не делает
    // сам бэкап неудавшимся.
    for (const name of entries) {
      if (!name.startsWith(STALE_LOCK_PREFIX)) continue;
      try {
        fs.rmSync(join(backupDir, name), { recursive: true, force: true });
        staleLocks++;
      } catch (e) {
        log.warn("[backup] brought-forward stale lock quarantine cleanup failed", {
          quarantinePath: join(backupDir, name),
          error: String(e),
        });
      }
    }
    result.staleLocksCleaned = staleLocks;
    if (staleLocks > 0) {
      log.info(`[backup] swept ${staleLocks} brought-forward lock quarantine dirs`);
    }
    for (const name of entries) {
      const kind = kinds.find((k) => name.startsWith(k.prefix));
      if (!kind) continue;
      const full = join(backupDir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs >= cutoff) continue;
      if (!kind.fresh) {
        kept++;
        continue;
      }
      try {
        fs.unlinkSync(full);
        cleaned++;
      } catch (e: any) {
        result.errors.push(`unlink ${name}: ${e?.message ?? e}`);
      }
    }
    result.cleaned = cleaned;
    result.keptUnverified = kept;
    log.info(`[backup] cleaned ${cleaned} old files, kept ${kept} (нет свежей замены)`);
    if (kept > 0) {
      emitAlert(
        "warn",
        "backup_retention_held",
        "ротация бэкапов приостановлена: свежий снапшот не получен",
        { kept, errors: result.errors },
      );
    }
  } catch (e: any) {
    const msg = `[backup] cleanup failed: ${e?.message ?? e}`;
    log.warn(msg);
    result.errors.push(msg);
  }

  return result;
}

export function startBackupScheduler(
  opts: StartBackupSchedulerOptions,
): BackupSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const initialDelayMs = opts.initialDelayMs ?? 60_000;

  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  let running = false;

  const kick = async () => {
    if (stopped) return;
    // VACUUM INTO по всей БД плюс tar по вики — не та работа, которую стоит
    // запускать вторым экземпляром поверх первого. При 24-часовом интервале
    // наложение недостижимо, но `running` стоит у digest и self-diag, а тут
    // отсутствовал — и защищает он как раз от смены интервала на короткий.
    if (running) {
      log.debug("[backup] previous run still in progress — tick skipped");
      return;
    }
    running = true;
    try {
      const res = await runBackup(opts.dataDir, opts.backupDir, {
        retainDays: opts.retainDays,
      });
      // Аудит 2026-08-08: результат прогона здесь выбрасывался целиком.
      // runBackup наружу не бросает — он складывает сбои в result.errors, а
      // единственный alert внутри него привязан к `kept > 0`, то есть требует,
      // чтобы на диске уже лежали файлы старше retainDays. На свежей установке
      // (и первые 14 дней после неё) их нет, поэтому полностью провалившийся
      // бэкап не давал ни одного сигнала вообще — до дня, когда он понадобится.
      if (res.skipped) {
        // Замок занят соседним процессом — это не провал. Прогон идёт там, и
        // алерт (если он нужен) поднимет он же.
        log.info("[backup] прогон пропущен: бэкап уже делает другой процесс", {
          errors: res.errors,
        });
      } else if (res.errors.length) {
        emitAlert("warn", "backup_failed", "прогон бэкапа завершился с ошибками", {
          errors: res.errors,
          dbPath: res.dbPath,
          wikiPath: res.wikiPath,
        });
      } else if (!res.dbPath && !res.wikiPath) {
        // Ошибок нет, но и файлов нет: оба источника «не найдены» и оба шага
        // тихо пропущены. Для планировщика это то же самое, что провал.
        emitAlert("warn", "backup_empty", "бэкап не создал ни одного файла", {
          dataDir: opts.dataDir,
          backupDir: opts.backupDir,
        });
      } else if (!res.dbPath || !res.wikiPath) {
        // Аудит 2026-08-21: конъюнкция выше ловит только «пропали оба», а
        // пропасть может ровно один — каталог вики уехал (MEMORY_DIR не
        // выставлен и сменился cwd), снапшот БД при этом успешен. Ни
        // backup_failed (errors пуст: «источник не найден» ошибкой не
        // считается ни в одном из двух шагов), ни backup_empty (dbPath не
        // null), ни ретеншн (все архивы моложе retainDays, kept === 0) —
        // сигнала не было ни одного. Половина бэкапа тихо переставала
        // делаться до дня, когда последняя валидная копия сама выпадет за
        // окно ретеншна.
        emitAlert("warn", "backup_partial", "бэкап сделал только часть источников", {
          dbPath: res.dbPath,
          wikiPath: res.wikiPath,
          dataDir: opts.dataDir,
          backupDir: opts.backupDir,
        });
      }
    } catch (e) {
      log.warn("[backup] scheduler tick error", { error: String(e) });
    } finally {
      running = false;
    }
  };

  /**
   * Свежий ли уже снапшот за сегодня. Стартовый прогон заводился «через 60
   * секунд после старта процесса», и это ровно то, что делает деплой: каждый
   * рестарт после первой минуты аптайма запускал полный VACUUM INTO + tar
   * заново. Три деплоя подряд — три полных бэкапа одного и того же состояния,
   * а флап systemd с аптаймом больше минуты превращал это в цикл.
   *
   * Ретеншн от этого не страдал (имя файла посуточное, старый удаляется перед
   * перезаписью) — страдал диск и тот же единственный поток.
   */
  const freshSnapshotExists = (): boolean => {
    const tag = ymd(new Date());
    // Аудит 2026-08-08: смотрели только на снапшот БД. А шаг БД не создаёт
    // файла вовсе, если источник не найден (MEMORY_DB_PATH указывает не туда,
    // БД ещё не создана) — и тогда сторож всегда отвечал «свежего нет», то есть
    // отключался ровно в том сценарии, где рестарт-шторм и надо гасить: каждый
    // рестарт заново гонял tar по всей вики. Свежим считаем прогон, а не один
    // его артефакт: любой из двух файлов за сегодня означает, что прогон был.
    const names = [`db-${tag}.sqlite`, `memory-${tag}.tgz`];
    return names.some((name) => {
      try {
        const st = fs.statSync(join(opts.backupDir, name));
        return Date.now() - st.mtimeMs < intervalMs;
      } catch {
        return false; // нет файла (или каталога)
      }
    });
  };

  const initial = setTimeout(() => {
    if (stopped) return;
    if (freshSnapshotExists()) {
      log.info("[backup] сегодняшний снапшот свежий — стартовый прогон пропущен");
    } else {
      void kick();
    }
    interval = setInterval(kick, intervalMs);
  }, initialDelayMs);

  log.info(
    `[backup] scheduler started: every ${Math.round(
      intervalMs / 1000,
    )}s, initial in ${Math.round(initialDelayMs / 1000)}s, dir=${opts.backupDir}`,
  );

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    },
  };
}
