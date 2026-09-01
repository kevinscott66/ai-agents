/**
 * Аудит 2026-08-27: описание дайджеста уходило в мету без ограничения длины.
 *
 * `injectActivityMeta` режет описание до 300 символов (`metaDescription`), а
 * `injectDigestMeta` рядом подставлял `d.summary` как есть — при том что
 * ингест пропускает `INGEST_MAX.summary = 2 000`. Расхождение без причины:
 * og:description длиннее ~300 не показывает ни Telegram, ни поисковик, зато
 * оболочка каждой статьи распухала на несколько килобайт, повторённых в трёх
 * атрибутах (og:description, twitter:description, description).
 *
 * Инвариант: у обоих типов страниц описание в мете ограничено одинаково.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-meta-clip-"));
process.env.SITE_DB_PATH = join(TMP, "meta.db");

const { injectDigestMeta, injectActivityMeta } = await import("./index.ts");

const SHELL = `<!doctype html><html><head><title>DeLabs</title></head><body></body></html>`;

/** Значение атрибута `content` у тега с данным ключом. */
function metaOf(html: string, key: string): string {
  const re = new RegExp(
    `<meta[^>]*(?:property|name)="${key}"[^>]*content="([^"]*)"`,
    "i",
  );
  return html.match(re)?.[1] ?? "";
}

const LONG = "Длинное описание. ".repeat(200); // ~3 600 символов

describe("мета статьи: описание ограничено у обоих типов", () => {
  test("дайджест: summary на 2 000+ символов режется, а не уходит целиком", () => {
    const out = injectDigestMeta(SHELL, {
      id: "d1",
      date: "2026-08-27",
      title: "Заголовок",
      summary: LONG,
    } as never);

    const og = metaOf(out, "og:description");
    expect(og.length).toBeLessThanOrEqual(300);
    expect(og.length).toBeGreaterThan(100);
    expect(og.endsWith("…")).toBe(true);
    // Все три атрибута несут одно и то же обрезанное значение.
    expect(metaOf(out, "twitter:description")).toBe(og);
    expect(metaOf(out, "description")).toBe(og);
  });

  test("гайд режется так же — потолок общий", () => {
    const out = injectActivityMeta(SHELL, {
      id: "a1",
      project: "P",
      title: "Гайд",
      date: "2026-08-27",
      intro: LONG,
    } as never);
    expect(metaOf(out, "og:description").length).toBeLessThanOrEqual(300);
  });

  test("короткое описание не трогается и не получает многоточия", () => {
    const short = "Коротко и по делу.";
    const out = injectDigestMeta(SHELL, {
      id: "d2",
      date: "2026-08-27",
      title: "Заголовок",
      summary: short,
    } as never);
    expect(metaOf(out, "og:description")).toBe(short);
  });
});
