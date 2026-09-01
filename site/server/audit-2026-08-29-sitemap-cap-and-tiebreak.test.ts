/**
 * Аудит 2026-08-29: две молчаливые недоговорённости рядом с картой сайта.
 *
 *  1. `buildSitemapXml` читает `listSitemapEntries(20_000)` под комментарием
 *     «упереться в него молча нельзя» — и ровно молча в него и упирался.
 *     Выборку режет `LIMIT`, счётчика нет, предупреждения нет: страницы просто
 *     перестали бы попадать в карту, а узнали бы мы об этом по падению
 *     индексации через недели.
 *
 *  2. `findLatestDigestByTitle` — `ORDER BY date DESC LIMIT 1` без второго
 *     ключа. Заголовок не уникален, дата у правки того же дня совпадает, и
 *     какой из дублей победит, решает план запроса. А победитель уезжает в
 *     `reusableDigestId`, то есть определяет, какую опубликованную страницу
 *     перезапишет повторная присылка. DELETE-роута у дайджестов нет — неверный
 *     выбор не отменяется ничем.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-sitemap-tie-"));
process.env.SITE_DB_PATH = join(TMP, "sitemap-tie.db");
process.env.SITE_INGEST_TOKEN = "sitemap-tie-token";

const { makeFetchHandler, _resetRateLimiter, buildSitemapXml, SITEMAP_MAX_PER_TABLE } =
  await import("./index.ts");
const { findLatestDigestByTitle } = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sitemap-tie-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

/** Собрать карту с заданным потолком, вернув XML и все строки warn. */
function sitemapWithLimit(limit: number): { xml: string; warns: unknown[][] } {
  const warns: unknown[][] = [];
  const spy = spyOn(console, "warn");
  spy.mockImplementation(((...a: unknown[]) => {
    warns.push(a);
  }) as never);
  try {
    return { xml: buildSitemapXml(limit), warns };
  } finally {
    spy.mockRestore();
  }
}

describe("потолок карты сайта называется вслух", () => {
  beforeAll(async () => {
    for (const n of ["карта один", "карта два", "карта три"]) {
      await post("/api/internal/digests", {
        title: n,
        summary: "аннотация",
        items: [{ text: "источник" }],
      });
    }
  });

  test("упёрлись — предупреждение с таблицей и потолком", () => {
    const { xml, warns } = sitemapWithLimit(2);
    // Карта всё равно отдаётся: насыщение — состояние, а не ошибка.
    expect(xml).toContain("<urlset");
    const hit = warns.find((a) => String(a[0]).startsWith("[sitemap]"));
    expect(hit).toBeDefined();
    expect(hit![1]).toMatchObject({ limit: 2, tables: ["digests"] });
  });

  test("не упёрлись — тишина", () => {
    const { warns } = sitemapWithLimit(1_000);
    expect(warns.filter((a) => String(a[0]).startsWith("[sitemap]"))).toEqual([]);
  });

  test("потолок по умолчанию — прежние 20 000", () => {
    expect(SITEMAP_MAX_PER_TABLE).toBe(20_000);
  });
});

describe("дубли заголовка разрешаются полным порядком", () => {
  const TITLE = "одинаковый заголовок для тай-брейка";
  const DATE = "2026-03-04";

  test("побеждает больший id, а не порядок вставки", async () => {
    // Вставляем по возрастанию id: без тай-брейка выборка возвращает первую
    // строку скана, то есть меньший id — не «самый свежий» ни по какому
    // осмысленному признаку.
    await post("/api/internal/digests", {
      id: "aaa-tie",
      title: TITLE,
      summary: "аннотация",
      date: DATE,
    });
    await post("/api/internal/digests", {
      id: "zzz-tie",
      title: TITLE,
      summary: "аннотация",
      date: DATE,
    });
    expect(findLatestDigestByTitle(TITLE)?.id).toBe("zzz-tie");
  });

  test("выбор не зависит от порядка вызова", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      seen.add(findLatestDigestByTitle(TITLE)?.id ?? "нет");
    }
    expect([...seen]).toEqual(["zzz-tie"]);
  });

  test("более свежая дата всё ещё главнее id", async () => {
    await post("/api/internal/digests", {
      id: "bbb-tie",
      title: TITLE,
      summary: "аннотация",
      date: "2026-03-05",
    });
    expect(findLatestDigestByTitle(TITLE)?.id).toBe("bbb-tie");
  });
});
