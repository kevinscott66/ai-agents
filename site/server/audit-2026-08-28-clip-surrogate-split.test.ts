/**
 * Аудит 2026-08-28: `clipSlug` починили, а `clip` рядом остался прежним.
 *
 * Тем же аудитом слагостроители перевели на рез по символам — потому что рез
 * по единицам UTF-16 оставлял в хвосте одинокий суррогат. Общий `clip`, через
 * который проходят title, summary, body, тексты источников, шаги и хэштеги,
 * правку не получил: `v.slice(0, max)` резал ровно так же.
 *
 * Тихой эту порчу делает то, что SQLite сохраняет невалидный UTF-16 как
 * U+FFFD. То есть в ответе одно, в базе другое — и `existing.title !== title`
 * в предикате `taken` ВСЕГДА истинно, хотя присылают тот же самый материал.
 *
 * Больнее всего активностям: их слаг (`slugFromProjectTitle`) не содержит
 * даты и не имеет обходного пути вроде `reusableDigestId`. Повторная присылка
 * того же гайда — обычный путь обновления — вместо правки заводит `-2`, потом
 * `-3`, и так до `-50` и `-${Date.now()}`. Каждый дубль уходит в
 * `/api/activities` и в `sitemap.xml`, а DELETE-роута у сайта нет: убрать их
 * нечем.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-clip-surrogate-"));
process.env.SITE_DB_PATH = join(TMP, "clip.db");
process.env.SITE_INGEST_TOKEN = "clip-surrogate-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

/** U+20000 — две единицы UTF-16. 299 + пара = 301, рез на 300 бьёт по паре. */
const ASTRAL = "𠀀";
const SPLIT_TITLE = `${"a".repeat(299)}${ASTRAL}`;

/** Строка переживает round-trip через UTF-8 только без одиноких суррогатов. */
function healthy(s: string): void {
  expect(Buffer.from(s, "utf8").toString("utf8")).toBe(s);
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer clip-surrogate-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

describe("предпосылки", () => {
  test("рез по единицам UTF-16 действительно оставляет одинокий суррогат", () => {
    expect(SPLIT_TITLE.length).toBe(301);
    const naive = SPLIT_TITLE.slice(0, 300);
    const tail = naive.charCodeAt(naive.length - 1);
    expect(tail).toBeGreaterThanOrEqual(0xd800);
    expect(tail).toBeLessThanOrEqual(0xdbff);
    // Ровно то, из-за чего база и ответ расходятся.
    expect(Buffer.from(naive, "utf8").toString("utf8")).not.toBe(naive);
  });
});

describe("активность: повторная присылка правит, а не плодит", () => {
  const body = {
    project: "clipproj",
    title: SPLIT_TITLE,
    summary: "аннотация",
    steps: ["шаг"],
  };

  test("тот же гайд дважды — тот же id", async () => {
    const first = (await post("/api/internal/activities", body)).id as string;
    const second = (await post("/api/internal/activities", body)).id as string;
    const third = (await post("/api/internal/activities", body)).id as string;
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("сохранённый заголовок — валидный UTF-8 и совпадает с обрезкой", async () => {
    const id = (await post("/api/internal/activities", body)).id as string;
    const got = await fetch(`${base}/api/activities/${encodeURIComponent(id)}`);
    expect(got.status).toBe(200);
    const stored = ((await got.json()) as { title: string }).title;
    healthy(stored);
    expect(stored).toBe(SPLIT_TITLE.slice(0, 299));
  });
});

describe("дайджест: заголовок доезжает целым", () => {
  test("сохранённый заголовок — валидный UTF-8", async () => {
    const res = await post("/api/internal/digests", {
      title: SPLIT_TITLE,
      summary: "аннотация",
      items: [{ text: "источник" }],
    });
    const got = await fetch(
      `${base}/api/digests/${encodeURIComponent(res.id as string)}`,
    );
    expect(got.status).toBe(200);
    const stored = ((await got.json()) as { title: string }).title;
    healthy(stored);
    expect(stored).toBe(SPLIT_TITLE.slice(0, 299));
  });
});

describe("потолок остался потолком", () => {
  test("длинный BMP-заголовок режется ровно по 300 и не короче", async () => {
    const title = "я".repeat(400);
    const res = await post("/api/internal/activities", {
      project: "clipbmp",
      title,
      steps: [],
    });
    const got = await fetch(
      `${base}/api/activities/${encodeURIComponent(res.id as string)}`,
    );
    const stored = ((await got.json()) as { title: string }).title;
    expect(stored.length).toBe(300);
  });

  test("обрезка не удлиняет строку сверх потолка", async () => {
    // Рез по символам (Array.from) дал бы до 600 единиц — потолок сторожит
    // размер того, что уедет в БД, поэтому граница считается в единицах.
    const title = ASTRAL.repeat(400);
    const res = await post("/api/internal/activities", {
      project: "clipastral",
      title,
      steps: [],
    });
    const got = await fetch(
      `${base}/api/activities/${encodeURIComponent(res.id as string)}`,
    );
    const stored = ((await got.json()) as { title: string }).title;
    expect(stored.length).toBeLessThanOrEqual(300);
    healthy(stored);
  });

  test("короткая строка не трогается вовсе", async () => {
    const res = await post("/api/internal/activities", {
      project: "clipshort",
      title: `Гайд ${ASTRAL} про мосты`,
      steps: [],
    });
    const got = await fetch(
      `${base}/api/activities/${encodeURIComponent(res.id as string)}`,
    );
    const stored = ((await got.json()) as { title: string }).title;
    expect(stored).toBe(`Гайд ${ASTRAL} про мосты`);
  });
});
