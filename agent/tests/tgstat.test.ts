/**
 * T-718: TGStat клиент — parseChannelId + shapeChannelStats (чистые, без сети).
 */
import { describe, test, expect } from "bun:test";
import { parseChannelId, shapeChannelStats } from "../lib/tgstat.ts";

describe("parseChannelId", () => {
  test("@username", () => expect(parseChannelId("@delabsru")).toBe("@delabsru"));
  test("bare username", () => expect(parseChannelId("delabsru")).toBe("@delabsru"));
  test("t.me link", () =>
    expect(parseChannelId("https://t.me/delabsru")).toBe("@delabsru"));
  test("мусор → null", () => {
    expect(parseChannelId("a b c")).toBeNull();
    expect(parseChannelId("")).toBeNull();
    expect(parseChannelId("@x")).toBeNull(); // слишком коротко
  });
});

describe("shapeChannelStats", () => {
  test("маппит реальный TGStat-ответ (@delabsru)", () => {
    const resp = {
      title: "DeLabs | Degens Drop Hub",
      username: "@delabsru",
      participants_count: 6848,
      avg_post_reach: 143,
      daily_reach: 326,
      er_percent: 14.2,
      err24_percent: 0.8,
      posts_count: 1838,
      mentions_count: 1204,
      forwards_count: 342,
      ci_index: 10.8266,
    };
    const s = shapeChannelStats(resp);
    expect(s.title).toBe("DeLabs | Degens Drop Hub");
    expect(s.participants).toBe(6848);
    expect(s.erPercent).toBe(14.2);
    expect(s.postsCount).toBe(1838);
    expect(s.ciIndex).toBeCloseTo(10.83, 1);
  });

  test("отсутствующие поля → 0/undefined, не падает", () => {
    const s = shapeChannelStats({});
    expect(s.participants).toBe(0);
    expect(s.title).toBeUndefined();
  });
});
