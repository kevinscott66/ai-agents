/**
 * Аудит 2026-08-28: ингест дайджестов молчал о полях, которые не понял.
 *
 * Ингест активностей строкой ниже с этого же аудита собирает `ignoredFields`:
 * поле неверного типа не трогает сохранённое, но попадает в лог и в ответ.
 * У дайджестов та же ветка осталась немой — `items` не-массив, `body`
 * не-строка и `sourceCount` не-число сводились к «не прислали» без единого
 * следа, и ответ был неотличим от успешного полного обновления.
 *
 * Направление безопасное (данные сохраняются), поэтому это не потеря, а
 * немота: отправитель с опечаткой в типе видит `ok:true` и считает, что
 * опубликовал тело статьи, хотя на странице осталось прежнее.
 *
 * Отдельно — `id`. Оба обработчика читают его как
 * `typeof b.id === "string" ? … : ""`, то есть НЕстроковый id (число из
 * сериализатора, объект) не 400 и не «взяли как есть», а «id не прислали»:
 * заводится свежий слаг и появляется вторая страница. У активностей в слаге
 * нет даже даты, а DELETE-маршрута нет ни у тех, ни у других.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-ingest-ignored-"));
process.env.SITE_DB_PATH = join(TMP, "ignored.db");
process.env.SITE_INGEST_TOKEN = "ingest-ignored-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

type Json = Record<string, unknown>;

async function post(path: string, body: unknown, status = 200): Promise<Json> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer ingest-ignored-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(status);
  return (await r.json()) as Json;
}

const digest = (extra: Json): Json => ({
  title: "Дайджест про типы",
  summary: "Сводка",
  ...extra,
});

const activity = (extra: Json): Json => ({
  project: "TypeProbe",
  title: "Гайд про типы",
  ...extra,
});

function ignored(res: Json): string[] {
  return (res.ignoredFields as string[] | undefined) ?? [];
}

describe("предпосылки: непонятое поле не стирает сохранённое", () => {
  test("items не-массив оставляет пункты на месте", async () => {
    const id = "probe-items";
    await post("/api/internal/digests", digest({ id, items: [{ text: "раз" }] }));
    const res = await post("/api/internal/digests", digest({ id, items: "раз, два" }));
    expect(res.items).toBe(1);
  });

  test("body не-строка оставляет текст на месте", async () => {
    const id = "probe-body";
    await post("/api/internal/digests", digest({ id, body: "полный текст" }));
    await post("/api/internal/digests", digest({ id, body: null }));
    const page = (await (await fetch(`${base}/api/digests/${id}`)).json()) as Json;
    expect(page.body).toBe("полный текст");
  });
});

describe("дайджест называет поля, которые не смог прочитать", () => {
  test("items не-массив", async () => {
    const res = await post("/api/internal/digests", digest({ id: "ign-items", items: "раз" }));
    expect(ignored(res)).toEqual(["items"]);
  });

  test("body не-строка", async () => {
    const res = await post("/api/internal/digests", digest({ id: "ign-body", body: 42 }));
    expect(ignored(res)).toEqual(["body"]);
  });

  test("sourceCount не-число и не-конечное", async () => {
    const a = await post("/api/internal/digests", digest({ id: "ign-sc-a", sourceCount: "12" }));
    expect(ignored(a)).toEqual(["sourceCount"]);
    // JSON не умеет NaN/Infinity, но `null` из сериализатора — умеет.
    const b = await post("/api/internal/digests", digest({ id: "ign-sc-b", sourceCount: null }));
    expect(ignored(b)).toEqual(["sourceCount"]);
  });

  test("id не-строка: страница всё равно создаётся, но об этом сказано", async () => {
    const res = await post("/api/internal/digests", digest({ id: 42 }));
    expect(ignored(res)).toEqual(["id"]);
    // Поведение прежнее: свежий слаг, а не 400 и не подмена чужой страницы.
    expect(typeof res.id).toBe("string");
    expect(res.id).not.toBe("42");
  });

  test("несколько полей сразу перечисляются все", async () => {
    const res = await post(
      "/api/internal/digests",
      digest({ id: "ign-many", items: 1, body: [], sourceCount: {} }),
    );
    expect(ignored(res).sort()).toEqual(["body", "items", "sourceCount"]);
  });

  test("корректный вход не добавляет поля в ответ", async () => {
    const res = await post(
      "/api/internal/digests",
      digest({ id: "ign-clean", items: [{ text: "раз" }], body: "текст", sourceCount: 3 }),
    );
    expect(res).not.toHaveProperty("ignoredFields");
    expect(res.items).toBe(1);
    expect(res.sourceCount).toBe(3);
  });

  test("отсутствие полей — не повод их называть", async () => {
    const res = await post("/api/internal/digests", digest({ id: "ign-absent" }));
    expect(res).not.toHaveProperty("ignoredFields");
  });
});

describe("активность: id читается тем же правилом, что и остальные поля", () => {
  test("id не-строка попадает в ignoredFields", async () => {
    const res = await post("/api/internal/activities", activity({ id: 7 }));
    expect(ignored(res)).toContain("id");
    expect(typeof res.id).toBe("string");
    expect(res.id).not.toBe("7");
  });

  test("строковый id полей в ответ не добавляет", async () => {
    const res = await post("/api/internal/activities", activity({ id: "act-clean" }));
    expect(res.id).toBe("act-clean");
    expect(res).not.toHaveProperty("ignoredFields");
  });
});
