/**
 * Аудит 2026-08-29: «футером» в резке считался любой короткий последний блок.
 *
 * `fitToLimit` при превышении лимита откалывает последний абзац и приклеивает
 * его обратно ПОСЛЕ обрезанного тела — чтобы канонический футер со ссылками
 * пережил обрезку. Признаком футера была одна лишь длина:
 *
 *     const hasFooter = blocks.length > 1 && plainTelegramLength(last) <= 300;
 *
 * У поста без футера (ensureChannelFooter его не навязывает — «не каждый пост
 * дайджест») последний абзац — это вывод. Замер до правки на
 * «Заголовок + длинный абзац + „Ждём аирдроп в сентябре.“», лимит 1024: тело
 * обрезано многоточием, а сразу за многоточием стоит вывод. Читатель видит
 * пост, который выглядит завершённым: многоточие читается как приём, а не как
 * «здесь вырезано». Публикация уже одобрена человеком, и правится текст,
 * который человек утвердил.
 *
 * Что считать футером, в проекте определено ровно один раз — в
 * `lib/channel-footer.ts` («ОДНО определение на всех»). Второе, разъехавшееся
 * определение по длине — тот самый класс, ради которого этот модуль и
 * заводили. Резка теперь спрашивает у него же.
 *
 * Порядок вызовов это позволяет: `dispatch/publish.ts` зовёт
 * `ensureChannelFooter` строкой ВЫШЕ `fitToLimit`, то есть если футер в посте
 * был, к моменту резки он уже канонический.
 */
import { describe, test, expect } from "bun:test";
import { fitToLimit } from "../lib/action-dispatch.ts";
import { CHANNEL_FOOTER, isChannelFooterLine } from "../lib/channel-footer.ts";
import { plainTelegramLength } from "../lib/telegram-format.ts";

const LIMIT = 1024;
const TAIL = "Ждём аирдроп в сентябре.";

function para(n: number): string {
  return "слово ".repeat(Math.ceil(n / 6)).trim().slice(0, n);
}

describe("предпосылки: единое определение футера", () => {
  test("канонический футер узнаётся, обычный вывод — нет", () => {
    expect(CHANNEL_FOOTER.split("\n").some(isChannelFooterLine)).toBe(true);
    expect(isChannelFooterLine(TAIL)).toBe(false);
  });

  test("вывод короче потолка, по которому его прежде считали футером", () => {
    // Иначе тест ничего не проверял бы: он должен ловиться старым признаком.
    expect(plainTelegramLength(TAIL)).toBeLessThanOrEqual(300);
  });
});

describe("короткий вывод — это тело, а не футер", () => {
  const text = `**Итоги недели**\n\n${para(1800)}\n\n${TAIL}`;

  test("вывод не приклеивается к обрезанному телу", () => {
    const out = fitToLimit(text, LIMIT, "smm");
    expect(out).not.toContain(TAIL);
  });

  test("начало поста при этом на месте", () => {
    const out = fitToLimit(text, LIMIT, "smm");
    expect(out.startsWith("**Итоги недели**")).toBe(true);
  });

  test("обрезка по-прежнему видна многоточием и укладывается в лимит", () => {
    const out = fitToLimit(text, LIMIT, "smm");
    expect(out.endsWith("…")).toBe(true);
    expect(plainTelegramLength(out)).toBeLessThanOrEqual(LIMIT);
  });
});

describe("настоящий футер обрезку по-прежнему переживает", () => {
  test("канонический однострочный", () => {
    const out = fitToLimit(`**Итоги недели**\n\n${para(1800)}\n\n${CHANNEL_FOOTER}`, LIMIT, "smm");
    expect(out).toContain("notion.site");
    expect(out.trimEnd().endsWith(CHANNEL_FOOTER)).toBe(true);
    expect(plainTelegramLength(out)).toBeLessThanOrEqual(LIMIT);
  });

  test("рукописный многострочный (💬 над © Copyright)", () => {
    // Блок из двух строк: футерной строкой его делает вторая.
    const footer = "💬 ЧАТ сообщества\n© Copyright 2023-2026 DeLabs";
    const out = fitToLimit(`**Итоги**\n\n${para(1800)}\n\n${footer}`, LIMIT, "smm");
    expect(out).toContain("© Copyright 2023-2026 DeLabs");
    expect(plainTelegramLength(out)).toBeLessThanOrEqual(LIMIT);
  });
});

describe("рабочий путь не задет", () => {
  test("текст в лимите возвращается нетронутым", () => {
    const text = `Заголовок\n\n${para(300)}\n\n${TAIL}`;
    expect(fitToLimit(text, LIMIT, "smm")).toBe(text);
  });

  test("единственный блок без футера режется как раньше", () => {
    const out = fitToLimit(para(1800), LIMIT, "smm");
    expect(plainTelegramLength(out)).toBeLessThanOrEqual(LIMIT);
    expect(out.endsWith("…")).toBe(true);
  });
});
