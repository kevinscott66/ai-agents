/**
 * Аудит 2026-08-28: ссылка со скобкой внутри обрывалась и уезжала битой.
 *
 * `MD_LINK_RE` читал адрес как `[^)\s]+` — то есть до первой закрывающей
 * скобки, откуда бы она ни взялась. У статей Википедии скобка в пути обычная
 * (`DAO_(организация)`), и такая ссылка превращалась в `…/DAO_(организация`:
 * схема https на месте, значит `safeStoredUrl` на сайте её пропускает, и битый
 * адрес попадает на публичную страницу и в RSS. Хвостовая скобка при этом
 * оставалась в тексте пункта.
 *
 * Разрешаем один уровень вложенных скобок — этого хватает и Википедии, и
 * трекерам с `(v2)` в пути.
 */
import { describe, expect, test } from "bun:test";
import { parseDigestPost } from "../lib/site-ingest.ts";

const INTRO = "Собрали главное за сутки.";

function items(line: string) {
  return parseDigestPost(["**Дайджест**", INTRO, "", line].join("\n")).items;
}

describe("скобки внутри адреса", () => {
  test("статья Википедии доезжает целиком", () => {
    expect(items("[Про DAO](https://ru.wikipedia.org/wiki/DAO_(организация))")).toEqual([
      { text: "Про DAO", url: "https://ru.wikipedia.org/wiki/DAO_(организация)" },
    ]);
  });

  test("латиница и хвост после скобки", () => {
    expect(
      items("[DAO](https://en.wikipedia.org/wiki/DAO_(organization)#History) — что это"),
    ).toEqual([
      { text: "DAO", url: "https://en.wikipedia.org/wiki/DAO_(organization)#History" },
    ]);
  });

  test("две скобочные ссылки в одной строке разбираются по отдельности", () => {
    const got = items(
      "[A](https://x.test/a_(1)) и [B](https://y.test/b_(2)) — обе",
    );
    expect(got.map((i) => i.url)).toEqual(["https://x.test/a_(1)", "https://y.test/b_(2)"]);
  });

  test("текст пункта не таскает за собой лишнюю скобку", () => {
    const d = parseDigestPost(
      ["**Дайджест**", INTRO, "", "[Про DAO](https://ru.wikipedia.org/wiki/DAO_(организация))"].join(
        "\n",
      ),
    );
    expect(d.items[0]!.text).toBe("Про DAO");
  });
});

describe("прежнее поведение не сдвинулось", () => {
  test("обычная ссылка", () => {
    expect(items("[Monad](https://monad.xyz) — тестнет")).toEqual([
      { text: "Monad", url: "https://monad.xyz" },
    ]);
  });

  test("точка и запятая после ссылки остаются в тексте", () => {
    expect(items("[Zora](https://zora.co/drop).")).toEqual([
      { text: "Zora", url: "https://zora.co/drop" },
    ]);
  });

  test("незакрытая скобка не съедает остаток строки", () => {
    // Битую разметку разбирать нечем — важно, что мы не утаскиваем в адрес
    // весь хвост и не зависаем.
    const got = items("[A](https://x.test/a_(1 и дальше текст [B](https://y.test/b)");
    expect(got.map((i) => i.url)).toEqual(["https://y.test/b"]);
  });

  test("не-http схемы по-прежнему не считаются ссылкой", () => {
    expect(items("[файл](ftp://x.test/f) — не ссылка")).toEqual([]);
  });
});
