/**
 * Аудит 2026-08-14: разбиение отдавало пустые части и пустой результат.
 *
 * Два разных дефекта с общим корнем — правило «пустого сообщения не бывает»
 * жило внутри `flush()`, то есть работало ровно на том пути, что собирает
 * буфер. `hardSlice` кладёт куски в `out` напрямую и этой проверки не видит.
 *
 *  1. Пустые ЧАСТИ. Замер на `"x\n\n" + " ".repeat(5000) + "\n\ny"`: 4 части,
 *     из них 2 состоят целиком из пробелов. Первая уходит в чат, вторая ловит
 *     400 «message text is empty» — действие объявляется неудачным, хотя часть
 *     текста уже доставлена, и ретрай пришлёт «x» вторым экземпляром.
 *  2. Пустой РЕЗУЛЬТАТ. Текст длиннее лимита и целиком из пробелов даёт `[]`,
 *     `sendChunked` не зовёт `send` ни разу и возвращает undefined. Дальше
 *     расходятся три разных вранья: путь юзербота читает `last.message_id` и
 *     падает с TypeError; путь Bot API отдаёт `{ok:true, result:undefined}` —
 *     успех в аудите за неотправленное сообщение; handoff пишет ответ делегата
 *     в историю чата (`sent?.message_id`), которого в чате не было.
 *
 * Вход SEND_MESSAGE закрыт `build-payload` (`String(i.text ?? "").trim()`), но
 * handoff шлёт ответ модели напрямую, и дефект №1 достижим с любого пути:
 * после trim текст не пуст, а пустой становится отдельная часть.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitForTelegram, sendChunked } from "../lib/telegram-chunking.ts";

/** Разделитель из пробелов длиннее лимита — прямой вход в hardSlice. */
const BLANK_BLOCK = `x\n\n${" ".repeat(5000)}\n\ny`;
const ALL_BLANK = `${" ".repeat(2200)}\n\n${" ".repeat(2200)}`;

describe("splitForTelegram не отдаёт пустых частей", () => {
  test("замер из находки: текст режется, пустых кусков не остаётся", () => {
    const parts = splitForTelegram(BLANK_BLOCK);
    expect(parts.filter((p) => !p.trim())).toEqual([]);
    expect(parts).toEqual(["x", "y"]);
  });

  test("содержательный текст не теряется", () => {
    const parts = splitForTelegram(BLANK_BLOCK);
    expect(parts.join("")).toContain("x");
    expect(parts.join("")).toContain("y");
  });

  test("длинная строка из пробелов не даёт ни одной части", () => {
    expect(splitForTelegram(" ".repeat(5000))).toEqual([]);
  });

  test("пустой и пробельный вход — пустой результат, а не часть-пустышка", () => {
    expect(splitForTelegram("")).toEqual([]);
    expect(splitForTelegram("   ")).toEqual([]);
    expect(splitForTelegram("\n\n\t ")).toEqual([]);
  });

  test("теряются только пробелы — ни один непробельный символ не пропадает", () => {
    // Аудит 2026-09-11: выбрасывание пробельного куска — объявленное
    // исключение из правила «отправитель не переписывает текст» (см.
    // комментарий у hardSlice). Исключение стоит держать ровно таким, каким
    // оно объявлено, поэтому граница пинуется числами: на
    // `"A" + " "*9000 + "B"` вход 9002, выход 5002, пропало 4000 пробелов —
    // и ни одной буквы.
    const s = `A${" ".repeat(9000)}B`;
    const parts = splitForTelegram(s);
    const strip = (t: string) => t.replace(/\s+/g, "");
    expect(strip(parts.join(""))).toBe(strip(s));
    expect(s.length - parts.join("").length).toBe(4000);
    expect(parts.every((p) => p.trim().length > 0)).toBe(true);
  });

  test("обычное разбиение не задето", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Абзац ${i}`).join("\n\n");
    const parts = splitForTelegram(long, 400);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.trim().length > 0)).toBe(true);
    expect(parts.join("\n\n")).toBe(long);
  });

  test("длинная строка без переносов по-прежнему режется жёстко", () => {
    const parts = splitForTelegram("а".repeat(1000), 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe("а".repeat(1000));
  });
});

describe("sendChunked не рапортует об успехе за неотправленное", () => {
  test("пустой результат разбиения — явная ошибка, а не undefined", async () => {
    const sends: string[] = [];
    await expect(
      sendChunked(async (t) => {
        sends.push(t);
        return { message_id: sends.length };
      }, ALL_BLANK),
    ).rejects.toThrow("нечего отправлять");
    expect(sends).toHaveLength(0);
  });

  test("успешный путь возвращает последнее отправленное", async () => {
    const sends: string[] = [];
    const last = await sendChunked(async (t) => {
      sends.push(t);
      return { message_id: sends.length };
    }, BLANK_BLOCK);
    // Ровно две непустые части, ни одного вызова с пробелами.
    expect(sends).toHaveLength(2);
    expect(sends.every((s) => s.trim().length > 0)).toBe(true);
    expect(last).toEqual({ message_id: 2 });
  });

  test("одна часть уходит без префикса нумерации", async () => {
    const sends: string[] = [];
    await sendChunked(async (t) => {
      sends.push(t);
      return { message_id: 1 };
    }, "короткий ответ");
    expect(sends).toEqual(["короткий ответ"]);
  });
});

describe("форма исправления", () => {
  const SRC = readFileSync(
    join(import.meta.dir, "..", "lib", "telegram-chunking.ts"),
    "utf8",
  );

  test("hardSlice фильтруется — правило больше не живёт только во flush", () => {
    // Аудит 2026-08-21: форма вызова сменилась с
    // `out.push(...hardSlice(...).filter(...))` на цикл, потому что каждой
    // части теперь надо двигать `carry` (см. withFenceMarkers). Инвариант тот
    // же и проверяется по телу цикла, а не по точному синтаксису: пустые куски
    // отсеиваются НА МЕСТЕ ВЫЗОВА, а не только во flush().
    // ПОПРАВКА 2026-08-28: цикл стал инкрементальным (идёт по `sliceOneEnd`) —
    // жадный hardSlice мерил все куски, кроме первого, с чужой чётностью
    // фенсов. Инвариант тот же и проверяется по телу цикла, а не по форме
    // вызова.
    const at = SRC.indexOf("sliceOneEnd(line, at, limit, fits)");
    expect(at).toBeGreaterThan(-1);
    const end = SRC.indexOf("\n        }", at);
    expect(end).toBeGreaterThan(at);
    expect(SRC.slice(at, end)).toMatch(/piece\.trim\(\)/);
  });

  test("пустой результат проверяется ДО цикла отправки", () => {
    // Ищем внутри самой sendChunked, а не по всему файлу: `for (let i = 0; i <
    // parts.length; i++)` встречается и в balanceFences (аудит 2026-08-19),
    // которая объявлена выше, — по всему файлу проверка сравнивала бы гвард с
    // чужим циклом и стала бы красной, ничего не поймав.
    const fn = SRC.slice(SRC.indexOf("export async function sendChunked"));
    expect(fn.length).toBeGreaterThan(0);
    const guard = fn.indexOf("parts.length === 0");
    const loop = fn.indexOf("for (let i = 0; i < parts.length; i++)");
    expect(guard).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(loop);
  });
});
