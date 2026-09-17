/**
 * Аудит 2026-09-11: резчик сам создавал закрывашку, после которой содержимое
 * части пропадало из чата целиком.
 *
 * `FENCE_RE` в telegram-chunking.ts считает языком любой прогон
 * `[a-zA-Z0-9_+-]` сразу после ```, без требования перевода строки.
 * `mdToTelegramHtml` требует перевод строки и вдобавок видит метку языка
 * только у ЗАКРЫТОГО блока — а закрывашку у непоследней части дописывает сам
 * `balanceFences`. То есть часть вида "```" + прогон уезжала в Telegram как
 * "```" + прогон + "\n```", форматтер читал ВЕСЬ прогон как метку языка и
 * выбрасывал его: `<pre></pre>`, сообщение уходит успешно, читатель видит
 * пустой блок.
 *
 * Замер на "```" + 8400 символов прогона: видно без резки 8409, после резки
 * 4335 — то есть 4074 символа исходного текста исчезли. Ошибки нет ни в
 * логах, ни в ответе Telegram (400 не приходит, значит и плейн-фолбэк
 * `sendWithHtml` не срабатывает), и повторить нечего: отправка считается
 * успешной.
 *
 * Триггер достижим из недоверенного ввода, который агент цитирует дословно:
 * base64-вложение через READ_FILE, выдача web_search, текст пользователя.
 *
 * Чинится на стороне резчика, а не форматтера: форматтер разбирает исходник
 * верно (в самом тексте блок не закрыт и метки языка там нет), закрывашку
 * придумывает резчик — он и обязан оставить открывашку в том виде, где его
 * же закрывашка ничего не съедает.
 *
 * Прежний тест этого файла-соседа (audit-2026-08-28-chunk-hardslice-stale-carry)
 * пинил только ДЛИНЫ частей, поэтому пропажу содержимого не ловил: пустая
 * часть под лимит проходит идеально.
 */
import { describe, test, expect } from "bun:test";
import { splitForTelegram, htmlPartFits } from "../lib/telegram-chunking.ts";
import { plainTelegramLength, mdToTelegramHtml } from "../lib/telegram-format.ts";

/** Жёсткий предел Bot API для текста сообщения. */
const HARD = 4096;
const FITS = htmlPartFits(HARD);

/** Прогон из символов, которые `FENCE_RE` примет за lang-токен. */
const langRun = (n: number) => {
  const alpha = "aA0_+-";
  let s = "";
  for (let i = 0; i < n; i++) s += alpha[i % alpha.length];
  return s;
};

/** Что увидит читатель: разметка уже разобрана, тегов не видно. */
const visible = (part: string) => mdToTelegramHtml(part).replace(/<[^>]+>/g, "");

/**
 * Только символы алфавита `langRun`. Обёртка, разделители и русский текст
 * отсеиваются, остаётся ровно содержимое — и его можно сверить с исходным
 * посимвольно: равенство ловит и пропажу, и дублирование.
 */
const contentOnly = (s: string) => s.replace(/[^aA0_+\-]/g, "");

/** Содержимое, увиденное читателем во всех частях подряд. */
const seenContent = (parts: string[]) => contentOnly(parts.map(visible).join(""));

describe("резка не съедает содержимое", () => {
  test("прогон сразу после ``` доезжает до читателя целиком", () => {
    const token = langRun(8400);
    const parts = splitForTelegram("```" + token, HARD, FITS);
    expect(parts.length).toBeGreaterThan(1);
    // До правки: видно 8409 без резки и 4335 после неё.
    expect(seenContent(parts)).toBe(token);
  });

  test("ни одна часть не превращается в пустой блок", () => {
    const parts = splitForTelegram("```" + langRun(8400), HARD, FITS);
    for (const p of parts) {
      expect(mdToTelegramHtml(p).replace(/<[^>]+>/g, "").trim()).not.toBe("");
    }
  });

  test("то же с текстом до блока и внутри длинного сообщения", () => {
    for (const n of [4200, 5000, 8400]) {
      const token = langRun(n);
      for (const text of [
        "```" + token,
        "хвост\n\n```" + token,
        "интро\n\n```" + token + "\n\nконец",
      ]) {
        expect(seenContent(splitForTelegram(text, HARD, FITS))).toBe(token);
      }
    }
  });

  test("длины частей при этом остаются под пределом", () => {
    for (const text of [
      "```" + langRun(8400),
      "хвост\n\n```" + langRun(8400),
      "интро\n\n```" + langRun(5000) + "\n\nконец",
    ]) {
      for (const p of splitForTelegram(text, HARD, FITS)) {
        // Только видимая длина: `htmlPartFits` без второго аргумента сырую
        // границу не ставит намеренно — см. её докблок в telegram-chunking.ts.
        expect(plainTelegramLength(p)).toBeLessThanOrEqual(HARD);
      }
    }
  });
});

describe("метка языка", () => {
  test("прогон длиннее MAX_FENCE_LANG не выдаётся за язык на переносе", () => {
    const parts = splitForTelegram("хвост\n\n```" + langRun(8400), HARD, FITS);
    for (const p of parts.slice(1)) {
      const first = p.split("\n")[0]!;
      if (first.startsWith("```")) expect(first).toBe("```");
    }
  });

  test("настоящий язык по-прежнему переносится в следующую часть", () => {
    const line = (n: number) => `const x${n} = ${n}; // строка номер ${n}`;
    const body = Array.from({ length: 400 }, (_, i) => line(i)).join("\n");
    const parts = splitForTelegram("```js\n" + body, HARD, FITS);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts.slice(1)) expect(p.startsWith("```js\n")).toBe(true);
  });
});
