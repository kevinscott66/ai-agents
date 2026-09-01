/**
 * Аудит 2026-08-20: правка дайджеста на стыке UTC-суток заводила вторую страницу.
 *
 * Производный слаг начинается с даты (`slugFromTitle`), а дату ингест берёт
 * «сейчас»: мост `ingestDigestToSite` шлёт только
 * `{title, summary, items, sourceCount}` — ни `id`, ни `date`. Пока правка
 * приходит в те же сутки, слаг совпадает и статья обновляется на месте (ровно
 * то, что обещает докстринг `freeSlug`: «агент переотправляет статью после
 * правок, и плодить копии на каждую правку нельзя»). На стыке суток префикс
 * меняется — и тот же материал получает вторую страницу с тем же заголовком.
 *
 * Замер до правки: пост в 23:50 и его правка в 00:10 дают
 * `2026-08-12-…` и `2026-08-13-…`, `countDigests()` растёт на 2. Это и есть
 * ситуация инцидента T-743 (восемь лишних страниц на живом delabs.space),
 * только приезжающая сама собой.
 *
 * Инвариант, который здесь закрепляется: правка в пределах
 * `DIGEST_REUSE_WINDOW_MS` обновляет статью на месте независимо от полуночи, а
 * следующий выпуск того же ШАБЛОНА (те же «Итоги недели» неделей позже)
 * по-прежнему заводит свою страницу.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-midnight-"));
process.env.SITE_DB_PATH = join(TMP, "midnight.db");
process.env.SITE_INGEST_TOKEN = "midnight-test-token";

const { makeFetchHandler, _resetRateLimiter, reusableDigestId } = await import(
  "./index.ts"
);
const db = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  // Лимитер — модульный и один на весь процесс: bun гоняет все файлы в одном.
  // Этот файл шлёт десятки ингестов подряд и оставлял ведро выбранным, а
  // следующий файл получал 429 на первом же запросе (падали `sitemap.test.ts`
  // и `robots`, к ингесту отношения не имеющие).
  _resetRateLimiter();
});

// Счётчик лимитера общий на весь процесс bun test.
beforeEach(() => _resetRateLimiter());

async function ingest(body: unknown): Promise<string> {
  const r = await fetch(`${base}/api/internal/digests`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer midnight-test-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  const j = (await r.json()) as { ok: boolean; id: string };
  expect(j.ok).toBe(true);
  return j.id;
}

const TITLE = "Итоги недели";

describe("ингест дайджестов: полночь не плодит копии", () => {
  test("пост в 23:50 и правка в 00:10 — одна страница", async () => {
    const before = db.countDigests();
    const id1 = await ingest({
      title: TITLE,
      summary: "Первая редакция.",
      date: "2026-08-12T23:50:00.000Z",
    });
    const id2 = await ingest({
      title: TITLE,
      summary: "Поправили опечатку и добавили пункт.",
      date: "2026-08-13T00:10:00.000Z",
    });

    expect(id2).toBe(id1);
    expect(db.countDigests()).toBe(before + 1);
    // На месте — значит с новым содержимым, а не со старым.
    expect(db.getDigest(id1)?.summary).toBe("Поправили опечатку и добавили пункт.");
  });

  test("следующий выпуск того же шаблона неделей позже — своя страница", async () => {
    const before = db.countDigests();
    const week1 = await ingest({
      title: `${TITLE} (шаблон)`,
      summary: "Неделя с 6 по 12 августа.",
      date: "2026-08-12T09:00:00.000Z",
    });
    const week2 = await ingest({
      title: `${TITLE} (шаблон)`,
      summary: "Неделя с 13 по 19 августа.",
      date: "2026-08-19T09:00:00.000Z",
    });

    expect(week2).not.toBe(week1);
    expect(db.countDigests()).toBe(before + 2);
    // Выпуск недельной давности не должен быть затёрт свежим.
    expect(db.getDigest(week1)?.summary).toBe("Неделя с 6 по 12 августа.");
  });

  test("присланный id по-прежнему главнее любых догадок", async () => {
    const before = db.countDigests();
    await ingest({
      title: `${TITLE} (явный id)`,
      summary: "Первая.",
      date: "2026-08-12T23:50:00.000Z",
    });
    const explicit = await ingest({
      id: "moy-sobstvennyy-id",
      title: `${TITLE} (явный id)`,
      summary: "Вторая, с явным id.",
      date: "2026-08-13T00:10:00.000Z",
    });

    expect(explicit).toBe("moy-sobstvennyy-id");
    expect(db.countDigests()).toBe(before + 2);
  });
});

describe("reusableDigestId: границы окна", () => {
  const stored = { id: "2026-08-12-itogi", date: "2026-08-12T23:50:00.000Z" };

  test("внутри окна — переиспользуем", () => {
    expect(reusableDigestId("2026-08-13T00:10:00.000Z", stored)).toBe(stored.id);
    expect(reusableDigestId("2026-08-13T11:49:00.000Z", stored)).toBe(stored.id);
  });

  test("за окном — новый id", () => {
    expect(reusableDigestId("2026-08-13T11:51:00.000Z", stored)).toBeNull();
    expect(reusableDigestId("2026-08-19T09:00:00.000Z", stored)).toBeNull();
  });

  test("ничего похожего не нашлось — новый id", () => {
    expect(reusableDigestId("2026-08-13T00:10:00.000Z", null)).toBeNull();
  });

  test("непарсимая дата не считается совпадением", () => {
    expect(
      reusableDigestId("2026-08-13T00:10:00.000Z", { id: "x", date: "не дата" }),
    ).toBeNull();
    expect(reusableDigestId("не дата", stored)).toBeNull();
  });

  test("дата чуть в будущем (расхождение часов) — та же статья", () => {
    // Сравнение по модулю: «на пять минут вперёд» не повод плодить страницу.
    expect(reusableDigestId("2026-08-12T23:45:00.000Z", stored)).toBe(stored.id);
  });
});
