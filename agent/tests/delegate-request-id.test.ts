/**
 * Аудит 2026-08-08: делегированный ход не наследовал request_id.
 *
 * T-410 завёл корреляционный id, чтобы одно сообщение пользователя читалось в
 * audit_logs как одна история. Но `RespondAsOpts` его не нёс, а
 * gateOrDispatch/dispatchAndAudit заводят новый при отсутствии — то есть
 * «оркестратор попросил backend, backend опубликовал в канал» распадалось на
 * несвязанные записи, и сшить их можно было только по времени.
 */
import { describe, test, expect, mock } from "bun:test";
import { dispatchAction, gateOrDispatch } from "../lib/action-dispatch.ts";
import type { RunningBot } from "../lib/types.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";

const CHAT = -1_000_812;
const fakeBot = (k: string): RunningBot => ({
  def: { key: k as never, name: k, envToken: "", system: "" } as never,
  bot: { telegram: {} } as never,
  username: `${k}_bot`,
  id: 100,
});
const fakeDeps = (): HandoffDeps => ({
  anthropic: {} as never,
  model: "t",
  historyLimit: 10,
  bots: [],
});

describe("DELEGATE_TO_ROLE → request_id", () => {
  test("делегат получает тот же request_id, что и делегирующий", async () => {
    let seen: RespondAsOpts | null = null;
    const stub = mock(async (o: RespondAsOpts) => {
      seen = o;
      return "готово";
    });
    await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "макет" },
      {
        agentKey: "orchestrator",
        chatId: CHAT,
        resolveAgent: (k) => fakeBot(k),
        handoffDeps: fakeDeps(),
        respondAsImpl: stub as never,
        requestId: "req-fixed-1",
      },
    );
    expect(seen).not.toBeNull();
    expect(seen!.requestId).toBe("req-fixed-1");
  });

  test("id, заведённый ленивo на входе, тоже доезжает до делегата", async () => {
    let seen: RespondAsOpts | null = null;
    const stub = mock(async (o: RespondAsOpts) => {
      seen = o;
      return "готово";
    });
    // ctx без requestId: gateOrDispatch заводит его сам, и именно этот id
    // должен уйти делегату — иначе ленивая ветка (а это обычный путь из чата)
    // остаётся ровно с той же дырой.
    const ctx = {
      agentKey: "orchestrator",
      chatId: CHAT,
      resolveAgent: (k: string) => fakeBot(k),
      handoffDeps: fakeDeps(),
      respondAsImpl: stub as never,
    };
    await gateOrDispatch(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "макет" } as never,
      ctx as never,
    );
    expect(seen).not.toBeNull();
    expect(typeof seen!.requestId).toBe("string");
    expect(seen!.requestId).toBe((ctx as { requestId?: string }).requestId);
  });
});
