/**
 * Аудит 2026-08-21: заголовок дайджеста уезжал на сайт куском сырой разметки.
 *
 * `deriveTitle` снимал только MD_PUNCT_RE (`#*_\`>|~`) и ведущие не-буквы, а про
 * скобки markdown-ссылки не знал ничего. Обычная шапка поста
 * `**[Zora Drop](https://zora.co/drop)**` давала title
 * `Zora Drop](https://zora.co/drop)`, и он же уходил в summary (фолбэк
 * `summary = title`). Публикуется это на публичный delabs.space и в RSS.
 */
import { describe, expect, test } from "bun:test";
import { parseDigestPost } from "../lib/site-ingest.ts";

/** Ни одна из этих последовательностей не должна доезжать до сайта в title. */
const RAW_MD = /\]\(|https?:\/\//;

describe("site-ingest: markdown-ссылки в заголовке", () => {
  test("bold-шапка со ссылкой даёт текст ссылки, а не разметку", () => {
    const r = parseDigestPost(
      "**[Zora Drop](https://zora.co/drop)**\n\n[пункт](https://y/2)",
    );
    expect(r.title).toBe("Zora Drop");
    expect(r.title).not.toMatch(RAW_MD);
  });

  test("фолбэк берёт видимый текст строки, ссылка разворачивается", () => {
    const r = parseDigestPost(
      "Свежие ссылки: [Zora](https://zora.co)\n\n[a](https://x/1)",
    );
    expect(r.title).toBe("Свежие ссылки: Zora");
    expect(r.title).not.toMatch(RAW_MD);
  });

  test("порог «осмысленности» считается по тексту, а не по URL", () => {
    // `[a](https://x/1)` — одна буква видимого текста. Раньше порог в 6
    // алфавитно-цифровых набирал сам URL (`ahttpsx1`), и строка-ссылка
    // становилась заголовком.
    const r = parseDigestPost("[a](https://x/1)");
    expect(r.title).toBe("Дайджест");
    expect(r.title).not.toMatch(RAW_MD);
  });

  test("пост из одних ссылок по-прежнему уходит на сайт — политика не менялась", () => {
    // Фикс правит ТОЛЬКО заголовок. Пускать ли на публичный сайт пост без
    // единого слова прозы — решение владельца; тест держит текущее поведение,
    // чтобы оно не поменялось молча вместе с косметикой заголовка.
    const r = parseDigestPost("[a](https://x/1)");
    expect(r.items).toHaveLength(1);
    expect(r.sourceCount).toBe(1);
    expect(r.summary).toBe("Дайджест");
  });

  test("ни одна форма поста не отдаёт заголовок с сырой разметкой", () => {
    const shapes = [
      "[a](https://x/1)",
      "**[Zora Drop](https://zora.co/drop)**\nвступление",
      "Свежие ссылки: [Zora](https://zora.co)",
      "[раз](https://x/1)\n[два](https://x/2)\n[три](https://x/3)",
      "📰 **[Заголовок](https://x/1)**\n🗓️ 21.08\n\n[пункт](https://y/2)",
      "**жирный без ссылки**\n[пункт](https://y/2)",
    ];
    for (const s of shapes) {
      const t = parseDigestPost(s).title;
      expect(t).not.toMatch(RAW_MD);
      expect(t.length).toBeGreaterThan(0);
    }
  });

  test("текст пунктов и счётчик источников не задеты", () => {
    const r = parseDigestPost(
      "**[Шапка](https://x/0)**\n\n[Zora](https://zora.co) и [Base](https://base.org)",
    );
    expect(r.items).toEqual([
      { text: "Шапка", url: "https://x/0" },
      { text: "Zora", url: "https://zora.co" },
      { text: "Base", url: "https://base.org" },
    ]);
    expect(r.sourceCount).toBe(3);
  });

  test("общий MD_LINK_RE не таскает lastIndex между вызовами", () => {
    // Регулярка с `/g` теперь одна на модуль: её же использует matchAll в
    // разборе пунктов. Два одинаковых вызова обязаны дать одинаковый результат.
    const post = "**[Шапка](https://x/0)**\n[a](https://x/1)\n[b](https://x/2)";
    const first = parseDigestPost(post);
    const second = parseDigestPost(post);
    expect(second).toEqual(first);
    expect(first.items).toHaveLength(3);
  });
});
