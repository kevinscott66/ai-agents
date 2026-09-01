/**
 * Аудит 2026-08-29: у ссылок не было потолка длины, а они едут в списках.
 *
 * `INGEST_MAX` существует ровно затем, чтобы «любой баг в агентской петле» не
 * раздул строку в БД: там потолки на id, title, summary, body, число пунктов,
 * текст пункта, шаги, хэштеги, sourceCount. Поля `url` в таблице нет —
 * `safeStoredUrl` проверяет только схему `http(s)://` и отдаёт строку любой
 * длины.
 *
 * Место, где это стреляет, — проекции списков. `DIGEST_CARD_COLUMNS`
 * намеренно не берёт `body` (аудит 2026-08-20: «limit=100 собирал ответ
 * порядка двадцати мегабайт синхронным JSON.stringify»), но `items_json`
 * берёт целиком, а `ACTIVITY_CARD_COLUMNS` берёт `url`. То есть та самая
 * амплификация осталась открытой через колонку без потолка: сто пунктов с
 * длинными url — до мегабайта в одной строке, и `GET /api/digests?limit=100`
 * снова собирает десятки мегабайт на анонимной ручке.
 *
 * Лечим потолком, но не резом. Обрезанная ссылка — это НЕВЕРНАЯ ссылка,
 * которая всё равно отрисуется как кликабельная; обрезанный текст остаётся
 * читаемым текстом. Поэтому слишком длинный url не сохраняется вовсе, а поле
 * попадает в `ignoredFields` — тем же способом, каким этот обработчик уже
 * сообщает про непонятые поля.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-url-cap-"));
process.env.SITE_DB_PATH = join(TMP, "urlcap.db");
process.env.SITE_INGEST_TOKEN = "url-cap-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

type Json = Record<string, any>;

async function post(path: string, body: unknown, status = 200): Promise<Json> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer url-cap-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(status);
  return (await r.json()) as Json;
}

async function get(path: string): Promise<Json> {
  const r = await fetch(`${base}${path}`);
  expect(r.status).toBe(200);
  return (await r.json()) as Json;
}

/** Ссылка заведомо длиннее любого разумного потолка, но синтаксически валидная. */
const HUGE_URL = `https://delabs.space/x?q=${"a".repeat(5_000)}`;
const OK_URL = "https://delabs.space/guide";

describe("дайджест: длинная ссылка пункта не сохраняется", () => {
  test("пункт остаётся, ссылки нет, поле названо в ответе", async () => {
    const res = await post("/api/internal/digests", {
      id: "url-cap-digest",
      title: "Дайджест со ссылкой",
      summary: "Сводка",
      items: [{ text: "Пункт с гигантской ссылкой", url: HUGE_URL }],
    });
    expect(res.ok).toBe(true);
    expect(res.ignoredFields).toContain("item.url");

    const page = await get("/api/digests/url-cap-digest");
    expect(page.items).toHaveLength(1);
    expect(page.items[0].text).toBe("Пункт с гигантской ссылкой");
    expect(page.items[0].url).toBeUndefined();
  });

  test("нормальная ссылка сохраняется как раньше", async () => {
    const res = await post("/api/internal/digests", {
      id: "url-ok-digest",
      title: "Дайджест с нормальной ссылкой",
      summary: "Сводка",
      items: [{ text: "Пункт", url: OK_URL }],
    });
    expect(res.ignoredFields).toBeUndefined();

    const page = await get("/api/digests/url-ok-digest");
    expect(page.items[0].url).toBe(OK_URL);
  });

  test("в списке карточек гигантской ссылки нет", async () => {
    const list = await get("/api/digests?limit=100");
    expect(JSON.stringify(list)).not.toContain("a".repeat(5_000));
  });
});

describe("активность: длинная ссылка не сохраняется", () => {
  test("поле названо в ответе, сохранённое не тронуто", async () => {
    await post("/api/internal/activities", {
      id: "url-cap-activity",
      project: "DeLabs",
      title: "Активность",
      short: "Коротко",
      url: OK_URL,
    });
    const before = await get("/api/activities/url-cap-activity");
    expect(before.url).toBe(OK_URL);

    const res = await post("/api/internal/activities", {
      id: "url-cap-activity",
      project: "DeLabs",
      title: "Активность",
      short: "Коротко",
      url: HUGE_URL,
    });
    expect(res.ignoredFields).toContain("url");

    const after = await get("/api/activities/url-cap-activity");
    // «Не смогли прочитать» = «не трогаем сохранённое», как у остальных полей.
    expect(after.url).toBe(OK_URL);
  });

  test("в списке активностей гигантской ссылки нет", async () => {
    const list = await get("/api/activities?limit=100");
    expect(JSON.stringify(list)).not.toContain("a".repeat(5_000));
  });
});
