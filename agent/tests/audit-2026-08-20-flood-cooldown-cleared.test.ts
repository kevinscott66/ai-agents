/**
 * Аудит 2026-08-20: успех снимал кулдаун, взведённый НЕ этим вызовом.
 *
 * `armFloodCooldown` подписан «Продлевать можно, укорачивать — нет» и делает
 * `Math.max(prev, until)` именно затем, чтобы требование сервера нельзя было
 * случайно сократить. А в ветке успеха стояло безусловное
 * `floodCooldownUntil.delete(characterId)` — то есть укорачивание сразу до
 * нуля, мимо всей этой арифметики.
 *
 * Проверка на входе гарантирует, что в начале вызова активного кулдауна не
 * было. Значит любой кулдаун, дошедший до момента успеха, взведён ПОКА мы
 * летали, и источников у него ровно два:
 *
 *   — наш собственный короткий FLOOD_WAIT, который цикл честно переждал:
 *     его снять правильно, сервер уже принял следующую отправку;
 *   — чужой: параллельный вызов получил FLOOD_WAIT_300 (дольше потолка —
 *     ретраев нет, кулдаун взведён, вызов вернул ошибку) либо
 *     `noteFloodWait` из createTeamChannel, где FLOOD_WAIT прилетает из
 *     середины цикла приглашений.
 *
 * Второй случай и ломался: аккаунт владельца обязан молчать пять минут, а
 * наш успех обнулял это требование целиком — и следующее действие любой из
 * 12 ролей снова било в тот же бан. Ровно та молотьба, ради которой кулдаун
 * и заводили (аудит 2026-08-09).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  withUserbotFloodGuard,
  noteFloodWait,
  floodCooldownRemainingMs,
  _resetFloodCooldowns,
} from "../lib/userbot-flood.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";

const MAX_KEY = "USERBOT_FLOOD_MAX_PER_WINDOW";
let prevMax: string | undefined;

beforeEach(() => {
  prevMax = process.env[MAX_KEY];
  process.env[MAX_KEY] = "50";
  _resetRateLimits();
  _resetFloodCooldowns();
});
afterEach(() => {
  if (prevMax === undefined) delete process.env[MAX_KEY];
  else process.env[MAX_KEY] = prevMax;
  _resetRateLimits();
  _resetFloodCooldowns();
});

const noopSleep = async (_ms: number) => {};

describe("успех не отменяет чужой кулдаун", () => {
  test("кулдаун, взведённый во время полёта, переживает наш успех", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });

    const run = withUserbotFloodGuard("agentC1", "-7001", async () => {
      await gate;
      return "sent";
    }, { _sleep: noopSleep, _recorder: null });

    // Пока отправка в полёте, сервер потребовал молчания от аккаунта
    // (параллельный вызов или createTeamChannel).
    noteFloodWait("agentC1", 300);
    release();
    const r = await run;

    expect(r.ok).toBe(true);
    const left = floodCooldownRemainingMs("agentC1");
    expect(left).toBeGreaterThan(290_000);
  });

  test("наш собственный пережданый FLOOD_WAIT по-прежнему снимается", async () => {
    let calls = 0;
    const r = await withUserbotFloodGuard("agentC2", "-7002", async () => {
      calls++;
      if (calls === 1) throw new Error("FLOOD_WAIT_5");
      return "ok";
    }, { _sleep: noopSleep, _recorder: null, maxFloodRetries: 3 });

    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(floodCooldownRemainingMs("agentC2")).toBe(0);
  });

  test("чужой кулдаун длиннее нашего не сокращается до нашего", async () => {
    let calls = 0;
    const r = await withUserbotFloodGuard("agentC3", "-7003", async () => {
      calls++;
      if (calls === 1) throw new Error("FLOOD_WAIT_5");
      // Между нашей паузой и повтором пришло требование куда длиннее.
      if (calls === 2) noteFloodWait("agentC3", 300);
      return "ok";
    }, { _sleep: noopSleep, _recorder: null, maxFloodRetries: 3 });

    expect(r.ok).toBe(true);
    expect(floodCooldownRemainingMs("agentC3")).toBeGreaterThan(290_000);
  });

  test("без кулдауна успех ничего не ломает", async () => {
    const r = await withUserbotFloodGuard("agentC4", "-7004", async () => "sent",
      { _sleep: noopSleep, _recorder: null });
    expect(r.ok).toBe(true);
    expect(floodCooldownRemainingMs("agentC4")).toBe(0);
  });

  test("активный кулдаун по-прежнему отбивает вызов на входе", async () => {
    noteFloodWait("agentC5", 120);
    let called = false;
    const r = await withUserbotFloodGuard("agentC5", "-7005", async () => {
      called = true;
      return "sent";
    }, { _sleep: noopSleep, _recorder: null });

    expect(called).toBe(false);
    expect(r.rateLimited?.reason).toContain("FLOOD_WAIT");
    expect(floodCooldownRemainingMs("agentC5")).toBeGreaterThan(110_000);
  });
});
