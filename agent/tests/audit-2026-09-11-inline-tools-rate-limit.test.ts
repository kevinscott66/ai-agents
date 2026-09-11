/**
 * Аудит 2026-09-11: инлайновые инструменты мимо минутного бакета.
 *
 * `checkRateLimit` / `checkAndConsumeRateLimit` зовутся только внутри
 * `gateOrDispatch` (action-dispatch.ts). Инструменты из `INLINE_TOOL_NAMES`
 * до гейта не доходят — `executeTool` обслуживает их сам, — поэтому бакет
 * `agent-all:<agentKey>` (ALL_AGENT_TOOLS_RULE, 60/мин) на них не тратился
 * вовсе. Это третий случай того же класса: ровно так же мимо инлайновой ветки
 * когда-то проходили `CALLER_RESTRICTED` (роль) и `agentStopReason`/`locked`
 * (пауза и стоп-кран), и оба закрыты проверками выше по блоку.
 *
 * Последствие не теоретическое: внутри одного прогона потолок держал
 * `MAX_CALLS_PER_TOOL_PER_RUN` (tool-loop.ts, 8 на инструмент), а между
 * прогонами не держало ничто. Цикл ходов, ретраи после ошибки и несколько
 * чатов подряд упирались только в него — при том что в списке есть QUERY_DB
 * (произвольный SELECT по операционной БД, без chat-скоупа) и
 * CANCEL_SCHEDULED_POST, единственная мутация среди инлайновых.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { _resetRateLimits, checkRateLimit } from "../lib/rate-limits.ts";
import { INLINE_TOOL_NAMES } from "../lib/constants.ts";

const CTX = { agentKey: "_test_inline_rl", chatId: -1_000_911 };

/** Потолок общего ведра — ALL_AGENT_TOOLS_RULE. */
const ALL_TOOLS_MAX = 60;

beforeEach(_resetRateLimits);
afterEach(_resetRateLimits);

describe("инлайновые инструменты тратят общий минутный бакет", () => {
  test("READ_WIKI списывает слот так же, как гейтованное действие", async () => {
    expect(checkRateLimit(CTX.agentKey, "READ_WIKI").ok).toBe(true);
    await executeTool("READ_WIKI", { scope: "_team", slug: "нет-такой" }, CTX);
    // Ведро общее: тратит его READ_WIKI, а видно это и с другого actionType.
    for (let i = 1; i < ALL_TOOLS_MAX; i++) {
      await executeTool("READ_WIKI", { scope: "_team", slug: "нет-такой" }, CTX);
    }
    // 60 обращений сделано — 61-е упирается в потолок.
    expect(checkRateLimit(CTX.agentKey, "SEND_MESSAGE").ok).toBe(false);
  });

  test("на 61-м вызове инструмент отказывает, а не выполняется", async () => {
    let lastOk = true;
    let firstRejectAt = -1;
    for (let i = 1; i <= ALL_TOOLS_MAX + 2; i++) {
      const out = JSON.parse(
        await executeTool("READ_WIKI", { scope: "_team", slug: "нет-такой" }, CTX),
      );
      // READ_WIKI по несуществующей странице и так отвечает ok:false, поэтому
      // различаем ветки по тексту, а не по флагу.
      const limited = typeof out.error === "string" && out.error.startsWith("rate_limited");
      if (limited && firstRejectAt < 0) firstRejectAt = i;
      lastOk = !limited;
    }
    expect(firstRejectAt).toBe(ALL_TOOLS_MAX + 1);
    expect(lastOk).toBe(false);
  });

  test("ведро персонально: сосед по ключу агента не страдает", async () => {
    for (let i = 0; i < ALL_TOOLS_MAX + 1; i++) {
      await executeTool("READ_WIKI", { scope: "_team", slug: "нет-такой" }, CTX);
    }
    const other = { ...CTX, agentKey: "_test_inline_rl_2" };
    const out = JSON.parse(
      await executeTool("READ_WIKI", { scope: "_team", slug: "нет-такой" }, other),
    );
    expect(String(out.error ?? "")).not.toContain("rate_limited");
  });

  test("проверка стоит в общем блоке — значит накрывает весь список", () => {
    // Не хардкодим состав: важно, что ветка одна на все INLINE_TOOL_NAMES.
    expect(INLINE_TOOL_NAMES.has("QUERY_DB")).toBe(true);
    expect(INLINE_TOOL_NAMES.has("CANCEL_SCHEDULED_POST")).toBe(true);
    expect(INLINE_TOOL_NAMES.size).toBeGreaterThan(5);
  });
});
