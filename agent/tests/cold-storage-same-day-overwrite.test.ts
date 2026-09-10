/**
 * Аудит 2026-08-13: второй экспорт в тот же день затирал первый.
 *
 * Имя файла собиралось только из даты (`slice(0, 10)`), а открывался он как
 * `openSync(file, "w")` — усечение. Строки первого экспорта к этому моменту
 * уже удалены из БД (prune идёт сразу за fsync), то есть файл был их
 * ЕДИНСТВЕННОЙ копией.
 *
 * Последовательность не выдуманная — она прямо предложена докстрингом CLI
 * `tools/export-archive.ts`: сначала обычный прогон (всё старше 365 дней),
 * следом `COLD_STORAGE_DAYS=0` «выгрузить остальное». То же имя, тот же день,
 * годовой архив исчезает без единой ошибки в логе.
 *
 * Вторая половина того же дефекта: `COLD_STORAGE_DAYS=0` вообще не работал.
 * `readColdDays` требовал `n > 0` и на ноль молча возвращал 365 — оператор,
 * набравший 0 ради полной выгрузки, получал обычный годовой экспорт.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { db } from "../lib/db.ts";
import { exportColdStorage, coldStorageFileName } from "../lib/cold-storage.ts";

const TMP = `/tmp/cold-same-day-${Math.floor(performance.now())}`;
const BASE = 8_300_000;
const NOW = 1_900_000_000_000;
const OLD = NOW - 400 * 86_400_000;

function seed(ids: number[], archivedAt: number) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO messages_archive
       (id, chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, archived_at)
     VALUES (?, '-778', NULL, 0, 'u1', 'tester', 'hi', ?, ?)`,
  );
  db.transaction(() => {
    for (const id of ids) ins.run(id, archivedAt, archivedAt);
  })();
}

/**
 * Свои строки в выгрузке.
 *
 * `exportColdStorage` забирает ВСЮ таблицу старше отсечки — ни chat_id, ни
 * автора он не различает, и это правильно: холодное хранилище общее. Но `NOW`
 * здесь 2030 год, то есть при `coldDays: 365` отсечка уезжает в 2029 и под неё
 * попадает вообще любая строка, оставленная соседним файлом в
 * `messages_archive`. Поэтому и содержимое дампа, и счётчики ниже считаются
 * только по своему диапазону id. Порядок файлов у `bun test` не фиксирован —
 * без этого файл краснел бы через раз. T-751.
 */
function dumpIds(file: string): number[] {
  return gunzipSync(readFileSync(file))
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { id: number }).id)
    .filter((id) => id >= BASE && id < BASE + 10_000)
    .sort((a, b) => a - b);
}

/**
 * Файлы выгрузки ИМЕННО `messages_archive`.
 *
 * P2bis (nightly, 2026-09-10): `exportColdStorage` выгружает все архивные
 * таблицы разом, и в общей `data/memory.db` соседние файлы оставляют строки в
 * `agent_actions_archive` / `audit_logs_archive` / `approvals_archive`. Каждая
 * непустая таблица добавляет в каталог свой файл, и подсчёт «всего файлов» на
 * чистой локальной БД давал 2, а в CI — 5. Проверяется здесь не число таблиц,
 * а то, что второй прогон завёл ВТОРОЙ файл своей таблицы, а не переписал
 * первый, — поэтому и считаем по своей таблице, ровно как соседние счётчики
 * уже считают по своему диапазону id (T-751).
 */
function ownDumps(): string[] {
  return readdirSync(join(TMP, "cold-storage")).filter((f) =>
    f.startsWith("messages_archive-"),
  );
}

/** Сколько ЧУЖИХ строк уедет в тот же проход — их вычитаем из счётчиков. */
function foreignOlderThan(cutoff: number): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS n FROM messages_archive
         WHERE archived_at < ? AND NOT (id >= ${BASE} AND id < ${BASE + 10_000})`,
      )
      .get(cutoff) as { n: number }
  ).n;
}

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* каталога могло не быть */
  }
  db.prepare(
    `DELETE FROM messages_archive WHERE id >= ${BASE} AND id < ${BASE + 10_000}`,
  ).run();
});

describe("cold-storage: два экспорта в один день", () => {
  test("второй прогон не затирает файл первого", () => {
    // Первый прогон: годовой рубеж, забирает только совсем старые строки.
    seed([BASE, BASE + 1], OLD);
    seed([BASE + 100, BASE + 101], NOW - 30 * 86_400_000);
    const foreign1 = foreignOlderThan(NOW - 365 * 86_400_000);
    const first = exportColdStorage({ now: NOW, coldDays: 365, dir: TMP });
    const m1 = first.find((r) => r.table === "messages_archive")!;
    expect(m1.exported - foreign1).toBe(2);
    expect(m1.pruned - foreign1).toBe(2);

    // Второй прогон в тот же день, через минуту: «выгрузить остальное».
    const later = NOW + 60_000;
    const foreign2 = foreignOlderThan(later);
    const second = exportColdStorage({ now: later, coldDays: 0, dir: TMP });
    const m2 = second.find((r) => r.table === "messages_archive")!;
    expect(m2.exported - foreign2).toBe(2);

    // Ключевое: файл первого прогона цел и всё ещё содержит СВОИ строки.
    // До правки здесь лежали бы только строки второго прогона, а первые две
    // не существовали бы уже нигде — ни в БД, ни на диске.
    expect(m1.file).not.toBe(m2.file);
    expect(dumpIds(m1.file!)).toEqual([BASE, BASE + 1]);
    expect(dumpIds(m2.file!)).toEqual([BASE + 100, BASE + 101]);
    expect(ownDumps().length).toBe(2);
  });

  test("совпадение имени — это отказ, а не потеря", () => {
    // Внутри одной секунды имена совпадут. Флаг `wx` превращает это в ошибку
    // открытия: prune отменяется, а чужой файл остаётся нетронутым — раньше
    // неудачный экспорт стирал обрывок по пути, не спрашивая, чей он.
    seed([BASE, BASE + 1], OLD);
    const foreign = foreignOlderThan(NOW - 365 * 86_400_000);
    const first = exportColdStorage({ now: NOW, coldDays: 365, dir: TMP });
    const m1 = first.find((r) => r.table === "messages_archive")!;
    expect(m1.exported - foreign).toBe(2);

    seed([BASE + 2, BASE + 3], OLD);
    const again = exportColdStorage({ now: NOW, coldDays: 365, dir: TMP });
    const m2 = again.find((r) => r.table === "messages_archive")!;
    expect(m2.pruned).toBe(0);
    expect(m2.file).toBeNull();

    // Файл первого прогона на месте и читается; новые строки остались в БД.
    expect(dumpIds(m1.file!)).toEqual([BASE, BASE + 1]);
    const left = db
      .prepare(
        `SELECT count(*) AS n FROM messages_archive WHERE id >= ${BASE} AND id < ${BASE + 10_000}`,
      )
      .get() as { n: number };
    expect(left.n).toBe(2);
  });
});

describe("cold-storage: COLD_STORAGE_DAYS=0", () => {
  test("ноль из env значит «всё», а не молча 365", () => {
    // Через opts.coldDays ноль работал всегда — расходился именно env-путь,
    // и расходился в сторону «сделали не то, о чём просили, и промолчали».
    seed([BASE, BASE + 1], NOW - 10 * 86_400_000);
    const saved = process.env.COLD_STORAGE_DAYS;
    try {
      process.env.COLD_STORAGE_DAYS = "0";
      const foreign = foreignOlderThan(NOW);
      const res = exportColdStorage({ now: NOW, dir: TMP });
      const m = res.find((r) => r.table === "messages_archive")!;
      expect(m.exported - foreign).toBe(2);
      expect(m.pruned - foreign).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.COLD_STORAGE_DAYS;
      else process.env.COLD_STORAGE_DAYS = saved;
    }
  });

  test("мусор и отрицательное значение по-прежнему падают в 365", () => {
    // Ноль допущен как осознанный ввод; всё, что не разбирается в число, и
    // отрицательное (cutoff уехал бы в будущее) — нет.
    seed([BASE, BASE + 1], NOW - 10 * 86_400_000);
    const saved = process.env.COLD_STORAGE_DAYS;
    try {
      for (const bad of ["", "abc", "-5"]) {
        process.env.COLD_STORAGE_DAYS = bad;
        const foreign = foreignOlderThan(NOW - 365 * 86_400_000);
        const res = exportColdStorage({ now: NOW, dir: TMP });
        expect(
          res.find((r) => r.table === "messages_archive")!.exported - foreign,
        ).toBe(0);
      }
    } finally {
      if (saved === undefined) delete process.env.COLD_STORAGE_DAYS;
      else process.env.COLD_STORAGE_DAYS = saved;
    }
  });

  test("имя файла разводит прогоны по секундам", () => {
    expect(coldStorageFileName("messages_archive", NOW)).not.toBe(
      coldStorageFileName("messages_archive", NOW + 1000),
    );
    expect(coldStorageFileName("messages_archive", NOW)).toMatch(
      /^messages_archive-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.ndjson\.gz$/,
    );
  });
});
