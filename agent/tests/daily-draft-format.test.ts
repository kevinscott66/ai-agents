import { describe, expect, test } from "bun:test";
import {
  dayTitle,
  buildPreviewText,
  buildDraftCaption,
  buildDraftReviewText,
  chunkForTelegram,
  TG_CAPTION_LIMIT,
  DRAFT_CAPTION_FOOTER,
  type DraftArticle,
} from "../lib/daily-draft-format.ts";
import { primarySourceLink, ruDate } from "../lib/delabs-text.ts";

const article = (overrides: Partial<DraftArticle> = {}): DraftArticle => ({
  title: "Дайджест: Новости протокола",
  date: "2026-10-30",
  summary: "Команда открыла **новую сеть**",
  body: "Полный **проверяемый** текст.\n\nВторой абзац сохраняется целиком.",
  items: [
    { text: "Официальный (анонс)", url: "https://example.com/news_(main)?x=1" },
    { text: "Проверка", url: "https://example.net/report" },
  ],
  sourceCount: 2,
  emoji: "🔥",
  blurb: "Резервная короткая фраза",
  ...overrides,
});

describe("daily draft formatting without the delivery runtime", () => {
  test("day title keeps the full reference headline, including beyond the old 90-unit cut", () => {
    expect(dayTitle([])).toBe("Дайджест");
    expect(dayTitle([article({ title: "  Короткий заголовок  " })])).toBe("Короткий заголовок");
    expect(dayTitle([article({ title: "   " })])).toBe("");
    const title = "А".repeat(50) + " " + "Б".repeat(60);
    expect(dayTitle([article({ title })])).toBe(title);
    expect(dayTitle([article({ title: "А".repeat(100) })])).toBe("А".repeat(100));
    const unicodeTitle = "А".repeat(89) + "🔥 подтверждённый запуск";
    expect(dayTitle([article({ title: unicodeTitle })])).toBe(unicodeTitle);
  });

  test("preview keeps exact layout, summary priority, safe source link and markup treatment", () => {
    const a = article({ title: "Дайджест: > **Новости** [анонс]", emoji: ">" });
    expect(buildPreviewText([a])).toBe([
      "📰 **> **Новости** [анонс]**",
      `🗓️ ${ruDate()}`,
      "",
      "Коротко о главном — первоисточники под новостями.",
      "",
      "🔥 **Дайджест: > Новости (анонс)**",
      `Команда открыла новую сеть. ${primarySourceLink(a.items)}`,
    ].join("\n"));
    expect(buildPreviewText([a])).not.toContain(a.blurb!);
    expect(buildPreviewText([article({ summary: "", blurb: "Запасной факт!" })])).toContain("Запасной факт!");
    expect(buildPreviewText([article({ items: [{ text: "bad", url: "javascript:alert(1)" }] })])).not.toContain("[Первоисточник]");
  });

  test("short captions remain exact preview plus approval footer", () => {
    const articles = [article()];
    expect(buildDraftCaption(articles)).toBe(`${buildPreviewText(articles)}\n\n${DRAFT_CAPTION_FOOTER}`);
    expect(buildDraftCaption([])).toBe(`${buildPreviewText([])}\n\n${DRAFT_CAPTION_FOOTER}`);
  });

  test("legacy fitting retains summary preference and truncates only the preview, never the review", () => {
    const a = article({ summary: "Полный факт 🔥 ".repeat(150), blurb: "Коротко", body: "Тело 🔥 ".repeat(500) });
    const before = structuredClone(a);
    const caption = buildDraftCaption([a], 400);
    expect(caption.length).toBeLessThanOrEqual(400);
    expect(caption.endsWith(DRAFT_CAPTION_FOOTER)).toBe(true);
    expect(caption).not.toContain("Коротко.");
    expect(caption).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    const review = buildDraftReviewText([a]);
    expect(review).toContain(a.summary);
    expect(review).toContain(a.body);
    expect(a).toEqual(before);
    expect(buildDraftCaption([a]).length).toBeLessThanOrEqual(TG_CAPTION_LIMIT);
  });

  test("review preserves all fields, every source and ordered story boundaries", () => {
    const a = article();
    const b = article({ title: "Вторая новость", summary: "", body: "body", items: [] });
    expect(buildDraftReviewText([a, b])).toBe([
      "🔎 ПОЛНЫЙ РЕДАКЦИОННЫЙ ТЕКСТ — прочти до «+»:",
      [
        `1/2 · ${a.title}`, a.summary, "", a.body, "", "Источники:",
        ...a.items.map(it => `• ${it.text} — ${it.url}`),
      ].join("\n"),
      "2/2 · Вторая новость\n\n\nbody",
    ].join("\n\n———\n\n"));
    expect(buildDraftReviewText([])).toBe("🔎 ПОЛНЫЙ РЕДАКЦИОННЫЙ ТЕКСТ — прочти до «+»:");
  });

  test("chunking retains full oversized lines and respects UTF-16 boundaries", () => {
    const text = "а".repeat(9) + "🔥" + "б".repeat(8) + "🌐" + "в".repeat(12);
    const chunks = chunkForTelegram(text, 10);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every(c => c.length <= 10)).toBe(true);
    for (const c of chunks) {
      expect(c).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
    expect(chunkForTelegram("abc\ndef\nxyz", 7)).toEqual(["abc\ndef", "xyz"]);
    expect(chunkForTelegram("")).toEqual([""]);
  });

  test("formatter dependency graph bundles for browsers without delivery, files or research", async () => {
    const imports = new Set<string>();
    const result = await Bun.build({
      entrypoints: [new URL("../lib/daily-draft-format.ts", import.meta.url).pathname],
      target: "browser",
      plugins: [{ name: "record-format-dependencies", setup(build) {
        build.onResolve({ filter: /.*/ }, args => { imports.add(args.path); return undefined; });
      } }],
    });
    expect(result.success).toBe(true);
    expect([...imports].filter(p => !p.endsWith("/daily-draft-format.ts")).sort()).toEqual([
      "./delabs-text.ts", "./log.ts", "./text-cut.ts",
    ]);
  });
});
