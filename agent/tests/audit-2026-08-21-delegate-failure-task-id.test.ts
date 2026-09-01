/**
 * Аудит 2026-08-21: провал делегирования терял `taskId`.
 *
 * DELEGATE_TO_ROLE заводит строку в `tasks` («[delegate→role] …»), переводит её
 * в `running`, и при отказе делегата закрывает как `failed`. Но возврат провала
 * отдавал только `{ ok:false, error }` — без `taskId`. А `dispatchAndAudit`
 * пишет в `agent_actions` ровно `res.taskId ?? null` на ОБЕИХ ветках, так что
 * каждый неудавшийся ход оставлял в журнале строку с `task_id = NULL` рядом с
 * осиротевшей задачей на доске: связать их можно было только по времени.
 *
 * Что делает контракт таким: комментарий у самого union `DispatchResult`
 * (action-dispatch.ts) прямо говорит, что `taskId` есть и у провала, и сосед
 * SPLIT_TASK так и делает — его провал возвращает `taskId: parent.id`. То есть
 * это не задумка, а пропуск в одной из двух веток.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { dispatchAction, dispatchAndAudit } from "../lib/action-dispatch.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { listTasksByChat } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";
import type { HandoffDeps, RespondAsOpts, HandoffOutcome } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_821;

let savedGlobal = saveAutonomy();

beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  savedGlobal = saveAutonomy();
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
});

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

/** Стаб делегата с заранее заданным исходом хода. */
function outcomeStub(outcome: HandoffOutcome) {
  return mock(async (_o: RespondAsOpts, _d: HandoffDeps) => outcome);
}

function ctxWith(stub: unknown) {
  return {
    agentKey: "orchestrator",
    chatId: TEST_CHAT,
    resolveAgent: (k: string) => fakeBot(k),
    handoffDeps: fakeDeps(),
    respondAsImpl: stub as never,
  };
}

/** Строка доски, заведённая делегированием (а не самодиагностикой). */
function delegateTaskRow() {
  const rows = listTasksByChat(TEST_CHAT).filter((r) =>
    /^\[delegate→/.test(String(r.title)),
  );
  expect(rows.length).toBe(1);
  return rows[0]!;
}

describe("DELEGATE_TO_ROLE: провал возвращает taskId заведённой задачи", () => {
  test("skipped (роль на паузе) → taskId той же строки, что закрыта failed", async () => {
    const stub = outcomeStub({
      status: "skipped",
      reason: "роль design остановлена (paused)",
    });
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "макет баннера" },
      ctxWith(stub) as never,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/delegate_skipped/);

    const row = delegateTaskRow();
    expect(row.status).toBe("failed");
    // Собственно инвариант: вызывающий получает id строки, которую увидит на доске.
    expect(res.taskId).toBe(row.id);
  });

  test("failed (делегат сломался) → тот же контракт", async () => {
    const stub = outcomeStub({
      status: "failed",
      reason: "anthropic 500",
    });
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "backend", task: "почини импорт" },
      ctxWith(stub) as never,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/delegate_failed: anthropic 500/);
    expect(res.taskId).toBe(delegateTaskRow().id);
  });

  test("успех по-прежнему несёт taskId (контроль, чтобы правка не съела ветку)", async () => {
    const stub = outcomeStub({ status: "answered", reply: "готово" });
    const res = await dispatchAction(
      "DELEGATE_TO_ROLE",
      { role: "design", task: "макет" },
      ctxWith(stub) as never,
    );
    expect(res.ok).toBe(true);
    const row = delegateTaskRow();
    expect(row.status).toBe("done");
    expect(res.taskId).toBe(row.id);
  });

  test("audit-строка провала ссылается на задачу, а не на NULL", async () => {
    const stub = outcomeStub({
      status: "skipped",
      reason: "исчерпан бюджет вызовов ролей на ход (8)",
    });
    // `_diag: true` — штатный opt-out самодиагностики. Здесь он нужен, чтобы в
    // чате не появлялись её задачи: измеряем ровно одну строку журнала.
    await dispatchAndAudit(
      "DELEGATE_TO_ROLE",
      { role: "smm", task: "пост", _diag: true } as never,
      ctxWith(stub) as never,
    );
    const logged = db
      .prepare(
        `SELECT task_id FROM agent_actions
          WHERE chat_id = ? AND action_type = 'DELEGATE_TO_ROLE' AND status = 'error'`,
      )
      .all(TEST_CHAT) as { task_id: string | null }[];
    expect(logged.length).toBe(1);
    expect(logged[0]!.task_id).toBe(delegateTaskRow().id);
  });
});
