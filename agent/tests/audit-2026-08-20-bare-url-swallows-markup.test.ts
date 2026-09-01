import { describe, expect, it } from "bun:test";
import {
  mdToTelegramHtml,
  mdToUserbotHtml,
} from "../lib/telegram-format.ts";

/**
 * Аудит 2026-08-20: шаг 4b («голые ссылки») забирал в плейсхолдер закрывающий
 * markdown-разделитель, стоящий вплотную к URL.
 *
 * Регулярка ссылки — `[^\s<>"]+`, а `*`, `~` и `|` в этот класс попадают. Для
 * `||спойлер https://delabs.space/a||` в плейсхолдер уезжало
 * `https://delabs.space/a||`, открывающие `||` оставались в тексте без пары,
 * шаг 10 спойлер не собирал — и `<tg-spoiler>` не появлялся.
 *
 * Последствие ровно то, которое этот же файл уже чинил 2026-08-13 (`<spoiler>`
 * против `<tg-spoiler>`): помеченный автором скрытым текст уходит в канал
 * ВИДИМЫМ. Молча — ни 400, ни фолбэка, отправка успешна.
 *
 * Второй, косметический слой: `**жирный https://…**` и `~~зачёркнутый …~~`
 * теряли разметку и показывали читателю литеральные `**` / `~~`.
 */

const URL_A = "https://delabs.space/digest/2026-08-20";
const TAG_URL = "https://delabs.space/tag/_defi_";

describe("аудит 2026-08-20: голая ссылка не должна съедать закрывающий разделитель", () => {
  it("якорь: без ссылки спойлер собирается — значит тест не вакуумный", () => {
    expect(mdToTelegramHtml("||обычный спойлер||")).toBe(
      "<tg-spoiler>обычный спойлер</tg-spoiler>",
    );
  });

  it("спойлер, заканчивающийся ссылкой, остаётся спойлером", () => {
    const out = mdToTelegramHtml(`||Ответ: ${URL_A}||`);
    expect(out).toContain("<tg-spoiler>");
    expect(out).toContain("</tg-spoiler>");
    expect(out).not.toContain("||");
  });

  it("ссылка внутри спойлера доезжает целой, без потерянного хвоста", () => {
    expect(mdToTelegramHtml(`||${URL_A}||`)).toContain(URL_A);
  });

  it("юзербот (путь публикации в канал) тоже получает <spoiler>", () => {
    const out = mdToUserbotHtml(`||Ответ: ${URL_A}||`);
    expect(out).toContain("<spoiler>");
    expect(out).toContain("</spoiler>");
    expect(out).toContain(URL_A);
  });

  it("спойлер с точкой после закрывающих палок тоже собирается", () => {
    const out = mdToTelegramHtml(`||Ответ: ${URL_A}||.`);
    expect(out).toContain("<tg-spoiler>");
    expect(out.endsWith("</tg-spoiler>.")).toBe(true);
    expect(out).toContain(URL_A);
  });

  it("жирный, заканчивающийся ссылкой, остаётся жирным", () => {
    const out = mdToTelegramHtml(`**Читать: ${URL_A}**`);
    expect(out).toBe(`<b>Читать: ${URL_A}</b>`);
  });

  it("зачёркнутый, заканчивающийся ссылкой, остаётся зачёркнутым", () => {
    const out = mdToTelegramHtml(`~~${URL_A}~~`);
    expect(out).toBe(`<s>${URL_A}</s>`);
  });

  it("__жирный__ вокруг ссылки: подчёркивания НЕ трогаем (см. следующий тест)", () => {
    // `__` — единственный разделитель, который реально встречается в конце URL
    // (`/__init__`, вики-пути). Обменять редкий сломанный жирный на редкую
    // битую ссылку — плохая сделка, поэтому здесь разметка теряется осознанно.
    expect(mdToTelegramHtml(`__${URL_A}__`)).toBe(`__${URL_A}__`);
  });

  it("URL с подчёркиваниями на конце не ломается (защита шага 4b жива)", () => {
    expect(mdToTelegramHtml(TAG_URL)).toBe(TAG_URL);
    expect(mdToTelegramHtml("https://delabs.space/py/__init__")).toBe(
      "https://delabs.space/py/__init__",
    );
    expect(mdToTelegramHtml(`[док](${TAG_URL})`)).toBe(
      `<a href="${TAG_URL}">док</a>`,
    );
  });

  it("одиночные `*` и `|` на конце URL не срезаются — граница осознанная", () => {
    // Одиночный разделитель мог бы оказаться частью адреса, а срезанный хвост
    // потом съест курсив шага 9 — и читатель получит ссылку на 404.
    expect(mdToTelegramHtml(`*${URL_A}*`)).toBe(`*${URL_A}*`);
  });

  it("точка ПЕРЕД закрывающим разделителем тоже не мешает", () => {
    expect(mdToTelegramHtml(`**Читать: ${URL_A}.**`)).toBe(
      `<b>Читать: ${URL_A}.</b>`,
    );
  });

  it("обычная хвостовая пунктуация ничего не меняет", () => {
    const src = `См. (ссылка ${URL_A}) далее`;
    expect(mdToTelegramHtml(src)).toBe(src);
    expect(mdToTelegramHtml(`Ссылка: ${URL_A}.`)).toBe(`Ссылка: ${URL_A}.`);
  });

  it("две ссылки в спойлерах подряд не путают индексы плейсхолдеров", () => {
    const out = mdToTelegramHtml(`||${URL_A}|| и ||https://delabs.space/b||`);
    expect(out).toBe(
      `<tg-spoiler>${URL_A}</tg-spoiler> и <tg-spoiler>https://delabs.space/b</tg-spoiler>`,
    );
  });
});
