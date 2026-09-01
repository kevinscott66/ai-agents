/**
 * Аудит 2026-08-28: название и описание канала резались молча.
 *
 * `CREATE_TEAM_CHANNEL` собирал payload как `title: title.slice(0, 128)` и
 * `about: String(i.about).slice(0, 255)`. Числа верные — это лимиты Telegram, —
 * а вот молчание нет: длинное название уезжало в создание канала обрубком, и
 * действие рапортовало `ok:true` с готовым chat_id. Узнать, что имя не то,
 * которое просили, модель не могла ниоткуда.
 *
 * Это прямое противоречие доктрине, выведенной в этом же файле на 300 строк
 * выше (шапка PUBLISH_TEXT_MAX_RAW): «лимит проверяется на тексте, который
 * реально уходит в Telegram, — либо целиком дальше, либо явный отказ». По ней
 * же аудит 2026-08-20 перевёл соседние coverTitle/coverSubtitle со `slice` на
 * отказ (`coverField`), а `coverStyle` и `roles` — на отказ вместо подмены.
 * До `title`/`about` та правка не дошла.
 *
 * Цена здесь выше, чем у обложки, и её называет комментарий в этом же case:
 * «создание канала необратимо, повтор плодит второй». Обрезанный баннер
 * перевыпускают; канал с покалеченным именем удаляет руками владелец, а
 * повторная попытка оставляет в аккаунте два канала.
 *
 * Инвариант: то, что вызывающий дал как название и описание, либо доезжает до
 * Telegram целиком, либо названо в отказе. Молча не укорачивается.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { buildPayload } from "../lib/action-dispatch.ts";

const CTX = { agentKey: "orchestrator", chatId: -1 } as any;

function build(input: Record<string, unknown>) {
  return buildPayload("CREATE_TEAM_CHANNEL" as any, input, CTX);
}

const TITLE_MAX = 128;
const ABOUT_MAX = 255;

const SRC = readFileSync(
  new URL("../lib/dispatch/build-payload.ts", import.meta.url),
  "utf-8",
);

describe("предпосылки", () => {
  test("соседнее поле обложки на том же входе отказывает, а не режет", () => {
    // Ровно та доктрина, которой не хватало title/about: аудит 2026-08-20.
    const r = buildPayload(
      "PUBLISH_TO_CHANNEL" as any,
      { channelId: -100123, text: "пост", coverTitle: "т".repeat(161) },
      CTX,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("160");
  });

  test("необратимость создания канала записана рядом с кодом", () => {
    expect(SRC).toContain("создание канала необратимо");
  });
});

describe("title", () => {
  test("граница включительно: ровно лимит проходит целиком", () => {
    const title = "т".repeat(TITLE_MAX);
    const r = build({ title, roles: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload as any).title).toBe(title);
  });

  test("на символ длиннее — отказ с обеими цифрами", () => {
    const r = build({ title: "т".repeat(TITLE_MAX + 1), roles: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("title");
    expect(r.error).toContain(String(TITLE_MAX + 1));
    expect(r.error).toContain(String(TITLE_MAX));
  });

  test("длинное название не превращается в обрубок с ok:true", () => {
    const r = build({ title: "т".repeat(200), roles: ["smm"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Именно эта подмена и была: 200 символов молча становились 128.
    expect((r as any).payload).toBeUndefined();
  });

  test("длина меряется после trim — пробелы по краям не съедают лимит", () => {
    const title = "т".repeat(TITLE_MAX);
    const r = build({ title: `   ${title}   `, roles: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload as any).title).toBe(title);
  });

  test("короткое название доезжает нетронутым", () => {
    const r = build({ title: "DeLabs Новости", roles: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload as any).title).toBe("DeLabs Новости");
  });
});

describe("about", () => {
  test("отсутствующее описание остаётся пустой строкой", () => {
    const r = build({ title: "Канал", roles: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload as any).about).toBe("");
  });

  test("граница включительно: ровно лимит проходит целиком", () => {
    const about = "о".repeat(ABOUT_MAX);
    const r = build({ title: "Канал", about, roles: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload as any).about).toBe(about);
  });

  test("на символ длиннее — отказ с обеими цифрами", () => {
    const r = build({ title: "Канал", about: "о".repeat(ABOUT_MAX + 1), roles: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("about");
    expect(r.error).toContain(String(ABOUT_MAX + 1));
    expect(r.error).toContain(String(ABOUT_MAX));
  });

  test("описание не укорачивается молча", () => {
    const r = build({ title: "Канал", about: "о".repeat(400), roles: [] });
    expect(r.ok).toBe(false);
  });

  test("отказ по описанию не маскируется под отказ по названию", () => {
    const r = build({ title: "Канал", about: "о".repeat(400), roles: [] });
    if (r.ok) return;
    expect(r.error).not.toContain("title");
  });
});

describe("применение", () => {
  test("молчаливых slice в этом case не осталось", () => {
    const start = SRC.indexOf('case "CREATE_TEAM_CHANNEL"');
    expect(start).toBeGreaterThan(0);
    const end = SRC.indexOf('case "PUBLISH_TO_CHANNEL"', start);
    expect(end).toBeGreaterThan(start);
    // Комментарии срезаем: правка цитирует то, что убрала, и source-guard без
    // этого ломается о собственную документацию (CLAUDE.md, аудит 2026-08-11).
    const block = SRC.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(block).not.toContain("slice(0, 128)");
    expect(block).not.toContain("slice(0, 255)");
  });

  test("лимиты объявлены константами, а не литералами по месту", () => {
    expect(SRC).toContain(`const CHANNEL_TITLE_MAX = ${TITLE_MAX};`);
    expect(SRC).toContain(`const CHANNEL_ABOUT_MAX = ${ABOUT_MAX};`);
  });
});
