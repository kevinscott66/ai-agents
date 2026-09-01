/**
 * Аудит 2026-08-28: доказательство потолка подписи считало не все слагаемые.
 *
 * `buildWeeklyTextFitting` ужимал пост, выбрасывая пункты, и на последней
 * ступени сдавался с комментарием: «пост из одной новости и одной активности
 * при полностью забитых полях даёт максимум 1002 знака, до жёсткого потолка
 * 1024 запас есть всегда». Перечисление в этом доказательстве покрывало только
 * капы `oneLine` (90 / 200 / 80 / 200 / 200) — и мимо него прошли два
 * слагаемых: ширина маркера пункта и ширина диапазона дат, который на стыке
 * годов вдвое длиннее («6 — 12 июля 2026» против «28 декабря 2026 — 3 января
 * 2027»). Цена ошибки — не косметика: подпись сверх 1024 это
 * `MEDIA_CAPTION_TOO_LONG` от `sendFile`, `fail("preview send failed", 1)`,
 * отпущенный замок и невышедший выпуск.
 *
 * Правка не уточняет арифметику, а убирает зависимость от неё: у ужимателя
 * появилась настоящая последняя ступень — блок планов.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildWeeklyTextFitting, fitsWeeklyCaption } from "../tools/weekly-draft.ts";
import { buildWeeklyRecapText } from "../lib/delabs-post-templates.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";
import { TELEGRAM_CAPTION_HARD_LIMIT } from "../lib/telegram-actions.ts";

/** Воскресенье недели, которая начинается в прошлом году. */
const YEAR_EDGE = new Date("2027-01-03T12:00:00.000Z");
/** Обычная неделя внутри одного месяца — самый короткий возможный диапазон. */
const MID_MONTH = new Date("2026-07-12T12:00:00.000Z");

/** Маркер в четыре единицы UTF-16 — максимум, который пропускает `itemEmoji`. */
const WIDE_MARKER = "👍🏻";

const AHEAD = "п".repeat(200);

/**
 * Ссылки — часть худшего случая, а не украшение: `moreLink` добавляет к пункту
 * подпись «Подробнее →», которую `plainTelegramLength` считает целиком, и у
 * карточек сайта `url` есть всегда. Без них те же данные дают 983 знака вместо
 * 1002 — то есть измерение без ссылок промахивается мимо порога.
 */
const MORE_URL = "https://delabs.space/digest/1";

function worstCase(weekEnd: Date, ahead: string | undefined = AHEAD) {
  return {
    news: [{ emoji: WIDE_MARKER, title: "з".repeat(90), blurb: "б".repeat(200), url: MORE_URL }],
    activities: [
      { emoji: WIDE_MARKER, project: "п".repeat(80), done: "с".repeat(200), url: MORE_URL },
    ],
    ahead,
    weekEnd,
  };
}

describe("предпосылки: чего не было в доказательстве", () => {
  test("диапазон дат на стыке годов вдвое шире обычного", () => {
    const width = (d: Date) =>
      buildWeeklyRecapText({ news: [{ title: "t", blurb: "b" }], weekEnd: d }).split("\n")[1]!
        .length;
    expect(width(MID_MONTH)).toBe(16);
    expect(width(YEAR_EDGE)).toBe(31);
  });

  test("минимальный пост с планами не влезал в мягкий лимит ни в какую неделю", () => {
    // Ровно та ситуация, в которой цикл доходил до терминальной ветки: резать
    // больше нечего, и прежний код возвращал текст как есть.
    for (const weekEnd of [MID_MONTH, YEAR_EDGE]) {
      expect(fitsWeeklyCaption(buildWeeklyRecapText(worstCase(weekEnd)))).toBe(false);
    }
  });
});

describe("ступень планов", () => {
  test("худший случай теперь влезает в мягкий лимит, а не «почти в жёсткий»", () => {
    for (const weekEnd of [MID_MONTH, YEAR_EDGE]) {
      const out = buildWeeklyTextFitting(worstCase(weekEnd));
      expect(fitsWeeklyCaption(out)).toBe(true);
      expect(plainTelegramLength(out)).toBeLessThan(TELEGRAM_CAPTION_HARD_LIMIT);
    }
  });

  test("выброшен именно блок планов, остальное на месте", () => {
    const out = buildWeeklyTextFitting(worstCase(YEAR_EDGE));
    expect(out).not.toContain(AHEAD);
    expect(out).toContain("з".repeat(90));
    expect(out).toContain("п".repeat(80));
  });

  test("планы, которые влезают, не трогаются", () => {
    const out = buildWeeklyTextFitting({
      news: [{ emoji: "🔥", title: "Заголовок", blurb: "Короткий блёрб." }],
      activities: [{ emoji: "⚡️", project: "Проект", done: "Прошли тестнет." }],
      ahead: "На следующей неделе — разбор трёх сетей.",
      weekEnd: MID_MONTH,
    });
    expect(out).toContain("На следующей неделе — разбор трёх сетей.");
    expect(fitsWeeklyCaption(out)).toBe(true);
  });

  test("порядок ступеней: пункты уходят раньше планов", () => {
    // Шесть новостей и планы: ужимателю есть что резать до планов, и он режет
    // именно пункты — иначе выпуск терял бы анонс на пустом месте.
    const out = buildWeeklyTextFitting({
      news: Array.from({ length: 6 }, (_, i) => ({
        title: `Новость ${i} ${"з".repeat(60)}`,
        blurb: "б".repeat(120),
      })),
      activities: [{ project: "Проект", done: "Прошли тестнет." }],
      ahead: "Планы на неделю.",
      weekEnd: MID_MONTH,
    });
    expect(out).toContain("Планы на неделю.");
    expect(out).toContain("Новость 0");
    expect(out).not.toContain("Новость 5");
    expect(fitsWeeklyCaption(out)).toBe(true);
  });

  test("пустой ввод по-прежнему даёт пустую строку, а не бесконечный цикл", () => {
    expect(buildWeeklyTextFitting({ news: [], activities: [], weekEnd: MID_MONTH })).toBe("");
  });

  test("недостижимый лимит завершает цикл, а не крутит его", () => {
    // Без планов ужимать уже нечего: терминальная ветка обязана вернуть текст.
    const out = buildWeeklyTextFitting(worstCase(YEAR_EDGE, undefined));
    expect(out).toContain("з".repeat(90));
  });
});

describe("применение", () => {
  const SRC = readFileSync(new URL("../tools/weekly-draft.ts", import.meta.url), "utf-8");
  const CODE = SRC.split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  test("планы стали изменяемой ступенью, а не константой аргумента", () => {
    expect(CODE).toContain("let ahead = args.ahead;");
    expect(CODE).toContain("else if (ahead) ahead = undefined;");
    // Прежний вызов передавал `args.ahead` напрямую — тогда ступень была бы
    // мёртвой: сброс переменной не доезжал бы до сборки текста.
    expect(CODE).not.toContain("ahead: args.ahead");
    expect(CODE).toContain("buildWeeklyRecapText({ news, activities, ahead, weekEnd: args.weekEnd })");
  });
});
