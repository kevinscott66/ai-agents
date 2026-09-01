/**
 * Аудит 2026-08-29: подбор брошенных diag-задач не отличал «умерла ДО
 * отправки действия» от «умерла ПОСЛЕ» — и повторял побочный эффект.
 *
 * Между `updateTaskStatus(task.id, "running")` и терминальной записью нет ни
 * одной долговечной отметки, а посередине стоит единственный на весь модуль
 * `dispatchAndAudit`. Задача, пережившая `systemctl restart` или выкатку
 * внутри длинного вызова (`GENERATE_IMAGE`, порезанный на части
 * `SEND_DOCUMENT`), возвращалась подбором в `pending` — и тем же тиком
 * подбиралась заново, потому что `tick()` зовёт `listPendingDiagTasks` сразу
 * после `recoverStrandedDiagTasks`. Второй пост в канал, второй документ,
 * вторая платная картинка.
 *
 * Второй дефект того же места: `JSON.parse(row.input)` в подборе падал в
 * `catch`, оставлял `input = {}` и всё равно возвращал задачу в `pending`, а
 * запись затирала JSON целиком на `{"_diag_restarts":1}`. Строки
 * `"_diag":true` в input больше нет — значит задачу не видит ни подбор, ни
 * `listPendingDiagTasks`. Комментарий в `catch` обещал, что «закроет её
 * второй проход по счётчику»: именно этого произойти и не могло, задача
 * висела в `pending` до `gcStaleTasks`, который через сутки называл её
 * `gc_stale`.
 *
 * Замер до фикса на этом файле (сеам на месте, логика откачена): 4 pass / 8 fail.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  processDiagTask,
  recoverStrandedDiagTasks,
  markDiagDispatched,
  SELF_DIAG_STRANDED_MS,
  type SelfDiagDeps,
} from "../lib/self-diag.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_830;
const AUTHORITY = "orchestrator";

let saved = saveAutonomy();

beforeEach(() => {
  saved = saveAutonomy();
  _resetRateLimits();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

afterEach(() => {
  restoreAutonomy(saved);
  _resetRateLimits();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  cleanupChat(CHAT, "aieng");
  cleanupChat(CHAT, AUTHORITY);
});

function rawInput(id: string): string {
  const row = db.prepare(`SELECT input FROM tasks WHERE id=?`).get(id) as
    | { input: string | null }
    | undefined;
  return row?.input ?? "";
}

function inputOf(id: string): Record<string, unknown> {
  return JSON.parse(rawInput(id) || "{}") as Record<string, unknown>;
}

function diagTask(): string {
  setAutonomy("chat", String(CHAT), "auto");
  return createTask({
    title: "diag",
    chatId: CHAT,
    createdBy: AUTHORITY,
    assignedTo: "aieng",
    inputPayload: {
      _diag: true,
      actionType: "SEND_MESSAGE",
      payload: { text: "исходный текст" },
      error: "no telegram context",
      _retry_count: 0,
    },
  }).id;
}

/** Смерть процесса в окне: задача осталась в `running` и состарилась. */
function strand(id: string, ageMs = SELF_DIAG_STRANDED_MS + 60_000): void {
  db.prepare(`UPDATE tasks SET status='running', updated_at=? WHERE id=?`).run(
    Date.now() - ageMs,
    id,
  );
}

function aiengProposes(text: string) {
  return (async () => ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [
      {
        type: "text",
        text: JSON.stringify({
          action: "SEND_MESSAGE",
          payload: { text },
          reason: "fix",
        }),
      },
    ],
  })) as any;
}

function deps(text: string, sendMessage: () => Promise<unknown>): SelfDiagDeps {
  return {
    anthropic: {} as any,
    model: "test",
    callAnthropicImpl: aiengProposes(text),
    buildDispatchCtx: (args: { agentKey: string; chatId: number }) =>
      ({
        agentKey: args.agentKey,
        chatId: args.chatId,
        telegram: { sendMessage },
      }) as any,
  } as unknown as SelfDiagDeps;
}

describe("отметка об отправке пишется ДО побочного эффекта", () => {
  test("к моменту доставки сообщения строка уже помечена", async () => {
    const id = diagTask();
    let markedAtSend: unknown;
    const task = getTask(id)!;

    await processDiagTask(
      task,
      deps("ответ", async () => {
        markedAtSend = inputOf(id)._diag_dispatched;
        return { message_id: 1 };
      }),
    );

    expect(markedAtSend).toBe("SEND_MESSAGE");
  });

  test("отметка переживает отправку и остаётся в строке", async () => {
    const id = diagTask();
    await processDiagTask(
      getTask(id)!,
      deps("ответ", async () => ({ message_id: 1 })),
    );

    expect(inputOf(id)._diag_dispatched).toBe("SEND_MESSAGE");
  });

  test("`_diag` не теряется — выборка подбора всё ещё матчит строку", () => {
    const id = diagTask();
    markDiagDispatched(id, "GENERATE_IMAGE");

    expect(inputOf(id)._diag).toBe(true);
    expect(rawInput(id)).toContain('"_diag":true');
  });

  test("прочие поля input не затираются", () => {
    const id = diagTask();
    markDiagDispatched(id, "SEND_DOCUMENT");

    const input = inputOf(id);
    expect(input.actionType).toBe("SEND_MESSAGE");
    expect(input._retry_count).toBe(0);
    expect((input.payload as Record<string, unknown>).text).toBe(
      "исходный текст",
    );
  });
});

describe("подбор не повторяет уже отправленное действие", () => {
  test("помеченная задача уходит в failed, а не в pending", () => {
    const id = diagTask();
    markDiagDispatched(id, "SEND_MESSAGE");
    strand(id);

    const res = recoverStrandedDiagTasks();

    expect(res.requeued).not.toContain(id);
    expect(res.failed).toContain(id);
    expect(getTask(id)?.status).toBe("failed");
  });

  test("причина названа честно и содержит имя действия", () => {
    const id = diagTask();
    markDiagDispatched(id, "GENERATE_IMAGE");
    strand(id);

    recoverStrandedDiagTasks();

    const err = getTask(id)?.error ?? "";
    expect(err).toContain("GENERATE_IMAGE");
    expect(err).toContain("после отправки");
    expect(err).not.toContain("gc_stale");
  });

  test("помеченной задаче не ставится счётчик перезапусков", () => {
    const id = diagTask();
    markDiagDispatched(id, "SEND_MESSAGE");
    strand(id);

    recoverStrandedDiagTasks();

    expect(inputOf(id)._diag_restarts).toBeUndefined();
  });

  test("контроль: без отметки задача по-прежнему возвращается в pending", () => {
    const id = diagTask();
    strand(id);

    const res = recoverStrandedDiagTasks();

    expect(res.requeued).toContain(id);
    expect(getTask(id)?.status).toBe("pending");
  });
});

describe("нечитаемый input закрывается, а не воскресает", () => {
  /** Строка содержит `"_diag":true` (выборка её видит), но не парсится. */
  function corrupt(id: string, input: string): void {
    db.prepare(`UPDATE tasks SET input=? WHERE id=?`).run(input, id);
    strand(id);
  }

  test("битый JSON → failed, не pending", () => {
    const id = diagTask();
    corrupt(id, '{"_diag":true, "payload": {oops');

    const res = recoverStrandedDiagTasks();

    expect(res.requeued).not.toContain(id);
    expect(res.failed).toContain(id);
    expect(getTask(id)?.status).toBe("failed");
    expect(getTask(id)?.error).toContain("нечитаемый input");
  });

  test("отметка на битой строке оставляет строку разбираемой", () => {
    // markDiagDispatched зовут на уже прочитанной задаче, так что это
    // подстраховка: даже потеряв нечитаемый мусор, она обязана оставить
    // валидный JSON с `"_diag":true` — иначе задачу не увидит и подбор.
    const id = diagTask();
    db.prepare(`UPDATE tasks SET input=? WHERE id=?`).run('{"_diag":true, oops', id);

    markDiagDispatched(id, "SEND_MESSAGE");

    expect(inputOf(id)._diag).toBe(true);
    expect(inputOf(id)._diag_dispatched).toBe("SEND_MESSAGE");
  });

  test("input не затирается на `{\"_diag_restarts\":1}`", () => {
    const id = diagTask();
    corrupt(id, '{"_diag":true, "payload": {oops');

    recoverStrandedDiagTasks();

    // Раньше подбор писал сюда сериализованный `{}` + счётчик, и строка
    // переставала матчиться обеими выборками — задача пропадала совсем.
    expect(rawInput(id)).not.toContain("_diag_restarts");
    expect(rawInput(id)).toContain("oops");
  });

  test("здоровые задачи в той же выборке не страдают", () => {
    const broken = diagTask();
    corrupt(broken, '{"_diag":true, oops');
    const healthy = diagTask();
    strand(healthy);

    const res = recoverStrandedDiagTasks();

    expect(res.failed).toContain(broken);
    expect(res.requeued).toContain(healthy);
    expect(getTask(healthy)?.status).toBe("pending");
  });
});
