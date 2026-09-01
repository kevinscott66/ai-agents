/**
 * Аудит 2026-08-14: индекс разблокировок не совпадал с ORDER BY.
 *
 * Комментарий в db.ts обещал: «индексы совпадают с ORDER BY соответствующих
 * выборок, поэтому снимают и сортировку». Для дайджестов и активностей это
 * было правдой, для разблокировок — нет: индекс (date, symbol, project), а
 * выборка сортирует по (date, project). `symbol` стоит МЕЖДУ ними и в ORDER BY
 * не участвует, поэтому внутри одной даты индекс идёт в порядке символа, а
 * нужен порядок проекта. SQLite честно сообщал об этом:
 *
 *   (date, symbol, project) → SEARCH … USE TEMP B-TREE FOR LAST TERM OF ORDER BY
 *   (date, project)         → SEARCH … (временного дерева нет)
 *
 * Вторая половина находки — как правку доставить. `CREATE INDEX IF NOT EXISTS`
 * с тем же именем и другими колонками не пересоздаёт индекс и не ругается: он
 * просто ничего не делает. На живой БД, где индекс создан 2026-08-13, правка
 * «на месте» осталась бы незамеченной навсегда. Поэтому старое имя дропается,
 * новое создаётся — и вот это здесь проверяется отдельно.
 *
 * Третья — разворот сортировки. Было `date DESC, project ASC`: переключатель
 * «ближайшие/дальние» давал не обратный список, строки одного дня сохраняли
 * прежний порядок. Тайбрейк теперь разворачивается вместе с датой.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-unlocks-idx-"));
const DB_PATH = join(TMP, "unlocks-idx.db");
process.env.SITE_DB_PATH = DB_PATH;

const db = await import("./db.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString();

/** Три проекта в один день — ради них тайбрейк и существует. */
const SAME_DAY = iso(3);

beforeAll(() => {
  db.upsertUnlocks([
    { project: "Bravo", symbol: "BRV", date: SAME_DAY, pctOfSupply: 1, amountUsd: null },
    { project: "Alfa", symbol: "ZZZ", date: SAME_DAY, pctOfSupply: 2, amountUsd: null },
    { project: "Charlie", symbol: "AAA", date: SAME_DAY, pctOfSupply: 3, amountUsd: null },
    { project: "Delta", symbol: "DLT", date: iso(10), pctOfSupply: 4, amountUsd: null },
    { project: "Echo", symbol: "ECH", date: iso(20), pctOfSupply: 5, amountUsd: null },
  ]);
});

/** План запроса читаем из той же БД, что и данные, — иначе это разговор ни о чём. */
function plan(sql: string, ...params: unknown[]): string {
  const raw = new Database(DB_PATH, { readonly: true });
  try {
    const rows = raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
      detail: string;
    }>;
    return rows.map((r) => r.detail).join(" ;; ");
  } finally {
    raw.close();
  }
}

const LIST_ASC =
  "SELECT * FROM unlocks WHERE date >= ? ORDER BY date ASC, project ASC LIMIT ? OFFSET ?";
const LIST_DESC =
  "SELECT * FROM unlocks WHERE date >= ? ORDER BY date DESC, project DESC LIMIT ? OFFSET ?";
const LIST_WINDOW =
  "SELECT * FROM unlocks WHERE date >= ? AND date <= ? ORDER BY date ASC, project ASC LIMIT ? OFFSET ?";

describe("индекс разблокировок совпадает с сортировкой", () => {
  test("старого трёхколоночного индекса в схеме нет", () => {
    const names = db
      .getDb()
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='unlocks'")
      .all() as Array<{ name: string }>;
    const own = names.map((n) => n.name).filter((n) => n.startsWith("idx_"));
    // Именно дроп: пересоздать под тем же именем нельзя, IF NOT EXISTS промолчит.
    expect(own).not.toContain("idx_unlocks_date");
    expect(own).toContain("idx_unlocks_date_project");
  });

  test("индекс объявлен по (date, project) — без symbol посередине", () => {
    const row = db
      .getDb()
      .query("SELECT sql FROM sqlite_master WHERE name='idx_unlocks_date_project'")
      .get() as { sql: string } | null;
    expect(row?.sql).toContain("date");
    expect(row?.sql).toContain("project");
    expect(row?.sql).not.toContain("symbol");
  });

  test("выборка «ближайшие первыми» больше не строит временное дерево", () => {
    const p = plan(LIST_ASC, iso(0), 20, 0);
    expect(p).toContain("idx_unlocks_date_project");
    // Была эта строка — ради неё вся правка.
    expect(p).not.toContain("TEMP B-TREE");
  });

  test("обратный порядок тоже идёт по индексу", () => {
    const p = plan(LIST_DESC, iso(0), 20, 0);
    expect(p).toContain("idx_unlocks_date_project");
    expect(p).not.toContain("TEMP B-TREE");
  });

  test("окно «N дней» — тот же индекс, оба конца", () => {
    const p = plan(LIST_WINDOW, iso(0), iso(7), 20, 0);
    expect(p).toContain("idx_unlocks_date_project");
    expect(p).not.toContain("TEMP B-TREE");
  });

  test("счётчик остаётся покрывающим — он ходит на каждую страницу", () => {
    const p = plan("SELECT COUNT(*) FROM unlocks WHERE date >= ?", iso(0));
    expect(p).toContain("idx_unlocks_date_project");
  });
});

describe("порядок строк, а не только план", () => {
  test("в один день проекты идут по алфавиту", () => {
    const rows = db.listUpcomingUnlocks(10, 0);
    const sameDay = rows.filter((r) => r.date === SAME_DAY).map((r) => r.project);
    // По symbol это было бы Charlie(AAA), Bravo(BRV), Alfa(ZZZ) — обратный порядок.
    expect(sameDay).toEqual(["Alfa", "Bravo", "Charlie"]);
  });

  test("переключатель сортировки даёт ровно обратный список", () => {
    const asc = db.listUpcomingUnlocks(10, 0).map((r) => `${r.date}|${r.project}`);
    const desc = db.listUpcomingUnlocks(10, 0, { desc: true }).map((r) => `${r.date}|${r.project}`);
    // До правки хвост из трёх строк одного дня в обоих списках шёл одинаково.
    expect(desc).toEqual([...asc].reverse());
  });

  test("пагинация по OFFSET не теряет и не дублирует строк", () => {
    const whole = db.listUpcomingUnlocks(10, 0).map((r) => `${r.date}|${r.project}`);
    const paged = [
      ...db.listUpcomingUnlocks(2, 0),
      ...db.listUpcomingUnlocks(2, 2),
      ...db.listUpcomingUnlocks(2, 4),
    ].map((r) => `${r.date}|${r.project}`);
    expect(paged).toEqual(whole);
    expect(new Set(paged).size).toBe(paged.length);
  });
});
