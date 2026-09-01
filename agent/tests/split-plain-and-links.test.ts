/**
 * Аудит 2026-08-12: решение о разрыве принималось по plain, а сам разрыв — по raw.
 *
 * `tgSendPhoto`/`tgSendDocument` спрашивают `plainTelegramLength(caption) > 1000`
 * — правильно, Telegram считает подпись после разбора сущностей. А режет
 * `splitForTelegram`, который меряет `text.length`, то есть сырой markdown с
 * URL'ами внутри. Две беды из одной причины.
 *
 * 1) Разрыв попадает внутрь ссылки. Замер (абзац raw 1032 / plain 991, лимит 1000):
 *
 *      часть 1 …текст текст текст [Подробнее →](https://dela
 *      часть 2 bs.space/digest/9f3c2a1b7) конец
 *
 *    Обе половины парсятся без ошибок — значит плейн-фолбэк не сработает, и
 *    читатель просто видит разорванный посреди URL пост. Тот же `hardSlice`
 *    уже умеет не рвать суррогатную пару, а про ссылку не знает.
 *
 * 2) Части выходят много короче лимита. Замер (18 строк
 *    `• Пункт N [Подробнее →](https://delabs.space/digest/…)`): raw 1295 против
 *    plain 404 — по сырой длине это два куска, по видимой всё влезало в один.
 *    Пост дробится сильнее, чем нужно, ровно там, где его просили оставить
 *    одним сообщением.
 *
 * Инвариант: чем решаем, тем и режем; на срезе не остаётся оборванной ссылки.
 */
import { describe, test, expect } from "bun:test";
import {
  splitForTelegram,
  htmlPartFits,
  TELEGRAM_MESSAGE_HARD_LIMIT,
} from "../lib/telegram-chunking.ts";
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_CAPTION_HARD_LIMIT,
} from "../lib/telegram-actions.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";

const CAPTION_FITS = htmlPartFits(TELEGRAM_CAPTION_LIMIT, TELEGRAM_CAPTION_HARD_LIMIT);

describe("разрыв не попадает внутрь ссылки", () => {
  test("длинный абзац со ссылкой у границы", () => {
    const para =
      "Дайджест дня: " +
      "текст ".repeat(160) +
      "[Подробнее →](https://delabs.space/digest/9f3c2a1b7) конец";
    // Замер из шапки.
    expect(para.length).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);

    const parts = splitForTelegram(para, TELEGRAM_CAPTION_LIMIT);
    // Абзац длиннее лимита обязан разбиться, а не исчезнуть: проверки ниже —
    // это цикл по частям, и на пустом списке они не выполняются ни разу.
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("").replace(/\s+/g, "")).toBe(para.replace(/\s+/g, ""));
    for (const p of parts) {
      expect(p).not.toMatch(/\[[^\]]*$/); // оборванный текст ссылки
      expect(p).not.toMatch(/\]\([^)]*$/); // оборванный URL
    }
    // Ни одна часть не начинается остатком URL.
    for (const p of parts.slice(1)) expect(p).not.toMatch(/^[a-z0-9.\-/]+\)/);
  });

  test("текст не теряется при разбиении", () => {
    const para = "х".repeat(700) + " [ссылка](https://delabs.space/a) " + "у".repeat(700);
    const parts = splitForTelegram(para, TELEGRAM_CAPTION_LIMIT);
    const joined = parts.join(" ").replace(/\s+/g, "");
    expect(joined).toBe(para.replace(/\s+/g, ""));
  });

  test("суррогатная пара по-прежнему не рвётся", () => {
    const src = "🔥".repeat(800);
    const parts = splitForTelegram(src, 1000);
    // Тем же цикл ниже пуст — и «не рвётся» выполнялось бы для нуля частей.
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(src);
    for (const p of parts) {
      const last = p.charCodeAt(p.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      const first = p.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
  });
});

describe("мерка разрыва совпадает с меркой решения", () => {
  const links = Array.from(
    { length: 18 },
    (_, i) =>
      `• Пункт ${i + 1} [Подробнее →](https://delabs.space/digest/2026-08-12-item-${i + 1})`,
  ).join("\n");

  test("замер из шапки: raw вдвое больше plain", () => {
    expect(links.length).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);
    expect(plainTelegramLength(links)).toBeLessThan(TELEGRAM_CAPTION_LIMIT);
  });

  test("продакшен-путь такую подпись вообще не режет", () => {
    // Условие в tgSendPhoto/tgSendDocument — по видимой длине; 404 < 1000,
    // значит splitForTelegram даже не зовётся. Фиксируем, чтобы «мерка решения»
    // не уехала обратно на сырую длину.
    expect(plainTelegramLength(links) > TELEGRAM_CAPTION_LIMIT).toBe(false);
  });

  test("если резать всё-таки пришлось — частей меньше, чем по сырой длине", () => {
    // Сырую длину не отпускаем совсем: плейн-фолбэк sendWithHtml шлёт сырой
    // текст, и часть, влезающая по видимой длине и не влезающая по сырой,
    // превратила бы ошибку разметки в потерянный документ.
    const byRaw = splitForTelegram(links, TELEGRAM_CAPTION_LIMIT);
    const byPlain = splitForTelegram(links, TELEGRAM_CAPTION_LIMIT, CAPTION_FITS);
    // Сравнение «меньше либо равно» верно и для двух пустых списков, а цикл
    // ниже на пустом byPlain не проверяет ничего.
    expect(byRaw.length).toBeGreaterThan(1);
    expect(byPlain.length).toBeGreaterThan(0);
    expect(byPlain.length).toBeLessThanOrEqual(byRaw.length);
    for (const p of byPlain) {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_HARD_LIMIT);
      expect(plainTelegramLength(p)).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    }
  });

  test("части не превышают ни видимый лимит, ни жёсткий лимит Telegram", () => {
    const long = Array.from(
      { length: 90 },
      (_, i) =>
        `• Пункт ${i + 1} [Подробнее →](https://delabs.space/digest/2026-08-12-item-${i + 1})`,
    ).join("\n");
    expect(plainTelegramLength(long)).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);
    const parts = splitForTelegram(long, TELEGRAM_CAPTION_LIMIT, CAPTION_FITS);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(plainTelegramLength(p)).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
      // Плейн-фолбэк sendWithHtml шлёт СЫРОЙ текст: он тоже обязан влезать,
      // иначе ошибка разметки превратится в потерянное сообщение.
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_HARD_LIMIT);
    }
  });

  test("без предиката поведение прежнее — по сырой длине", () => {
    const parts = splitForTelegram(links, TELEGRAM_CAPTION_LIMIT);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
  });

  test("htmlPartFits держит обе границы", () => {
    const fits = htmlPartFits(1000, 1024);
    expect(fits("[тут](https://delabs.space/" + "a".repeat(1100) + ")")).toBe(false);
    expect(fits("[тут](https://delabs.space/a)")).toBe(true);
    expect(fits("я".repeat(1001))).toBe(false);
  });

  test("жёсткий лимит сообщения — 4096", () => {
    expect(TELEGRAM_MESSAGE_HARD_LIMIT).toBe(4096);
    expect(TELEGRAM_CAPTION_HARD_LIMIT).toBe(1024);
  });
});
