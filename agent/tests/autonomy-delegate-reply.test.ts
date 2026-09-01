/**
 * Шаг 2 автономности: DELEGATE_TO_ROLE возвращает оркестратору ОТВЕТ делегата
 * (result.reply), чтобы он передал результат следующему шагу пайплайна.
 */
import { describe, test, expect, mock } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import type { RunningBot } from "../lib/types.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";

const CHAT = -100777;
const fakeBot = (k: string): RunningBot => ({
  def: { key: k as never, name: k, envToken: "", system: "" } as never,
  bot: { telegram: {} } as never,
  username: `${k}_bot`,
  id: 100,
});
const fakeDeps = (): HandoffDeps => ({ anthropic: {} as never, model: "t", historyLimit: 10, bots: [] });

describe("autonomy step 2 — DELEGATE returns delegate reply", () => {
  test("result.reply carries the delegated agent's output", async () => {
    const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "ГОТОВЫЙ МАКЕТ: лендинг v1");
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "сделай макет" },
      {
        agentKey: "orchestrator",
        chatId: CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { reply?: string; delegated?: boolean };
      expect(r.delegated).toBe(true);
      expect(r.reply).toBe("ГОТОВЫЙ МАКЕТ: лендинг v1");
    }
  });

  // Аудит 2026-08-13: тут проверялось, что провал делегата приезжает как
  // ok:true с reply:null. Ровно этого признака оркестратору и не хватало, чтобы
  // отличить «роль не отработала» от «роль отработала»: tool-loop ставит
  // is_error только по ok===false, поэтому пайплайн шёл дальше и в чат уходило
  // «готово».
  test("делегат не отработал → ok:false с причиной, а не молчаливое reply:null", async () => {
    const stub = mock(async () => ({
      status: "failed" as const,
      reason: "connect ECONNREFUSED",
    }));
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "frontend", task: "x" },
      { agentKey: "orchestrator", chatId: CHAT, resolveAgent: (k) => fakeBot(k), handoffDeps: fakeDeps(), respondAsImpl: stub as never },
    );
    if (res.ok) throw new Error("ожидался отказ, получен ok:true");
    expect(String(res.error)).toContain("delegate_failed");
    expect(String(res.error)).toContain("ECONNREFUSED");
  });

  test("ход, закрытый инструментом → ok:true, но вместо reply — явная пометка", async () => {
    const stub = mock(async () => ({ status: "acted" as const }));
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "нарисуй баннер" },
      { agentKey: "orchestrator", chatId: CHAT, resolveAgent: (k) => fakeBot(k), handoffDeps: fakeDeps(), respondAsImpl: stub as never },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("ожидался ok:true");
    const r = res.result as { reply: unknown; note?: string };
    expect(r.reply).toBeNull();
    // Без пометки модель принимает пустоту за «нечего сказать» и пересказывает
    // картинку, которой не видела.
    expect(String(r.note)).toContain("действием");
  });
});
