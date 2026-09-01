/**
 * Аудит 2026-08-28: ответ ингеста дайджеста считал пункты, которых не отправляли.
 *
 * Реингест без `items` сохранённые пункты не трогает — это починили в тот же
 * день (`items_json = CASE WHEN $items IS NULL …` в upsertDigest). Но ответ
 * эндпоинта остался прежним: `items: items.length`, где `items` — локальный
 * пустой массив, собранный из неприсланного поля. То есть на сохранение,
 * которое ничего не потеряло, приходил ноль. `sourceCount` в этом случае
 * вообще уезжал как `undefined` и пропадал из JSON.
 *
 * Отправитель по этому числу и судит: droppedItems его не спасает — он
 * считается от того же пустого массива и тоже ноль. Отвечать «пунктов ноль»
 * про статью, у которой их три, — ровно та немота, от которой уходили в
 * аудите 2026-08-13, только с другой стороны.
 *
 * У активностей этот же ответ уже читает фактическое сохранённое число
 * (index.ts, `storedSteps`); до дайджестов правку не довели.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-dig-count-"));
process.env.SITE_DB_PATH = join(TMP, "dig.db");
process.env.SITE_INGEST_TOKEN = "dig-count-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const { getDigest } = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

interface IngestRes {
  ok: boolean;
  id: string;
  items: number;
  sourceCount?: number;
  droppedItems?: number;
}

async function ingest(body: unknown): Promise<IngestRes> {
  const r = await fetch(`${base}/api/internal/digests`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer dig-count-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as IngestRes;
}

const ITEMS = [
  { text: "первый источник", url: "https://example.org/1" },
  { text: "второй источник" },
  { text: "третий источник" },
];

/**
 * Дата сида — час назад, а не литерал.
 *
 * Аудит 2026-08-29: здесь стояло `"2026-08-28T09:00:00.000Z"`, и реингест
 * попадал на ту же запись только потому, что `reusableDigestId` переиспользует
 * слаг в пределах 12 часов. С 2026-08-28T21:00Z окно закрылось, второй POST
 * стал заводить новую строку с сегодняшним слагом, и файл падал пятью тестами
 * каждый день — не находя при этом ни одной регрессии. Час назад — внутри
 * окна при любом запуске, так что переиспользование слага проверяется ровно
 * тем же путём, каким его проходит прод.
 */
async function seed(title: string): Promise<string> {
  const r = await ingest({
    title,
    summary: "сводка",
    items: ITEMS,
    date: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  expect(r.items).toBe(3);
  return r.id;
}

describe("реингест без пунктов отвечает сохранённым числом", () => {
  test("items — фактическое число в БД, а не ноль", async () => {
    const id = await seed("Сохранённые пункты");
    const again = await ingest({ title: "Сохранённые пункты", summary: "новая сводка" });

    expect(again.id).toBe(id);
    expect(getDigest(id)?.items.length).toBe(3);
    expect(again.items).toBe(3);
  });

  test("sourceCount не пропадает из ответа", async () => {
    const id = await seed("Счётчик источников");
    const again = await ingest({ title: "Счётчик источников", summary: "правка" });
    expect(getDigest(id)?.sourceCount).toBe(3);
    expect(again.sourceCount).toBe(3);
  });

  test("присланный sourceCount важнее сохранённого", async () => {
    // Поле необязательное и приезжает отдельно от пунктов: отправитель может
    // сообщить, сколько источников он просмотрел, не пересылая их списком.
    const id = await seed("Свой счётчик");
    const again = await ingest({
      title: "Свой счётчик",
      summary: "правка",
      sourceCount: 9,
    });
    expect(getDigest(id)?.sourceCount).toBe(9);
    expect(again.sourceCount).toBe(9);
    expect(again.items).toBe(3);
  });

  test("потери не выдумываются на пустом месте", async () => {
    await seed("Без потерь");
    const again = await ingest({ title: "Без потерь", summary: "правка" });
    expect(again.droppedItems).toBeUndefined();
  });
});

describe("прежние ответы не поехали", () => {
  test("явная очистка отвечает нулём", async () => {
    const id = await seed("Явная очистка");
    const again = await ingest({ title: "Явная очистка", summary: "правка", items: [] });
    expect(getDigest(id)?.items.length).toBe(0);
    expect(again.items).toBe(0);
    expect(again.sourceCount).toBe(0);
  });

  test("новая статья без пунктов отвечает нулём, а не молчанием", async () => {
    const r = await ingest({ title: "Совсем новая", summary: "сводка" });
    expect(r.items).toBe(0);
    expect(r.sourceCount).toBe(0);
  });

  test("выброшенные пункты по-прежнему считаются", async () => {
    const r = await ingest({
      title: "С мусором",
      summary: "сводка",
      items: [{ text: "живой" }, { text: "" }, 42, null],
    });
    expect(r.items).toBe(1);
    expect(r.droppedItems).toBe(3);
  });

  test("присланные пункты считаются по сохранённым, а не по отправленным", async () => {
    const id = await seed("Замена набора");
    const again = await ingest({
      title: "Замена набора",
      summary: "правка",
      items: [{ text: "единственный" }],
    });
    expect(getDigest(id)?.items.length).toBe(1);
    expect(again.items).toBe(1);
    expect(again.sourceCount).toBe(1);
  });
});
