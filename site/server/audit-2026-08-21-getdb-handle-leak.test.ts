/**
 * Аудит 2026-08-21: неудачная миграция оставляла открытый хэндл базы.
 *
 *   const db = new Database(path, { create: true });
 *   db.exec("PRAGMA journal_mode = WAL;");
 *   …
 *   migrate(db);          // ← бросил
 *   _db = db;             // ← сюда уже не дошли
 *
 * `_db` остаётся `null`, а открытый `Database` — открытым и недостижимым.
 * Значит следующий запрос откроет ЕЩЁ один, и так каждый: `getDb()` зовётся
 * из каждой ручки.
 *
 * Замер до правки (`/dev/fd`, WAL — два дескриптора на соединение):
 * 20 неудачных вызовов = +40 дескрипторов, линейно и без потолка.
 *
 * Опасна тут не сама утечка, а превращение временной ошибки в постоянную:
 * `migrate` падает от «database is locked» или переполненного диска —
 * то есть от состояния, которое проходит само, — но процесс к этому моменту
 * уже упёрся в EMFILE и не отдаёт ничего до рестарта.
 *
 * Правка закрывает соединение и пробрасывает ошибку дальше: глотать её
 * нельзя, иначе вместо шумного отказа получится тихая работа на пустой базе.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "web3puls-getdb-leak-"));
const BROKEN = join(dir, "broken.db");
const OK = join(dir, "ok.db");

beforeAll(() => {
  // `digests` существует как ПРЕДСТАВЛЕНИЕ: `CREATE TABLE IF NOT EXISTS` его
  // не тронет (имя занято), а `ALTER TABLE … ADD COLUMN` по представлению
  // обязан упасть. Способ получить падение внутри migrate, не трогая код.
  const raw = new Database(BROKEN, { create: true });
  raw.exec("CREATE TABLE t(x); CREATE VIEW digests AS SELECT x AS id FROM t;");
  raw.close();
});

const { getDb } = await import("./db.ts");

/** Число открытых дескрипторов процесса. */
function fdCount(): number {
  return readdirSync("/dev/fd").length;
}

function failingCalls(n: number): number {
  let failures = 0;
  for (let i = 0; i < n; i++) {
    process.env.SITE_DB_PATH = BROKEN;
    try {
      getDb();
    } catch {
      failures++;
    }
  }
  return failures;
}

describe("getDb: упавшая миграция не течёт дескрипторами", () => {
  test("ошибка пробрасывается, а не глотается", () => {
    process.env.SITE_DB_PATH = BROKEN;
    expect(() => getDb()).toThrow(/column|view/i);
  });

  test("20 неудачных вызовов не открывают 20 соединений", () => {
    failingCalls(3); // прогрев: первые вызовы могут тянуть ленивые импорты
    const before = fdCount();
    expect(failingCalls(20)).toBe(20);
    const grown = fdCount() - before;
    // До правки здесь ровно +40 (WAL = два дескриптора на соединение).
    // Порог с запасом на посторонние открытия в том же процессе.
    expect(grown).toBeLessThan(8);
  });

  test("после сбоя рабочая база по-прежнему открывается", () => {
    failingCalls(1);
    process.env.SITE_DB_PATH = OK;
    expect(() => getDb().query("SELECT 1 AS n").get()).not.toThrow();
  });
});
