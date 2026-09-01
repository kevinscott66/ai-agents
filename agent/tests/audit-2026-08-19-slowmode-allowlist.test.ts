/**
 * Аудит 2026-08-19, вторая партия.
 *
 *  1. Слоумод чата принимался за FLOOD_WAIT аккаунта. У gramjs это соседние
 *     классы одного предка (`FloodError`) с одинаковым числовым `.seconds`, а
 *     кулдаун наверху заведён на characterId БЕЗ чата: штатный слоумод в одной
 *     группе затыкал роли юзербот во всех чатах сразу.
 *  2. Границу чатов в диагностической точке входа `orchestrator-userbot.ts`
 *     проходила подстрока, а пустой allowlist открывал вообще всё (fail-open) —
 *     при том, что юзербот работает от личного аккаунта владельца.
 */
import { describe, test, expect } from "bun:test";
import {
  isFloodWaitError,
  parseFloodWaitSeconds,
  isSlowModeWaitError,
  parseSlowModeWaitSeconds,
} from "../lib/flood-wait-error.ts";
import { canonicalChatId } from "../lib/userbot.ts";

/** Копия формы gramjs: см. node_modules/telegram/errors/RPCErrorList.js. */
class SlowModeWaitError extends Error {
  seconds: number;
  constructor(seconds: number) {
    super(
      `A wait of ${seconds} seconds is required before sending another message in this chat`,
    );
    this.seconds = seconds;
  }
}
class FloodWaitError extends Error {
  seconds: number;
  constructor(seconds: number) {
    super(`A wait of ${seconds} seconds is required`);
    this.seconds = seconds;
  }
}

describe("slow mode отделён от FLOOD_WAIT", () => {
  test("SlowModeWaitError больше не считается флудом аккаунта", () => {
    const e = new SlowModeWaitError(30);
    expect(isSlowModeWaitError(e)).toBe(true);
    expect(parseSlowModeWaitSeconds(e)).toBe(30);
    // Ключевое: кулдаун на characterId взводится только по этим двум.
    expect(isFloodWaitError(e)).toBe(false);
    expect(parseFloodWaitSeconds(e)).toBeUndefined();
  });

  test("настоящий FLOOD_WAIT распознаётся как раньше", () => {
    const e = new FloodWaitError(47);
    expect(isFloodWaitError(e)).toBe(true);
    expect(parseFloodWaitSeconds(e)).toBe(47);
    expect(isSlowModeWaitError(e)).toBe(false);
    expect(parseSlowModeWaitSeconds(e)).toBeUndefined();

    expect(parseFloodWaitSeconds(new Error("FLOOD_WAIT_30"))).toBe(30);
    expect(parseFloodWaitSeconds({ seconds: 12 })).toBe(12);
  });

  test("текстовая форма слоумода тоже отсекается", () => {
    expect(isSlowModeWaitError("SLOWMODE_WAIT_15")).toBe(true);
    expect(parseSlowModeWaitSeconds("SLOWMODE_WAIT_15")).toBe(15);
    expect(isFloodWaitError("SLOWMODE_WAIT_15")).toBe(false);
  });

  test("посторонние ошибки не трогаем", () => {
    expect(isSlowModeWaitError(new Error("CONNECTION_KILLED"))).toBe(false);
    expect(isSlowModeWaitError(null)).toBe(false);
    expect(isSlowModeWaitError(undefined)).toBe(false);
    expect(parseSlowModeWaitSeconds(new Error("CONNECTION_KILLED"))).toBeUndefined();
  });
});

describe("граница чатов юзербота: fail-closed и точное совпадение", () => {
  test("пустой allowlist не пропускает ничего", () => {
    // Было `ALLOWED_GROUP_IDS.length > 0 && …`: незаданный или криво
    // распарсенный TELEGRAM_ALLOWED_GROUP_IDS открывал любой чат, включая
    // личку владельца.
    expect(canonicalChatId([], "-1001234567890")).toBeNull();
    expect(canonicalChatId([], "1234567890")).toBeNull();
  });

  test("подстрока не проходит", () => {
    const allowed = ["-1001234567890"];
    expect(canonicalChatId(allowed, "-1001234567890")).toBe("-1001234567890");
    expect(canonicalChatId(allowed, "1234567890")).toBe("-1001234567890"); // тот же чат без префикса
    // А вот это — ДРУГИЕ чаты, и раньше `chatId.includes(norm)` их пускал.
    expect(canonicalChatId(allowed, "-100112345678900")).toBeNull();
    expect(canonicalChatId(allowed, "12345678901")).toBeNull();
    expect(canonicalChatId(allowed, "-100912345678903")).toBeNull();
  });
});
