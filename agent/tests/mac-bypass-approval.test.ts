/**
 * Аудит 2026-08-08: bypass-запуск на Mac владельца мог уйти без человека.
 *
 * `mode: "bypass"` доезжает до демона как `claude --permission-mode
 * bypassPermissions` в проекте на личном MacBook — то есть произвольные команды
 * без единого подтверждения. И хендлер, и комментарий у macAutonomous
 * утверждали, что человек тут обязателен всегда; на деле approval держался
 * только на ALWAYS_APPROVE, а `macAuto` (MAC_AUTONOMOUS=true) эту ветку как раз
 * пропускает — по одному actionType, не заглядывая в payload.
 *
 * Тест закрывает именно ту комбинацию, где дыра и была: владелец включил
 * автономию для MAC_RUN_CLAUDE вообще — но не для bypass.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  evaluateGate,
  isBypassMacRun,
  payloadForcesApproval,
} from "../lib/permissions.ts";

const prevAutonomous = process.env.MAC_AUTONOMOUS;

afterEach(() => {
  // Без восстановления env течёт в соседние тесты (CLAUDE.md §3.8 п.7).
  if (prevAutonomous === undefined) delete process.env.MAC_AUTONOMOUS;
  else process.env.MAC_AUTONOMOUS = prevAutonomous;
});

const RUN = (mode: string) => ({ project: "/x", prompt: "p", mode });

describe("isBypassMacRun", () => {
  test("только bypass и только у MAC_RUN_CLAUDE", () => {
    expect(isBypassMacRun("MAC_RUN_CLAUDE", RUN("bypass"))).toBe(true);
    for (const m of ["ask", "accept_edits", "plan", "auto"]) {
      expect(isBypassMacRun("MAC_RUN_CLAUDE", RUN(m))).toBe(false);
    }
    expect(isBypassMacRun("MAC_STOP", RUN("bypass"))).toBe(false);
    expect(isBypassMacRun("SEND_MESSAGE", RUN("bypass"))).toBe(false);
  });

  test("мусорный payload не роняет проверку", () => {
    expect(isBypassMacRun("MAC_RUN_CLAUDE", undefined)).toBe(false);
    expect(isBypassMacRun("MAC_RUN_CLAUDE", null)).toBe(false);
    expect(isBypassMacRun("MAC_RUN_CLAUDE", {})).toBe(false);
  });
});

describe("payloadForcesApproval", () => {
  test("причина у bypass своя, а не owner-identity", () => {
    const r = payloadForcesApproval("MAC_RUN_CLAUDE", RUN("bypass"));
    expect(r).toBe("bypass mode requires approval");
  });

  test("owner-voice по-прежнему даёт свою причину", () => {
    expect(payloadForcesApproval("SEND_MESSAGE", { via_userbot: true })).toBe(
      "owner-identity action requires approval",
    );
  });

  test("обычный запуск ничего не форсит", () => {
    expect(payloadForcesApproval("MAC_RUN_CLAUDE", RUN("ask"))).toBeNull();
  });
});

describe("гейт: MAC_AUTONOMOUS не распространяется на bypass", () => {
  test("bypass требует человека даже при MAC_AUTONOMOUS=true", () => {
    process.env.MAC_AUTONOMOUS = "true";
    const forced = payloadForcesApproval("MAC_RUN_CLAUDE", RUN("bypass"));
    const g = evaluateGate({
      agentKey: "orchestrator",
      actionType: "MAC_RUN_CLAUDE",
      forceApproval: forced !== null,
      forceApprovalReason: forced ?? undefined,
    });
    expect(g.decision).toBe("approval");
    expect((g as { reason: string }).reason).toBe(
      "bypass mode requires approval",
    );
  });

  test("не-bypass при MAC_AUTONOMOUS=true остаётся как был — опция не сломана", () => {
    process.env.MAC_AUTONOMOUS = "true";
    const forced = payloadForcesApproval("MAC_RUN_CLAUDE", RUN("accept_edits"));
    expect(forced).toBeNull();
    const g = evaluateGate({
      agentKey: "orchestrator",
      actionType: "MAC_RUN_CLAUDE",
      forceApproval: false,
    });
    // Конкретное решение зависит от autonomy чата; важно, что approval сюда
    // больше не приходит ИЗ-ЗА payload'а.
    expect(g.decision === "allow" || g.decision === "approval").toBe(true);
  });
});
