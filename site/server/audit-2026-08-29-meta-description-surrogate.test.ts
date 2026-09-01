/**
 * Аудит 2026-08-29: `metaDescription` — последний рез, который ломал
 * суррогатную пару.
 *
 * Двум соседним резам это уже чинили: `clipSlug` перевели на посимвольный
 * `Array.from` (2026-08-28, первый заход), `clip` — на явную проверку хвоста
 * (2026-08-28, второй заход), а XML-путь выкидывает одинокие суррогаты через
 * `XML_FORBIDDEN`. Здесь остался прямой `one.slice(0, META_DESC_MAX - 1)`: если
 * граница на 299-й единице UTF-16 попадала внутрь пары, в хвосте оставался
 * одинокий суррогат, и он уезжал сразу в три атрибута — og:description,
 * twitter:description и description.
 *
 * Одинокий суррогат не кодируется в UTF-8, так что до читателя доезжает
 * U+FFFD: в карточке ссылки — «ромб с вопросом» на месте последней буквы.
 * Символы за пределами BMP тут не экзотика — эмодзи в сводке хватает.
 *
 * Инвариант формулируется не списком написаний, а свойством: в описании нет
 * одиноких суррогатов, какой бы ни была граница реза.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-meta-surrogate-"));
process.env.SITE_DB_PATH = join(TMP, "meta.db");

const { injectDigestMeta, injectActivityMeta } = await import("./index.ts");

const SHELL = `<!doctype html><html><head><title>DeLabs</title></head><body></body></html>`;

function metaOf(html: string, key: string): string {
  const re = new RegExp(
    `<meta[^>]*(?:property|name)="${key}"[^>]*content="([^"]*)"`,
    "i",
  );
  return html.match(re)?.[1] ?? "";
}

/** Одинокий суррогат — любая единица UTF-16 без парной соседки. */
function lonelySurrogates(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else out.push(i);
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(i);
    }
  }
  return out;
}

const ROCKET = "\u{1F680}"; // U+1F680, суррогатная пара

/**
 * Сводка, у которой граница реза (299-я единица UTF-16) приходится ровно
 * внутрь пары: 298 однобайтовых символов, затем ракета, затем хвост.
 */
const SPLIT_AT_BOUNDARY = "а".repeat(298) + ROCKET + "хвост".repeat(50);

const DIGEST = {
  id: "d-surrogate",
  date: "2026-08-29",
  title: "Заголовок",
  summary: SPLIT_AT_BOUNDARY,
} as never;

const ACTIVITY = {
  id: "a-surrogate",
  project: "Проект",
  title: "Гайд",
  date: "2026-08-29",
  intro: SPLIT_AT_BOUNDARY,
} as never;

const KEYS = ["og:description", "twitter:description", "description"];

describe("описание в мете не рвёт суррогатную пару", () => {
  test("предпосылка: граница реза действительно попадает внутрь пары", () => {
    // Если это перестанет быть правдой (сменился META_DESC_MAX), тест ниже
    // выродится в тавтологию — пусть падает здесь, а не молча зеленеет.
    const cut = SPLIT_AT_BOUNDARY.slice(0, 299);
    expect(lonelySurrogates(cut)).toEqual([298]);
  });

  test("дайджест: во всех трёх атрибутах нет одиноких суррогатов", () => {
    const out = injectDigestMeta(SHELL, DIGEST);
    for (const key of KEYS) {
      const v = metaOf(out, key);
      expect(v.length).toBeGreaterThan(0);
      expect(lonelySurrogates(v)).toEqual([]);
    }
  });

  test("гайд: во всех трёх атрибутах нет одиноких суррогатов", () => {
    const out = injectActivityMeta(SHELL, ACTIVITY);
    for (const key of KEYS) {
      const v = metaOf(out, key);
      expect(v.length).toBeGreaterThan(0);
      expect(lonelySurrogates(v)).toEqual([]);
    }
  });

  test("описание переживает кодирование в UTF-8 без U+FFFD", () => {
    // Прямая проверка того, чем дефект оборачивался для читателя: ответ
    // сервера — это байты UTF-8, а одинокий суррогат в них не кодируется.
    const v = metaOf(injectDigestMeta(SHELL, DIGEST), "og:description");
    const roundTrip = new TextDecoder().decode(new TextEncoder().encode(v));
    expect(roundTrip).toBe(v);
    expect(roundTrip).not.toContain("�");
  });

  test("рез по-прежнему держит потолок и ставит многоточие", () => {
    const v = metaOf(injectDigestMeta(SHELL, DIGEST), "og:description");
    expect(v.length).toBeLessThanOrEqual(300);
    expect(v.endsWith("…")).toBe(true);
  });

  test("описание короче потолка не трогается", () => {
    const short = `Коротко ${ROCKET} и всё`;
    const v = metaOf(
      injectDigestMeta(SHELL, { ...(DIGEST as object), summary: short } as never),
      "og:description",
    );
    expect(v).toBe(short);
    expect(lonelySurrogates(v)).toEqual([]);
  });
});
