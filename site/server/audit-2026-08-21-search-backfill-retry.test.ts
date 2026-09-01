/**
 * Аудит 2026-08-21: заполнение `search_text` не переживало прерывания и
 * второго шанса не получало.
 *
 * Миграция стояла так:
 *
 *   if (addColumnIfMissing(db, "digests", "search_text", "…")) {
 *     backfillDigestSearchText(db);
 *   }
 *
 * `ALTER TABLE … ADD COLUMN` — DDL, он коммитится сразу и сам по себе;
 * заполнение идёт следом отдельной транзакцией. Между ними есть окно: падение
 * процесса, SIGKILL при рестарте деплоя, «database is locked», исключение
 * внутри самого заполнения. Что бы ни случилось, колонка после этого уже
 * существует — значит на следующем старте `addColumnIfMissing` вернёт `false`,
 * и заполнение не выполнится НИКОГДА.
 *
 * Цена: у переживших окно строк `search_text` остаётся пустым, а `LIKE` по
 * пустой строке не находит ничего. Поиск на delabs.space молча отвечает
 * «ничего не найдено» — без ошибки, без записи в лог, без способа заметить.
 * Ровно тот класс отказа, который чинил сам аудит 2026-08-13: выдача пустая,
 * признаков сбоя нет.
 *
 * Правка делает заполнение управляемым ДАННЫМИ, а не возвратом ALTER: строки
 * с пустым `search_text` дозаполняются на каждом старте. После первого прохода
 * это no-op (`WHERE search_text = ''` не находит ничего).
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "web3puls-backfill-"));
/** База в состоянии «ALTER прошёл, заполнение не успело». */
const INTERRUPTED = join(dir, "interrupted.db");
/** Чистая база — обычный путь, где колонки ещё нет. */
const FRESH = join(dir, "fresh.db");

const DIGEST = {
  id: "2026-08-21-bitcoin",
  title: "Биткоин снова растёт",
  date: "2026-08-21",
  summary: "Курс обновил максимум",
  items: [{ text: "Подробности про Monad тестнет" }],
};

beforeAll(() => {
  // Ровно та схема, что была бы после ALTER: колонка есть, значение пустое.
  const raw = new Database(INTERRUPTED, { create: true });
  raw.exec(`
    CREATE TABLE digests (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      date         TEXT NOT NULL,
      summary      TEXT NOT NULL,
      items_json   TEXT NOT NULL DEFAULT '[]',
      source_count INTEGER NOT NULL DEFAULT 0,
      body         TEXT NOT NULL DEFAULT '',
      search_text  TEXT NOT NULL DEFAULT ''
    );
  `);
  raw
    .query(
      `INSERT INTO digests (id, title, date, summary, items_json, search_text)
       VALUES (?1, ?2, ?3, ?4, ?5, '')`,
    )
    .run(
      DIGEST.id,
      DIGEST.title,
      DIGEST.date,
      DIGEST.summary,
      JSON.stringify(DIGEST.items),
    );
  raw.close();
});

/** Переключает базу и отдаёт свежие ручки (getDb переоткрывает по пути). */
async function on(path: string) {
  process.env.SITE_DB_PATH = path;
  const m = await import("./db.ts");
  // Дёргаем любую ручку, чтобы getDb() увидел новый путь и прогнал migrate().
  m.countDigests();
  return m;
}

describe("прерванное заполнение search_text", () => {
  test("строка, пережившая окно, находится поиском", async () => {
    const { searchDigests, countSearchDigests } = await on(INTERRUPTED);
    // До правки: 0 — колонка есть, значит backfill пропущен навсегда.
    expect(countSearchDigests("биткоин")).toBe(1);
    expect(searchDigests("биткоин", 10, 0)[0]?.id).toBe(DIGEST.id);
  });

  test("ищется и по аннотации, и по тексту пунктов", async () => {
    const { countSearchDigests } = await on(INTERRUPTED);
    expect({
      summary: countSearchDigests("максимум"),
      items: countSearchDigests("Monad"),
    }).toEqual({ summary: 1, items: 1 });
  });

  test("регистр по-прежнему складывается (правка 2026-08-13 цела)", async () => {
    const { countSearchDigests } = await on(INTERRUPTED);
    expect({
      lower: countSearchDigests("биткоин"),
      upper: countSearchDigests("БИТКОИН"),
      title: countSearchDigests("Биткоин"),
    }).toEqual({ lower: 1, upper: 1, title: 1 });
  });

  test("повторный старт ничего не ломает и не перетирает", async () => {
    const { countSearchDigests } = await on(FRESH);
    const again = await on(INTERRUPTED);
    expect(again.countSearchDigests("биткоин")).toBe(1);
    expect(countSearchDigests).toBeDefined();
  });
});

describe("обычный путь не задет", () => {
  test("новая база: запись через upsert ищется", async () => {
    const { upsertDigest, countSearchDigests } = await on(FRESH);
    upsertDigest({
      id: "2026-08-20-scroll",
      title: "Scroll Sessions",
      date: "2026-08-20",
      summary: "Новый сезон",
      items: [{ text: "как участвовать" }],
      sourceCount: 1,
    } as never);
    expect(countSearchDigests("scroll")).toBe(1);
  });
});
