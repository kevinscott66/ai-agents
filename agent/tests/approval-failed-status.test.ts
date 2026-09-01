/**
 * Аудит 2026-08-07: одобренное действие, которое упало при исполнении.
 *
 * Решение коммитится ДО исполнения (правильно: иначе краш между отправкой и
 * записью дал бы повторную отправку необратимого действия). Но при падении
 * строка оставалась `approved` с `reason=NULL` — в БД «одобрено и выполнено» и
 * «одобрено, но не выполнено» выглядели одинаково, а текст ошибки жил только в
 * ответе чата / 502 Mini App. Теперь провал терминально пишется в строку.
 *
 * Плюс здесь же — гейт `status='pending'` в WHERE у decideApproval: без него
 * два одновременных «Approve» могли оба дойти до исполнения.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  createApproval,
  decideApproval,
  getApproval,
  markApprovalFailed,
} from "../lib/approvals.ts";
import { cmdApprove } from "../lib/commands.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const TEST_CHAT = -1_000_807;
const prevAutonomy = saveAutonomy();

const mkApproval = (actionType = "SEND_MESSAGE", payload: unknown = { text: "привет" }) => {
  const actionId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO agent_actions(id, chat_id, agent_key, action_type, payload, status, created_at)
     VALUES (?, ?, 'orchestrator', ?, ?, 'pending_approval', ?)`,
  ).run(actionId, TEST_CHAT, actionType, JSON.stringify(payload), Date.now());
  return createApproval({
    actionId,
    chatId: TEST_CHAT,
    requestedBy: "orchestrator",
    actionType,
    payload,
  });
};

describe("approval: провал исполнения виден в строке", () => {
  beforeEach(() => {
    cleanupChat(TEST_CHAT, "orchestrator");
    setAutonomy("chat", String(TEST_CHAT), "auto");
  });
  afterAll(() => {
    cleanupChat(TEST_CHAT, "orchestrator");
    restoreAutonomy(prevAutonomy);
  });

  test("исполнение упало → status='failed' + причина в reason", async () => {
    const a = mkApproval();
    // resolveTg не передаём → у хендлера нет telegram-контекста → dispatch падает.
    const out = await cmdApprove({
      approvalId: a.id,
      decidedBy: "owner",
      chatId: TEST_CHAT,
    });
    expect(out).toContain("выполнение упало");

    const after = getApproval(a.id)!;
    expect(after.status).toBe("failed");
    expect(after.reason).toBeTruthy();
    expect(after.reason).toContain("telegram");
    // Решение человека не теряется: кто одобрил — по-прежнему в строке.
    expect(after.decided_by).toBe("owner");
  });

  test("успешное исполнение оставляет 'approved' — failed не ставится зря", async () => {
    const a = mkApproval();
    const sent: string[] = [];
    const out = await cmdApprove({
      approvalId: a.id,
      decidedBy: "owner",
      chatId: TEST_CHAT,
      deps: {
        resolveTg: () =>
          ({
            sendMessage: (_c: number, t: string) => {
              sent.push(t);
              return Promise.resolve({ message_id: 1 });
            },
          }) as never,
      },
    });
    expect(out).toContain("OK:");
    expect(sent.length).toBe(1);
    expect(getApproval(a.id)!.status).toBe("approved");
  });

  test("повторный /approve по упавшему апруву не исполняет заново", async () => {
    const a = mkApproval();
    await cmdApprove({ approvalId: a.id, decidedBy: "owner", chatId: TEST_CHAT });
    expect(getApproval(a.id)!.status).toBe("failed");

    let calls = 0;
    const out = await cmdApprove({
      approvalId: a.id,
      decidedBy: "owner",
      chatId: TEST_CHAT,
      deps: {
        resolveTg: () =>
          ({
            sendMessage: () => {
              calls++;
              return Promise.resolve({ message_id: 1 });
            },
          }) as never,
      },
    });
    expect(out).toContain("уже failed");
    expect(calls).toBe(0);
  });

  test("decideApproval: второй решающий по той же строке падает (гонка Approve)", () => {
    const a = mkApproval();
    expect(decideApproval(a.id, "approved", "owner").status).toBe("approved");
    // Второй «Approve» по уже решённой строке — исполнения быть не должно.
    expect(() => decideApproval(a.id, "approved", "admin2")).toThrow(/already approved/);
    // Решение первого не переписано.
    expect(getApproval(a.id)!.decided_by).toBe("owner");
  });

  test("markApprovalFailed трогает только approved-строки", () => {
    const pending = mkApproval();
    expect(markApprovalFailed(pending.id, "boom")).toBeNull();
    expect(getApproval(pending.id)!.status).toBe("pending");

    const rejected = mkApproval();
    decideApproval(rejected.id, "rejected", "owner", "нет");
    expect(markApprovalFailed(rejected.id, "boom")).toBeNull();
    expect(getApproval(rejected.id)!.status).toBe("rejected");
    expect(getApproval(rejected.id)!.reason).toBe("нет");
  });
});
