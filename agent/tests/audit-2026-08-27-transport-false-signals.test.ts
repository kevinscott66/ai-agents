/**
 * Аудит 2026-08-27: два места в транспорте, где сообщение об отказе (или сам
 * отказ) утверждало не то, что есть на самом деле.
 *
 * 1. `anti-dup.ts` проверял СВОЙ хэндл через `mentionsHandle` (с границей
 *    слова), а чужие — голым `includes("@" + u)`. Асимметрия ровно в ту
 *    сторону, ради которой границу и заводили: посторонний хэндл-префикс
 *    (`@dlb_design_bot_v2`) считался упоминанием нашего `@dlb_design_bot` и
 *    молча выключал инструменты оркестратора — тот отвечал текстом вместо
 *    того, чтобы делегировать.
 *
 * 2. `reserveUserbotFloodSlots` при нехватке ёмкости отдавал срок повтора,
 *    равный времени до освобождения ОДНОГО (самого старого) слота. При
 *    пустом ведре и `partCount > max` он равен нулю, и `dispatch/telegram.ts`
 *    печатал «повтор через ~0s» для запроса, который не пройдёт никогда.
 *    Даже когда ждать осмысленно, одного слота мало: нужно `count - free`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ChatRow } from "../lib/db.ts";
import type { RunningBot } from "../lib/types.ts";
import { shouldAllowTools } from "../lib/anti-dup.ts";
import {
  reserveUserbotFloodSlots,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import { dispatchAction, type DispatchResult } from "../lib/action-dispatch.ts";
import { splitForTelegram } from "../lib/telegram-chunking.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import { setAutonomy } from "../lib/permissions.ts";

function fakeBot(key: string, username: string, id: number): RunningBot {
  return { def: { key } as any, bot: {} as any, username, id };
}

const BOTS: RunningBot[] = [
  fakeBot("orchestrator", "dlb_lead_bot", 1),
  fakeBot("design", "dlb_design_bot", 2),
];
const LEAD = { key: "orchestrator" } as const;
const NO_HISTORY: ChatRow[] = [];

describe("anti-dup: граница хэндла у чужих ботов, а не только у своего", () => {
  test("чужой бот с нашим именем в префиксе не глушит инструменты", () => {
    expect(
      shouldAllowTools(
        LEAD,
        NO_HISTORY,
        "посмотри, что делает @dlb_design_bot_v2 — и собери релиз",
        BOTS,
      ),
    ).toBe(true);
  });

  test("суффикс тоже не считается: @dlb_design_botx — не наш", () => {
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "спроси у @dlb_design_botx", BOTS),
    ).toBe(true);
  });

  test("настоящее упоминание по-прежнему глушит", () => {
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "@dlb_design_bot сделай баннер", BOTS),
    ).toBe(false);
  });

  test("упоминание в конце строки — тоже упоминание", () => {
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "это к @dlb_design_bot", BOTS),
    ).toBe(false);
  });

  test("знак препинания сразу за хэндлом границу не ломает", () => {
    expect(
      shouldAllowTools(LEAD, NO_HISTORY, "это к @dlb_design_bot, срочно", BOTS),
    ).toBe(false);
  });
});

describe("userbot flood: срок повтора не врёт", () => {
  const ENV = {
    max: process.env.USERBOT_FLOOD_MAX_PER_WINDOW,
    win: process.env.USERBOT_FLOOD_WINDOW_MS,
  };

  beforeEach(() => {
    process.env.USERBOT_FLOOD_MAX_PER_WINDOW = "4";
    process.env.USERBOT_FLOOD_WINDOW_MS = "60000";
    _resetRateLimits();
  });

  afterEach(() => {
    if (ENV.max === undefined) delete process.env.USERBOT_FLOOD_MAX_PER_WINDOW;
    else process.env.USERBOT_FLOOD_MAX_PER_WINDOW = ENV.max;
    if (ENV.win === undefined) delete process.env.USERBOT_FLOOD_WINDOW_MS;
    else process.env.USERBOT_FLOOD_WINDOW_MS = ENV.win;
    _resetRateLimits();
  });

  test("запрос больше всего ведра помечен impossible, а не «через ~0s»", () => {
    const r = reserveUserbotFloodSlots("agentA", -100, 5, 1_000_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.impossible).toBe(true);
    expect(r.free).toBe(4);
    expect(r.max).toBe(4);
  });

  test("ждать столько, чтобы освободилось НУЖНОЕ число слотов", () => {
    const t0 = 1_000_000;
    // Три занятых слота с разным временем: t0, t0+10s, t0+20s.
    expect(reserveUserbotFloodSlots("agentB", -100, 1, t0).ok).toBe(true);
    expect(reserveUserbotFloodSlots("agentB", -100, 1, t0 + 10_000).ok).toBe(true);
    expect(reserveUserbotFloodSlots("agentB", -100, 1, t0 + 20_000).ok).toBe(true);

    // Свободен один слот, просим три — не хватает двух. Второй по старшинству
    // (t0+10s) выпадет из окна в t0+70s, то есть через 50s от t0+20s.
    const r = reserveUserbotFloodSlots("agentB", -100, 3, t0 + 20_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.impossible).toBe(false);
    expect(r.free).toBe(1);
    expect(r.retryInMs).toBe(50_000);
  });

  test("нехватка одного слота — срок до самой старой записи", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 4; i++) {
      expect(reserveUserbotFloodSlots("agentC", -100, 1, t0 + i * 1_000).ok).toBe(true);
    }
    const r = reserveUserbotFloodSlots("agentC", -100, 1, t0 + 5_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.impossible).toBe(false);
    expect(r.retryInMs).toBe(55_000);
  });

  test("хватает ёмкости — резерв проходит и держит слоты", () => {
    const r = reserveUserbotFloodSlots("agentD", -100, 4, 3_000_000);
    expect(r.ok).toBe(true);
    const again = reserveUserbotFloodSlots("agentD", -100, 1, 3_000_000);
    expect(again.ok).toBe(false);
  });
});

describe("dispatch: отказ по ёмкости говорит правду о повторе", () => {
  const TEST_CHAT = -1_000_827;
  const CHAR = "orchestrator";
  const LONG = Array.from(
    { length: 240 },
    (_, i) => `Строка ${i} ${"я".repeat(200)}`,
  ).join("\n\n");
  const ub = {
    isNoop: false,
    async sendMessage(_c: number, _t: string) {
      throw new Error("не должно дойти до отправки");
    },
  };
  const ctx = () =>
    ({ agentKey: CHAR, chatId: TEST_CHAT, userbot: ub, telegram: undefined }) as never;
  const failed = (r: DispatchResult): Extract<DispatchResult, { ok: false }> =>
    r as Extract<DispatchResult, { ok: false }>;

  let prev: ReturnType<typeof saveAutonomy>;
  const ENV = process.env.USERBOT_FLOOD_MAX_PER_WINDOW;

  beforeEach(() => {
    prev = saveAutonomy();
    _resetRateLimits();
    cleanupChat(TEST_CHAT, CHAR);
    setAutonomy("chat", String(TEST_CHAT), "auto");
    process.env.USERBOT_FLOOD_MAX_PER_WINDOW = "2";
  });

  afterEach(() => {
    if (ENV === undefined) delete process.env.USERBOT_FLOOD_MAX_PER_WINDOW;
    else process.env.USERBOT_FLOOD_MAX_PER_WINDOW = ENV;
    _resetRateLimits();
    cleanupChat(TEST_CHAT, CHAR);
    restoreAutonomy(prev);
  });

  test("ответ длиннее всего ведра — «ожидание не поможет», а не «~0s»", async () => {
    // Условие осмысленности: ведро пустое, а частей больше, чем весь лимит.
    expect(splitForTelegram(LONG).length).toBeGreaterThan(2);

    const r = await dispatchAction(
      "SEND_MESSAGE",
      { text: LONG, via_userbot: true } as never,
      ctx(),
    );
    expect(r.ok).toBe(false);
    const msg = failed(r).error;
    expect(msg).toContain("Ожидание не поможет");
    expect(msg).toContain("сократи ответ");
    expect(msg).toContain("Не отправлено ничего");
    // Ровно та строка, которая приглашала крутить отказ в цикле.
    expect(msg).not.toContain("~0s");
    expect(msg).not.toContain("повтор через");
  });
});
