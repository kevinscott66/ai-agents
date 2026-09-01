/**
 * Аудит 2026-08-11: `fitToLimit` — последняя инстанция перед публикацией в
 * канал. Через неё проходит каждый пост: сначала под лимит сообщения (4096),
 * потом, если есть обложка, под лимит подписи (2048 у Premium). Её контракт —
 * «текст гарантированно влезает» — и вызывающий код на него опирается: дальше
 * никаких проверок нет, текст уходит в Telegram как есть.
 *
 * Контракт не выполнялся. Резка шла ТОЛЬКО целыми блоками (абзацами через
 * пустую строку) и только пока блоков больше одного:
 *
 *     while (body.length > 1 && plain(assemble(body)) > limit) body.pop();
 *
 * Отсюда две разные беды, обе на правдоподобном входе — замер до фикса, лимит
 * 2048:
 *
 * 1. Пост, написанный ОДНИМ абзацем (с футером или без), не резался вообще:
 *    вход 3630 → выход 3630, на 1582 символа выше лимита. Дальше это уходит в
 *    Telegram и получает 400 «message is too long» — публикация теряется
 *    целиком. Лог при этом рапортует «обрезал до 3630», то есть выглядит как
 *    успех.
 *
 * 2. «Заголовок + один длинный абзац + футер»: вход 3631 → выход 30. Единственный
 *    содержательный блок выбрасывался целиком, и в канал уходил заголовок с
 *    футером и без текста. Это хуже отказа: отказ виден, а пустой пост
 *    подписчики уже получили.
 *
 * Инвариант: результат всегда в лимите И сохраняет столько текста, сколько в
 * лимит помещается.
 */
import { describe, test, expect } from "bun:test";
import { fitToLimit } from "../lib/action-dispatch.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";
import { CHANNEL_FOOTER } from "../lib/channel-footer.ts";

const LIMIT = 2048;
// Аудит 2026-08-29: здесь стояла выдуманная строка «🔗 Подписаться:
// t.me/delabsru». Футером её не считает `channel-footer.ts` — единственное
// место, где в проекте определено, что такое футер, — а `fitToLimit` считал,
// потому что смотрел только на длину последнего блока. Теперь он спрашивает у
// того же модуля, и тесты обязаны работать на настоящем футере: иначе они
// продолжали бы фиксировать поведение, которого в канале не бывает.
const FOOTER = CHANNEL_FOOTER;

/** Абзац примерно на `n` символов plain-текста. */
function para(n: number): string {
  return "слово ".repeat(Math.ceil(n / 6)).trim().slice(0, n);
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

describe("fitToLimit: результат всегда в лимите", () => {
  const CASES: { name: string; text: string }[] = [
    { name: "один абзац без футера", text: para(3600) },
    { name: "один абзац с футером", text: `${para(3600)}\n\n${FOOTER}` },
    { name: "заголовок + огромный абзац + футер", text: `Итоги недели\n\n${para(3600)}\n\n${FOOTER}` },
    {
      name: "много блоков",
      text:
        Array.from({ length: 30 }, (_, i) => `Пункт ${i}\n${para(180)}`).join("\n\n") +
        `\n\n${FOOTER}`,
    },
    { name: "одна строка без пробелов", text: "я".repeat(3600) },
    { name: "текст из эмодзи", text: "🚀".repeat(1800) },
    { name: "блок с ссылками", text: Array.from({ length: 90 }, (_, i) => `[пункт ${i}](https://example.com/very/long/path/${i})`).join(" ") },
  ];

  for (const { name, text } of CASES) {
    test(name, () => {
      const out = fitToLimit(text, LIMIT, "smm");
      expect(plainTelegramLength(out)).toBeLessThanOrEqual(LIMIT);
      expect(hasLoneSurrogate(out)).toBe(false);
    });
  }

  test("текст в лимите возвращается нетронутым", () => {
    const text = `Заголовок\n\n${para(500)}\n\n${FOOTER}`;
    expect(fitToLimit(text, LIMIT, "smm")).toBe(text);
  });
});

describe("fitToLimit: сохраняет содержание, а не только заголовок", () => {
  test("длинный абзац подрезается, а не выбрасывается целиком", () => {
    // Было: 3631 → 30 символов, в канал уходил заголовок с футером без текста.
    const text = `Итоги недели\n\n${para(3600)}\n\n${FOOTER}`;
    const out = fitToLimit(text, LIMIT, "smm");
    // Занимаем лимит осмысленно: не меньше половины бюджета.
    expect(plainTelegramLength(out)).toBeGreaterThan(LIMIT / 2);
    expect(out).toContain("Итоги недели");
  });

  test("футер со ссылками переживает обрезку", () => {
    const text = `${para(3600)}\n\n${FOOTER}`;
    const out = fitToLimit(text, LIMIT, "smm");
    expect(out.trimEnd().endsWith(FOOTER)).toBe(true);
  });

  test("обрезанный текст помечен многоточием", () => {
    const out = fitToLimit(para(3600), LIMIT, "smm");
    expect(out.endsWith("…")).toBe(true);
  });

  test("не остаётся оборванной markdown-ссылки", () => {
    // Ссылка, разрезанная посередине, превращается в сломанный HTML на выходе
    // конвертера — это 400 «can't parse entities», то есть снова потерянный пост.
    const text = Array.from(
      { length: 120 },
      (_, i) => `[пункт номер ${i}](https://example.com/a/very/long/path/segment/${i})`,
    ).join(" ");
    const out = fitToLimit(text, LIMIT, "smm");
    const lastOpen = out.lastIndexOf("[");
    const lastClose = out.lastIndexOf(")");
    expect(lastOpen).toBeLessThan(lastClose);
  });

  test("последний блок — не футер, а тело: заголовок не теряется", () => {
    // Футер опционален (ensureChannelFooter не навязывает его не-дайджестам).
    // «Последний блок = футер» превращало пост «заголовок + один абзац» в
    // body=[заголовок] и «футер» на 1800 символов: заголовок вместе с таким
    // хвостом в лимит не влезал, отбрасывался, и наружу уходил обезглавленный
    // кусок текста. Замер до правки, лимит 1024: выход начинался со «слово».
    const out = fitToLimit(`**Итоги недели**\n\n${para(1800)}`, 1024, "smm");
    expect(plainTelegramLength(out)).toBeLessThanOrEqual(1024);
    expect(out.startsWith("**Итоги недели**")).toBe(true);
  });

  test("не остаётся непарного ** или `", () => {
    const text = Array.from({ length: 200 }, (_, i) => `**жирный ${i}** и \`код ${i}\``).join(" ");
    const out = fitToLimit(text, LIMIT, "smm");
    expect((out.match(/\*\*/g) ?? []).length % 2).toBe(0);
    expect((out.match(/`/g) ?? []).length % 2).toBe(0);
  });
});
