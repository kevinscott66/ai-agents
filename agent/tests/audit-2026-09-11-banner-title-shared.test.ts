/**
 * Аудит 2026-09-11: у поста два заголовка, и второй считался своей копией.
 *
 * `deriveTitle` (lib/site-ingest.ts) чинили дважды: аудит 2026-08-20 добавил
 * фильтр футера (иначе заголовком становился копирайт), аудит 2026-08-28 —
 * снятие markdown-ссылок и порог «шесть букв» уже по видимому тексту (иначе
 * порог набирал сам URL). До `deriveBannerTitle` в lib/dispatch/publish.ts не
 * доехала ни одна из двух правок: там лежало тело ДО обеих.
 *
 * Разница в цене не в пользу баннера. Заголовок записи на сайте можно
 * переингестить; заголовок баннера впечатан в PNG публичного поста в канале.
 *
 * Здесь же — вторая половина того же расхождения: текст ПУНКТА в
 * `parseDigestPost` нормализовался своим набором знаков, без `>` и `|`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deriveTitle, parseDigestPost } from "../lib/site-ingest.ts";
import { CHANNEL_FOOTER } from "../lib/channel-footer.ts";

const PUBLISH = readFileSync(
  new URL("../lib/dispatch/publish.ts", import.meta.url),
  "utf8",
);

/** Как публикация зовёт заголовок баннера. */
const banner = (text: string) => deriveTitle(text, 70);

describe("заголовок баннера не берёт футер", () => {
  test("пост без своего жирного не получает на обложку копирайт", () => {
    const post = `Разобрали три дропа недели, вот что важно.\n\n${CHANNEL_FOOTER}`;
    const t = banner(post);
    expect(t).not.toContain("Copyright");
    expect(t).not.toContain("DeLabs");
    expect(t).toContain("Разобрали три дропа");
  });

  test("свой жирный в теле по-прежнему выигрывает", () => {
    const post = `**Итоги недели**\n\nТекст поста.\n\n${CHANNEL_FOOTER}`;
    expect(banner(post)).toBe("Итоги недели");
  });
});

describe("заголовок баннера не показывает адреса", () => {
  test("жирная ссылка сводится к своему тексту", () => {
    const post = "**[Zora Drop](https://zora.co/drop)** — новый дроп сезона";
    const t = banner(post);
    expect(t).toBe("Zora Drop");
    expect(t).not.toContain("https");
  });

  test("строка-ссылка не проходит порог за счёт самого URL", () => {
    const post = "[a](https://example.com/1)\nНастоящий заголовок поста";
    expect(banner(post)).toBe("Настоящий заголовок поста");
  });
});

describe("две длины — единственное расхождение", () => {
  const long = `**${"я".repeat(200)}**`;

  test("баннеру 70", () => {
    expect(banner(long).length).toBe(70);
  });

  test("записи на сайте 120 по умолчанию", () => {
    expect(deriveTitle(long).length).toBe(120);
  });
});

describe("своей копии в публикации не осталось", () => {
  test("deriveBannerTitle удалён", () => {
    expect(PUBLISH).not.toContain("deriveBannerTitle");
  });

  test("заголовок берётся общей функцией, обеими ветками обложки", () => {
    expect(PUBLISH).toContain('from "../site-ingest.ts"');
    const uses = PUBLISH.split("\n").filter((l) =>
      l.includes("deriveTitle(p.text, BANNER_TITLE_MAX)"),
    );
    expect(uses.length).toBe(2);
  });
});

describe("текст пункта режется тем же набором знаков, что и заголовок", () => {
  test("маркер цитаты и палка не уезжают на сайт", () => {
    const post = "**Обзор**\n\n- [Курс > 3000 | итоги](https://example.com/x)";
    const parsed = parseDigestPost(post);
    expect(parsed.items.length).toBe(1);
    expect(parsed.items[0]!.text).toBe("Курс  3000  итоги");
  });

  test("те же знаки в заголовке снимались и раньше", () => {
    expect(deriveTitle("**Курс > 3000 | итоги**")).toBe("Курс  3000  итоги");
  });
});
