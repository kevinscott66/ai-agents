/**
 * Аудит 2026-08-28: подзаголовок обложки терялся на пути по умолчанию.
 *
 * `buildIllustratedBannerSvg` умеет рисовать подзаголовок — это чинили
 * 2026-08-20 (cover-banner.ts, «подзаголовок здесь не рисовался ВООБЩЕ»). Но
 * `renderCoverBanner` собирала опции иллюстрированного баннера вручную из трёх
 * полей — title/date/seed — и `subtitle` в этот объект просто не попадал.
 *
 * А иллюстрированный баннер — это и есть путь по умолчанию: `style !== "clean"`
 * и непустой пул фонов. Схема инструмента прямо просит модель дать
 * `coverSubtitle`, publish.ts прокидывает его в `renderCoverBanner` во всех трёх
 * местах вызова — и там текст молча исчезал. Правка 2026-08-20 работала только
 * на чистом баннере, то есть почти никогда.
 *
 * Проверяем сборку опций, а не пиксели: реальный путь тянет Resvg с загрузкой
 * системных шрифтов (~2 с синхронно на общем процессе 12 ботов).
 */
import { describe, expect, test } from "bun:test";
import { renderCoverBanner } from "../lib/dispatch/publish.ts";
import type { CoverBannerDeps } from "../lib/dispatch/publish.ts";
import { buildIllustratedBannerSvg, hasBannerPool } from "../lib/cover-banner.ts";

const ILLU = Buffer.from("illustrated");
const CLEAN = Buffer.from("clean");

function deps(over: Partial<CoverBannerDeps> = {}) {
  const seen: { illustrated: unknown[]; clean: unknown[] } = { illustrated: [], clean: [] };
  const d: CoverBannerDeps = {
    poolAvailable: () => true,
    illustrated: async (o) => {
      seen.illustrated.push(o);
      return ILLU;
    },
    clean: async (o) => {
      seen.clean.push(o);
      return CLEAN;
    },
    ...over,
  };
  return { d, seen };
}

const opts = {
  title: "Аирдропы недели",
  subtitle: "12 проектов, 3 дедлайна",
  date: "28 августа",
};

describe("иллюстрированный баннер получает подзаголовок", () => {
  test("subtitle доезжает до рендера", async () => {
    const { d, seen } = deps();
    await renderCoverBanner(opts, undefined, d);
    expect(seen.illustrated[0]).toMatchObject({ subtitle: "12 проектов, 3 дедлайна" });
  });

  test("остальные поля не потерялись при этом", async () => {
    const { d, seen } = deps();
    await renderCoverBanner({ ...opts, seed: "seed-1" }, undefined, d);
    expect(seen.illustrated[0]).toEqual({
      title: "Аирдропы недели",
      subtitle: "12 проектов, 3 дедлайна",
      date: "28 августа",
      seed: "seed-1",
    });
  });

  test("без seed сидом остаётся заголовок — выбор фона детерминирован", async () => {
    const { d, seen } = deps();
    await renderCoverBanner(opts, undefined, d);
    expect(seen.illustrated[0]).toMatchObject({ seed: "Аирдропы недели" });
  });

  test("подзаголовка нет — поле остаётся пустым, а не строкой «undefined»", async () => {
    const { d, seen } = deps();
    await renderCoverBanner({ title: "Т", date: "28 августа" }, undefined, d);
    expect((seen.illustrated[0] as { subtitle?: string }).subtitle).toBeUndefined();
  });
});

describe("маршрутизация не изменилась", () => {
  test("style=clean идёт мимо иллюстрированного и несёт подзаголовок", async () => {
    const { d, seen } = deps();
    const out = await renderCoverBanner(opts, "clean", d);
    expect(out).toBe(CLEAN);
    expect(seen.illustrated).toEqual([]);
    expect(seen.clean[0]).toMatchObject({ subtitle: "12 проектов, 3 дедлайна" });
  });

  test("пустой пул фонов — тоже чистый баннер", async () => {
    const { d, seen } = deps({ poolAvailable: () => false });
    expect(await renderCoverBanner(opts, undefined, d)).toBe(CLEAN);
    expect(seen.illustrated).toEqual([]);
  });

  test("null от иллюстрированного — фолбэк на чистый", async () => {
    const { d, seen } = deps({ illustrated: async () => null });
    expect(await renderCoverBanner(opts, undefined, d)).toBe(CLEAN);
    expect(seen.clean[0]).toMatchObject({ subtitle: "12 проектов, 3 дедлайна" });
  });

  test("исключение в иллюстрированном — фолбэк, а не падение публикации", async () => {
    const { d } = deps({
      illustrated: async () => {
        throw new Error("resvg упал");
      },
    });
    expect(await renderCoverBanner(opts, undefined, d)).toBe(CLEAN);
  });

  test("успешный иллюстрированный возвращается как есть", async () => {
    const { d, seen } = deps();
    expect(await renderCoverBanner(opts, undefined, d)).toBe(ILLU);
    expect(seen.clean).toEqual([]);
  });
});

describe("получатель подзаголовок действительно рисует", () => {
  test("текст подзаголовка попадает в SVG иллюстрированного баннера", () => {
    // Без этого форвардинг был бы бессмысленным: проверяем, что принимающая
    // сторона (правка 2026-08-20) на месте и с ней есть что соединять.
    expect(hasBannerPool()).toBe(true);
    const svg = buildIllustratedBannerSvg({
      title: "Аирдропы недели",
      subtitle: "12 проектов, 3 дедлайна",
      date: "28 августа",
    });
    expect(svg).toContain("12 проектов");
  });
});
