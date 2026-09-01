/**
 * Аудит 2026-08-12: правка резалась по сырой длине вопреки правилу своего же файла.
 *
 * Шапка `lib/telegram-actions.ts` (строки 38-42) требует мерить длину
 * `plainTelegramLength` — после Markdown→HTML, потому что именно столько видит
 * Telegram, когда мы шлём с `parse_mode`. `tgEditMessage` мерил
 * `args.text.length` и резал `slice(0, 3999)`.
 *
 * Замер (60 строк `Пункт N: [подробности](https://github.com/kevinscott66/ai-agents/pull/…)`):
 *
 *   raw   = 4550   ← по этому резали
 *   plain = 1310   ← столько на самом деле видит Telegram, влезает трижды
 *
 * Итог: 119 видимых символов выброшены без причины, а срез попадает внутрь
 * ссылки — `…[подробности](https://github.com/kevinscott66/` + «…». Разметка при
 * этом остаётся валидной (конвертер просто не узнаёт оборванную ссылку), значит
 * ошибки парсинга нет и плейн-фолбэк не срабатывает: пользователь видит
 * обрубленный URL и считает это правкой. Плюс `slice` по code units рвёт
 * суррогатную пару — `"a"*3998 + "🔥"` кончается одиноким `d83d`, — тогда как
 * соседи (`hardSlice`, `cutBlock`) от этого защищены.
 *
 * Инвариант: чем мерим, тем и режем; режем по символам, а не по code units.
 */
import { describe, test, expect } from "bun:test";
import { tgEditMessage } from "../lib/telegram-actions.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";

const TELEGRAM_EDIT_LIMIT = 4000;

function linkyText(n: number) {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(
      `Пункт ${i}: [подробности](https://github.com/kevinscott66/ai-agents/pull/${300 + i})`,
    );
  }
  return out.join("\n");
}

function fakeTg(sent: Array<{ text: string; pm?: string }>) {
  return {
    editMessageText: async (
      _chat: number,
      _msg: number,
      _inline: undefined,
      text: string,
      extra?: { parse_mode?: string },
    ) => {
      sent.push({ text, pm: extra?.parse_mode });
      return { message_id: 1 };
    },
  } as never;
}

describe("tgEditMessage: мерка длины", () => {
  test("размеченный текст, влезающий по видимой длине, не режется", async () => {
    const text = linkyText(60);
    // Замер из шапки — фиксируем, иначе тест перестанет проверять тот случай.
    expect(text.length).toBeGreaterThan(TELEGRAM_EDIT_LIMIT);
    expect(plainTelegramLength(text)).toBeLessThan(TELEGRAM_EDIT_LIMIT);

    const sent: Array<{ text: string; pm?: string }> = [];
    const r = await tgEditMessage(fakeTg(sent), {
      chatId: -100,
      messageId: 7,
      text,
    });
    expect(r).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.pm).toBe("HTML");
    // Ни одна ссылка не оборвана: последний пункт дошёл целиком.
    expect(sent[0]!.text).toContain("pull/360");
    expect(sent[0]!.text).not.toContain("…");
  });

  test("текст, длинный и по видимой длине, всё-таки режется", async () => {
    const text = "я".repeat(5000);
    expect(plainTelegramLength(text)).toBeGreaterThan(TELEGRAM_EDIT_LIMIT);
    const sent: Array<{ text: string; pm?: string }> = [];
    const r = await tgEditMessage(fakeTg(sent), {
      chatId: -100,
      messageId: 7,
      text,
    });
    expect(r).toEqual({ ok: true, truncated: true });
    expect(plainTelegramLength(sent[0]!.text)).toBeLessThanOrEqual(
      TELEGRAM_EDIT_LIMIT,
    );
    expect(sent[0]!.text.endsWith("…")).toBe(true);
  });

  test("срез не оставляет половину суррогатной пары", async () => {
    // Замер из шапки: срез на 3999 попадает ровно в середину первой пары.
    const text = "a".repeat(3998) + "🔥".repeat(200);
    const sent: Array<{ text: string; pm?: string }> = [];
    await tgEditMessage(fakeTg(sent), { chatId: -100, messageId: 7, text });
    const out = sent[0]!.text;
    for (let i = 0; i < out.length; i++) {
      const c = out.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = out.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
      if (c >= 0xdc00 && c <= 0xdfff) {
        const prev = out.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
  });

  test("срез не оставляет оборванную ссылку", async () => {
    const text =
      "б".repeat(3900) +
      " " +
      "[подробности](https://github.com/kevinscott66/ai-agents/pull/999) ".repeat(20);
    const sent: Array<{ text: string; pm?: string }> = [];
    await tgEditMessage(fakeTg(sent), { chatId: -100, messageId: 7, text });
    const out = sent[0]!.text;
    // Всякая открывающая скобка ссылки закрыта — иначе в чате висит голый URL.
    const opens = (out.match(/\[/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    expect(closes).toBeGreaterThanOrEqual(opens);
    expect(out).not.toMatch(/\[[^\]]*$/);
    expect(out).not.toMatch(/\]\([^)]*$/);
  });

  test("короткий текст не трогается вовсе", async () => {
    const sent: Array<{ text: string; pm?: string }> = [];
    const r = await tgEditMessage(fakeTg(sent), {
      chatId: -100,
      messageId: 7,
      text: "**готово**",
    });
    expect(r).toEqual({ ok: true });
    expect(sent[0]!.text).toBe("<b>готово</b>");
  });
});
