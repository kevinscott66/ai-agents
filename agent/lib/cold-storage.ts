/**
 * T-113: cold storage for `*_archive` tables.
 *
 * ADR-0007 archives old rows into `*_archive` (non-destructive). Over years
 * those grow too. This moves archive rows OLDER THAN `COLD_STORAGE_DAYS`
 * (default 365) out of the live SQLite DB into compressed NDJSON files on disk,
 * then deletes them from the DB — keeping the live DB bounded. Local-only
 * (no cloud creds); the `.ndjson.gz` files ARE the cold store and can be
 * rsync'd off-box by the operator.
 *
 * Safe-by-construction: a table's rows are deleted ONLY after its export file
 * is written and fsync'd and its size on disk matches the bytes written.
 * Аудит 2026-08-27: раньше здесь стояло «row count matches» — проверка байт
 * описывалась как сверка строк. Сверять строки значило бы развернуть весь
 * экспорт обратно в память, ровно против чего заведены батчи; читатель же
 * шапки уходил с мыслью, что перед DELETE пересчитаны строки (см. :269-279).
 * Прополка привязана к `rowid` последней выгруженной строки — этим и держится
 * «удалили ровно то, что записали», а не пересчётом.
 */
import {
  mkdirSync,
  existsSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { DAY_MS } from "./time-constants.ts";
import { db } from "./db.ts";
import { log } from "./log.ts";
import { getErrorMessage } from "./errors.ts";

/**
 * Размер страницы выгрузки. Раньше таблица читалась одним `SELECT *` без
 * лимита, из строк собиралась одна NDJSON-строка, и она же целиком уходила в
 * gzip — три полные копии архива в памяти единственного потока, который держит
 * 12 ботов и HTTP Mini App. Экспорт запускается раз в месяц, 1-го числа, то
 * есть ровно тогда, когда архив накопил максимум. Батч режет пик до размера
 * страницы; конкатенация gzip-членов — валидный gzip, `zcat` читает файл как
 * одно целое.
 */
const BATCH_ROWS = 2000;

/**
 * Точка подмены записи для тестов.
 *
 * Аудит 2026-08-08: шапка модуля обещает, что строки удаляются только после
 * того, как файл «записан и число строк на диске сошлось» — но сверка шла по
 * буферу в памяти (`Bun.gunzipSync(gz)`), а файла не касалась вовсе; про диск
 * спрашивали только «размер не ноль». Между тем `write(2)` на заполнившемся
 * разделе не бросает: он записывает сколько влезло и возвращает КОРОТКИЙ
 * счётчик (ENOSPC приходит уже следующим вызовом). Обрезанный последний
 * gzip-член проходил и сверку по памяти, и «размер не ноль», после чего строки
 * удалялись из БД — а `zcat` на таком файле спотыкается о «unexpected end of
 * file», и хвост не восстановить ничем. Стенда «диск полон» в тестах нет,
 * поэтому запись вынесена в подменяемое поле.
 */
export const _io = {
  write: (fd: number, data: Uint8Array): number => writeSync(fd, data),
};

const ARCHIVE_TABLES = [
  "messages_archive",
  "agent_actions_archive",
  "audit_logs_archive",
  // Аудит 2026-08-14: `approvals` архивируется с этого же прогона (миграция
  // 042), и без строки здесь её архив стал бы следующей таблицей, которая
  // только растёт — с телами постов в payload.
  "approvals_archive",
  // Аудит 2026-08-27: `role_runtime_queue` начала архивироваться этим же
  // прогоном (миграция 046). Без строки здесь её архив стал бы следующей
  // таблицей, которая только растёт — с системными промптами ролей внутри.
  "role_runtime_queue_archive",
] as const;

export interface ColdStorageOptions {
  now?: number;
  coldDays?: number;
  dir?: string;
  /** dry run: export but do NOT delete from the DB. */
  prune?: boolean;
}

export interface ColdStorageResult {
  table: string;
  exported: number;
  file: string | null;
  pruned: number;
  /**
   * Причина отказа по этой таблице, если экспорт не удался. `null` — и когда
   * всё прошло, и когда выгружать было нечего.
   *
   * Аудит 2026-08-21. Отличить отказ от «нечего делать» вызывающий не мог: обе
   * ситуации возвращали ровно `{exported: 0, file: null, pruned: 0}`. А
   * поскольку отказ здесь обрабатывается ВНУТРИ (log.error + `continue`, см.
   * ниже) и наружу не бросается, единственный обработчик у вызывающего —
   * `catch` — не срабатывал никогда. Замер: каталог холодного хранилища,
   * подменённый файлом (ENOTDIR на openSync), даёт в логе
   * «экспорт не удался — prune отменён», а в audit_logs — ноль строк
   * `alert.db_maint.cold_storage_failed`.
   */
  error: string | null;
}

/**
 * Аудит 2026-08-28: `??` ловит только null/undefined, а пустая строка и строка
 * с пробелами — значения. `BACKUP_DIR=` уводил холодное хранилище в
 * `./cold-storage` относительно cwd, `BACKUP_DIR=" ./backups "` — в каталог с
 * пробелами в имени. Оба — мимо того `$BACKUP_DIR`, который владелец синкает
 * с машины, а `.ndjson.gz` после прунинга остаётся ЕДИНСТВЕННОЙ копией:
 * обратной дороги в БД в репозитории нет вовсе. Тот же разбор в
 * `orchestrator/services.ts:280` починили 2026-08-28 — здесь он остался
 * старым, то есть бэкапы и холодное хранилище разъезжались по разным местам.
 * Форма — та же, что у соседа.
 */
function coldDir(opts: ColdStorageOptions): string {
  const base = opts.dir?.trim() || process.env.BACKUP_DIR?.trim() || "./backups";
  return join(base, "cold-storage");
}

/** Тестовый шов: путь считается из env, побочных эффектов нет. */
export const _coldDir = coldDir;

function readColdDays(opts: ColdStorageOptions): number {
  if (typeof opts.coldDays === "number") return opts.coldDays;
  // Аудит 2026-08-28: `Number.parseInt` не разбирает, а обрезает.
  // `parseInt("0.5") === 0`, а ноль здесь — документированная ручка «выгрести
  // и удалить ВЕСЬ архив»: владелец, написавший полсуток, получал полную
  // зачистку пяти *_archive таблиц в ближайший месячный прогон, включая
  // строки, которые archiveOldRows положил минутой раньше. `parseInt("1e3")`
  // так же молча превращал тысячу суток в одни. Разбираем как сосед
  // `parseMessagesRetentionDays` (db-maint.ts:141) — целым числом или отказ.
  const raw = process.env.COLD_STORAGE_DAYS?.trim() ?? "";
  const n = raw === "" ? Number.NaN : Number(raw);
  // Аудит 2026-08-13: было `n > 0`, то есть ноль отбрасывался как мусор и молча
  // становился годом. А ноль — это документированная ручка: tools/export-archive.ts
  // в своей же шапке обещает `COLD_STORAGE_DAYS=0 … export+prune ALL archive rows`.
  // Владелец, которому нужно выгрести архив целиком, получал ровно обратное —
  // выгрузку старше года — и без единого предупреждения. Заодно это чинит
  // расхождение внутри самой функции: путь через opts.coldDays ноль принимал.
  // Отрицательное по-прежнему уходит в дефолт: там cutoff уезжает в будущее,
  // то есть под нож попали бы и свежие строки — это опечатка, а не ручка.
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : 365;
}

/** Тестовый шов: разбор env, побочных эффектов нет. */
export const _readColdDays = readColdDays;

/**
 * Имя файла экспорта.
 *
 * Аудит 2026-08-13: здесь была только дата (`slice(0, 10)`), а файл
 * открывался как `openSync(file, "w")` — то есть ВТОРОЙ экспорт в тот же день
 * молча усекал первый. Строки первого к тому моменту уже удалены из БД, и
 * файл был их единственной копией.
 *
 * Это не гипотетика, а ровно та последовательность, которую предлагает
 * докстринг CLI: сначала обычный прогон (выгрузил и удалил всё старше 365
 * дней), следом `COLD_STORAGE_DAYS=0` «выгрузить остальное» — то же имя, тот
 * же день, и годовой архив исчезает без единой ошибки в логе. Ежемесячный
 * прогон 1-го числа плюс любой ручной в тот же день дают то же самое.
 *
 * Секунды в имени разводят прогоны, а флаг `wx` ниже делает невозможным даже
 * маловероятное совпадение внутри одной секунды: столкновение станет отказом
 * (prune отменяется), а не потерей.
 */
export function coldStorageFileName(table: string, now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/:/g, "-");
  return `${table}-${stamp}.ndjson.gz`;
}

/** Tables may not exist on a minimal/legacy DB — treat missing as empty. */
function tableExists(name: string): boolean {
  try {
    const row = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

export function exportColdStorage(opts: ColdStorageOptions = {}): ColdStorageResult[] {
  const now = opts.now ?? Date.now();
  const cutoff = now - readColdDays(opts) * DAY_MS;
  const dir = coldDir(opts);
  const prune = opts.prune !== false; // default: prune after export
  const out: ColdStorageResult[] = [];

  for (const table of ARCHIVE_TABLES) {
    if (!tableExists(table)) {
      out.push({ table, exported: 0, file: null, pruned: 0, error: null });
      continue;
    }
    const head = db
      .prepare(
        `SELECT count(*) AS n FROM ${table} WHERE archived_at < ?`,
      )
      .get(cutoff) as { n: number };
    if (head.n === 0) {
      out.push({ table, exported: 0, file: null, pruned: 0, error: null });
      continue;
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, coldStorageFileName(table, now));

    const page = db.prepare(
      `SELECT rowid AS _rid, * FROM ${table}
       WHERE archived_at < ? AND rowid > ?
       ORDER BY rowid LIMIT ${BATCH_ROWS}`,
    );

    let exported = 0;
    let lastRid = 0;
    let expectedBytes = 0;
    let fd: number | null = null;
    let failure: string | null = null;
    // Создали ли файл МЫ. Ниже по коду неудачный экспорт удаляет обрывок, и до
    // аудита 2026-08-13 он удалял его просто по пути. С флагом `wx` сюда стало
    // возможно приехать с чужим файлом на этом пути (EEXIST) — стереть его
    // значило бы потерять как раз то, что мы бережём.
    let created = false;
    try {
      // `wx` вместо `w`: не создавать поверх существующего. Экспорт — операция
      // с односторонним эффектом (за ней идёт DELETE из БД), и усечение чужого
      // файла здесь невосстановимо. Отказ безопаснее.
      fd = openSync(file, "wx");
      created = true;
      for (;;) {
        const rows = page.all(cutoff, lastRid) as Array<
          Record<string, unknown> & { _rid: number }
        >;
        if (rows.length === 0) break;
        lastRid = rows[rows.length - 1]!._rid;
        const lines = rows
          .map((r) => {
            const { _rid, ...rest } = r;
            return JSON.stringify(rest);
          })
          .join("\n");
        const gz = Bun.gzipSync(Buffer.from(lines + "\n", "utf8"));
        // Сверяем ровно то, что обещает шапка модуля: сколько строк реально
        // легло в файл. Проверка идёт по батчу, а не по всему экспорту, чтобы
        // не разворачивать гигабайты обратно в память.
        const back = Bun.gunzipSync(gz);
        let nl = 0;
        for (let i = 0; i < back.length; i++) if (back[i] === 0x0a) nl++;
        if (nl !== rows.length) {
          failure = `батч свернулся в ${nl} строк вместо ${rows.length}`;
          break;
        }
        const wrote = _io.write(fd, gz);
        if (wrote !== gz.byteLength) {
          // Короткая запись — это заполнившийся раздел, а не экзотика: экспорт
          // идёт 1-го числа, когда архив максимален, и пишет в тот же
          // BACKUP_DIR, где лежат снапшоты БД.
          failure = `батч записан частично: ${wrote} из ${gz.byteLength} байт`;
          break;
        }
        expectedBytes += gz.byteLength;
        exported += rows.length;
      }
      if (!failure) {
        // Данные должны лежать НА ДИСКЕ до того, как мы их удалим из БД: файл
        // после prune — единственная их копия, а writeFileSync доводил только
        // до страничного кэша. Питание, пропавшее между записью и DELETE,
        // теряло строки навсегда.
        fsyncSync(fd);
      }
    } catch (e) {
      failure = getErrorMessage(e);
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* уже закрыт */
        }
      }
    }

    if (!failure) {
      try {
        // Имя нового файла тоже живёт в каталоге — без его fsync запись может
        // пережить перезагрузку, а ссылка на неё нет.
        const dfd = openSync(dir, "r");
        try {
          fsyncSync(dfd);
        } finally {
          closeSync(dfd);
        }
      } catch (e) {
        // Без этого ошибки каталога превращались в успешный экспорт и строки
        // удалялись из SQLite, хотя durability файла не подтверждена.
        failure = `не удалось синхронизировать каталог: ${getErrorMessage(e)}`;
      }
    }

    if (!failure) {
      // Единственная проверка, которая смотрит на ДИСК, а не на память. Байты
      // вместо строк: сверять строки значило бы развернуть весь экспорт обратно
      // в память — ровно то, ради чего заведены батчи.
      const onDisk = existsSync(file) ? statSync(file).size : -1;
      if (onDisk !== expectedBytes) {
        failure =
          onDisk < 0
            ? "файл отсутствует"
            : `на диске ${onDisk} байт вместо ${expectedBytes}`;
      }
    }

    if (failure) {
      // Недописанный файл не оставляем: рядом с валидными экспортами он читался
      // бы как полноценная копия. Но только СВОЙ: если openSync упал на `wx`,
      // на этом пути лежит чужой экспорт, и он нам не принадлежит.
      //
      // Убираем ДО log.error, чтобы одна строка отказа сразу говорила, остался
      // ли на диске обрубок. Аудит 2026-08-20: раньше провал unlink уходил в
      // log.debug, а в проде уровень `info` (см. log.ts/resolveLogLevel) —
      // то есть про огрызок не сообщал никто, и следующий прогон падал на
      // `wx` («файл занят»), потеряв исходную причину.
      let leftover: string | null = null;
      if (created && existsSync(file)) {
        try {
          unlinkSync(file);
        } catch (e) {
          leftover = file;
          log.warn("[cold-storage] не удалось убрать недописанный экспорт", {
            table,
            file,
            e: String(e),
          });
        }
      }
      log.error("[cold-storage] экспорт не удался — prune отменён", {
        table,
        file,
        error: failure,
        leftover,
      });
      out.push({ table, exported: 0, file: null, pruned: 0, error: failure });
      continue;
    }

    let pruned = 0;
    if (prune) {
      // Только до последней ВЫГРУЖЕННОЙ строки. Предикат `archived_at < cutoff`
      // сам по себе шире выгрузки: строки в архив кладёт db-maint, и хотя он
      // работает на том же потоке, привязка к rowid делает соответствие
      // «удалили ровно то, что записали» свойством запроса, а не расписания.
      const res = db
        .prepare(
          `DELETE FROM ${table} WHERE archived_at < ? AND rowid <= ?`,
        )
        .run(cutoff, lastRid);
      pruned = Number(res.changes ?? 0);
    }
    log.info("[cold-storage] exported archive table", {
      table,
      exported,
      pruned,
      file,
    });
    out.push({ table, exported, file, pruned, error: null });
  }
  return out;
}
