/**
 * Аудит 2026-09-11, круг 30: circuit breaker T-705b был недостижим.
 *
 * Оба предохранителя C15 стояли под одним условием:
 *
 *     if (!shouldSkipSelfDiag(...) && !diagFlag && retryCount < 1) {
 *       if (parentChain.length >= maxDepth) { …breaker… }
 *
 * Единственный, кто пишет `_fix_chain` в payload ДЕЙСТВИЯ, — `processDiagTask`
 * в lib/self-diag.ts, и он кладёт на тот же объект `_retry_count: 1`. Значит
 * payload с непустой цепочкой внешнее условие не проходит, а у всех, кто до
 * сравнения доходил, цепочка ПУСТА. `positiveEnvInt` не пускает maxDepth ниже
 * единицы, так что `0 >= maxDepth` ложно всегда. Ветка мертва, лог
 * `inter_agent_fix.circuit_breaker` не мог появиться ни при какой настройке,
 * а ручка INTER_AGENT_FIX_CHAIN_MAX_DEPTH не управляла ничем.
 *
 * Почему это не поймал t705b-anti-loop-guards.test.ts: он кормит диспетчер
 * payload'ами вида `{ text: "hi", _fix_chain: ["a","b","c"] }` — с цепочкой и
 * БЕЗ `_retry_count`. Такой формы конвейер не производит. Тест исполнял ветку,
 * которую в бою не исполнял никто, и ровно этим её мёртвость маскировал.
 * Отсюда правило здесь: payload берётся в той форме, в какой его собирает
 * self-diag, а не в удобной для теста.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { dispatchAndAudit, type DispatchAndAuditResult } from "../lib/action-dispatch.ts";
import { cleanupChat } from "./_helpers.ts";

const TEST_CHAT = -1_000_9311;

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH;
  else process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = savedEnv;
  cleanupChat(TEST_CHAT, "orchestrator");
  cleanupChat(TEST_CHAT, "aieng");
});

function errorOf(res: DispatchAndAuditResult): string {
  if (res.ok) throw new Error("ожидали провал действия, получили ok");
  return res.error;
}

function diagTasksFor(chatId: number): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE chat_id = ? AND assigned_to = 'aieng' AND input LIKE '%"_diag":true%'`,
    )
    .get(chatId) as { n: number };
  return r.n;
}

/** Ровно та форма, которую собирает `processDiagTask` перед ретраем. */
function retryPayload(chain: string[]): Record<string, unknown> {
  return { text: "hi", _retry_count: 1, _fix_chain: chain };
}

describe("breaker меряет цепочку, а не счётчик ретраев", () => {
  test("payload ретрая с цепочкой >= потолка доводит до breaker", async () => {
    process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = "1";

    const res = await dispatchAndAudit("SEND_MESSAGE", retryPayload(["diag:SEND_MESSAGE:x"]) as any, {
      agentKey: "orchestrator",
      chatId: TEST_CHAT,
    });

    expect(res.ok).toBe(false);
    // До правки сюда приезжала исходная ошибка действия: внешнее условие
    // отсекало весь блок по `_retry_count === 1`, и breaker молчал.
    expect(errorOf(res)).toContain("circuit breaker");
  });

  test("breaker не заводит новую диаг-задачу", async () => {
    process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = "1";
    const before = diagTasksFor(TEST_CHAT);

    await dispatchAndAudit("SEND_MESSAGE", retryPayload(["diag:SEND_MESSAGE:x"]) as any, {
      agentKey: "orchestrator",
      chatId: TEST_CHAT,
    });

    expect(diagTasksFor(TEST_CHAT)).toBe(before);
  });

  test("цепочка короче потолка — breaker молчит, но и задачи нет (cap ретрая)", async () => {
    process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = "3";
    const before = diagTasksFor(TEST_CHAT);

    const res = await dispatchAndAudit("SEND_MESSAGE", retryPayload(["one"]) as any, {
      agentKey: "orchestrator",
      chatId: TEST_CHAT,
    });

    expect(errorOf(res)).not.toContain("circuit breaker");
    // Счётчик ретраев по-прежнему ограничивает ЗАВЕДЕНИЕ задачи — это второй,
    // независимый вопрос, и разделение предохранителей его не ослабило.
    expect(diagTasksFor(TEST_CHAT)).toBe(before);
  });

  test("первая попытка (счётчика нет) по-прежнему заводит диаг-задачу", async () => {
    process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH = "3";
    const before = diagTasksFor(TEST_CHAT);

    const res = await dispatchAndAudit("SEND_MESSAGE", { text: "hi" } as any, {
      agentKey: "orchestrator",
      chatId: TEST_CHAT,
    });

    expect(res.ok).toBe(false);
    expect(errorOf(res)).not.toContain("circuit breaker");
    expect(diagTasksFor(TEST_CHAT)).toBe(before + 1);
  });
});

describe("почему прежняя форма была мертва", () => {
  test("писатель `_fix_chain` в payload действия ставит `_retry_count: 1`", () => {
    // Различающее свидетельство: пока это так, «цепочка непуста» и
    // «счётчик меньше единицы» несовместимы, и держать их под одним `if`
    // значит навсегда закрыть второе первым.
    const src = readFileSync(new URL("../lib/self-diag.ts", import.meta.url), "utf8");
    const i = src.indexOf("_fix_chain: retryChain");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, i - 200), i)).toContain("_retry_count: 1");
  });

  test("в диспетчере предохранители больше не под одним условием", () => {
    const src = readFileSync(new URL("../lib/action-dispatch.ts", import.meta.url), "utf8");
    // Именно эта связка и была дефектом: цепочка меряется только тогда,
    // когда payload заведомо не может её нести.
    expect(src).not.toContain("!diagFlag && retryCount < 1");
  });
});
