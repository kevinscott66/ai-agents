/**
 * Аудит 2026-09-11: рефанд после того, как мы УЖЕ постучались.
 *
 * Два места считали «сделано» вместо «попробовали», и оба возвращали
 * потраченное обратно:
 *
 *  1. `dispatch/telegram.ts` занимает слоты ведра юзербота на все части
 *     ответа одним резервом, а в `finally` возвращает неотправленные:
 *     `slots.release(partCount - sentParts)`. Счётчик рос ПОСЛЕ возврата
 *     `guardedUserbotCall`, так что часть, на которой отправка упала,
 *     считалась неотправленной — и её слот возвращался в ведро. Между тем
 *     обращение к аккаунту владельца состоялось: таймаут и RPC-ошибка
 *     приходят и тогда, когда запрос до Telegram дошёл. Ровно из-за этого
 *     коммит слота в `userbot-flood.ts` переехал ДО обращения к серверу
 *     (аудит 2026-08-20, «ведро считает обращения к аккаунту, а не успехи»);
 *     здесь то же правило нарушалось с другого конца.
 *
 *  2. `dispatch/mac.ts` сворачивал все режекты моста в одинаковый
 *     `{ok:false, error}` без `sideEffect`, а `action-dispatch.ts` на таком
 *     провале возвращает слот лимита и зовёт повторить. Для `mac_offline` /
 *     `mac_busy` / `mac_send_dropped` (кадр `run` не ушёл) и для
 *     `mac_timeout` / `mac_stopped` (прогон явно попросили убить) это верно.
 *     Для `mac_replaced` / `mac_disconnected` / `mac_bridge_stopped` — нет:
 *     `failAllPending` только чистит карту ожиданий, отменить прогон нечем, и
 *     `claude` в режиме `bypass` продолжает работать в проекте владельца, уже
 *     не считаясь в `MAC_MAX_CONCURRENT_RUNS`. Повтор клал бы второй прогон
 *     поверх первого.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { handleSendMessage } from "../lib/dispatch/telegram.ts";
import {
  handleMacRunClaude,
  macFailureLeavesRunAlive,
} from "../lib/dispatch/mac.ts";
import { splitForTelegram } from "../lib/telegram-chunking.ts";
import { userbotFloodCapacity, _resetRateLimits } from "../lib/rate-limits.ts";
import { _resetFloodCooldowns } from "../lib/userbot-flood.ts";

const MAX_KEY = "USERBOT_FLOOD_MAX_PER_WINDOW";
let prevMax: string | undefined;

beforeEach(() => {
  prevMax = process.env[MAX_KEY];
  _resetRateLimits();
  _resetFloodCooldowns();
});
afterEach(() => {
  if (prevMax === undefined) delete process.env[MAX_KEY];
  else process.env[MAX_KEY] = prevMax;
  _resetRateLimits();
  _resetFloodCooldowns();
});

/** Текст, который `splitForTelegram` заведомо режет на несколько частей. */
function multiPartText(): string {
  const para = "x".repeat(3000);
  const text = [para, para, para].join("\n\n");
  if (splitForTelegram(text).length < 3) {
    throw new Error("фикстура перестала биться на три части");
  }
  return text;
}

describe("ведро юзербота: возвращаем только нетронутые части", () => {
  test("часть, на которой отправка упала, остаётся списанной", async () => {
    process.env[MAX_KEY] = "10";
    const text = multiPartText();
    const partCount = splitForTelegram(text).length;
    let calls = 0;
    const ub = {
      isNoop: false,
      sendMessage: async () => {
        calls++;
        if (calls === 2) throw new Error("boom: соединение оборвалось");
        return { message_id: calls };
      },
    } as any;

    const res = await handleSendMessage(
      { text, via_userbot: true } as any,
      { agentKey: "orchestrator", chatId: -7001, userbot: ub } as any,
    );

    expect(res.ok).toBe(false);
    expect(calls).toBe(2);
    // Две попытки состоялись — значит в ведре осталось два слота из десяти,
    // а не один. Остальные `partCount - 2` вернулись.
    const cap = userbotFloodCapacity("orchestrator", "-7001");
    expect(cap.max).toBe(10);
    expect(cap.free).toBe(8);
    expect(partCount).toBeGreaterThan(2);
  });

  test("полностью успешная отправка списывает ровно все части", async () => {
    process.env[MAX_KEY] = "10";
    const text = multiPartText();
    const partCount = splitForTelegram(text).length;
    let calls = 0;
    const ub = {
      isNoop: false,
      sendMessage: async () => ({ message_id: ++calls }),
    } as any;

    const res = await handleSendMessage(
      { text, via_userbot: true } as any,
      { agentKey: "orchestrator", chatId: -7002, userbot: ub } as any,
    );

    expect(res.ok).toBe(true);
    expect(calls).toBe(partCount);
    expect(userbotFloodCapacity("orchestrator", "-7002").free).toBe(
      10 - partCount,
    );
  });

  test("отказ на ПЕРВОЙ части тоже списан: кадр уже ушёл", async () => {
    process.env[MAX_KEY] = "10";
    const text = multiPartText();
    const ub = {
      isNoop: false,
      sendMessage: async () => {
        throw new Error("boom");
      },
    } as any;

    // Первая часть не даёт частичной доставки — `sendChunked` бросает
    // исходное исключение, и `partialSendFailure` пропускает его дальше.
    // `finally` при этом уже отработал, и ведро можно проверить.
    await expect(
      handleSendMessage(
        { text, via_userbot: true } as any,
        { agentKey: "orchestrator", chatId: -7003, userbot: ub } as any,
      ),
    ).rejects.toThrow("boom");
    expect(userbotFloodCapacity("orchestrator", "-7003").free).toBe(9);
  });

  test("счёт ведётся до вызова, а не после", () => {
    const src = readFileSync(
      new URL("../lib/dispatch/telegram.ts", import.meta.url),
      "utf8",
    );
    // Комментарии цитируют старое имя, поэтому смотрим на КОД.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toContain("sentParts");
    // Инкремент обязан стоять ПЕРЕД обращением к гварду, иначе упавшая
    // попытка снова окажется «неотправленной».
    const i = code.indexOf("attemptedParts++");
    const j = code.indexOf("await guardedUserbotCall", i);
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(code).toContain("slots.release(partCount - attemptedParts)");
  });
});

describe("мост мака: не рефандить прогон, который остался жив", () => {
  test("живым прогон остаётся только там, где его нечем отменить", () => {
    for (const e of ["mac_replaced", "mac_disconnected", "mac_bridge_stopped"]) {
      expect(macFailureLeavesRunAlive(e)).toBe(true);
    }
    for (const e of [
      "mac_offline",
      "mac_busy: уже выполняется 2 из 2",
      "mac_send_dropped",
      "mac_timeout",
      "mac_stopped",
      "spawn_failed",
      "",
    ]) {
      expect(macFailureLeavesRunAlive(e)).toBe(false);
    }
  });

  function bridgeRejecting(reason: string) {
    return {
      isMacConnected: () => true,
      isMacOnline: () => true,
      isUserAllowed: () => true,
      stopMac: async () => ({ ok: true }),
      sendToMac: async () => {
        throw new Error(reason);
      },
    } as any;
  }

  /**
   * Провал как провал: `HandlerResult` — юнион, и без сужения `sideEffect`
   * с `error` не существуют на успешной ветке (tsc это ловит).
   */
  async function failWith(
    reason: string,
  ): Promise<{ error?: string; sideEffect?: boolean }> {
    const res = await handleMacRunClaude(
      { project: "p", prompt: "hi", mode: "ask", _userId: "1" } as any,
      { agentKey: "orchestrator", chatId: -7010, macBridge: bridgeRejecting(reason) } as any,
    );
    if (res.ok) throw new Error(`ожидался провал на ${reason}`);
    return res;
  }

  test("обрыв связи помечается sideEffect — рефанда не будет", async () => {
    for (const reason of ["mac_disconnected", "mac_replaced", "mac_bridge_stopped"]) {
      const res = await failWith(reason);
      expect(res.sideEffect).toBe(true);
      expect(res.error).toContain(reason);
      // Отказ обязан сказать, что повтор кладёт второй прогон поверх первого:
      // иначе это приглашение крутить цикл (то же правило, что у отказа
      // ведра юзербота, аудит 2026-08-27).
      expect(res.error).toContain("MAC_STOP");
    }
  });

  test("отказы до запуска и явная отмена рефандятся по-прежнему", async () => {
    for (const reason of [
      "mac_offline",
      "mac_send_dropped",
      "mac_timeout",
      "mac_stopped",
    ]) {
      const res = await failWith(reason);
      expect(res.sideEffect).toBeUndefined();
      expect(res.error).toBe(reason);
    }
  });

  test("докстрока не обещает отмены там, где её нет", () => {
    const src = readFileSync(
      new URL("../lib/dispatch/mac.ts", import.meta.url),
      "utf8",
    );
    // Прежний комментарий утверждал, что ВСЕ транспортные отказы приходят
    // «до всякой отправки» и рефандятся правильно. Для mac_timeout и группы
    // обрыва это неверно, и утверждение убрано.
    expect(src).not.toContain("их рефанд правильный");
    expect(src).toContain("macFailureLeavesRunAlive");
  });
});
