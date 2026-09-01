/**
 * Аудит 2026-08-29: два реза по единицам UTF-16 пережили общую починку.
 *
 * `clipSlug` перевели на посимвольный `Array.from`, `clip` — на проверку
 * хвоста, XML-путь чистит через XML_FORBIDDEN, а комментарий у
 * `metaDescription` объявил свой рез «третьим и последним в файле». Осталось
 * два, оба вне тех правок:
 *
 *  1. `index.ts`, `/api/digests?q=` — `(…).trim().slice(0, 120)`. Граница на
 *     120-й единице приходится на середину суррогатной пары, и в `LIKE` едет
 *     одинокий суррогат. Через bun:sqlite он превращается в U+FFFD, то есть в
 *     символ, которого в сохранённом тексте нет: вместо совпадений по
 *     обрезанному префиксу поиск молча отдаёт ноль строк.
 *  2. `unlocks.ts`, `symbolFromName` — `w[0]` и `slice(0, 10)`. Имя проекта,
 *     начинающееся с не-BMP символа, давало в тикере одинокий суррогат; в
 *     UTF-8 он не кодируется и доезжает до читателя как U+FFFD.
 *
 * Инвариант тот же, что и у починенных мест: наружу не уходит строка, которая
 * не переживает round-trip через UTF-8.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-surrogate-cuts-"));
process.env.SITE_DB_PATH = join(TMP, "cuts.db");
process.env.SITE_INGEST_TOKEN = "surrogate-cuts-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const { parseEmissions } = await import("./unlocks.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

/** U+20000 — две единицы UTF-16. */
const ASTRAL = "𠀀";

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

/** Строка переживает round-trip через UTF-8 только без одиноких суррогатов. */
function healthy(s: string): void {
  expect(Buffer.from(s, "utf8").toString("utf8")).toBe(s);
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer surrogate-cuts-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

/** 119 букв + пара: срез на 120-й единице бьёт ровно по паре. */
const NEEDLE = `${"q".repeat(119)}${ASTRAL}`;
const SEARCH_TITLE = `${NEEDLE} хвост`;

describe("предпосылки", () => {
  test("голый рез на 120 оставляет одинокий суррогат", () => {
    expect(NEEDLE.length).toBe(121);
    const naive = NEEDLE.slice(0, 120);
    const tail = naive.charCodeAt(naive.length - 1);
    expect(tail).toBeGreaterThanOrEqual(0xd800);
    expect(tail).toBeLessThanOrEqual(0xdbff);
    expect(Buffer.from(naive, "utf8").toString("utf8")).not.toBe(naive);
  });
});

describe("поиск по дайджестам: длинный запрос с эмодзи находит", () => {
  test("запрос длиной 121 единицу возвращает совпадение", async () => {
    await post("/api/internal/digests", {
      title: SEARCH_TITLE,
      summary: "аннотация",
      items: [{ text: "источник" }],
    });
    const r = await fetch(
      `${base}/api/digests?q=${encodeURIComponent(NEEDLE)}&limit=10`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { title: string }[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.some((d) => d.title === SEARCH_TITLE)).toBe(true);
  });

  test("короткий запрос по-прежнему находит — потолок не сдвинулся", async () => {
    await post("/api/internal/digests", {
      title: `${SEARCH_TITLE} второй`,
      summary: "аннотация",
      items: [{ text: "источник" }],
    });
    const r = await fetch(`${base}/api/digests?q=${encodeURIComponent("qqqq")}`);
    const body = (await r.json()) as { total: number };
    expect(body.total).toBeGreaterThan(0);
  });

  test("запрос длиннее потолка всё ещё режется", async () => {
    // 400 BMP-букв: рез обязан остаться резом, иначе LIKE снова получает
    // километровый паттерн, ради чего потолок и заводили.
    const r = await fetch(
      `${base}/api/digests?q=${encodeURIComponent("z".repeat(400))}`,
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { total: number }).total).toBe(0);
  });
});

describe("тикер из имени проекта", () => {
  const nowMs = 1_700_000_000_000;
  const ts = Math.floor(nowMs / 1000) + 7 * 24 * 3600;

  function tickerFor(name: string): string {
    const out = parseEmissions(
      {
        data: [
          {
            name,
            maxSupply: 1_000_000,
            events: [{ timestamp: ts, noOfTokens: [1_000] }],
          },
        ],
      },
      nowMs,
    );
    expect(out.length).toBe(1);
    return out[0]!.symbol;
  }

  test("инициалы не рвут суррогатную пару", () => {
    const sym = tickerFor(`${ASTRAL}alpha beta`);
    healthy(sym);
    expect(Array.from(sym).length).toBe(2);
  });

  test("одно слово из не-BMP символов режется по кодовым точкам", () => {
    const sym = tickerFor(ASTRAL.repeat(12));
    healthy(sym);
    expect(Array.from(sym).length).toBe(10);
  });

  test("обычное имя не изменилось", () => {
    expect(tickerFor("Ethereum Name Service")).toBe("ENS");
    expect(tickerFor("Hyperliquid")).toBe("HYPERLIQUI");
  });
});
