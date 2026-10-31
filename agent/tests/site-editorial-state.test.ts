import { describe, expect, test } from "bun:test";
import { activityReviewReceipt } from "../lib/activity-review.mjs";
import {
  activityCopy, digestCopy, digestNeedsReview, pickPending, withJournalEditorial,
  type EditorialEntry, type EditorialFile, type RawActivity, type RawDigest,
} from "../lib/site-editorial-state.ts";
import * as state from "../lib/site-editorial-state.ts";
import * as tool from "../tools/site-editorial.ts";
const { checkPublication } = tool;

const now = Date.parse("2026-10-30T12:00:00Z");
const entry: EditorialEntry = {
  title: "Fixture открыл приём заявок на тестирование приложения",
  summary: "Условия регистрации и сроки тестирования опубликованы в официальном анонсе проекта. Участники подают заявку на сайте.",
  body: "Подтверждённый факт с полезными условиями участия. ".repeat(14).trim(),
  items: [{ text: "Анонс", url: "https://example.com/announcement?id=1" }],
  editorialVersion: 3,
  reviewAfter: new Date(now + 86400000).toISOString(),
};
const digest = (id: string, date: string, over: Partial<RawDigest> = {}): RawDigest => ({
  id, date, origin: "telegram", title: "Fixture: Открыта регистрация", items: entry.items, ...over,
});

describe("editorial state compatibility", () => {
  test("the tool preserves its existing pure exports for daily-draft and other callers", () => {
    for (const name of Object.keys(state) as (keyof typeof state)[]) expect(tool[name]).toBe(state[name]);
  });

  test("mixed origins, human protection, cooldowns and backlog retain the same ordered selection", () => {
    const rows = [
      digest("oldest", "2020-01-01", { origin: "saved" }),
      digest("tie-z", "2026-10-25"), digest("tie-a", "2026-10-25"),
      digest("newest", "2026-10-30"), digest("protected", "2026-10-29"),
      digest("title-only", "2026-10-28", { origin: "api", title: entry.title, body: entry.body }),
      digest("blocked", "2026-10-27"), digest("blank-manual", "2026-10-26"),
      digest("complete-saved", "2026-10-30", { origin: "saved", title: entry.title, body: entry.body }),
      digest("fresh-auto", "2026-10-30"), digest("archive-auto", "2020-01-01"),
      digest("unknown-origin", "2026-10-30", { origin: "other" }),
    ];
    const manual: EditorialFile = { digests: {
      protected: { title: "Ручная редактура", body: "Защищённый ручной текст" },
      "title-only": { title: "Ручной заголовок" }, "blank-manual": { title: "Ручной заголовок", body: " \n " },
    } };
    const auto: EditorialFile = { digests: {
      "title-only": { ...entry, reviewAfter: new Date(now).toISOString() },
      "fresh-auto": entry, "archive-auto": { ...entry, editorialVersion: 2 },
    } };
    const retryAfter = { "digests:blocked": now + 1 };
    const before = structuredClone({ rows, manual, auto, retryAfter });
    const select = (limit: number, at = now) => pickPending(rows, manual, auto, "digests", limit, retryAfter, at).map(row => row.id);
    expect(select(3)).toEqual(["newest", "title-only", "oldest"]);
    expect(select(2)).toEqual(["newest", "oldest"]);
    expect(select(20)).toEqual(["newest", "title-only", "blank-manual", "tie-a", "tie-z", "oldest"]);
    expect(select(20, now + 1)).toEqual(["newest", "title-only", "blocked", "blank-manual", "tie-a", "tie-z", "oldest"]);
    expect({ rows, manual, auto, retryAfter }).toEqual(before);
  });

  test("the thirty-day boundary and malformed legacy copy keep their existing review semantics", () => {
    const boundary = now - 30 * 86400000;
    const legacy = { ...entry, editorialVersion: 2 };
    expect(digestNeedsReview(digest("boundary", new Date(boundary).toISOString()), legacy, now)).toBe(true);
    expect(digestNeedsReview(digest("archive", new Date(boundary - 1).toISOString()), legacy, now)).toBe(false);
    expect(digestNeedsReview(digest("unknown-date", "not-a-date"), legacy, now)).toBe(false);
    expect(digestNeedsReview(digest("due", new Date(now).toISOString()), { ...entry, reviewAfter: new Date(now).toISOString() }, now)).toBe(true);
    expect(digestNeedsReview(digest("archive", "2020-01-01"), { ...entry, title: "Публикация в X сообщила о запуске приложения" }, now)).toBe(true);
  });

  test("ordered journal operations preserve kind-specific fields, deletes and explicit empty overrides", () => {
    const manual: EditorialFile = {
      digests: { story: { ...entry }, removed: { ...entry } },
      activities: { story: { title: "Old activity title", intro: "Protected old intro" } },
    };
    const journal = [
      { kind: "digest", op: "patch", key: "story", value: { title: " First title ", body: "", intro: "Wrong kind", steps: ["Ignored"] } },
      { kind: "activity", op: "patch", key: "story", value: { title: "Intermediate", body: "Wrong kind" } },
      { kind: "activity", op: "remove", key: "story" },
      { kind: "activity", op: "add", key: "story", value: { title: "Re-added title", intro: "", status: "Ignored" } },
      { kind: "digest", op: "patch", key: "story", value: { summary: "Final summary", items: [] } },
      { kind: "digest", op: "remove", key: "removed" },
      { kind: "digest", op: "unknown", key: "story", value: { title: "Ignored" } },
      { kind: "project", op: "patch", key: "story", value: { title: "Ignored" } },
      { kind: "digest", op: "patch", key: 17, value: { title: "Ignored" } },
    ];
    const before = structuredClone({ manual, journal });
    const merged = withJournalEditorial(manual, journal);
    expect(merged.digests).toEqual({ story: { ...entry, title: " First title ", body: "", summary: "Final summary", items: [] } });
    expect(merged.activities).toEqual({ story: { title: "Re-added title", intro: "", status: "Ignored" } });
    expect({ manual, journal }).toEqual(before);
    expect(() => withJournalEditorial(manual, null)).toThrow("Invalid editorial journal");
  });

  test("the digest verifier receives cleaned human sources and nonblank trimmed human copy", async () => {
    const proposal = { ...entry };
    const raw = digest("story", "2026-10-30");
    const manual = {
      title: "  Ручной заголовок об условиях тестирования  ", summary: " \n ", body: "  Ручной текст  ",
      items: [{ text: "Ручной источник", url: "https://example.com/terms?utm_source=channel&ref=owner&id=17#conditions" }],
    };
    const before = structuredClone({ proposal, raw, manual });
    let verified = 0;
    expect(await checkPublication(proposal, raw, manual, async (published, input) => {
      verified++;
      expect(published).toEqual({ ...proposal, title: manual.title.trim(), body: manual.body.trim(),
        items: [{ text: "Ручной источник", url: "https://example.com/terms?id=17#conditions" }] });
      expect(input).toBe(raw);
      return ["Retained manual contradiction"];
    })).toEqual(["Retained manual contradiction"]);
    expect(verified).toBe(1);
    expect({ proposal, raw, manual }).toEqual(before);
    expect(await checkPublication(proposal, raw, { items: [] }, async published => {
      expect(published.items).toEqual([]);
      return [];
    })).toEqual([]);
  });

  test("digest copy keeps proposal values for blank or invalid human fields and preserves unrelated proposal metadata", () => {
    const proposal = { ...entry, title: " Proposed title ", body: " Proposed body ", at: "checked-at", by: "writer" };
    const manual = { title: " \n ", summary: 17, body: null, items: undefined, by: "human" } as unknown as Partial<EditorialEntry>;
    expect(digestCopy(proposal, manual)).toEqual(proposal);
    expect(digestCopy(proposal, { title: " Human title ", items: [] })).toEqual({ ...proposal, title: "Human title", items: [] });
    expect(proposal.items).toEqual(entry.items);
  });

  test("activity selection uses the final journal copy and invalidates bindings for changed retained terms", () => {
    const raw: RawActivity = {
      id: "testnet", title: "Original campaign", intro: "Raw intro", project: "Fixture", date: "2026-10-30",
      steps: ["Read the terms"], whatIs: "Project description", time: "10 minutes", spent: "Unknown",
      rewardType: "Points", status: "Active", raised: "$1 million", investors: "Investor A",
      dateReceive: "Unknown", deadlineAt: "2026-11-10", url: "https://example.com/app",
      sourceUrl: "https://t.me/fixture/1", origin: "telegram", activityReviewRequired: true,
    };
    const proposal = { title: " Proposed campaign title ", intro: " Proposed campaign intro " };
    const manual = withJournalEditorial({ activities: { testnet: { title: "Snapshot title" } } }, [
      { kind: "activity", op: "patch", key: "testnet", value: { title: " Journal title ", intro: " \n " } },
    ]);
    expect(activityCopy(proposal, manual.activities!.testnet)).toEqual({ title: "Journal title", intro: "Proposed campaign intro" });
    const published = { ...raw, ...activityCopy(proposal, manual.activities!.testnet) };
    const receipt = activityReviewReceipt(raw, published, now);
    const auto: EditorialFile = { activities: { testnet: { ...proposal, activityReview: receipt } } };
    const before = structuredClone({ raw, manual, auto });
    const pending = (input = raw, human = manual, at = now) => pickPending([input], human, auto, "activities", 2, {}, at);
    expect(pending()).toEqual([]);
    expect(pending(raw, manual, now - 1)).toEqual([raw]);
    expect(pending(raw, { activities: { testnet: { title: "Changed journal title" } } })).toEqual([raw]);
    expect(pending(raw, { activities: { testnet: { title: " Journal title ", intro: "New manual intro" } } })).toEqual([raw]);
    const changedTerms: Partial<RawActivity>[] = [
      { title: "Changed raw title" }, { intro: "Changed raw intro" }, { project: "Other project" }, { date: "2026-10-29" },
      { steps: ["Deposit funds"] }, { whatIs: "Other project description" }, { time: "1 hour" }, { spent: "$100" },
      { rewardType: "Tokens" }, { status: "Ended" }, { raised: "$2 million" }, { investors: "Investor B" },
      { dateReceive: "2027 Q1" }, { deadlineAt: "2026-11-11" }, { url: "https://example.com/other" },
      { sourceUrl: "https://t.me/fixture/2" }, { origin: "api" },
    ];
    for (const change of changedTerms) expect(pending({ ...raw, ...change })).toHaveLength(1);
    expect(pending({ ...raw, activityReviewRequired: false })).toEqual([]);
    expect({ raw, manual, auto }).toEqual(before);
  });
});

test('source-bound maintenance reopens a published guide queue without bypassing cooldowns',()=>{
 const row={id:'maintenance-guide',project:'Fixture',title:'Fixture: Test',intro:'Existing guide',date:'2026-10-30',origin:'telegram',steps:['Read the official rules'],whatIs:'Fixture',spent:'',time:'',rewardType:'',status:'Не проверено',dateReceive:'',deadlineAt:null,url:'https://example.com',raised:'',investors:'',activityReviewRequired:false} as RawActivity;
 const published={title:row.title,intro:row.intro,activityReview:activityReviewReceipt(row,row,now-1000)};
 expect(pickPending([row],{}, {activities:{[row.id]:published}},'activities',2,{},now)).toEqual([]);
 const due={...row,activityMaintenanceRequired:true};
 expect(pickPending([due],{}, {activities:{[row.id]:published}},'activities',2,{},now).map(r=>r.id)).toEqual([row.id]);
 expect(pickPending([due],{}, {activities:{[row.id]:published}},'activities',2,{['activities:'+row.id]:now+1000},now)).toEqual([]);
 expect(withJournalEditorial({activities:{}},[{kind:'activity',op:'patch',key:row.id,value:{spent:'Human retained'}}]).activities?.[row.id].spent).toBe('Human retained');
});
