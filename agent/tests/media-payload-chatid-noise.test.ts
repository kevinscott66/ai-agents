/**
 * Аудит 2026-08-12: сигнал об эксфильтрации звучал на КАЖДОЙ генерации картинки.
 *
 * `pinnedChatId` (dispatch/helpers.ts:59) пишет
 * `[security] …: cross-chat target ignored`, когда агент просит отправить
 * результат в чат, отличный от исходного. Это единственная строка, по которой
 * видно попытку унести контент наружу.
 *
 * Сборщики payload'а для картинок ставили `chatId: chatId ?? 0`
 * (dispatch/media.ts:159,180), где `chatId` — это то, что назвала МОДЕЛЬ
 * (build-payload.ts:159-160), а не чат хода. Модель его обычно не называет.
 * Замер:
 *
 *   GENERATE_IMAGE     → payload.chatId = 0
 *   GENERATE_SVG_IMAGE → payload.chatId = 0
 *   SEND_MESSAGE       → payload.chatId = undefined
 *
 * Ноль — не «не указан», а «указан чат 0», и он никогда не равен исходному.
 * То есть обычная генерация обложки давала ровно тот же warn, что реальная
 * попытка увести файл в чужой чат: журнал прода забит ложными срабатываниями,
 * настоящее в них тонет. Остальные 14 действий этой болезни не имеют — они
 * передают `chatId` как есть, включая undefined.
 *
 * Инвариант: `chatId` в payload'е картинок ведёт себя как у всех остальных
 * действий — не назвали, значит undefined; назвали чужой — предупреждение
 * остаётся, потому что это и есть событие, ради которого строка написана.
 */
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import { pinnedChatId } from "../lib/dispatch/helpers.ts";
import { log } from "../lib/log.ts";

const CTX = { triggerMessageId: undefined } as never;
const ORIGIN = -100_930_555;

const build = (type: string, input: Record<string, unknown>) => {
  const r = buildPayload(type as never, input as never, CTX) as
    | { ok: true; payload: { chatId?: number } }
    | { ok: false; error: string };
  if (!r.ok) throw new Error(r.error);
  return r.payload;
};

afterEach(() => {
  spyOn(log, "warn").mockRestore();
});

describe("chatId картинок не подделывается нулём", () => {
  test("замер из шапки: не назвали чат — значит undefined, как у всех", () => {
    expect(build("GENERATE_IMAGE", { prompt: "кот" }).chatId).toBeUndefined();
    expect(build("GENERATE_SVG_IMAGE", { svg: "<svg/>" }).chatId).toBeUndefined();
    // Контроль: соседнее действие всегда вело себя правильно.
    expect(build("SEND_MESSAGE", { text: "привет" }).chatId).toBeUndefined();
  });

  test("названный чат сохраняется — гейт должен его видеть", () => {
    expect(build("GENERATE_IMAGE", { prompt: "кот", chatId: -777 }).chatId).toBe(-777);
    expect(build("GENERATE_SVG_IMAGE", { svg: "<svg/>", chatId: -777 }).chatId).toBe(-777);
  });
});

describe("предупреждение о чужом чате остаётся событием, а не фоном", () => {
  test("обычная генерация больше не поднимает [security]", () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    const payload = build("GENERATE_IMAGE", { prompt: "кот" });
    expect(pinnedChatId(payload.chatId, ORIGIN, "GENERATE_IMAGE")).toBe(ORIGIN);
    expect(warn).not.toHaveBeenCalled();
  });

  test("попытка увести картинку в чужой чат — предупреждение и пиннинг", () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    const payload = build("GENERATE_IMAGE", { prompt: "кот", chatId: -777 });
    expect(pinnedChatId(payload.chatId, ORIGIN, "GENERATE_IMAGE")).toBe(ORIGIN);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("cross-chat target ignored");
  });
});
