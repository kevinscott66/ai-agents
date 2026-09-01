/**
 * Аудит 2026-08-11: защита от блокировки себя стояла не на том агенте.
 *
 * `validateChangeAgentStatusPayload` отдельным guard'ом (T-704) запрещает
 * выключить и залочить `orchestrator` — с объяснением «lock-out risk». Про
 * `perm` там не было ничего, хотя невозвратна как раз его блокировка:
 *
 *  • CHANGE_AGENT_STATUS в CALLER_RESTRICTED привязан к `perm` — больше никто
 *    его вызвать не может;
 *  • `evaluateGate` первым делом отвечает deny выключенному агенту на ЛЮБОЕ
 *    действие (permissions.ts, isAgentDisabled);
 *  • колонку `agent_states.status` во всём проекте пишет только
 *    `setAgentStatus`, то есть только этот же хендлер. В Mini App есть
 *    пауза/автономия, но НЕ статус.
 *
 * Значит `perm` выключает `perm` — и включить его обратно нечем: ни агенту, ни
 * владельцу из интерфейса. Только руками в SQLite на VPS.
 *
 * Сценарий не гипотетический и не атака: CHANGE_AGENT_STATUS в
 * ALWAYS_APPROVE_ACTIONS, то есть эту кнопку нажимает человек — по просьбе
 * агента вида «perm ведёт себя странно, выключи его». Формулировка выглядит
 * разумной ровно до нажатия.
 *
 * `locked` для perm не запрещаем: автономию Mini App переписывает
 * (POST /api/autonomy → setAutonomy('agent', …)), то есть это возвратно.
 * Обратимый способ остановить perm тоже остаётся — пауза из Mini App: она
 * денаит на гейте так же, а снимается кнопкой.
 */
import { describe, test, expect } from "bun:test";
import { validateChangeAgentStatusPayload } from "../lib/dispatch/agent-status.ts";
import { CALLER_RESTRICTED } from "../lib/permissions.ts";

const REASON = "перестраховка после инцидента с правами";

describe("perm нельзя выключить — включать его будет некому", () => {
  test("new_status=disabled для perm отклоняется", () => {
    const err = validateChangeAgentStatusPayload({
      target_agent_key: "perm",
      new_status: "disabled",
      reason: REASON,
    } as never);
    expect(err).toMatch(/perm/);
    expect(err).toMatch(/lock-out|включ/i);
  });

  test("остальные агенты выключаются как и раньше — их включит perm", () => {
    for (const key of ["qa", "smm", "design", "backend"]) {
      const err = validateChangeAgentStatusPayload({
        target_agent_key: key,
        new_status: "disabled",
        reason: REASON,
      } as never);
      expect(err).toBeNull();
    }
  });

  test("perm можно включить обратно и сменить ему автономию", () => {
    expect(
      validateChangeAgentStatusPayload({
        target_agent_key: "perm",
        new_status: "active",
        reason: REASON,
      } as never),
    ).toBeNull();
    expect(
      validateChangeAgentStatusPayload({
        target_agent_key: "perm",
        new_autonomy_mode: "locked",
        reason: REASON,
      } as never),
    ).toBeNull();
  });

  test("orchestrator остаётся защищённым (T-704)", () => {
    expect(
      validateChangeAgentStatusPayload({
        target_agent_key: "orchestrator",
        new_status: "disabled",
        reason: REASON,
      } as never),
    ).toMatch(/lock-out/);
  });
});

describe("предпосылка защиты", () => {
  test("CHANGE_AGENT_STATUS всё ещё привязан к perm", () => {
    // Если ограничение когда-нибудь снимут, guard выше станет лишним — но
    // молча лишним, поэтому предпосылку фиксируем явно.
    expect(CALLER_RESTRICTED.CHANGE_AGENT_STATUS).toBe("perm");
  });
});
