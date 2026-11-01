/** Model-response decoding only: no network, Telegram, persistence or clock. */
import { extractModelObject } from "./model-json.ts";
import { ITEM_EMOJI } from "./delabs-text.ts";
import type { DraftArticle } from "./daily-draft-format.ts";

/** The initial answer and bounded repair use the same parser and normalization. */
export function articlesFromResponse(raw: string): DraftArticle[] {
  return articlesFromResearch(extractModelObject(raw));
}

function isCandidate(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return !!row.title && !!row.body;
}

/**
 * Ответ модели → статьи черновика. Отдельно от `research`, потому что
 * `research` ходит в сеть, а разбор — чистый и проверяемый.
 */
export function articlesFromResearch(parsed: unknown): DraftArticle[] {
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).articles))
    throw new Error("JSON has no articles[]");
  const articles = (parsed as { articles: unknown[] }).articles;
  return articles
    .filter(isCandidate)
    .slice(0, 4)
    .map((a, i) => {
      // Keep the existing http(s) selection; public-address and factual checks
      // still run later. Decoding alone never makes a source trustworthy.
      const items = Array.isArray(a.items)
        ? a.items
            .filter((it) => it && typeof it.url === "string" && /^https?:\/\//.test(it.url))
            .slice(0,4).map((it) => ({ text: String(it.text ?? "Источник").trim(), url: it.url }))
        : [];
      return {
        title: String(a.title).trim(),
        date: typeof a.date === "string" ? a.date : "",
        summary: String(a.summary ?? "").trim(),
        body: String(a.body ?? "").trim(),
        items,
        // Never trust the model's count: describe only the retained links.
        sourceCount: items.length,
        emoji: ITEM_EMOJI[i % ITEM_EMOJI.length],
        blurb: String(a.summary ?? "").trim().split(/(?<=[.!?])\s/)[0] || String(a.title),
      };
    });
}

