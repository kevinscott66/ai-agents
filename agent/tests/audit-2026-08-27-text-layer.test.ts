/**
 * Аудит 2026-08-27 — четыре дефекта текстового слоя канала.
 *
 * Общая цена у всех одна: `PUBLISH_TO_CHANNEL` вызывает и `mdToTelegramHtml`,
 * и `ensureChannelFooter` УЖЕ ПОСЛЕ одобрения человеком, то есть правится
 * текст, который человек утвердил, и результат виден только в публичном
 * канале. HTML при этом валиден — ни 400 от Telegram, ни плейн-фолбэка, ни
 * строки в логах.
 *
 * 1. `telegram-format.ts:149` — bold `[^\n*]+?` не пускал `*` внутрь, поэтому
 *    `**жирный с *курсивом* внутри**` не матчился шагом 5; шаг 9 съедал
 *    внутренние `*`, и в канал уходили сырые `**`.
 * 2. `telegram-format.ts:161-162` — границей слова служил `\w`, а он в JS
 *    только ASCII: кириллическая буква считалась «не словом» и ОТКРЫВАЛА
 *    курсив (`отчёт_за_неделю.md` → `отчёт<i>за</i>неделю.md`).
 * 3. `isChannelFooterLine` — ветка `copyright\s+\d{4}` без якоря матчила в
 *    любой позиции строки: содержательная строка «…про copyright 2024…»
 *    считалась футером, вырезалась из поста, а на её место приклеивался
 *    канонический футер, которого в посте не было. Тот же предикат построчно
 *    применяет `lib/site-ingest.ts` — строка молча выпадала из карточки сайта.
 * 4. `ensureChannelFooter` — подъём по слабому признаку (`looksLikeFooterTail`)
 *    не имел потолка. Канонический футер — ОДНА строка и 💬 в ней уже есть,
 *    поэтому следующая строка с 💬 вверх — это живая CTA, а не продолжение
 *    футера. Аудит 2026-08-20 чинил ровно этот класс, но покрыл только случай
 *    с ОБЫЧНЫМ абзацем между CTA и футером; смежный (CTA вплотную) остался.
 */
import { test, expect, describe } from "bun:test";
import { mdToTelegramHtml } from "../lib/telegram-format.ts";
import {
  ensureChannelFooter,
  isChannelFooterLine,
  CHANNEL_FOOTER,
} from "../lib/channel-footer.ts";

describe("bold с вложенным курсивом", () => {
  test("`**жирный с *курсивом* внутри**` не теряет жирность", () => {
    expect(mdToTelegramHtml("**жирный с *курсивом* внутри**")).toBe(
      "<b>жирный с <i>курсивом</i> внутри</b>",
    );
  });

  test("сырых `**` в выводе не остаётся", () => {
    expect(mdToTelegramHtml("**a *b* c**")).not.toContain("**");
  });

  test("две пары подряд не слипаются в одну", () => {
    expect(mdToTelegramHtml("**a** и **b**")).toBe("<b>a</b> и <b>b</b>");
  });

  test("`***x***` разбирается как и раньше — жирный внутри курсива", () => {
    expect(mdToTelegramHtml("***всё сразу***")).toBe("<i><b>всё сразу</b></i>");
  });

  test("`** пусто **` остаётся текстом: пары вокруг пробелов не схлопываем", () => {
    expect(mdToTelegramHtml("** пусто **")).toBe("** пусто **");
  });
});

describe("границы слова знают не только ASCII", () => {
  test.each([
    ["отчёт_за_неделю.md", "отчёт_за_неделю.md"],
    ["файл имя_поля_тут готов", "файл имя_поля_тут готов"],
    ["переменная MEMORY_DB_PATH пуста", "переменная MEMORY_DB_PATH пуста"],
    ["см. файл*звёздочка*тут", "см. файл*звёздочка*тут"],
  ])("%j не получает паразитный курсив", (input, expected) => {
    expect(mdToTelegramHtml(input)).toBe(expected);
  });

  test("настоящий курсив по-прежнему работает", () => {
    expect(mdToTelegramHtml("это _важно_ и *тоже*")).toBe(
      "это <i>важно</i> и <i>тоже</i>",
    );
  });

  test("подчёркивания внутри markdown-ссылки не трогаются", () => {
    expect(mdToTelegramHtml("[отчёт_за_неделю](https://x.io/a_b)")).toBe(
      '<a href="https://x.io/a_b">отчёт_за_неделю</a>',
    );
  });
});

describe("copyright с годом — только в начале строки", () => {
  test("содержательная строка с `copyright 2024` не футер", () => {
    expect(
      isChannelFooterLine("Спор про copyright 2024 закрыт мировым соглашением."),
    ).toBe(false);
  });

  test("такая строка остаётся в посте, футер не навязывается", () => {
    const post = [
      "📰 **Новости**",
      "",
      "🔥 **Zora**",
      "Спор про copyright 2024 закрыт мировым соглашением.",
    ].join("\n");
    expect(ensureChannelFooter(post)).toBe(post);
  });

  test.each([
    "© Copyright 2023-2026 DeLabs",
    "Copyright 2023-2026 DeLabs",
    "Copyright © 2026 DeLabs",
    "**© Copyright 2023-2026 DeLabs**🤑",
  ])("настоящая копирайт-строка (%j) по-прежнему футер", (line) => {
    expect(isChannelFooterLine(line)).toBe(true);
  });

  test("канонический футер целиком опознаётся построчно", () => {
    for (const line of CHANNEL_FOOTER.split("\n")) {
      expect(isChannelFooterLine(line)).toBe(true);
    }
  });
});

describe("CTA вплотную над футером выживает", () => {
  const CTA = "💬 Что думаете? Пишем в чате сообщества";

  test("однострочный футер не утягивает за собой CTA", () => {
    const post = ["🔥 **Monad**", "Тестнет открыт.", "", CTA, "", CHANNEL_FOOTER]
      .join("\n");
    const out = ensureChannelFooter(post);
    expect(out).toContain("Что думаете");
    expect(out.endsWith(CHANNEL_FOOTER)).toBe(true);
    // Футер по-прежнему ровно один.
    expect(out.split("Copyright").length - 1).toBe(1);
  });

  test("рукописный однострочный футер тоже заменяется, CTA цела", () => {
    const hand =
      "💬 [ЧАТ](https://t.me/x) сообщества | [Активности](https://n.site/a) " +
      "**© Copyright 2023-2026 [DeLabs](https://t.me/y)**🤑";
    const out = ensureChannelFooter(
      ["Тело поста.", "", CTA, "", hand].join("\n"),
    );
    expect(out).toContain("Что думаете");
    expect(out.endsWith(CHANNEL_FOOTER)).toBe(true);
    expect(out).not.toContain("https://t.me/x");
  });

  test("многострочный футер модели по-прежнему снимается целиком", () => {
    const out = ensureChannelFooter(
      [
        "Тело поста.",
        "",
        "💬 ЧАТ сообщества",
        "© Copyright 2023-2026 DeLabs",
      ].join("\n"),
    );
    // Ни одного остатка рукописного футера над каноническим.
    expect(out).toBe(`Тело поста.\n\n${CHANNEL_FOOTER}`);
  });

  test("многострочный футер + CTA над ним: снимается футер, CTA остаётся", () => {
    const out = ensureChannelFooter(
      [
        "Тело поста.",
        "",
        CTA,
        "",
        "💬 ЧАТ сообщества",
        "© Copyright 2023-2026 DeLabs",
      ].join("\n"),
    );
    expect(out).toBe(`Тело поста.\n\n${CTA}\n\n${CHANNEL_FOOTER}`);
  });
});
