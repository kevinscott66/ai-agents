/**
 * Аудит 2026-08-21: подпись к медиа резалась по мерке, которая менялась сразу
 * после решения о резке, и части уезжали выше жёсткого лимита Telegram.
 *
 * `splitForTelegram` режет СЫРОЙ markdown, а `balanceFences` потом дописывает
 * блокам кода недостающие маркеры на швах. Запас под эти маркеры брался
 * длиной — к кандидату приклеивалось `reserve - 1` символов «x»:
 *
 *   const pad = "\n" + "x".repeat(reserve - 1);
 *   fits = (part) => fitsRaw(part + pad);
 *
 * Это компенсировало сами маркеры и НЕ компенсировало главного: закрывашка
 * меняет МЕРКУ. Замер одной и той же ссылки:
 *
 *   вне блока          raw=67  plain=13   ← markdown, считается только якорь
 *   в закрытом блоке   raw=75  plain=67   ← <pre>, считается каждый символ URL
 *   после НЕзакрытого  raw=71  plain=17   ← снова markdown
 *
 * То есть предикат говорил «влезает», глядя на фрагмент с непарным ```, где
 * ссылки меряются по якорю; в чат уезжал уже закрытый блок, где они меряются
 * целиком.
 *
 * Достижимость: подписи к медиа. `tgSendPhoto` (telegram-actions.ts:488) и
 * `tgSendDocument` (:544) режут подпись как
 * `splitForTelegram(caption, TELEGRAM_CAPTION_LIMIT, CAPTION_FITS)`, где
 * `CAPTION_FITS = htmlPartFits(1000)` — мерка чисто plain. Запаса между мягким
 * лимитом 1000 и жёстким пределом Telegram 1024 всего 24 символа.
 *
 * Фаззинг подписи формата наших же отчётов (```-блок с пустой строкой внутри и
 * markdown-ссылками) до правки находил части в 2771 символ, после — 1000.
 *
 * Вред: Bot API отвечает 400 на подпись. Это не ошибка разметки, поэтому
 * плейн-фолбэк `sendWithHtml` не срабатывает (`isHtmlParseError` вернёт false)
 * — файл или картинка не доходит в чат вообще.
 */
import { describe, test, expect } from "bun:test";
import { splitForTelegram, htmlPartFits } from "../lib/telegram-chunking.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";

/** Мягкий лимит подписи в коде и жёсткий предел Bot API. */
const SOFT = 1000;
const HARD = 1024;
const CAPTION_FITS = htmlPartFits(SOFT);

const link = (n: number) =>
  `[ai-agents#${n}](https://github.com/kevinscott66/ai-agents/pull/${n})`;

/** Подпись формата наших отчётов: ```-блок с пустой строкой внутри. */
function report(rows: number, pad = 0): string {
  const lines = Array.from(
    { length: rows },
    (_, i) => `PR #${590 + i} ${link(590 + i)} — готов${"x".repeat(pad)}`,
  );
  return (
    "Отчёт.\n\n```\n" +
    lines.join("\n") +
    "\n\n" +
    lines.join("\n") +
    "\n```\n\nХвост."
  );
}

describe("мерка меняется на закрывашке — это и был дефект", () => {
  test("ссылка вне блока и в блоке меряются по-разному", () => {
    const bare = link(590);
    const fenced = "```\n" + bare + "\n```";
    const unclosed = "```\n" + bare;
    // Вне блока — только якорь.
    expect(plainTelegramLength(bare)).toBeLessThan(bare.length / 2);
    // В закрытом блоке — каждый символ URL: мерка совпадает с сырой длиной.
    expect(plainTelegramLength(fenced)).toBe(bare.length);
    // А после НЕзакрытого — снова как markdown: на этом фрагменте и
    // принималось решение «влезает».
    expect(plainTelegramLength(unclosed)).toBeLessThan(
      plainTelegramLength(fenced) / 2,
    );
  });
});

describe("части подписи не превышают жёсткий предел Telegram", () => {
  test("фаззинг отчёта: ни одна часть не выше 1024", () => {
    let worst = 0;
    let worstAt = "";
    for (let n = 1; n <= 40; n++) {
      for (const pad of [0, 7, 13, 29, 61]) {
        for (const part of splitForTelegram(report(n, pad), SOFT, CAPTION_FITS)) {
          const len = plainTelegramLength(part);
          if (len > worst) {
            worst = len;
            worstAt = `rows=${n} pad=${pad}`;
          }
        }
      }
    }
    // До правки здесь было 2771.
    expect(worst).toBeLessThanOrEqual(HARD);
    expect(`${worst} @ ${worstAt}`).toBe(`${worst} @ ${worstAt}`); // держим контекст в выводе
  });

  test("фаззинг отчёта: ни одна часть не выше мягкого лимита", () => {
    for (let n = 1; n <= 40; n++) {
      for (const part of splitForTelegram(report(n), SOFT, CAPTION_FITS)) {
        expect(plainTelegramLength(part)).toBeLessThanOrEqual(SOFT);
      }
    }
  });

  test("длинный блок с языком у открывашки", () => {
    const body = Array.from({ length: 60 }, (_, i) => `${i} ${link(600 + i)}`);
    const text =
      "Лог:\n\n```json\n" + body.join("\n") + "\n\n" + body.join("\n") + "\n```";
    for (const part of splitForTelegram(text, SOFT, CAPTION_FITS)) {
      expect(plainTelegramLength(part)).toBeLessThanOrEqual(SOFT);
    }
  });
});

describe("текст и оформление не теряются", () => {
  test("все строки блока доезжают", () => {
    const rows = Array.from({ length: 25 }, (_, i) => `PR #${590 + i} ${link(590 + i)} — готов`);
    const text = "Отчёт.\n\n```\n" + rows.join("\n") + "\n\n" + rows.join("\n") + "\n```\n\nХвост.";
    const joined = splitForTelegram(text, SOFT, CAPTION_FITS).join("\n");
    for (const r of rows) expect(joined).toContain(r);
    expect(joined).toContain("Хвост.");
  });

  test("маркеры на швах парные: каждая часть кроме последней закрыта", () => {
    const parts = splitForTelegram(report(25), SOFT, CAPTION_FITS);
    expect(parts.length).toBeGreaterThan(1);
    parts.slice(0, -1).forEach((p) => {
      expect((p.match(/```/g) ?? []).length % 2).toBe(0);
    });
  });
});

describe("тексты без блоков кода режутся как раньше", () => {
  test("простой длинный текст — мерка не тронута", () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Абзац ${i}. ${"слово ".repeat(20)}`);
    const parts = splitForTelegram(paras.join("\n\n"), SOFT, CAPTION_FITS);
    for (const p of parts) expect(plainTelegramLength(p)).toBeLessThanOrEqual(SOFT);
    expect(parts.join(" ")).toContain("Абзац 29.");
  });

  test("короткий текст с блоком остаётся одной частью", () => {
    const t = "Вот код:\n\n```\nconst x = 1;\n```\n\nВсё.";
    expect(splitForTelegram(t, SOFT, CAPTION_FITS)).toEqual([t]);
  });

  test("сырая мерка по умолчанию не сломана", () => {
    const t = "```\n" + "a".repeat(5000) + "\n```";
    for (const p of splitForTelegram(t)) expect(p.length).toBeLessThanOrEqual(4096);
  });
});
