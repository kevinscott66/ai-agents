import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-db-"));
process.env.SITE_DB_PATH = join(TMP, "db-test.db");

const db = await import("./db.ts");

describe("db layer", () => {
  beforeAll(() => {
    process.env.SITE_DB_PATH = join(TMP, "db-test.db");
    db.upsertDigest({
      id: "d1",
      title: "T1",
      date: "2026-06-12T00:00:00.000Z",
      summary: "s1",
      items: [{ text: "a", url: "https://x" }],
      sourceCount: 1,
    });
    db.upsertDigest({
      id: "d2",
      title: "T2",
      date: "2026-06-11T00:00:00.000Z",
      summary: "s2",
      items: [],
      sourceCount: 0,
    });
    db.upsertDrop({
      id: "drop1",
      project: "P",
      status: "active",
      deadline: null,
      url: "https://p",
      description: "d",
    });
  });

  test("digests round-trip with parsed items + ordered by date desc", () => {
    expect(db.countDigests()).toBe(2);
    const list = db.listDigests(10, 0);
    expect(list[0].id).toBe("d1"); // newer date first
    expect(list[0].items[0].text).toBe("a");
    expect(db.getDigest("d2")?.items).toEqual([]);
    expect(db.getDigest("missing")).toBeNull();
  });

  test("upsert overwrites by id", () => {
    db.upsertDigest({
      id: "d1",
      title: "T1b",
      date: "2026-06-12T00:00:00.000Z",
      summary: "s1b",
      items: [],
      sourceCount: 5,
    });
    expect(db.countDigests()).toBe(2);
    expect(db.getDigest("d1")?.sourceCount).toBe(5);
  });

  test("upcoming unlocks excludes past dates and sorts ascending", () => {
    const past = "2000-01-01T00:00:00.000Z";
    const future1 = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const future2 = new Date(Date.now() + 2 * 86_400_000).toISOString();
    db.upsertUnlocks([
      { project: "Old", symbol: "OLD", date: past, pctOfSupply: 1, amountUsd: null },
      { project: "F1", symbol: "F1", date: future1, pctOfSupply: 2, amountUsd: 100 },
      { project: "F2", symbol: "F2", date: future2, pctOfSupply: 3, amountUsd: null },
    ]);
    const up = db.listUpcomingUnlocks(10);
    expect(up.map((u) => u.project)).toEqual(["F2", "F1"]);
  });

  test("drops list orders active before soon/ended", () => {
    db.upsertDrop({
      id: "drop2",
      project: "Q",
      status: "ended",
      deadline: null,
      url: "https://q",
      description: "d",
    });
    const drops = db.listDrops(10);
    expect(drops[0].status).toBe("active");
  });

  test("safeStoredUrl allows only http(s), strips everything else", () => {
    expect(db.safeStoredUrl("https://x.io")).toBe("https://x.io");
    expect(db.safeStoredUrl("  http://x.io ")).toBe("http://x.io");
    expect(db.safeStoredUrl("HTTPS://x.io")).toBe("HTTPS://x.io");
    expect(db.safeStoredUrl("javascript:alert(1)")).toBe("");
    expect(db.safeStoredUrl("data:text/html,x")).toBe("");
    expect(db.safeStoredUrl("//evil.com")).toBe("");
    expect(db.safeStoredUrl(123 as unknown)).toBe("");
  });

  test("upsertDigest strips javascript: urls from items on write", () => {
    db.upsertDigest({
      id: "dx",
      title: "X",
      date: "2026-06-12T00:00:00.000Z",
      summary: "s",
      items: [
        { text: "ok", url: "https://good.io" },
        { text: "bad", url: "javascript:alert(1)" },
      ],
      sourceCount: 0,
    });
    const got = db.getDigest("dx")!;
    expect(got.items[0].url).toBe("https://good.io");
    expect(got.items[1].url).toBe(""); // sanitised to empty
  });

  test("upsertDrop sanitises a non-http url to empty", () => {
    db.upsertDrop({
      id: "dropx",
      project: "Z",
      status: "active",
      deadline: null,
      url: "javascript:alert(1)",
      description: "d",
    });
    expect(db.listDrops(20).find((x) => x.id === "dropx")?.url).toBe("");
  });
});
