/**
 * Аудит 2026-08-28 — `isFailureResult` в agent/lib/agent-sdk-runtime.ts.
 *
 * `pending_approval` и `rate_limited` приходят от `formatGateResult`
 * (action-dispatch.ts) с `ok:false`, но провалом инструмента не являются:
 * строка в `approvals` уже закоммичена к этому моменту (`dispatchAndAudit`
 * в том же файле), а отложенное
 * действие несёт `retryInMs`. Если отдать их модели как ошибку, она читает
 * это как провал и зовёт тот же инструмент снова — MAX_CALLS_PER_TOOL_PER_RESPONSE
 * не мешает (вызов в каждом ответе один), так что до
 * MAX_CALLS_PER_TOOL_PER_RUN = 8 набегает до восьми карточек согласования
 * владельцу на одну просьбу человека, либо восемь `rate_limited`-строк,
 * которые alerting.ts считает штормом рейт-лимита.
 *
 * Оговорку завели на raw-пути (`tool-loop.ts`) 2026-08-28 и не перенесли на
 * SDK-путь, притом что на проде USE_AGENT_SDK=true — то есть починили
 * фоллбэк, а боевой путь остался как был.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFailureResult } from "../lib/agent-sdk-runtime.ts";
import { CONTROL_TOOL_STATUSES } from "../lib/constants.ts";

describe("SDK-путь: управляющие статусы — не ошибка", () => {
  test("pending_approval не считается провалом", () => {
    const out = JSON.stringify({
      ok: false,
      status: "pending_approval",
      approvalId: 42,
      actionId: 7,
      reason: "требует согласования владельца",
    });
    expect(isFailureResult(out)).toBe(false);
  });

  test("rate_limited не считается провалом", () => {
    const out = JSON.stringify({
      ok: false,
      status: "rate_limited",
      actionId: 8,
      reason: "лимит на действие",
      retryInMs: 30_000,
    });
    expect(isFailureResult(out)).toBe(false);
  });

  test("настоящий отказ гейта остаётся ошибкой", () => {
    for (const status of ["forbidden", "failed", "invalid_payload"]) {
      expect(isFailureResult(JSON.stringify({ ok: false, status }))).toBe(true);
    }
  });

  test("ok:false без статуса — по-прежнему ошибка", () => {
    expect(isFailureResult(JSON.stringify({ ok: false, error: "boom" }))).toBe(true);
  });

  test("успех и сырой текст ошибкой не считаются", () => {
    expect(isFailureResult(JSON.stringify({ ok: true, result: {} }))).toBe(false);
    expect(isFailureResult("# Вики-страница\n\nтекст")).toBe(false);
    expect(isFailureResult("")).toBe(false);
    expect(isFailureResult("null")).toBe(false);
  });

  test("status не строка — не пролезает как управляющий", () => {
    expect(isFailureResult(JSON.stringify({ ok: false, status: null }))).toBe(true);
    expect(isFailureResult(JSON.stringify({ ok: false, status: 0 }))).toBe(true);
  });

  test("набор статусов — один на два пути, копии в tool-loop нет", () => {
    expect([...CONTROL_TOOL_STATUSES].sort()).toEqual([
      "pending_approval",
      "rate_limited",
    ]);
    const loop = readFileSync(
      join(import.meta.dir, "../lib/tool-loop.ts"),
      "utf8",
    );
    // Прямой импорт tool-loop → agent-sdk-runtime уже есть, обратный дал бы
    // цикл; поэтому общий набор живёт в constants.ts, и второй копии быть не
    // должно — разъехавшиеся близнецы в этом коде уже случались.
    expect(loop).not.toContain('new Set(["pending_approval"');
    expect(loop).toContain("CONTROL_TOOL_STATUSES,");
  });
});
