/**
 * Аудит 2026-08-19: блок кода, разорванный между частями.
 *
 * splitForTelegram режет СЫРОЙ markdown по пустым строкам, а пустая строка
 * внутри фенса — обычное дело (лог, диф, конфиг, вывод команды). Маркеры
 * оставались непарными, mdToTelegramHtml переставал видеть блок вовсе, и код
 * не просто терял моноширинность — он МЕНЯЛСЯ: маркеры показывались буквально,
 * `*b*` становилось курсивом, `# h` жирным, а строка `---` молча исчезала.
 */
import { describe, test, expect } from "bun:test";
import { splitForTelegram, TELEGRAM_MESSAGE_HARD_LIMIT } from "../lib/telegram-chunking.ts";
import { mdToTelegramHtml } from "../lib/telegram-format.ts";

/** Тройной обратный апостроф. Отдельной константой, чтобы не экранировать его
 *  в каждом шаблонном литерале ниже. */
const F = "```";

const BLOCK = Array.from({ length: 60 }, (_, i) => "line " + i + " " + "y".repeat(60)).join("\n");
/** Пустая строка внутри блока — то самое место, по которому идёт резка. */
const LOG = "Вот лог:\n\n" + F + "typescript\n" + BLOCK + "\n\n" + BLOCK + "\n" + F + "\n\nКонец.";

describe("splitForTelegram: блок кода переживает разрез", () => {
  test("каждая часть с кодом — законченный <pre>", () => {
    const parts = splitForTelegram(LOG);
    expect(parts.length).toBeGreaterThan(2); // предпосылка: разрез случился

    let withPre = 0;
    for (const part of parts) {
      const html = mdToTelegramHtml(part);
      const open = (html.match(/<pre>/g) ?? []).length;
      const close = (html.match(/<\/pre>/g) ?? []).length;
      expect(open).toBe(close); // непарных маркеров не осталось
      if (open > 0) withPre++;
      // Осиротевший маркер читателю не показывается.
      expect(html).not.toContain(F);
    }
    // Все части, кроме вступления и хвоста «Конец.», несут код.
    expect(withPre).toBeGreaterThanOrEqual(parts.length - 2);
  });

  test("язык блока переносится в продолжение", () => {
    const parts = splitForTelegram(LOG);
    const reopened = parts.filter((p) => p.startsWith(F + "typescript"));
    expect(reopened.length).toBeGreaterThan(0);
  });

  test("содержимое кода не переформатируется", () => {
    const code = Array.from(
      { length: 40 },
      (_, i) => "const a" + i + " = *b* + _c_; // " + "z".repeat(60),
    ).join("\n");
    const md = F + "\n" + code + "\n\n---\n" + code + "\n" + F;
    const parts = splitForTelegram(md);
    expect(parts.length).toBeGreaterThan(1);
    const html = parts.map(mdToTelegramHtml).join("\n");
    expect(html).not.toContain("<i>b</i>");
    expect(html).toContain("---"); // правило горизонтальной линии до кода не достаёт
  });

  test("запас под маркеры вычитается из лимита, а не добавляется к части", () => {
    // Инвариант функции: часть не длиннее лимита. У подписи к фото между
    // мягким лимитом и жёстким всего 24 символа — дописать маркеры «сверху»
    // означало бы 400 от Telegram.
    for (const limit of [1000, 4000, 137]) {
      const parts = splitForTelegram(LOG, limit);
      for (const p of parts) expect(p.length).toBeLessThanOrEqual(limit);
    }
    for (const p of splitForTelegram(LOG)) {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_HARD_LIMIT);
    }
  });

  test("текст без блоков кода режется ровно как раньше", () => {
    const plain = Array.from(
      { length: 40 },
      (_, i) => "параграф " + i + " " + "а".repeat(200),
    ).join("\n\n");
    const parts = splitForTelegram(plain, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p).not.toContain(F);
    expect(parts.join("\n\n")).toBe(plain);
  });

  test("незакрытый в исходнике блок остаётся незакрытым", () => {
    // Форматтер показывает такой маркер буквально — разрезанный текст обязан
    // выглядеть так же, как неразрезанный, а не «дочиняться» на ходу.
    const md = "Начало:\n\n" + F + "\n" + BLOCK + "\n\n" + BLOCK;
    const parts = splitForTelegram(md);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[parts.length - 1]!.endsWith(F)).toBe(false);
  });
});
