/**
 * Аудит 2026-08-28: слаг резался посреди суррогатной пары.
 *
 * `slugFromTitle` ограничивал основу `.slice(0, 80)`, а `slugFromProjectTitle`
 * — `.slice(0, 90)`. Обе — резы по единицам UTF-16. Символы вне BMP (CJK
 * Extension B, математические литеры, Osage) занимают ДВЕ единицы и проходят
 * фильтр `[^\p{L}\p{N}]` как буквы: если граница попадала между единицами,
 * в конце слага оставался одинокий суррогат.
 *
 * Последствия ровно два, и оба видимые:
 *   1. Строка перестаёт быть валидным UTF-8. SQLite хранит её как U+FFFD, то
 *      есть id в БД и id в ответе — РАЗНЫЕ: `GET /api/digests/<id>` отдаёт 404,
 *      хотя сама статья лежит в списке, в rss.xml и в sitemap.xml.
 *   2. `encodeURIComponent` на одиноком суррогате бросает URIError — клиент не
 *      может даже собрать ссылку на только что созданную страницу.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-slug-surrogate-"));
process.env.SITE_DB_PATH = join(TMP, "slug.db");
process.env.SITE_INGEST_TOKEN = "slug-surrogate-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

// U+20000 — буква (\p{L}) и две единицы UTF-16. Ведущая «a» сдвигает границу
// так, что рез на 80/90 приходится ровно между единицами пары.
const ASTRAL = "𠀀";
const LONG_TITLE = `a${ASTRAL.repeat(60)}`;

function healthy(id: string): void {
  expect(Buffer.from(id, "utf8").toString("utf8")).toBe(id);
  expect(() => encodeURIComponent(id)).not.toThrow();
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer slug-surrogate-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

describe("дайджест", () => {
  test("id остаётся валидным UTF-8 и адресуемым", async () => {
    const res = await post("/api/internal/digests", {
      title: LONG_TITLE,
      summary: "аннотация",
      items: [{ text: "источник" }],
    });
    const id = res.id as string;
    healthy(id);
    const got = await fetch(`${base}/api/digests/${encodeURIComponent(id)}`);
    expect(got.status).toBe(200);
  });

  test("рез по-прежнему ограничивает длину", async () => {
    const res = await post("/api/internal/digests", {
      title: `b${"я".repeat(400)}`,
      summary: "аннотация",
      items: [],
    });
    const id = res.id as string;
    // Дата (10) + дефис + не более 80 символов основы.
    expect(Array.from(id).length).toBeLessThanOrEqual(91);
    healthy(id);
  });
});

describe("активность", () => {
  test("id остаётся валидным UTF-8 и адресуемым", async () => {
    const res = await post("/api/internal/activities", {
      project: "ab",
      title: `${ASTRAL.repeat(60)}`,
      steps: ["шаг"],
    });
    const id = res.id as string;
    healthy(id);
    const got = await fetch(`${base}/api/activities/${encodeURIComponent(id)}`);
    expect(got.status).toBe(200);
  });

  test("рез по-прежнему ограничивает длину", async () => {
    const res = await post("/api/internal/activities", {
      project: "Проект",
      title: "ц".repeat(400),
      steps: [],
    });
    expect(Array.from(res.id as string).length).toBeLessThanOrEqual(90);
    healthy(res.id as string);
  });
});

describe("обычные заголовки не изменились", () => {
  test("латиница и кириллица дают прежний слаг", async () => {
    const res = await post("/api/internal/digests", {
      title: "Эфир обновил максимум",
      summary: "аннотация",
      items: [],
    });
    expect(res.id as string).toMatch(/^\d{4}-\d{2}-\d{2}-эфир-обновил-максимум$/u);
  });

  test("активность: проект и заголовок склеиваются как прежде", async () => {
    const res = await post("/api/internal/activities", {
      project: "Scroll",
      title: "Гайд по тестнету",
      steps: [],
    });
    expect(res.id).toBe("scroll-гайд-по-тестнету");
  });
});
