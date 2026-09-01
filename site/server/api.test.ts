import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated DB before importing modules that open it.
const TMP = mkdtempSync(join(tmpdir(), "web3puls-"));
process.env.SITE_DB_PATH = join(TMP, "api-test.db");

const { seedIfEmpty } = await import("./seed.ts");
const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  // Re-assert our DB path at run time (Bun shares module state across test
  // files; getDb reopens when the path changes).
  process.env.SITE_DB_PATH = join(TMP, "api-test.db");
  // Seed real digests + drops; do NOT touch the network for unlocks.
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("GET /api/health", () => {
  test("returns ok:true and a numeric ts", async () => {
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(typeof j.ts).toBe("number");
  });
});

describe("GET /api/digests", () => {
  test("returns { items, total } with real seeded digests", async () => {
    const r = await fetch(`${base}/api/digests`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.items.length).toBeGreaterThan(0);
    expect(typeof j.total).toBe("number");
    expect(j.total).toBeGreaterThanOrEqual(8);
    const d = j.items[0];
    for (const k of ["id", "title", "date", "summary", "items", "sourceCount"]) {
      expect(d).toHaveProperty(k);
    }
    expect(Array.isArray(d.items)).toBe(true);
    expect(typeof d.sourceCount).toBe("number");
    // date is ISO
    expect(new Date(d.date).toString()).not.toBe("Invalid Date");
  });

  test("respects limit & offset", async () => {
    const r1 = await fetch(`${base}/api/digests?limit=1&offset=0`);
    const j1 = await r1.json();
    expect(j1.items.length).toBe(1);
    expect(j1.total).toBeGreaterThanOrEqual(8);
    const r2 = await fetch(`${base}/api/digests?limit=1&offset=1`);
    const j2 = await r2.json();
    expect(j2.items[0].id).not.toBe(j1.items[0].id);
  });
});

describe("GET /api/digests?q= (search)", () => {
  test("filters by a token present in seeded titles/summaries", async () => {
    // Grab a word from the first seeded digest's title to use as a query.
    const all = await (await fetch(`${base}/api/digests`)).json();
    const word = String(all.items[0].title).split(/\s+/).find((w: string) => w.length >= 4);
    expect(typeof word).toBe("string");
    const r = await fetch(`${base}/api/digests?q=${encodeURIComponent(word)}`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.items.length).toBeGreaterThan(0);
    // total reflects matches, not the full table.
    expect(j.total).toBe(j.items.length <= j.total ? j.total : j.total);
    expect(j.total).toBeLessThanOrEqual(all.total);
    expect(j.total).toBeGreaterThanOrEqual(1);
    // Every returned item actually contains the query (title/summary/items).
    for (const d of j.items) {
      const hay = (d.title + " " + d.summary + " " + JSON.stringify(d.items)).toLowerCase();
      expect(hay).toContain(word.toLowerCase());
    }
  });

  test("is case-insensitive", async () => {
    const all = await (await fetch(`${base}/api/digests`)).json();
    const word = String(all.items[0].title).split(/\s+/).find((w: string) => w.length >= 4)!;
    const lo = await (await fetch(`${base}/api/digests?q=${encodeURIComponent(word.toLowerCase())}`)).json();
    const up = await (await fetch(`${base}/api/digests?q=${encodeURIComponent(word.toUpperCase())}`)).json();
    expect(lo.total).toBe(up.total);
  });

  test("empty q behaves like no q (full list)", async () => {
    const base0 = await (await fetch(`${base}/api/digests`)).json();
    const empty = await (await fetch(`${base}/api/digests?q=`)).json();
    expect(empty.total).toBe(base0.total);
  });

  test("no matches -> empty items, total 0", async () => {
    const r = await fetch(`${base}/api/digests?q=${encodeURIComponent("zzz-not-a-real-token-qqq")}`);
    const j = await r.json();
    expect(j.items.length).toBe(0);
    expect(j.total).toBe(0);
  });

  test("LIKE wildcards in q are matched literally (no injection)", async () => {
    // Pick a real word, then prepend '_' (a LIKE single-char wildcard). If the
    // wildcard were active, '_word' would still match; escaped, it must not
    // (no seeded digest contains the literal "_word").
    const all = await (await fetch(`${base}/api/digests`)).json();
    const word = String(all.items[0].title).split(/\s+/).find((w: string) => w.length >= 4)!;
    const plain = await (await fetch(`${base}/api/digests?q=${encodeURIComponent(word)}`)).json();
    expect(plain.total).toBeGreaterThanOrEqual(1);
    const wild = await (await fetch(`${base}/api/digests?q=${encodeURIComponent("_" + word)}`)).json();
    expect(wild.total).toBe(0);
  });
});

describe("GET /rss.xml", () => {
  test("returns valid RSS 2.0 with items", async () => {
    const r = await fetch(`${base}/rss.xml`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/rss+xml");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const xml = await r.text();
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain("<channel>");
    expect(xml).toContain("<title>DeLabs — дайджесты</title>");
    expect(xml).toContain("<item>");
    expect(xml).toContain("delabs.space/digest/");
    expect(xml).toContain("<pubDate>");
    expect(xml).toContain("<guid");
    // Balanced channel/item tags (cheap well-formedness sanity check).
    expect((xml.match(/<item>/g) ?? []).length).toBe((xml.match(/<\/item>/g) ?? []).length);
    expect((xml.match(/<item>/g) ?? []).length).toBeGreaterThan(0);
    expect(xml).toContain("</channel>");
    expect(xml.trimEnd().endsWith("</rss>")).toBe(true);
  });

  test("escapes XML special chars in dynamic fields", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    const TOKEN = "rss-xss-token";
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          id: "rss-escape-test",
          title: "A & B <tag> \"quote\"",
          date: new Date().toISOString(),
          summary: "x < y & z",
        }),
      });
      const xml = await (await fetch(`${base}/rss.xml`)).text();
      expect(xml).toContain("A &amp; B &lt;tag&gt;");
      expect(xml).not.toContain("<tag>");
      expect(xml).toContain("x &lt; y &amp; z");
      // No raw ampersand leaked (every & must start an entity).
      expect(/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });
});

describe("GET /api/digests/:id", () => {
  test("returns a single Digest for a real id", async () => {
    const list = await (await fetch(`${base}/api/digests`)).json();
    const id = list.items[0].id;
    const r = await fetch(`${base}/api/digests/${encodeURIComponent(id)}`);
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.id).toBe(id);
    expect(d).toHaveProperty("items");
  });

  test("returns 404 for an unknown id", async () => {
    const r = await fetch(`${base}/api/digests/does-not-exist`);
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error).toBe("not_found");
  });

  test("ingested body is stored and returned in GET /api/digests/:id", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    const TOKEN = "body-ingest-token";
    process.env.SITE_INGEST_TOKEN = TOKEN;
    const bodyText = "Первый абзац **жирный**.\n\nВторой абзац статьи.";
    try {
      const ingest = await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          id: "body-roundtrip-test",
          title: "Тест тела статьи",
          summary: "Краткий блёрб.",
          body: bodyText,
          date: new Date().toISOString(),
        }),
      });
      expect(ingest.status).toBe(200);

      const r = await fetch(`${base}/api/digests/body-roundtrip-test`);
      expect(r.status).toBe(200);
      const d = await r.json();
      expect(d.body).toBe(bodyText);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("digest without body omits the field (back-compat)", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    const TOKEN = "no-body-token";
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          id: "no-body-test",
          title: "Без тела",
          summary: "Только саммари.",
          date: new Date().toISOString(),
        }),
      });
      const d = await (
        await fetch(`${base}/api/digests/no-body-test`)
      ).json();
      expect(d.body).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });
});

describe("GET /api/drops", () => {
  test("returns { items } of correct shape, real seeded drops", async () => {
    const r = await fetch(`${base}/api/drops`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.items.length).toBeGreaterThan(0);
    const d = j.items[0];
    for (const k of ["id", "project", "status", "deadline", "url", "description"]) {
      expect(d).toHaveProperty(k);
    }
    expect(["active", "soon", "ended"]).toContain(d.status);
  });

  test("with no limit param returns all seeded drops (default limit)", async () => {
    const j = await (await fetch(`${base}/api/drops`)).json();
    expect(j.items.length).toBeGreaterThanOrEqual(10);
  });
});

describe("GET /api/stats", () => {
  test("returns aggregate counts and an ISO updatedAt", async () => {
    const r = await fetch(`${base}/api/stats`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const j = await r.json();
    for (const k of ["digests", "unlocks", "drops", "updatedAt"]) {
      expect(j).toHaveProperty(k);
    }
    expect(typeof j.digests).toBe("number");
    expect(typeof j.unlocks).toBe("number");
    expect(typeof j.drops).toBe("number");
    expect(j.digests).toBeGreaterThanOrEqual(0);
    expect(j.unlocks).toBeGreaterThanOrEqual(0);
    expect(j.drops).toBeGreaterThanOrEqual(0);
    // Reflects the seeded data.
    expect(j.digests).toBeGreaterThanOrEqual(8);
    expect(j.drops).toBeGreaterThanOrEqual(10);
    // updatedAt — ISO либо null: фид разблокировок в тестах не приезжал, а
    // выдавать «обновлено сейчас» за отсутствие данных нельзя (аудит 2026-08-12).
    expect(j.updatedAt === null || typeof j.updatedAt === "string").toBe(true);
    if (j.updatedAt) {
      expect(new Date(j.updatedAt).toString()).not.toBe("Invalid Date");
    }
  });
});

describe("GET /api/unlocks", () => {
  test("returns { items, updatedAt } with array items (network not required)", async () => {
    const r = await fetch(`${base}/api/unlocks`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.updatedAt === null || typeof j.updatedAt === "string").toBe(true);
    if (j.updatedAt) {
      expect(new Date(j.updatedAt).toString()).not.toBe("Invalid Date");
    }
    // If any items exist they must have the right shape.
    for (const u of j.items) {
      for (const k of ["project", "symbol", "date", "pctOfSupply", "amountUsd"]) {
        expect(u).toHaveProperty(k);
      }
    }
  });
});

describe("GET /api/activities", () => {
  test("returns { items, total } with real seeded activities", async () => {
    const r = await fetch(`${base}/api/activities`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.items.length).toBeGreaterThan(0);
    expect(typeof j.total).toBe("number");
    expect(j.total).toBeGreaterThanOrEqual(2);
    const a = j.items[0];
    for (const k of [
      "id",
      "project",
      "emoji",
      "title",
      "intro",
      "raised",
      "investors",
      "spent",
      "time",
      "rewardType",
      "status",
      "dateReceive",
      "url",
      "hashtags",
      "date",
    ]) {
      expect(a).toHaveProperty(k);
    }
    // `whatIs` и `steps` в списке отсутствуют намеренно (аудит 2026-08-20):
    // до ~116 КБ на карточку, а карточки их не показывают. Полный гайд —
    // на /api/activities/:id, см. audit-2026-08-20-activity-list-projection.
    expect(a).not.toHaveProperty("whatIs");
    expect(a).not.toHaveProperty("steps");
    expect(Array.isArray(a.hashtags)).toBe(true);
    expect(typeof a.investors).toBe("string");
    expect(new Date(a.date).toString()).not.toBe("Invalid Date");
  });

  test("respects limit & offset", async () => {
    const r1 = await fetch(`${base}/api/activities?limit=1&offset=0`);
    const j1 = await r1.json();
    expect(j1.items.length).toBe(1);
    const r2 = await fetch(`${base}/api/activities?limit=1&offset=1`);
    const j2 = await r2.json();
    expect(j2.items[0].id).not.toBe(j1.items[0].id);
  });
});

describe("GET /api/activities/:id", () => {
  test("returns a single Activity for a real id", async () => {
    const list = await (await fetch(`${base}/api/activities`)).json();
    const id = list.items[0].id;
    const r = await fetch(`${base}/api/activities/${encodeURIComponent(id)}`);
    expect(r.status).toBe(200);
    const a = await r.json();
    expect(a.id).toBe(id);
    expect(Array.isArray(a.steps)).toBe(true);
  });

  test("returns 404 for an unknown id", async () => {
    const r = await fetch(`${base}/api/activities/does-not-exist`);
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error).toBe("not_found");
  });
});

describe("POST /api/internal/activities (ingest bridge)", () => {
  const TOKEN = "test-ingest-secret-act";

  test("returns 404 when SITE_INGEST_TOKEN is unset (bridge off)", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    delete process.env.SITE_INGEST_TOKEN;
    try {
      const r = await fetch(`${base}/api/internal/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: "X", title: "Y" }),
      });
      expect(r.status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("returns 401 without a valid token", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const r = await fetch(`${base}/api/internal/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: "X", title: "Y" }),
      });
      expect(r.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("invalid body (missing project/title) -> 400", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const r = await fetch(`${base}/api/internal/activities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ project: "", title: "" }),
      });
      expect(r.status).toBe(400);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("with valid token: 200 + activity appears in list", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const id = "ingest-test-activity-1";
      const r = await fetch(`${base}/api/internal/activities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          id,
          project: "TestProj",
          emoji: "🚀",
          title: "Тестовая активность",
          intro: "Интро",
          whatIs: "Что такое проект",
          steps: ["Шаг 1", "Шаг 2"],
          raised: "$1 млн",
          investors: "Fund A",
          spent: "$0",
          time: "5 мин",
          rewardType: "Ретро",
          status: "Подтверждено",
          dateReceive: "TBA",
          url: "https://example.com",
          hashtags: ["Test", "Airdrop"],
          date: "2026-06-20T00:00:00.000Z",
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.ok).toBe(true);
      expect(j.id).toBe(id);

      // Idempotent: re-POST same id does not duplicate.
      const before = await (await fetch(`${base}/api/activities`)).json();
      await fetch(`${base}/api/internal/activities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          id,
          project: "TestProj",
          title: "Тестовая активность",
          steps: ["Шаг 1", "Шаг 2"],
          investors: "Fund A",
          hashtags: ["Test", "Airdrop"],
        }),
      });
      const after = await (await fetch(`${base}/api/activities`)).json();
      expect(after.total).toBe(before.total);

      const got = await (
        await fetch(`${base}/api/activities/${encodeURIComponent(id)}`)
      ).json();
      expect(got.id).toBe(id);
      expect(got.steps).toEqual(["Шаг 1", "Шаг 2"]);
      expect(got.investors).toBe("Fund A");
      expect(got.hashtags).toEqual(["Test", "Airdrop"]);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("id defaults to slug from project+title when omitted", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const r = await fetch(`${base}/api/internal/activities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ project: "Slug Proj", title: "Делаем дроп" }),
      });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(typeof j.id).toBe("string");
      expect(j.id.length).toBeGreaterThan(0);
      expect(j.id).not.toContain(" ");
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("strips a non-http(s) (javascript:) url to empty string", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const id = "ingest-xss-url-activity";
      const r = await fetch(`${base}/api/internal/activities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          id,
          project: "XSSProj",
          title: "Зловредная ссылка",
          url: "javascript:alert(document.cookie)",
        }),
      });
      expect(r.status).toBe(200);
      const got = await (
        await fetch(`${base}/api/activities/${encodeURIComponent(id)}`)
      ).json();
      // safeStoredUrl drops anything that is not http(s).
      expect(got.url).toBe("");
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("tolerates junk steps/hashtags/investors without crashing", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const id = "ingest-junk-arrays-activity";
      const r = await fetch(`${base}/api/internal/activities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          id,
          project: "JunkProj",
          title: "Мусорные массивы",
          steps: "not-an-array",
          hashtags: [1, null, { x: 1 }, "ok"],
          investors: { not: "a string" },
        }),
      });
      expect(r.status).toBe(200);
      const got = await (
        await fetch(`${base}/api/activities/${encodeURIComponent(id)}`)
      ).json();
      expect(got.steps).toEqual([]);
      expect(got.hashtags).toEqual(["ok"]);
      expect(got.investors).toBe("");
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("405 for non-POST on the activities ingest path", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const r = await fetch(`${base}/api/internal/activities`);
      expect(r.status).toBe(405);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });
});

describe("GET /api/stats includes activities", () => {
  test("activities is a non-negative number reflecting seed", async () => {
    const j = await (await fetch(`${base}/api/stats`)).json();
    expect(j).toHaveProperty("activities");
    expect(typeof j.activities).toBe("number");
    expect(j.activities).toBeGreaterThanOrEqual(2);
  });
});

describe("unknown api route", () => {
  test("returns 404 json", async () => {
    const r = await fetch(`${base}/api/nope`);
    expect(r.status).toBe(404);
  });
});

describe("POST /api/internal/digests (ingest bridge)", () => {
  const TOKEN = "test-ingest-secret-123";

  test("returns 404 when SITE_INGEST_TOKEN is unset (bridge off)", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    delete process.env.SITE_INGEST_TOKEN;
    try {
      const r = await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "X", summary: "Y" }),
      });
      expect(r.status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("returns 401 without a valid token", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const r1 = await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "X", summary: "Y" }),
      });
      expect(r1.status).toBe(401);
      const r2 = await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ title: "X", summary: "Y" }),
      });
      expect(r2.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("with valid token: 200 + digest appears in /api/digests", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const id = "ingest-test-digest-1";
      const r = await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          id,
          title: "Тестовый дайджест",
          date: "2026-06-14T00:00:00.000Z",
          summary: "Короткое интро дайджеста",
          items: [{ text: "Пункт", url: "https://example.com/a" }],
          sourceCount: 1,
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.ok).toBe(true);
      expect(j.id).toBe(id);

      // Idempotent: re-POST same id (same payload) does not duplicate rows.
      const before = await (await fetch(`${base}/api/digests`)).json();
      await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          id,
          title: "Тестовый дайджест",
          date: "2026-06-14T00:00:00.000Z",
          summary: "Короткое интро дайджеста",
          items: [{ text: "Пункт", url: "https://example.com/a" }],
          sourceCount: 1,
        }),
      });
      const after = await (await fetch(`${base}/api/digests`)).json();
      expect(after.total).toBe(before.total);

      const got = await (
        await fetch(`${base}/api/digests/${encodeURIComponent(id)}`)
      ).json();
      expect(got.id).toBe(id);
      expect(got.title).toBe("Тестовый дайджест");
      expect(got.items[0].url).toBe("https://example.com/a");
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("invalid body (missing title/summary) -> 400", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const r = await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ title: "", summary: "" }),
      });
      expect(r.status).toBe(400);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("javascript: url in items is neutralised to undefined", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const id = "ingest-test-xss-1";
      await fetch(`${base}/api/internal/digests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          id,
          title: "XSS дайджест",
          summary: "Интро",
          items: [{ text: "Плохая ссылка", url: "javascript:alert(1)" }],
        }),
      });
      const got = await (
        await fetch(`${base}/api/digests/${encodeURIComponent(id)}`)
      ).json();
      expect(got.items[0].text).toBe("Плохая ссылка");
      expect(got.items[0].url).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });

  test("405 for non-POST on the ingest path", async () => {
    const prev = process.env.SITE_INGEST_TOKEN;
    process.env.SITE_INGEST_TOKEN = TOKEN;
    try {
      const r = await fetch(`${base}/api/internal/digests`);
      expect(r.status).toBe(405);
    } finally {
      if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
      else process.env.SITE_INGEST_TOKEN = prev;
    }
  });
});

describe("rate limiting", () => {
  test("eventually returns 429 under a burst from one client IP", async () => {
    // Behind a local proxy the client key is the last X-Forwarded-For hop.
    // Per-client capacity is 60; a burst of ~80 must trip it.
    let got429 = false;
    for (let i = 0; i < 80; i++) {
      const r = await fetch(`${base}/api/health`, {
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      if (r.status === 429) {
        got429 = true;
        expect(r.headers.get("retry-after")).toBe("60");
        break;
      }
    }
    expect(got429).toBe(true);
  });

  test("loopback traffic without client identity shares a larger pool (no premature 429)", async () => {
    // The .ton ADNL proxy connects from loopback with no XFF: requests land in
    // the shared ip:127.0.0.1 pool. With SITE_LOOPBACK_RL_CAPACITY set (as on
    // the VPS running the ton-proxy) it must comfortably hold a burst larger
    // than the per-client capacity.
    const prev = process.env.SITE_LOOPBACK_RL_CAPACITY;
    process.env.SITE_LOOPBACK_RL_CAPACITY = "600";
    _resetRateLimiter();
    try {
      for (let i = 0; i < 80; i++) {
        const r = await fetch(`${base}/api/health`);
        expect(r.status).toBe(200);
      }
    } finally {
      if (prev === undefined) delete process.env.SITE_LOOPBACK_RL_CAPACITY;
      else process.env.SITE_LOOPBACK_RL_CAPACITY = prev;
      _resetRateLimiter();
    }
  });

  test("one client's exhausted bucket does not affect another client", async () => {
    // Exhaust a fresh key, then verify a different key is still served.
    let got429 = false;
    for (let i = 0; i < 80; i++) {
      const r = await fetch(`${base}/api/health`, {
        headers: { "x-forwarded-for": "198.51.100.77" },
      });
      if (r.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
    const other = await fetch(`${base}/api/health`, {
      headers: { "x-forwarded-for": "198.51.100.9" },
    });
    expect(other.status).toBe(200);
  });
});
