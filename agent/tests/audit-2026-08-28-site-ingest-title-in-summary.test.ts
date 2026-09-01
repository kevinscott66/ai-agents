/**
 * Аудит 2026-08-28: описание карточки начиналось с её же заголовка.
 *
 * `parseDigestPost` обещает в шапке «summary: intro paragraph before the first
 * item, minus title line», и строку заголовка действительно пыталась выбросить:
 * `l.replace(MD_PUNCT_RE, "").trim() !== title`. Но сам `title` к этому моменту
 * прошёл ещё три шага (`unwrapMdLinks`, срез ведущей не-буквы, `.slice(0, 120)`),
 * так что строка почти никогда не совпадала сама с собой.
 *
 * Спасал только `isScaffoldLine`, а он знает ровно 📰 и 🗓 — тогда как
 * `tools-schema.ts:322` выдаёт модели всю палитру эмодзи и просит выбирать по
 * смыслу. Любой другой значок в шапке — и заголовок ехал в summary второй раз,
 * на публичный delabs.space и в RSS.
 */
import { describe, expect, test } from "bun:test";
import { parseDigestPost } from "../lib/site-ingest.ts";

const INTRO = "Собрали главное за сутки: без воды и по шагам.";
const ITEM = "[Monad](https://monad.xyz) — открыт тестнет";

function post(head: string): ReturnType<typeof parseDigestPost> {
  return parseDigestPost([head, INTRO, "", ITEM].join("\n"));
}

describe("строка заголовка не попадает в summary", () => {
  test("шапка с эмодзи не из списка обвязки", () => {
    // 🔥 — из палитры, которую tools-schema предлагает модели, но не из тех
    // двух, что знает isScaffoldLine.
    const d = post("🔥 **Web3 Пульс за 27 августа**");
    expect(d.title).toBe("Web3 Пульс за 27 августа");
    expect(d.summary).toBe(INTRO);
  });

  test("любой другой значок из той же палитры", () => {
    for (const emoji of ["🤩", "🙌", "😮", "💰", "👉", "⭐️", "😎", "✅"]) {
      const d = post(`${emoji} **Заголовок дня**`);
      expect({ emoji, summary: d.summary }).toEqual({ emoji, summary: INTRO });
    }
  });

  test("заголовок длиннее 120 символов (title режется, строка — нет)", () => {
    const long = `Очень длинный заголовок ${"дайджеста ".repeat(15)}конец`;
    const d = post(`**${long}**`);
    expect(d.title.length).toBe(120);
    expect(d.summary).toBe(INTRO);
  });

  test("заголовок со ссылкой внутри", () => {
    // Такая строка несёт ссылку, то есть она же и первый item: вступления перед
    // ней нет вовсе, и summary штатно откатывается на title. Проверяем, что в
    // описание не уехала сырая разметка — ради неё ключ и снимает ссылки.
    const d = post("**[Zora Drop](https://zora.co/drop)**");
    expect(d.title).toBe("Zora Drop");
    expect(d.summary).toBe("Zora Drop");
  });

  test("голая шапка без markdown", () => {
    const d = post("Web3 Пульс за 27 августа");
    expect(d.title).toBe("Web3 Пульс за 27 августа");
    expect(d.summary).toBe(INTRO);
  });
});

describe("лишнего не выбрасываем", () => {
  test("строка, где заголовок лишь часть текста, остаётся", () => {
    const d = parseDigestPost(
      ["**Пульс**", "Пульс выходит каждый день в 10:00.", "", ITEM].join("\n"),
    );
    expect(d.summary).toBe("Пульс выходит каждый день в 10:00.");
  });

  test("вступление из одной строки-заголовка откатывается на title", () => {
    const d = parseDigestPost(["🔥 **Только заголовок**", "", ITEM].join("\n"));
    expect(d.title).toBe("Только заголовок");
    expect(d.summary).toBe("Только заголовок");
  });

  test("прежняя обвязка по-прежнему режется", () => {
    const d = parseDigestPost(
      ["📰 **Дайджест**", "🗓️ 27 августа", INTRO, "", ITEM].join("\n"),
    );
    expect(d.summary).toBe(INTRO);
  });

  test("items и sourceCount не задеты", () => {
    const d = post("🔥 **Web3 Пульс за 27 августа**");
    expect(d.sourceCount).toBe(1);
    expect(d.items).toEqual([{ text: "Monad", url: "https://monad.xyz" }]);
  });
});
