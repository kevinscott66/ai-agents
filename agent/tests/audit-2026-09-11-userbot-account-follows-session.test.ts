/**
 * Аудит 2026-09-11: ведро анти-флуда следует за режимом, а надо — за аккаунтом.
 *
 * Аудит 2026-08-28 свёл вёдра всех ролей в одно, пока `USERBOT_ROUTER_ENABLED`
 * не равен "true": на общей сессии владельца четыре роли с PUBLISH_TO_CHANNEL
 * давали потолок 4×20/мин на один живой Telegram-аккаунт. Оговорка «с
 * включённым роутером у роли своя сессия» была принята за факт — а она верна
 * только для роли, чью сессию объявили. `getUserbotHandle`
 * (userbot-router.ts:452) отдаёт персональный хэндл лишь зарегистрированным,
 * остальные штатно откатываются на тот же синглтон владельца.
 *
 * Отсюда сценарий без злого умысла: оператор объявляет `USERBOT_SESSION_SMM`,
 * включает роутер — и copy, design, orchestrator продолжают публиковать с
 * личного аккаунта владельца, но уже с тремя отдельными вёдрами вместо одного
 * общего. Возвращается ровно та учетверённая квота, плюс кулдаун FLOOD_WAIT
 * (userbot-flood.ts ключуется той же функцией) перестаёт глушить соседей,
 * которые бьют в тот же бан.
 *
 * Ключ теперь спрашивает, объявлена ли у роли сессия. Ответ знает роутер, и он
 * же кладёт предикат в rate-limits при `setUserbotRouter` — импортировать
 * роутер в лист-модуль нельзя.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  checkUserbotFloodLimit,
  commitUserbotFloodLimit,
  userbotAccountKey,
  setUserbotSessionProbe,
  SHARED_USERBOT_ACCOUNT_KEY,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import {
  noteFloodWait,
  floodCooldownRemainingMs,
  _resetFloodCooldowns,
} from "../lib/userbot-flood.ts";
import { UserbotRouter, setUserbotRouter } from "../lib/userbot-router.ts";

const MAX_KEY = "USERBOT_FLOOD_MAX_PER_WINDOW";
const ROUTER_KEY = "USERBOT_ROUTER_ENABLED";
const savedMax = process.env[MAX_KEY];
const savedRouter = process.env[ROUTER_KEY];
const CHANNEL = -1_002_777_911;

function setEnv(key: string, v: string | undefined): void {
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}

/** Роутер включён — но кто ходит со своей сессии, решает регистрация. */
beforeEach(() => {
  setEnv(MAX_KEY, "3");
  setEnv(ROUTER_KEY, "true");
  _resetRateLimits(); // снимает предикат заодно
  _resetFloodCooldowns();
});

afterAll(() => {
  // env восстанавливаем: bun гоняет каталог одним процессом (CLAUDE.md §3.8 п.7).
  setEnv(MAX_KEY, savedMax);
  setEnv(ROUTER_KEY, savedRouter);
  setUserbotRouter(null);
  _resetRateLimits();
  _resetFloodCooldowns();
});

/** Роутер, в котором объявлена ровно одна роль — типовая частичная раскатка. */
function routerWithOnly(agentKey: string): UserbotRouter {
  const router = new UserbotRouter({
    onMessage: () => {},
    defaultAllowedChatIds: [CHANNEL],
  });
  router.registerAgent(agentKey, {
    sessionFile: `/nonexistent/${agentKey}.session`,
    allowedChatIds: [CHANNEL],
  });
  return router;
}

describe("ключ ведра идёт за аккаунтом, а не за флагом роутера", () => {
  test("роль без объявленной сессии делит ведро владельца", () => {
    setUserbotRouter(routerWithOnly("smm"));

    for (let i = 0; i < 3; i++) commitUserbotFloodLimit("copy", CHANNEL);
    // design ходит с того же аккаунта — слотов не осталось и у него.
    const r = checkUserbotFloodLimit("design", CHANNEL);
    expect(r.ok).toBe(false);
    expect(r.retryInMs ?? 0).toBeGreaterThan(0);
  });

  test("объявленная роль считается отдельно от общего аккаунта", () => {
    setUserbotRouter(routerWithOnly("smm"));

    for (let i = 0; i < 3; i++) commitUserbotFloodLimit("copy", CHANNEL);
    // У smm своя сессия — чужой расход её не касается.
    expect(checkUserbotFloodLimit("smm", CHANNEL).ok).toBe(true);
    expect(userbotAccountKey("smm")).toBe("smm");
    expect(userbotAccountKey("copy")).toBe(SHARED_USERBOT_ACCOUNT_KEY);
  });

  test("кулдаун FLOOD_WAIT глушит всех, кто ходит с аккаунта владельца", () => {
    setUserbotRouter(routerWithOnly("smm"));

    noteFloodWait("copy", 30);
    for (const role of ["design", "orchestrator", "pm"]) {
      expect(floodCooldownRemainingMs(role)).toBeGreaterThan(0);
    }
    // Своя сессия smm под чужой бан не попадает.
    expect(floodCooldownRemainingMs("smm")).toBe(0);
  });

  test("роутер снят — предикат снят вместе с ним, ключ общий", () => {
    setUserbotRouter(routerWithOnly("smm"));
    expect(userbotAccountKey("smm")).toBe("smm");

    setUserbotRouter(null);
    // Роутера нет — все ходят через синглтон, даже при включённом флаге.
    expect(userbotAccountKey("smm")).toBe(SHARED_USERBOT_ACCOUNT_KEY);
  });

  test("предиката не было вовсе — самый строгий вариант по умолчанию", () => {
    setUserbotSessionProbe(null);
    expect(userbotAccountKey("smm")).toBe(SHARED_USERBOT_ACCOUNT_KEY);
  });
});
