/**
 * Аудит 2026-08-29: при `skipBucket` повторы внутри гварда никто не считал.
 *
 * Многочастная owner-voice отправка занимает ёмкость одним резервом
 * (`reserveUserbotFloodSlots(agentKey, chatId, partCount)`), а части идут со
 * `skipBucket: true`, чтобы не списать ведро дважды. Но резерв оплачивает
 * ровно `partCount` обращений — по одному на часть, — тогда как каждая часть
 * внутри `withUserbotFloodGuard` может постучаться в аккаунт до четырёх раз
 * (`DEFAULT_MAX_RETRIES = 3`) плюс сколько угодно ожиданий слоумода.
 *
 * Ответ на пять частей с одним FLOOD_WAIT в каждой — это десять реальных
 * обращений против пяти списанных слотов: потолок «20 за 60s» пропускал
 * примерно вчетверо больше, чем настроено. Ведро здесь защищает не бота, а
 * личный аккаунт владельца, поэтому недосчёт всегда в опасную сторону.
 *
 * Кулдаун шага 0 это не компенсирует: он проверяется один раз, до цикла, а
 * `clearOwnFloodCooldown` снимает его на первой же успешной попытке.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { withUserbotFloodGuard, _resetFloodCooldowns } from "../lib/userbot-flood.ts";
import {
  userbotFloodCapacity,
  reserveUserbotFloodSlots,
  _resetRateLimits,
} from "../lib/rate-limits.ts";

const MAX_KEY = "USERBOT_FLOOD_MAX_PER_WINDOW";
let prevMax: string | undefined;

beforeEach(() => {
  prevMax = process.env[MAX_KEY];
  _resetRateLimits();
  _resetFloodCooldowns();
});
afterEach(() => {
  // env восстанавливаем всегда — иначе он течёт в соседние тесты.
  if (prevMax === undefined) delete process.env[MAX_KEY];
  else process.env[MAX_KEY] = prevMax;
  _resetRateLimits();
  _resetFloodCooldowns();
});

const noopSleep = async (_ms: number) => {};
const guardOpts = { _sleep: noopSleep, _recorder: null, skipBucket: true } as const;

/** Слоумод отличается от FLOOD_WAIT именем класса — так же, как у gramjs. */
class SlowModeWaitError extends Error {
  seconds: number;
  constructor(seconds: number) {
    super(`A wait of ${seconds} seconds is required before sending another message in this chat`);
    this.seconds = seconds;
  }
}

const CHAT = "-6100";
const used = (agent: string) => {
  const c = userbotFloodCapacity(agent, CHAT);
  return c.max - c.free;
};

describe("skipBucket: повторы считаются, первая попытка — нет", () => {
  test("одна успешная попытка резерв не расходует повторно", async () => {
    process.env[MAX_KEY] = "10";
    const r = await withUserbotFloodGuard("ubA", CHAT, async () => "sent", guardOpts);

    expect(r.ok).toBe(true);
    // Ни одного коммита: слот за эту попытку уже занят вызывающим.
    expect(used("ubA")).toBe(0);
  });

  test("два FLOOD_WAIT-повтора — два дополнительных слота", async () => {
    process.env[MAX_KEY] = "10";
    let calls = 0;
    const r = await withUserbotFloodGuard("ubB", CHAT, async () => {
      calls++;
      if (calls < 3) throw new Error("FLOOD_WAIT_1");
      return "ok";
    }, { ...guardOpts, maxFloodRetries: 3 });

    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
    // Три обращения к аккаунту: первое покрыто резервом, два повтора — нет.
    expect(used("ubB")).toBe(2);
  });

  test("ожидание слоумода — тоже обращение", async () => {
    process.env[MAX_KEY] = "10";
    let calls = 0;
    const r = await withUserbotFloodGuard("ubC", CHAT, async () => {
      calls++;
      if (calls < 2) throw new SlowModeWaitError(1);
      return "ok";
    }, guardOpts);

    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(used("ubC")).toBe(1);
  });

  test("исчерпанные ретраи списывают каждую попытку, кроме первой", async () => {
    process.env[MAX_KEY] = "10";
    let calls = 0;
    const r = await withUserbotFloodGuard("ubD", CHAT, async () => {
      calls++;
      throw new Error("FLOOD_WAIT_1");
    }, { ...guardOpts, maxFloodRetries: 3 });

    expect(r.ok).toBe(false);
    expect(calls).toBe(4); // 1 + maxFloodRetries
    expect(used("ubD")).toBe(3);
  });

  test("отказ по кулдауну до цикла слот не тратит", async () => {
    process.env[MAX_KEY] = "10";
    // Первый вызов ловит FLOOD_WAIT длиннее потолка — ретраев не будет,
    // но кулдаун на аккаунт взведён.
    await withUserbotFloodGuard("ubE", CHAT, async () => {
      throw new Error("FLOOD_WAIT_9999");
    }, guardOpts);
    const afterFirst = used("ubE");

    const second = await withUserbotFloodGuard("ubE", CHAT, async () => "sent", guardOpts);
    expect(second.ok).toBe(false);
    expect(second.rateLimited).toBeDefined();
    // До `fn` дело не дошло — ни одного нового обращения к аккаунту.
    expect(used("ubE")).toBe(afterFirst);
  });

  test("многочастная отправка: резерв плюс повторы = реальные обращения", async () => {
    process.env[MAX_KEY] = "20";
    const AGENT = "ubMulti";
    const PARTS = 3;

    const slots = reserveUserbotFloodSlots(AGENT, CHAT, PARTS);
    expect(slots.ok).toBe(true);
    expect(used(AGENT)).toBe(PARTS);

    let hits = 0;
    let sentParts = 0;
    for (let part = 0; part < PARTS; part++) {
      let attemptsThisPart = 0;
      const r = await withUserbotFloodGuard(AGENT, CHAT, async () => {
        hits++;
        attemptsThisPart++;
        if (attemptsThisPart < 2) throw new Error("FLOOD_WAIT_1");
        return { message_id: part };
      }, { ...guardOpts, maxFloodRetries: 3 });
      expect(r.ok).toBe(true);
      sentParts++;
    }
    if (slots.ok) slots.release(PARTS - sentParts);

    // Каждая часть постучалась дважды — ведро обязано это видеть.
    expect(hits).toBe(PARTS * 2);
    expect(used(AGENT)).toBe(hits);
  });

  test("недоотправленные части возвращаются, повторы — нет", async () => {
    process.env[MAX_KEY] = "20";
    const AGENT = "ubPartial";
    const PLANNED = 5;

    const slots = reserveUserbotFloodSlots(AGENT, CHAT, PLANNED);
    expect(slots.ok).toBe(true);

    // Отправили две части, каждая с одним повтором, — и остановились.
    let hits = 0;
    for (let part = 0; part < 2; part++) {
      let attempts = 0;
      await withUserbotFloodGuard(AGENT, CHAT, async () => {
        hits++;
        attempts++;
        if (attempts < 2) throw new Error("FLOOD_WAIT_1");
        return "ok";
      }, { ...guardOpts, maxFloodRetries: 3 });
    }
    if (slots.ok) slots.release(PLANNED - 2);

    expect(hits).toBe(4);
    // Резерв за три неотправленные части вернулся, четыре обращения — остались.
    expect(used(AGENT)).toBe(4);
  });

  test("без skipBucket поведение прежнее: считается каждая попытка", async () => {
    process.env[MAX_KEY] = "10";
    let calls = 0;
    const r = await withUserbotFloodGuard("ubPlain", CHAT, async () => {
      calls++;
      if (calls < 3) throw new Error("FLOOD_WAIT_1");
      return "ok";
    }, { _sleep: noopSleep, _recorder: null, maxFloodRetries: 3 });

    expect(r.ok).toBe(true);
    expect(used("ubPlain")).toBe(3);
  });
});
