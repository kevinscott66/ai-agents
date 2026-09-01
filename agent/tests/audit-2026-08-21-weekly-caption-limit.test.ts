/**
 * Аудит 2026-08-21: недельный пост мерился лимитом обычного сообщения (4096),
 * а уходил подписью к баннеру (потолок 1024) — и не уходил вообще.
 *
 * `buildWeeklyTextFitting` звал `fitsOneMessage`, то есть сравнивал с
 * `TG_MESSAGE_LIMIT`. При `MAX_NEWS = 6` / `MAX_ACTIVITIES = 4` этот порог
 * недостижим, поэтому ужиматель не срабатывал никогда, а `client.sendFile`
 * получал подпись в полтора раза длиннее разрешённой. Дальше `catch` →
 * `fail("preview send failed", 1)`, замок снят, следующая попытка — через
 * неделю. Тесты ниже ловят каждое звено этой цепочки отдельно.
 */
import { describe, expect, test } from "bun:test";
import {
  buildWeeklyTextFitting,
  fitsWeeklyCaption,
  WEEKLY_DRAFT_FOOTER,
} from "../tools/weekly-draft.ts";
import { buildWeeklyRecapText, fitsOneMessage } from "../lib/delabs-post-templates.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_CAPTION_HARD_LIMIT,
} from "../lib/telegram-actions.ts";
import { readFileSync } from "node:fs";

const weekEnd = new Date("2026-08-16T12:00:00Z");

/** Ровно та склейка, которая уходит в `sendFile({ caption })`. */
const asCaption = (text: string) => [text, "", WEEKLY_DRAFT_FOOTER].join("\n");

/**
 * Реалистичная неделя: шесть новостей и четыре активности с текстами той
 * длины, какую даёт сайт. Не патология — обычный полный выпуск.
 */
const NEWS = Array.from({ length: 6 }, (_, i) => ({
  emoji: "🔥",
  title: `Протокол ${i + 1} открыл поинты для ранних пользователей`,
  blurb:
    "Команда включила программу баллов: активность в тестнете и мосты учитываются " +
    "задним числом, снапшот обещают не раньше осени.",
  url: `https://delabs.space/digest/protokol-${i + 1}-otkryl-pointy`,
}));

const ACTIVITIES = Array.from({ length: 4 }, (_, i) => ({
  emoji: "💰",
  project: `Проект ${i + 1}`,
  done: "Аирдроп · Активна — разобрали гайд, прошли квест и мост, ждём снапшот.",
  url: `https://delabs.space/activity/${i + 1}`,
}));

describe("недельный пост меряется лимитом подписи, а не сообщения", () => {
  const full = buildWeeklyRecapText({ news: NEWS, activities: ACTIVITIES, weekEnd });

  test("старая мерка на этих данных говорила «влезает» — и врала", () => {
    // Обе половины важны: если fixture перестанет пролезать через 4096, тест
    // станет проверять не тот дефект. И если перестанет превышать 1024 —
    // проверять будет нечего.
    expect(fitsOneMessage(full)).toBe(true);
    expect(plainTelegramLength(asCaption(full))).toBeGreaterThan(
      TELEGRAM_CAPTION_HARD_LIMIT,
    );
  });

  test("ужиматель приводит обычную неделю к лимиту подписи", () => {
    const fitted = buildWeeklyTextFitting({ news: NEWS, activities: ACTIVITIES, weekEnd });
    expect(plainTelegramLength(asCaption(fitted))).toBeLessThanOrEqual(
      TELEGRAM_CAPTION_LIMIT,
    );
    expect(plainTelegramLength(asCaption(fitted))).toBeLessThanOrEqual(
      TELEGRAM_CAPTION_HARD_LIMIT,
    );
  });

  test("режет с конца: самое свежее остаётся, что-то остаётся всегда", () => {
    const fitted = buildWeeklyTextFitting({ news: NEWS, activities: ACTIVITIES, weekEnd });
    expect(fitted).toContain("Протокол 1");
    expect(fitted).toContain("Проект 1");
    expect(fitted.length).toBeLessThan(full.length);
  });

  test("мерка «плоская», а не сырая — иначе выбрасывали бы лишние пункты", () => {
    const fitted = buildWeeklyTextFitting({ news: NEWS, activities: ACTIVITIES, weekEnd });
    // Пост состоит из ссылок `[Подробнее →](…)`, у которых Telegram считает
    // только видимый текст. Сырая длина итога больше лимита — то есть по ней
    // ужиматель выкинул бы ещё пункты сверх нужного.
    expect(asCaption(fitted).length).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);
  });

  test("короткая неделя не ужимается", () => {
    const news = [{ emoji: "🔥", title: "T", blurb: "b", url: "https://delabs.space/digest/1" }];
    const text = buildWeeklyTextFitting({ news, activities: [], weekEnd });
    expect(text).toContain("🔥 **T**");
    expect(text).toBe(buildWeeklyRecapText({ news, activities: [], weekEnd }));
  });

  test("пустая неделя — пустая строка, а не шапка без пунктов", () => {
    expect(buildWeeklyTextFitting({ news: [], activities: [], weekEnd })).toBe("");
  });
});

describe("fitsWeeklyCaption", () => {
  test("считает футер: без него тот же текст «влезает», с ним — нет", () => {
    const text = "я".repeat(TELEGRAM_CAPTION_LIMIT - 10);
    expect(plainTelegramLength(text)).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(fitsWeeklyCaption(text)).toBe(false);
  });

  test("граница включительная", () => {
    const footer = plainTelegramLength(["", "", WEEKLY_DRAFT_FOOTER].join("\n"));
    const exact = "я".repeat(TELEGRAM_CAPTION_LIMIT - footer);
    expect(fitsWeeklyCaption(exact)).toBe(true);
    expect(fitsWeeklyCaption(exact + "я")).toBe(false);
  });

  test("мягкий лимит по умолчанию — тот же, которым режет публикатор", () => {
    const text = "я".repeat(TELEGRAM_CAPTION_LIMIT + 200);
    expect(fitsWeeklyCaption(text)).toBe(false);
    expect(fitsWeeklyCaption(text, TELEGRAM_CAPTION_LIMIT + 400)).toBe(true);
  });
});

describe("main() шлёт ровно то, что померили", () => {
  const src = readFileSync(new URL("../tools/weekly-draft.ts", import.meta.url), "utf8");

  test("подпись собирается из общей константы, а не из копии литерала", () => {
    expect(src).toContain('[text, "", WEEKLY_DRAFT_FOOTER].join("\\n")');
    // Литерал футера в файле ровно один — в самой константе. Вторая копия
    // означала бы, что мерка и отправка снова могут разъехаться.
    expect(src.split("ЧЕРНОВИК «Итоги недели»").length - 1).toBe(1);
  });

  test("лимит сообщения из этого файла ушёл совсем", () => {
    expect(src).not.toContain("fitsOneMessage(");
  });
});
