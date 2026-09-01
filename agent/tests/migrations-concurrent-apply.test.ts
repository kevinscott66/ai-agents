/**
 * Аудит 2026-08-13: два процесса, стартовавшие одновременно, роняли один
 * другого на миграциях.
 *
 * Проверка «применена ли миграция» стояла СНАРУЖИ транзакции: сначала
 * `has.get(m.name)` и `continue`, и только потом транзакция с `up` и отметкой.
 *
 * Базу открывает не только сервис: любой инструмент из `agent/tools/`
 * импортирует `lib/db.ts`, а `runMigrations` зовётся там на уровне модуля.
 * После деплоя с новой миграцией рестарт сервиса и любой запуск инструмента в
 * ту же секунду дают ровно эту гонку: оба читают «не применена», первый
 * применяет и отмечает, второй падает на `UNIQUE constraint failed:
 * schema_migrations.name` — из импорта, то есть не поднимается вообще ничего.
 *
 * Здесь проверяются обе половины фикса: авторитетная проверка внутри
 * транзакции и `BEGIN IMMEDIATE` (без него write-лок берётся только на первой
 * записи, и чужой коммит, попавший между снапшотом и записью, делает
 * промоушен невозможным — SQLite сразу отвечает «database is locked», ждать
 * там нечего).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { applyMigration, ensureMigrationsTable } from "../lib/migrations.ts";
import type { Migration } from "../lib/migrations.ts";

const files: string[] = [];

function tmpDb(): () => Database {
  const file =
    "/tmp/mig-race-" + files.length + "-" + Math.floor(performance.now() * 1000) + ".db";
  files.push(file);
  return () => {
    const d = new Database(file, { create: true });
    // Те же прагмы, что в lib/db.ts — гонка живёт именно в WAL.
    d.run("PRAGMA journal_mode = WAL;");
    d.run("PRAGMA busy_timeout = 5000;");
    return d;
  };
}

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(f + suffix, { force: true });
      } catch {
        /* файла могло не быть */
      }
    }
  }
});

const COUNT_MARKS = "SELECT count(*) AS n FROM schema_migrations";

describe("миграции: одновременный старт двух процессов", () => {
  test("второе соединение не падает на миграции, которую применило первое", () => {
    const open = tmpDb();
    const A = open();
    const B = open();
    ensureMigrationsTable(A);

    let ups = 0;
    const probe: Migration = {
      name: "zzz_probe_race",
      up: (d) => {
        ups++;
        d.run("CREATE TABLE IF NOT EXISTS zzz_probe (x INTEGER);");
      },
    };

    // Оба процесса уже прошли свою проверку «не применена» — дальше кто первый.
    expect(applyMigration(A, probe)).toBe(true);
    // До фикса здесь летел UNIQUE constraint failed прямо из импорта lib/db.ts.
    expect(applyMigration(B, probe)).toBe(false);
    expect(ups).toBe(1);

    const marks = B.prepare(COUNT_MARKS + " WHERE name = 'zzz_probe_race'").get() as {
      n: number;
    };
    expect(marks.n).toBe(1);
    A.close();
    B.close();
  });

  test("транзакция держит write-лок и на время up(), а не только на отметке", () => {
    // Половина фикса, которую не видно по одной лишь проверке внутри
    // транзакции: DEFERRED берёт снапшот на чтении, а write-лок — на первой
    // записи. Чужой коммит, попавший в этот промежуток (то есть во время
    // up()), проверку уже не догоняет, и падение возвращается.
    const open = tmpDb();
    const A = open();
    const other = open();
    other.run("PRAGMA busy_timeout = 100;"); // не ждать в тесте пять секунд
    ensureMigrationsTable(A);

    let interference = "не пробовали";
    const probe: Migration = {
      name: "zzz_probe_lock",
      up: (d) => {
        // Порядок здесь важен: чужая запись идёт ДО нашей первой. При DEFERRED
        // в этот момент за нами числится только чтение, чужой коммит проходит,
        // и следующая строка уже не может повысить транзакцию до пишущей —
        // SQLite отвечает «database is locked», и applyMigration бросает.
        try {
          other
            .prepare(
              "INSERT INTO schema_migrations(name, applied_at) VALUES ('zzz_probe_lock', 0)",
            )
            .run();
          interference = "успел";
        } catch {
          interference = "заблокирован";
        }
        d.run("CREATE TABLE IF NOT EXISTS zzz_probe_lock (x INTEGER);");
      },
    };

    // С BEGIN IMMEDIATE соседнее соединение не может вклиниться в середину.
    expect(applyMigration(A, probe)).toBe(true);
    expect(interference).toBe("заблокирован");
    A.close();
    other.close();
  });

  test("упавшая миграция не оставляет отметку и откатывает свои изменения", () => {
    // Обратная сторона: отметка и сама миграция обязаны быть атомарны, иначе
    // следующий старт пропустит недоделанную схему как применённую.
    const open = tmpDb();
    const A = open();
    ensureMigrationsTable(A);

    const bad: Migration = {
      name: "zzz_probe_boom",
      up: (d) => {
        d.run("CREATE TABLE zzz_probe_boom (x INTEGER);");
        throw new Error("миграция сломалась на середине");
      },
    };
    expect(() => applyMigration(A, bad)).toThrow(/сломалась на середине/);

    const marks = A.prepare(COUNT_MARKS + " WHERE name = 'zzz_probe_boom'").get() as {
      n: number;
    };
    expect(marks.n).toBe(0);
    const tbl = A.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='zzz_probe_boom'",
    ).get();
    expect(tbl).toBeNull();
    A.close();
  });
});
