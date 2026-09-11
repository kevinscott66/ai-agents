/**
 * Аудит 2026-09-11: колонка инвесторов показывала пользователю дословное «[]».
 *
 * `investors_json` названа как соседние `steps_json` / `hashtags_json`, и
 * умолчание у неё стояло такое же — `DEFAULT '[]'`. Но хранит она JSON-СТРОКУ,
 * а не массив: `upsertActivity` кладёт `COALESCE($investors, '""')`, а читает
 * `parseStr`, которая ждёт `typeof parsed === "string"`.
 *
 * Сходились эти два факта плохо. `JSON.parse("[]")` не бросает — значит ветка
 * `catch` не срабатывала, — но и строкой результат не был, поэтому управление
 * доходило до `return raw`, и наружу уходили два символа `[]` как текст. Взять
 * такую строку неоткуда только до тех пор, пока в таблицу пишет исключительно
 * `upsertActivity`: любой INSERT без этой колонки (ручная правка базы, импорт,
 * бэкфилл) получал умолчание и показывал «Инвесторы: []».
 *
 * Чинится с двух концов сразу: умолчание в схеме стало `'""'`, а `parseStr`
 * больше не выдаёт удавшийся разбор за сырой текст. Сырым текстом остаётся
 * только то, что не разобралось вовсе, — легаси-строки без кавычек.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-investors-"));
process.env.SITE_DB_PATH = join(TMP, "audit.db");

const { getDb, getActivity, upsertActivity } = await import("./db.ts");

const BARE = "activity-investors-bare";
const ARRAY = "activity-investors-array";
const LEGACY = "activity-investors-legacy";
const NORMAL = "activity-investors-normal";

/** INSERT мимо `upsertActivity`: ровно то, чего касается умолчание схемы. */
function insertWithoutInvestors(id: string): void {
  getDb()
    .query(
      `INSERT INTO activities (id, project, title, date)
       VALUES (?, 'Проект', 'Заголовок', '2026-09-11')`,
    )
    .run(id);
}

/** Прямая запись в колонку: форма, которую `upsertActivity` не создаёт. */
function setInvestorsColumn(id: string, raw: string): void {
  insertWithoutInvestors(id);
  getDb().query("UPDATE activities SET investors_json = ? WHERE id = ?").run(raw, id);
}

beforeAll(() => {
  insertWithoutInvestors(BARE);
  setInvestorsColumn(ARRAY, JSON.stringify(["a16z", "Paradigm"]));
  setInvestorsColumn(LEGACY, "a16z, Paradigm");
  upsertActivity({
    id: NORMAL,
    project: "Проект",
    title: "Заголовок",
    investors: "a16z, Paradigm",
    date: "2026-09-11",
  } as never);
});

afterAll(() => {
  for (const id of [BARE, ARRAY, LEGACY, NORMAL]) {
    getDb().query("DELETE FROM activities WHERE id = ?").run(id);
  }
});

describe("инвесторы: скобки не вылезают в карточку", () => {
  test("строка без колонки — пусто, а не «[]»", () => {
    const a = getActivity(BARE);
    expect(a).not.toBeNull();
    expect(a!.investors).toBe("");
  });

  test("умолчание схемы — JSON-строка, а не JSON-массив", () => {
    const sql = getDb()
      .query("SELECT sql FROM sqlite_master WHERE name = 'activities'")
      .get() as { sql: string };
    expect(sql.sql).toContain(`investors_json  TEXT NOT NULL DEFAULT '""'`);
  });

  test("массив строк склеивается, а не показывается как JSON", () => {
    expect(getActivity(ARRAY)!.investors).toBe("a16z, Paradigm");
  });

  test("неразобранный текст остаётся собой: легаси-строки живы", () => {
    expect(getActivity(LEGACY)!.investors).toBe("a16z, Paradigm");
  });

  test("обычная запись через upsert не задета", () => {
    expect(getActivity(NORMAL)!.investors).toBe("a16z, Paradigm");
  });
});
