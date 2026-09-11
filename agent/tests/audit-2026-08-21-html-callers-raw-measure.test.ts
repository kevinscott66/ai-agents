/**
 * Аудит 2026-08-21: отправители с `parse_mode: "HTML"` резали ответ по СЫРОЙ
 * длине.
 *
 * `sendChunked` зовёт `splitForTelegram(text)` без мерки, то есть по
 * `s.length <= 4000`. Но `[текст](url)` весит в сыром markdown весь URL, а в
 * чате — только якорь. Замер на отчёте из 45 строк
 * `- [ai-agents#NNN](https://github.com/kevinscott66/ai-agents/pull/NNN) — …`:
 * сырая длина 4916, видимая 2486. По сырой мерке это ТРИ сообщения с
 * префиксами «(1/3)», по видимой — одно.
 *
 * Ровно этот разбор уже сделан для подписи к фото (`CAPTION_FITS`,
 * telegram-actions.ts, аудит 2026-08-19): сырая граница снимается там, где у
 * плейн-фолбэка есть своя мерка, потому что дробление видит каждый читатель, а
 * обрезка живёт в ветке, срабатывающей только на невалидном HTML от нашего же
 * конвертера — и пишет предупреждение в лог.
 *
 * Что НЕ меняется: сырые отправители. `admin-commands.ts:218` шлёт
 * `telegrafCtx.reply(t)` без parse_mode, а юзербот
 * (`buildHandle().sendMessage` в `userbot.ts`) зовёт
 * gramjs `client.sendMessage(peer, {message: text})` — тоже без разметки. Для
 * них сырая длина и есть та, что считает Telegram, и мерку им менять нельзя.
 * Отдельно важно для юзербота: на нём висит гвард ёмкости
 * (`dispatch/telegram.ts:118`), который отказывает ЦЕЛИКОМ, если частей больше
 * свободного лимита, — занижение счёта там открыло бы обрыв на середине.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleSendMessage } from "../lib/dispatch/telegram.ts";
import {
  sendChunked,
  splitForTelegram,
  htmlPartFits,
  HTML_MESSAGE_FITS,
  TELEGRAM_MESSAGE_HARD_LIMIT,
} from "../lib/telegram-chunking.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";
import { _resetFloodCooldowns } from "../lib/userbot-flood.ts";

/** Отчёт со ссылками: сырая длина вдвое больше видимой. */
const REPORT = `Отчёт по PR.\n\n${Array.from(
  { length: 45 },
  (_, i) =>
    `- [ai-agents#${500 + i}](https://github.com/kevinscott66/ai-agents/pull/${500 + i}) — короткое описание изменения номер ${i}`,
).join("\n")}\n\nИтого.`;

const CTX = { agentKey: "orchestrator", chatId: -4242 };

describe("замер из находки", () => {
  test("у отчёта со ссылками сырая длина вдвое больше видимой", () => {
    // 4916 против 2486: URL весит в сыром markdown, а в чате его не видно.
    expect(REPORT.length).toBeGreaterThan(4000);
    expect(plainTelegramLength(REPORT)).toBeLessThan(REPORT.length / 1.8);
    expect(plainTelegramLength(REPORT)).toBeLessThan(4000);
  });

  test("сырая мерка даёт три части там, где видимая даёт одну", () => {
    expect(splitForTelegram(REPORT).length).toBe(3);
    expect(splitForTelegram(REPORT, 4000, htmlPartFits(4000)).length).toBe(1);
  });
});

describe("HTML-отправители меряют видимую длину", () => {
  test("SEND_MESSAGE через Bot API: одно сообщение вместо трёх", async () => {
    const sent: { text: string; extra: any }[] = [];
    const out: any = await handleSendMessage({ text: REPORT } as any, {
      ...CTX,
      telegram: {
        async sendMessage(_chatId: any, text: string, extra: any) {
          sent.push({ text, extra });
          return { message_id: sent.length };
        },
      } as any,
    } as any);

    expect(out.ok).toBe(true);
    expect(sent).toHaveLength(1);
    // Одна часть — значит и префикса нумерации быть не должно.
    expect(sent[0]!.text).not.toContain("(1/");
    expect(sent[0]!.extra?.parse_mode).toBe("HTML");
  });

  test("текст доезжает целиком", async () => {
    const sent: string[] = [];
    await handleSendMessage({ text: REPORT } as any, {
      ...CTX,
      telegram: {
        async sendMessage(_c: any, text: string) {
          sent.push(text);
          return { message_id: sent.length };
        },
      } as any,
    } as any);
    const all = sent.join("");
    expect(all).toContain("ai-agents#500");
    expect(all).toContain("ai-agents#544");
    expect(all).toContain("Итого.");
  });

  test("общая мерка HTML_MESSAGE_FITS — видимая длина под мягким лимитом", () => {
    expect(HTML_MESSAGE_FITS(REPORT)).toBe(true);
    // Видимой длины 4001 уже не пропускает.
    expect(HTML_MESSAGE_FITS("я".repeat(4001))).toBe(false);
    expect(HTML_MESSAGE_FITS("я".repeat(4000))).toBe(true);
  });
});

describe("сырые отправители не тронуты", () => {
  test("sendChunked без мерки режет по-старому", async () => {
    const sent: string[] = [];
    await sendChunked(async (t) => {
      sent.push(t);
      return { message_id: sent.length };
    }, REPORT);
    expect(sent).toHaveLength(3);
    // Счётчик отбит переводом строки, а не пробелом: разбор «почему» — в
    // audit-2026-09-11-chunk-counter-anchors-markdown.
    expect(sent[0]).toContain("(1/3)\n");
  });

  test("sendChunked с меркой шлёт одним сообщением", async () => {
    const sent: string[] = [];
    await sendChunked(
      async (t) => {
        sent.push(t);
        return { message_id: sent.length };
      },
      REPORT,
      undefined,
      HTML_MESSAGE_FITS,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("(1/");
  });

  test("юзербот считает части по сырой длине — гвард ёмкости не занижается", async () => {
    _resetFloodCooldowns();
    const sent: string[] = [];
    const out: any = await handleSendMessage(
      { text: REPORT, via_userbot: true } as any,
      {
        ...CTX,
        userbot: {
          isNoop: false,
          async sendMessage(_c: any, text: string) {
            sent.push(text);
            return { message_id: sent.length };
          },
        } as any,
      } as any,
    );
    expect(out.ok).toBe(true);
    // gramjs шлёт `message: text` без parse_mode — видимой длины там нет.
    expect(sent).toHaveLength(3);
  });
});

describe("плейн-фолбэк прикрыт своей меркой", () => {
  test("часть под видимым лимитом может быть длиннее жёсткого сырого", () => {
    // Это и есть цена снятия сырой границы: на плейн-пути Telegram считает
    // символы как есть. Поэтому у КАЖДОГО HTML-отправителя третьим аргументом
    // sendWithHtml обязана стоять messagePlainFits — она обрежет с записью в
    // лог. Здесь фиксируем сам факт: без неё часть не влезла бы.
    const one = splitForTelegram(REPORT, 4000, HTML_MESSAGE_FITS);
    expect(one).toHaveLength(1);
    expect(one[0]!.length).toBeGreaterThan(TELEGRAM_MESSAGE_HARD_LIMIT);
  });
});

describe("форма: мерка стоит у каждого HTML-отправителя, и только у них", () => {
  const read = (rel: string) =>
    readFileSync(join(import.meta.dir, "..", rel), "utf8")
      // Комментарии здесь именно что называют константу по имени — без снятия
      // проверка была бы зелёной от одного упоминания в пояснении.
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, pre) => pre);

  const HTML_SENDERS = ["lib/handoff.ts", "orchestrator/message-handler.ts"];

  /**
   * Именно СЧЁТ, а не `toContain`: одного вхождения хватает импорту, и проверка
   * оставалась бы зелёной после удаления самого вызова. Проверено мутацией.
   */
  const uses = (code: string, id: string) => code.split(id).length - 1;

  test.each(HTML_SENDERS)("%s передаёт мерку в sendChunked", (rel) => {
    const code = read(rel);
    expect(code).toContain("sendChunked("); // контроль: файл прочитан и не выеден
    expect(code).toContain("sendWithHtml("); // предпосылка: путь действительно HTML
    expect(uses(code, "HTML_MESSAGE_FITS")).toBeGreaterThanOrEqual(2);
  });

  test.each(HTML_SENDERS)("%s прикрывает плейн-фолбэк своей меркой", (rel) => {
    // Цена снятия сырой границы: фолбэк шлёт СЫРОЙ текст, и без messagePlainFits
    // часть с видимой длиной 4000 и сырой 4916 не влезет в жёсткий лимит.
    expect(uses(read(rel), "messagePlainFits")).toBeGreaterThanOrEqual(2);
  });

  test("сырые отправители мерку не берут", () => {
    // admin-commands шлёт telegrafCtx.reply(t) без parse_mode.
    const code = read("lib/admin-commands.ts");
    expect(code).toContain("sendChunked(");
    expect(code).not.toContain("HTML_MESSAGE_FITS");
  });
});
