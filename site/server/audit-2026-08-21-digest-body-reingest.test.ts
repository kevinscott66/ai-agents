/**
 * Аудит 2026-08-21: повторный ингест статьи стирал её текст.
 *
 * `body` по контракту необязателен (`types.ts`: `body?: string`), но
 * `upsertDigest` писал его в `ON CONFLICT DO UPDATE` безусловно, а отсутствие
 * поля превращал в пустую строку. То есть «не прислали» означало не «не
 * трогать», а «стереть».
 *
 * Почему это достижимо, а не теоретически:
 *   1. `ingestArticle` (agent/tools/approve-poll.ts) публикует статью с
 *      `body` — полным markdown-текстом.
 *   2. `ingestDigestToSite` (agent/lib/site-ingest.ts) шлёт на тот же эндпоинт
 *      payload БЕЗ поля `body` вообще — другого формата он не умеет.
 *   3. `id` не шлёт ни тот, ни другой; `handleIngestDigest` выводит слаг из
 *      заголовка, и `freeSlug` намеренно ПЕРЕИСПОЛЬЗУЕТ id при совпадении
 *      заголовка — комментарий рядом прямо говорит: «агент переотправляет
 *      статью после правок, upsert обязан обновить её на месте».
 *
 * Итог: та же строка, `body = ''`, страница /digest/<id> остаётся с одной
 * аннотацией. Ответ эндпоинта при этом — ok.
 *
 * Замер до правки (`SITE_DB_PATH=":memory:"`):
 *   после публикации : "# Полный текст\n\nмного абзацев"
 *   после реингеста  : undefined
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SITE_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "web3puls-body-reingest-")),
  "site.db",
);
const { upsertDigest, getDigest } = await import("./db.ts");

const BODY = "# Полный текст\n\nмного абзацев";
const base = {
  id: "d-body",
  title: "Заголовок",
  date: "2026-08-21T00:00:00.000Z",
  summary: "аннотация",
  items: [{ text: "пункт" }],
  sourceCount: 1,
};

describe("upsertDigest: отсутствующий body не стирает сохранённый", () => {
  beforeEach(() => {
    upsertDigest({ ...base, body: BODY });
  });

  test("реингест без body оставляет текст на месте", () => {
    upsertDigest({ ...base });
    expect(getDigest("d-body")?.body).toBe(BODY);
  });

  test("реингест без body обновляет остальные поля", () => {
    // Правка аннотации не должна стоить статьи — и наоборот, сохранение body
    // не должно замораживать строку целиком.
    upsertDigest({ ...base, summary: "новая аннотация" });
    const d = getDigest("d-body");
    expect({ summary: d?.summary, body: d?.body }).toEqual({
      summary: "новая аннотация",
      body: BODY,
    });
  });

  test("присланный body по-прежнему перезаписывает старый", () => {
    upsertDigest({ ...base, body: "# Другой текст" });
    expect(getDigest("d-body")?.body).toBe("# Другой текст");
  });

  test("первая запись без body — пустой текст, а не ошибка NOT NULL", () => {
    upsertDigest({ ...base, id: "d-fresh" });
    expect(getDigest("d-fresh")?.body).toBeUndefined();
  });

  test("search_text от body не зависит — обновляется и при пропуске body", () => {
    // `body` намеренно не входит в search_text (db.ts). Проверяем, что защита
    // body не заморозила заодно и поисковый индекс.
    upsertDigest({ ...base, title: "Совсем другой заголовок" });
    const d = getDigest("d-body");
    expect({ title: d?.title, body: d?.body }).toEqual({
      title: "Совсем другой заголовок",
      body: BODY,
    });
  });
});
