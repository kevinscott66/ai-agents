/**
 * Аудит 2026-08-20: `fitsOneMessage` мерил не ту длину.
 *
 * Гейт стоит перед сборкой недельного поста (`buildWeeklyTextFitting`): пока
 * текст не влезает, из него выкидываются самые старые пункты. Мерилась СЫРАЯ
 * длина, а Telegram считает длину после разбора сущностей — `[Подробнее →](url)`
 * весит только видимый текст. Пост состоит из таких ссылок целиком.
 *
 * Замер на обычной неделе (6 новостей + 4 активности, блёрбы по 200): 1995
 * сырых против 1605 «плоских». То есть по сырой длине выкидывались бы пункты,
 * которые на самом деле влезают, — молчаливая потеря содержания.
 *
 * Инвариант: меряем то же, что Telegram, и с честным запасом на футер.
 */
import { describe, test, expect } from "bun:test";
import { fitsOneMessage } from "../lib/delabs-post-templates.ts";
import { CHANNEL_FOOTER } from "../lib/channel-footer.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";
import { TG_MESSAGE_LIMIT } from "../lib/delabs-text.ts";

/** Пункт поста в реальной форме: текст + ссылка «Подробнее». */
function item(chars: number): string {
  return `🔥 **Заголовок**\n${"а".repeat(chars)} [Подробнее →](https://delabs.space/news/ochen-dlinnyj-slug-novosti-2026-08)\n\n`;
}

/**
 * Пост, который РАЗЛИЧАЕТ две мерки: 4300 сырых символов (за лимитом) против
 * 2940 «плоских» (с запасом внутри). Двадцать пунктов по 120 знаков — форма
 * длинного, но совершенно обычного выпуска.
 */
const LINK_HEAVY = item(120).repeat(20);

describe("длина считается так же, как её считает Telegram", () => {
  test("фикстура действительно различает две мерки", () => {
    // Без этого тест ниже прошёл бы и на старой реализации.
    expect(LINK_HEAVY.length).toBeGreaterThan(TG_MESSAGE_LIMIT);
    expect(plainTelegramLength(LINK_HEAVY)).toBeLessThan(TG_MESSAGE_LIMIT - 100);
  });

  test("пост за сырым лимитом, но в пределах плоского — проходит гейт", () => {
    // По старой мерке пункты выкидывались бы, хотя пост влезает целиком.
    expect(fitsOneMessage(LINK_HEAVY)).toBe(true);
  });

  test("URL ссылки не идёт в счёт: сырая длина растёт, вердикт не меняется", () => {
    const short = `${"я".repeat(3900)} [тут](https://x.dev/a)`;
    const long = `${"я".repeat(3900)} [тут](https://x.dev/${"b".repeat(500)})`;
    expect(long.length).toBeGreaterThan(short.length + 400);
    expect(fitsOneMessage(short)).toBe(true);
    expect(fitsOneMessage(long)).toBe(true);
  });

  test("текст без разметки за лимитом не проходит", () => {
    expect(fitsOneMessage("я".repeat(TG_MESSAGE_LIMIT))).toBe(false);
  });

  test("короткий пост проходит", () => {
    expect(fitsOneMessage("🔥 **Заголовок**\n\nКороткий текст.")).toBe(true);
  });
});

describe("запас на футер", () => {
  test("запаса хватает на канонический футер", () => {
    // Ровно на границе по умолчанию: добавление футера обязано остаться в
    // лимите сообщения.
    const body = "я".repeat(TG_MESSAGE_LIMIT - 100);
    expect(fitsOneMessage(body)).toBe(true);
    expect(
      plainTelegramLength(`${body}\n\n${CHANNEL_FOOTER}`),
    ).toBeLessThanOrEqual(TG_MESSAGE_LIMIT);
  });

  test("на символ длиннее — уже не влезает", () => {
    expect(fitsOneMessage("я".repeat(TG_MESSAGE_LIMIT - 99))).toBe(false);
  });

  test("запас задаётся явно", () => {
    const body = "я".repeat(TG_MESSAGE_LIMIT - 10);
    expect(fitsOneMessage(body, 0)).toBe(true);
    expect(fitsOneMessage(body, 20)).toBe(false);
  });
});
