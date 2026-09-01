/**
 * Аудит 2026-08-20: у вызова aieng в self-diag не было потолка ожидания.
 *
 * `processDiagTask` делает `await runTextViaAgentSdk(...)` — это спавн
 * дочернего `claude`. У вызова нет ни таймаута, ни AbortSignal, ни гонки с
 * дедлайном. Тик поллера держит флаг `running` на всё время await и снимает
 * его только в `finally`, так что один зависший subprocess (CLI не ответил,
 * сокет повис) останавливает ВЕСЬ self-heal — навсегда и молча: строка в лог
 * не пишется, следующий тик выходит по `if (running) return`.
 *
 * Вторая половина ущерба — сама задача. В начале `processDiagTask` она уже
 * переведена в `running`, а `listPendingDiagTasks` выбирает только
 * `status='pending'`. То есть даже после перезапуска процесса задача не
 * подхватится: она не pending и не завершена, она просто выпала.
 *
 * Чинится дедлайном: гонка с таймером, по срабатыванию — `SelfDiagTimeoutError`
 * в тот же catch, который уже умеет пометить задачу `failed`. Задача становится
 * видимой (терминальный статус с причиной), а поллер освобождается.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  processDiagTask,
  withDeadline,
  SelfDiagTimeoutError,
  SELF_DIAG_LLM_TIMEOUT_MS,
  type SelfDiagDeps,
} from "../lib/self-diag.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_820;
const AUTHORITY = "orchestrator";

let saved = saveAutonomy();

beforeEach(() => {
  saved = saveAutonomy();
  _resetRateLimits();
});

afterEach(() => {
  restoreAutonomy(saved);
  _resetRateLimits();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  cleanupChat(CHAT, "aieng");
  cleanupChat(CHAT, AUTHORITY);
});

function diagTask() {
  setAutonomy("chat", String(CHAT), "auto");
  return createTask({
    title: "diag",
    chatId: CHAT,
    createdBy: AUTHORITY,
    assignedTo: "aieng",
    inputPayload: {
      _diag: true,
      actionType: "SEND_MESSAGE",
      payload: { text: "привет" },
      error: "no telegram context",
      _retry_count: 0,
    },
  });
}

const never = () => new Promise<string>(() => {});

describe("withDeadline", () => {
  test("промис успел — возвращается его значение, таймер не стреляет", async () => {
    await expect(withDeadline(Promise.resolve("ok"), 5_000)).resolves.toBe("ok");
  });

  test("промис не успел — SelfDiagTimeoutError с указанием потолка", async () => {
    const p = withDeadline(never(), 30);
    await expect(p).rejects.toBeInstanceOf(SelfDiagTimeoutError);
    await p.catch((e: Error) => {
      expect(e.message).toContain("30");
    });
  });

  test("собственный reject промиса доезжает как есть, не подменяется таймаутом", async () => {
    const boom = new Error("cli died");
    await expect(withDeadline(Promise.reject(boom), 5_000)).rejects.toBe(boom);
  });

  test("поздний reject проигравшего промиса не всплывает как unhandled", async () => {
    let rejectLate: (e: Error) => void = () => {};
    const late = new Promise<string>((_, rej) => {
      rejectLate = rej;
    });
    await expect(withDeadline(late, 20)).rejects.toBeInstanceOf(
      SelfDiagTimeoutError,
    );
    // Гонка уже подписана на `late`, так что его отказ считается обработанным.
    rejectLate(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 30));
    expect(true).toBe(true);
  });

  test("дефолтный потолок задан и конечен", () => {
    expect(Number.isFinite(SELF_DIAG_LLM_TIMEOUT_MS)).toBe(true);
    expect(SELF_DIAG_LLM_TIMEOUT_MS).toBeGreaterThan(0);
    // Верхняя граница: дольше десяти минут ждать один одношаговый ответ
    // бессмысленно — поллер всё это время стоит.
    expect(SELF_DIAG_LLM_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60_000);
  });
});

describe("processDiagTask: зависший вызов aieng", () => {
  test("не висит вечно — возвращает управление по дедлайну", async () => {
    const task = diagTask();
    const deps: SelfDiagDeps = {
      llmTimeoutMs: 60,
      runTextImpl: never,
      buildDispatchCtx: () => null,
    } as unknown as SelfDiagDeps;

    const started = Date.now();
    await processDiagTask(task, deps);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("задача уходит в терминальный failed, а не застревает в running", async () => {
    const task = diagTask();
    const deps: SelfDiagDeps = {
      llmTimeoutMs: 60,
      runTextImpl: never,
      buildDispatchCtx: () => null,
    } as unknown as SelfDiagDeps;

    await processDiagTask(task, deps);

    const after = getTask(task.id);
    expect(after?.status).toBe("failed");
    expect(String(after?.error ?? "")).toContain("timed out");
  });

  test("тот же дедлайн действует на compat-сим callAnthropicImpl", async () => {
    const task = diagTask();
    const deps: SelfDiagDeps = {
      anthropic: {} as never,
      model: "test",
      llmTimeoutMs: 60,
      callAnthropicImpl: (() => new Promise(() => {})) as never,
      buildDispatchCtx: () => null,
    } as unknown as SelfDiagDeps;

    await processDiagTask(task, deps);

    const after = getTask(task.id);
    expect(after?.status).toBe("failed");
    expect(String(after?.error ?? "")).toContain("timed out");
  });

  test("успевший вызов дедлайном не трогается", async () => {
    const task = diagTask();
    const deps: SelfDiagDeps = {
      llmTimeoutMs: 5_000,
      runTextImpl: async () => JSON.stringify({ giveup: true, reason: "нечего чинить" }),
      buildDispatchCtx: () => null,
    } as unknown as SelfDiagDeps;

    await processDiagTask(task, deps);

    const after = getTask(task.id);
    // giveup — это done, а не failed: aieng ответил вовремя и по делу.
    expect(after?.status).not.toBe("running");
    expect(String(after?.error ?? "")).not.toContain("timed out");
  });
});
