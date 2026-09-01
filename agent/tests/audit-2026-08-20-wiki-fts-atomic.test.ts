/**
 * Аудит 2026-08-20: обновление FTS-строки вики шло двумя коммитами.
 *
 * `upsertWikiFts` делал `DELETE FROM wiki_fts …`, затем отдельным statement'ом
 * `INSERT`. В WAL это две транзакции. Вызывается функция УЖЕ после того, как
 * файл страницы переименован на место: и `wikiWrite`, и `wikiWriteAsync`
 * сначала делают atomic rename, и только потом трогают индекс.
 *
 * Значит между DELETE и INSERT есть окно, в котором новый текст лежит на
 * диске, а строки в индексе нет вообще. Провалить INSERT есть чему:
 * SQLITE_FULL на забитом разделе (туда же пишутся бэкапы и холодный экспорт),
 * SQLITE_BUSY от второго процесса (`tools/*`, `query-db-worker`), сбой FTS5,
 * либо процесс убит при деплое ровно между вызовами. Итог: `wikiSearch` и
 * списки в Mini App страницу не видят до следующего ребилда индекса — для
 * агентов она потеряна, — хотя наружу вернулась ошибка «запись не удалась».
 *
 * Рядом, у `rebuildWikiIndex`, тот же аргумент записан дословно («частичный
 * индекс внешне неотличим от полного») и транзакция там есть. Сюда не доехала.
 *
 * Инвариант: сорванный INSERT не оставляет индекс пустым — прежняя строка
 * переживает откат.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { wikiWrite, wikiSearch, upsertWikiFts, pagePath } from "../lib/memory.ts";
import { db } from "../lib/db.ts";
import { rmSync } from "node:fs";

const SCOPE = "_team" as const;
const SLUG = "atomic-fts-probe";
const MARKER = "цепенеющий";

afterAll(() => {
  db.prepare(`DELETE FROM wiki_fts WHERE slug LIKE ?`).run("%atomic-fts-probe%");
  try {
    rmSync(pagePath(SCOPE, SLUG), { force: true });
  } catch {}
});

function found(): number {
  return wikiSearch(MARKER, [SCOPE], 10).filter((h) =>
    h.slug.includes(SLUG),
  ).length;
}

describe("upsertWikiFts атомарен", () => {
  test("сорванный INSERT не стирает прежнюю строку индекса", () => {
    wikiWrite({
      scope: SCOPE,
      slug: SLUG,
      title: "Проба",
      content: `Текст ${MARKER} для поиска.`,
    });
    expect(found()).toBe(1);

    // Единственный способ воспроизвести SQLITE_FULL/BUSY детерминированно —
    // уронить именно второй statement. Патчим db.prepare, потому что
    // upsertWikiFts готовит запросы в момент вызова.
    const realPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string, ...rest: unknown[]) => {
      if (sql.includes("INSERT INTO wiki_fts")) {
        throw new Error("database or disk is full");
      }
      return realPrepare(sql, ...rest);
    };

    let threw = false;
    try {
      upsertWikiFts(
        SCOPE,
        SLUG,
        pagePath(SCOPE, SLUG),
        "Проба",
        `Другой ${MARKER} текст.`,
      );
    } catch {
      threw = true;
    } finally {
      (db as any).prepare = realPrepare;
    }

    // До фикса: DELETE закоммичен сам по себе → 0, страница пропала из поиска.
    expect({ threw, rows: found() }).toEqual({ threw: true, rows: 1 });
  });

  test("успешная перезапись по-прежнему обновляет строку и не плодит дублей", () => {
    upsertWikiFts(
      SCOPE,
      SLUG,
      pagePath(SCOPE, SLUG),
      "Проба",
      `Обновлённый ${MARKER} текст.`,
    );
    const hits = wikiSearch(MARKER, [SCOPE], 10).filter((h) =>
      h.slug.includes(SLUG),
    );
    expect(hits.length).toBe(1);
  });
});
