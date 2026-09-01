/**
 * Аудит 2026-08-28: анти-флуд юзербота вёлся по роли, а аккаунт один.
 *
 * Ведро `userbot:<characterId>:chat:<chatId>` и карта кулдаунов
 * `floodCooldownUntil` ключуются ролью. Но роль — не аккаунт: пока
 * `USERBOT_ROUTER_ENABLED` не равен "true", `resolveUserbotHandle` отдаёт
 * ОДИН синглтон (`getCurrentUserbot`), то есть личную сессию владельца, и
 * комментарий в `userbot-flood.ts` это прямо признаёт («12 ролей делят одну
 * сессию юзербота»).
 *
 * Отсюда две дыры:
 *  — `PUBLISH_TO_CHANNEL` разрешён четырём ролям (permissions.ts:171), и у
 *    каждой своё ведро на 20/мин: реальный потолок аккаунта вчетверо выше
 *    настроенного;
 *  — FLOOD_WAIT, пойманный ролью smm, заставляет молчать только smm. copy,
 *    design и orchestrator бьют в тот же бан следующим же действием — ровно
 *    то, чего clearOwnFloodCooldown старается не допустить («аккаунт владельца
 *    обязан молчать, и следующее действие любой из 12 ролей иначе снова бьёт
 *    в тот же бан»).
 *
 * С включённым роутером у роли своя сессия, и раздельные вёдра верны — потому
 * ключ и должен зависеть от режима, а не быть всегда ролевым.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  checkUserbotFloodLimit,
  commitUserbotFloodLimit,
  userbotFloodCapacity,
  reserveUserbotFloodSlots,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import {
  noteFloodWait,
  floodCooldownRemainingMs,
  withUserbotFloodGuard,
  _resetFloodCooldowns,
} from "../lib/userbot-flood.ts";

const MAX_KEY = "USERBOT_FLOOD_MAX_PER_WINDOW";
const ROUTER_KEY = "USERBOT_ROUTER_ENABLED";
const savedMax = process.env[MAX_KEY];
const savedRouter = process.env[ROUTER_KEY];

function setEnv(key: string, v: string | undefined): void {
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}

beforeEach(() => {
  setEnv(MAX_KEY, "3");
  setEnv(ROUTER_KEY, undefined); // одна сессия на всех — прод-режим
  _resetRateLimits();
  _resetFloodCooldowns();
});

afterAll(() => {
  // env восстанавливаем: bun гоняет каталог одним процессом (CLAUDE.md §3.8 п.7).
  setEnv(MAX_KEY, savedMax);
  setEnv(ROUTER_KEY, savedRouter);
  _resetRateLimits();
  _resetFloodCooldowns();
});

const CHANNEL = -1_002_777_501;

/** Роли с PUBLISH_TO_CHANNEL — все четыре ходят в один и тот же аккаунт. */
function burn(role: string, chatId: number, n: number): void {
  for (let i = 0; i < n; i++) commitUserbotFloodLimit(role, chatId);
}

describe("одна сессия — одно ведро", () => {
  test("роль, не потратившая ни слота, упирается в расход соседней", () => {
    burn("smm", CHANNEL, 3);
    const r = checkUserbotFloodLimit("copy", CHANNEL);
    expect(r.ok).toBe(false);
    expect(r.retryInMs ?? 0).toBeGreaterThan(0);
  });

  test("ёмкость считается по аккаунту, а не по роли", () => {
    burn("smm", CHANNEL, 2);
    expect(userbotFloodCapacity("design", CHANNEL).free).toBe(1);
  });

  test("резерв на длинный ответ видит чужие занятые слоты", () => {
    burn("smm", CHANNEL, 2);
    const res = reserveUserbotFloodSlots("orchestrator", CHANNEL, 2);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.free).toBe(1);
      expect(res.impossible).toBe(false);
    }
  });

  test("разные чаты по-прежнему считаются раздельно", () => {
    burn("smm", CHANNEL, 3);
    expect(checkUserbotFloodLimit("copy", CHANNEL - 1).ok).toBe(true);
  });
});

describe("кулдаун FLOOD_WAIT — на аккаунт", () => {
  test("бан, пойманный одной ролью, заставляет молчать остальные", () => {
    noteFloodWait("smm", 30);
    for (const role of ["copy", "design", "orchestrator"]) {
      expect(floodCooldownRemainingMs(role)).toBeGreaterThan(0);
    }
  });

  test("гвард не пускает соседнюю роль к серверу, пока аккаунт молчит", async () => {
    noteFloodWait("smm", 30);
    let called = 0;
    const r = await withUserbotFloodGuard("copy", CHANNEL, async () => {
      called++;
      return "sent";
    });
    expect(called).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.rateLimited?.reason).toContain("FLOOD_WAIT");
  });

  test("истёкший кулдаун отпускает всех", () => {
    const t0 = 1_700_000_000_000;
    noteFloodWait("smm", 5, t0);
    expect(floodCooldownRemainingMs("copy", t0 + 4_000)).toBeGreaterThan(0);
    expect(floodCooldownRemainingMs("copy", t0 + 5_001)).toBe(0);
  });
});

describe("с роутером у роли своя сессия — вёдра раздельные", () => {
  test("ведро не делится между ролями", () => {
    setEnv(ROUTER_KEY, "true");
    _resetRateLimits();
    burn("smm", CHANNEL, 3);
    expect(checkUserbotFloodLimit("smm", CHANNEL).ok).toBe(false);
    expect(checkUserbotFloodLimit("copy", CHANNEL).ok).toBe(true);
  });

  test("кулдаун не делится между ролями", () => {
    setEnv(ROUTER_KEY, "true");
    _resetFloodCooldowns();
    noteFloodWait("smm", 30);
    expect(floodCooldownRemainingMs("smm")).toBeGreaterThan(0);
    expect(floodCooldownRemainingMs("copy")).toBe(0);
  });
});
