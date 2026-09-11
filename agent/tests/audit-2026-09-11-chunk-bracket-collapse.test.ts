/**
 * Аудит 2026-09-11, круг 21: `sliceOneEnd` схлопывал кусок до нескольких
 * символов на любой квадратной скобке в прозе.
 *
 * Условие обрыва ссылки было записано как `open > chunk.lastIndexOf(")")`, то
 * есть сравнивало позицию последней `[` с позицией ЛЮБОЙ круглой скобки во
 * всём куске. Текста без единой круглой скобки в куске достаточно, чтобы
 * справа встало `-1`, и тогда условие выполняется для КАЖДОЙ `[`, стоящей не в
 * нулевой позиции. Никакой ссылки при этом нет.
 *
 * Это ровно тот дефект, который аудит 2026-08-29 уже нашёл и починил этажом
 * выше — в `cutBlock` (`lib/telegram-format.ts`), где в комментарии прямо
 * назван пример «[ANNOUNCED]». `sliceOneEnd` тогда не тронули, хотя правило у
 * обеих обрезок одно. Копия правила, действующая на одном месте из двух, —
 * это уже не правило.
 *
 * Цена наблюдаемая: `sendChunked` отправляет отдельным сообщением счётчик
 * «(1/4)» со строкой «Статус дропа», а следом настоящий текст. Квадратные скобки в
 * новостной прозе канала — статусы дропов, сноски `[1]`, маркеры вложений
 * вида `[файл: …]` — встречаются заметно чаще, чем обрывы ссылок.
 *
 * Само объединение правила в одну функцию сразу и поймало разницу между двумя
 * местами: условие `cutBlock` считало прозой кусок, оканчивающийся на
 * `[подпись]`, — для усечения верно, для разбиения нет, там `(url)` просто
 * уезжает в следующую часть. Инвариант «markdown-ссылка не рвётся посередине»
 * из tests/audit-2026-08-20-hardslice-window.test.ts упал на этом и заставил
 * дописать правилу второй аргумент. Он проверяется в конце файла.
 */
import { describe, test, expect } from "bun:test";
import {
  splitForTelegram,
  HTML_MESSAGE_FITS,
  TELEGRAM_MESSAGE_HARD_LIMIT,
} from "../lib/telegram-chunking.ts";
import { danglingLinkStart } from "../lib/telegram-format.ts";

/** Длинная строка без переносов — единственный путь в `sliceOneEnd`. */
const long = (head: string) => head + "детали дропа и условия участия ".repeat(300);

describe("квадратные скобки в прозе не режут кусок", () => {
  test("статус в скобках не схлопывает первую часть", () => {
    const parts = splitForTelegram(long("Статус дропа [ANNOUNCED] "), 4000, HTML_MESSAGE_FITS);
    // Раньше: первая часть — 13 символов «Статус дропа », и лишнее сообщение.
    expect(parts[0].length).toBeGreaterThan(1000);
    expect(parts[0]).toContain("[ANNOUNCED]");
  });

  test("сноска `[1]` тоже не схлопывает", () => {
    const parts = splitForTelegram(long("Источник [1] подтверждает: "), 4000, HTML_MESSAGE_FITS);
    expect(parts[0].length).toBeGreaterThan(1000);
  });

  test("маркер вложения не схлопывает", () => {
    const parts = splitForTelegram(long("Разбор [файл: report.pdf] "), 4000, HTML_MESSAGE_FITS);
    expect(parts[0].length).toBeGreaterThan(1000);
  });
});

describe("настоящий обрыв ссылки по-прежнему отрезается", () => {
  test("`[текст](url` без закрывающей скобки уезжает в следующую часть", () => {
    // Ссылка кладётся так, чтобы граница куска прошла внутри её url.
    const head = "а".repeat(4050);
    const line = `${head} [условия](https://example.com/${"u".repeat(400)}) хвост`;
    const parts = splitForTelegram(line, 4000, HTML_MESSAGE_FITS);
    expect(parts.length).toBeGreaterThan(1);
    // Половинки ссылки в первой части быть не должно.
    expect(parts[0]).not.toContain("](");
    expect(parts[0]).not.toContain("[условия");
  });

  test("подпись без закрывающей `]` тоже отрезается", () => {
    const head = "б".repeat(4050);
    const line = `${head} [${"т".repeat(400)}] хвост`;
    const parts = splitForTelegram(line, 4000, HTML_MESSAGE_FITS);
    expect(parts[0]).not.toContain("[ттт");
  });
});

describe("границы не сдвинулись", () => {
  test("ни одна часть не превышает жёсткий предел", () => {
    const parts = splitForTelegram(long("Статус [ANNOUNCED] "), 4000, HTML_MESSAGE_FITS);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_HARD_LIMIT);
  });

  test("склейка частей возвращает исходный текст без потерь символов", () => {
    const src = long("Статус дропа [ANNOUNCED] ");
    const parts = splitForTelegram(src, 4000, HTML_MESSAGE_FITS);
    expect(parts.join("").replace(/\s+/g, "")).toBe(src.replace(/\s+/g, ""));
  });
});

/**
 * Правило обрыва одно на два места, но места разные: `cutBlock` выбрасывает
 * хвост совсем, `sliceOneEnd` отдаёт его следующей частью. Кусок,
 * оканчивающийся на `[подпись]`, для первого — законченная проза, для второго
 * — разорванная пополам ссылка, если сразу за ним идёт `(url)`. Различает их
 * только второй аргумент, поэтому он проверяется отдельно от резки.
 */
describe("danglingLinkStart различает усечение и разбиение", () => {
  test("без хвоста `[подпись]` — проза, а не обрыв", () => {
    expect(danglingLinkStart("Дроп подтверждён [ANNOUNCED]")).toBe(-1);
  });

  test("хвост начинается с `(` — та же строка уже обрыв", () => {
    const s = "пункт 7 [Подробнее →]";
    expect(danglingLinkStart(s, "(https://example.com)")).toBe(s.indexOf("["));
  });

  test("скобка не на срезе — хвост ничего не меняет", () => {
    expect(danglingLinkStart("Статус [ANNOUNCED] — детали", "(x)")).toBe(-1);
  });

  test("`](` без закрывающей отрезается и без хвоста", () => {
    const s = "текст [условия](https://example.com/abc";
    expect(danglingLinkStart(s)).toBe(s.indexOf("["));
  });

  test("подпись без `]` — проза, пока хвост не докажет обратное", () => {
    // Круг 32: здесь было зафиксировано обратное — «отрезается и без хвоста».
    // Так ветка объявляла обрывом любую непарную `[`, и в усечении это
    // схлопывало блок до символа перед скобкой (см. докблок danglingLinkStart).
    expect(danglingLinkStart("текст [условия участия")).toBe(-1);
  });

  test("подпись без `]` — обрыв, когда хвост дочитывает `](`", () => {
    const s = "текст [условия участия";
    expect(danglingLinkStart(s, " и сроки](https://example.com)")).toBe(s.indexOf("["));
  });

  test("`]` в хвосте без `(` за ним — всё ещё проза", () => {
    // `]` сам по себе ссылку не делает: без `](` резать нечего.
    expect(danglingLinkStart("список [пункт", " первый] и дальше")).toBe(-1);
  });

  test("перевод строки в хвосте обрывает метку: ссылка не переносится", () => {
    expect(danglingLinkStart("абзац [начало", "\nследующий] (x)")).toBe(-1);
  });

  test("целая ссылка не трогается", () => {
    expect(danglingLinkStart("текст [условия](https://example.com) дальше", "(")).toBe(-1);
  });
});
