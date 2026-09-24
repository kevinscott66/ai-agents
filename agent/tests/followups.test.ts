/**
 * Отложенные проверки (lib/followups.ts): агент ставит их сам, в срок сервер
 * будит его с задачей. Инцидент 2026-09-18: Mac не отвечал, и агент предложил
 * владельцу «напомнить через пару минут» — доделывать дело пришлось человеку.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db.ts";
import {
  MAX_ACTIVE_FOLLOWUPS,
  MAX_ATTEMPTS,
  MAX_FOLLOWUPS_PER_DAY,
  RUNNING_STALE_MS,
  cancelFollowup,
  createFollowup,
  followupRefusal,
  getFollowup,
  renderFollowupTurn,
  runDueFollowups,
  type FollowupRow,
  type FollowupRunner,
} from "../lib/followups.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";

const OWNER = "918000918";
const OWNER_CHAT = Number(OWNER);
const OTHER_CHAT = -1_000_919;
const MIN = 60_000;

let savedOwners: string | undefined;
beforeAll(() => {
  savedOwners = process.env.MINIAPP_ADMIN_USER_IDS;
  process.env.MINIAPP_ADMIN_USER_IDS = OWNER;
});
afterAll(() => {
  if (savedOwners === undefined) delete process.env.MINIAPP_ADMIN_USER_IDS;
  else process.env.MINIAPP_ADMIN_USER_IDS = savedOwners;
});
const clean = () => db.prepare(`DELETE FROM followups WHERE chat_id IN (?, ?)`).run(OWNER_CHAT, OTHER_CHAT);
afterEach(() => {
  clean();
  _resetRateLimits();
});

const ownerCtx = { agentKey: "orchestrator", chatId: OWNER_CHAT, triggerUserId: OWNER, delegationChain: ["orchestrator"] };
const make = (inMin = 5, now = Date.now(), chatId = OWNER_CHAT) => {
  const r = createFollowup({ chatId, userId: OWNER, agentKey: "orchestrator", task: "повторить SHOP_QUOTE молока", inMin, now });
  if (!r.ok) throw new Error(r.error);
  return r.followup;
};

function fakeRunner(opts: { notifyFails?: boolean; runFails?: boolean } = {}) {
  const calls: { notify: string[]; run: Array<{ id: string; text: string; noticeId: number }> } = { notify: [], run: [] };
  const runner: FollowupRunner = {
    notify: async (_r: FollowupRow, text: string) => {
      if (opts.notifyFails) throw new Error("telegram 502");
      calls.notify.push(text);
      return 777;
    },
    run: async (r: FollowupRow, text: string, noticeId: number) => {
      calls.run.push({ id: r.id, text, noticeId });
      if (opts.runFails) throw new Error("turn crashed");
    },
  };
  return { runner, calls };
}

describe("кто может ставить проверку", () => {
  test("оркестратор в личке владельца — да", () => {
    expect(followupRefusal(ownerCtx)).toBeNull();
  });
  test("другая роль, группа, делегирование, не владелец — нет", () => {
    expect(followupRefusal({ ...ownerCtx, agentKey: "backend" })).toContain("forbidden");
    expect(followupRefusal({ ...ownerCtx, chatId: OTHER_CHAT })).toContain("forbidden");
    expect(followupRefusal({ ...ownerCtx, delegationChain: ["pm", "orchestrator"] })).toContain("forbidden");
    expect(followupRefusal({ ...ownerCtx, triggerUserId: "123", chatId: 123 })).toContain("forbidden");
    expect(followupRefusal({ ...ownerCtx, triggerUserId: undefined })).toContain("forbidden");
  });
  test("выключатель FOLLOWUPS_ENABLED=false", () => {
    process.env.FOLLOWUPS_ENABLED = "false";
    try {
      expect(followupRefusal(ownerCtx)).toContain("выключены");
    } finally {
      delete process.env.FOLLOWUPS_ENABLED;
    }
  });
});

describe("создание и отмена", () => {
  test("проверка входа", () => {
    const base = { chatId: OWNER_CHAT, userId: OWNER, agentKey: "orchestrator" };
    expect(createFollowup({ ...base, task: " ", inMin: 5 }).ok).toBe(false);
    expect(createFollowup({ ...base, task: "x".repeat(301), inMin: 5 }).ok).toBe(false);
    expect(createFollowup({ ...base, task: "x", inMin: 0 }).ok).toBe(false);
    expect(createFollowup({ ...base, task: "x", inMin: 1441 }).ok).toBe(false);
    expect(createFollowup({ ...base, task: "x", inMin: 2.5 }).ok).toBe(false);
    const ok = createFollowup({ ...base, task: "x", inMin: 10, now: 1_000_000 });
    expect(ok.ok && ok.followup.due_at).toBe(1_000_000 + 10 * MIN);
  });

  test("потолок активных на чат", () => {
    for (let i = 0; i < MAX_ACTIVE_FOLLOWUPS; i++) make();
    const r = createFollowup({ chatId: OWNER_CHAT, userId: OWNER, agentKey: "orchestrator", task: "ещё", inMin: 5 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("CANCEL_FOLLOWUP");
  });

  test("суточный потолок считает и завершённые", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_FOLLOWUPS_PER_DAY; i++) {
      const f = make(5, now);
      db.prepare(`UPDATE followups SET status = 'done' WHERE id = ?`).run(f.id);
    }
    const r = createFollowup({ chatId: OWNER_CHAT, userId: OWNER, agentKey: "orchestrator", task: "ещё", inMin: 5, now });
    expect(r.ok).toBe(false);
  });

  test("отмена только в своём чате и только ожидающей", () => {
    const f = make();
    expect(cancelFollowup(f.id, OTHER_CHAT).ok).toBe(false);
    expect(cancelFollowup(f.id, OWNER_CHAT).ok).toBe(true);
    expect(getFollowup(f.id)!.status).toBe("cancelled");
    expect(cancelFollowup(f.id, OWNER_CHAT).ok).toBe(false);
  });
});

describe("инструменты", () => {
  test("SCHEDULE_FOLLOWUP и CANCEL_FOLLOWUP у оркестратора в личке владельца", async () => {
    const out = JSON.parse(await executeTool("SCHEDULE_FOLLOWUP", { task: "проверить статус заказа", in_min: 10 }, ownerCtx));
    expect(out.ok).toBe(true);
    expect(out.followup.status).toBe("scheduled");
    expect(out.active).toHaveLength(1);
    const cancelled = JSON.parse(await executeTool("CANCEL_FOLLOWUP", { id: out.followup.id }, ownerCtx));
    expect(cancelled.ok).toBe(true);
    expect(cancelled.active).toHaveLength(0);
  });

  test("другой роли инструмент не выдан", async () => {
    const out = JSON.parse(
      await executeTool("SCHEDULE_FOLLOWUP", { task: "x", in_min: 5 }, { ...ownerCtx, agentKey: "backend", delegationChain: ["backend"] }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("forbidden");
  });

  test("из группы — отказ, строки нет", async () => {
    const out = JSON.parse(await executeTool("SCHEDULE_FOLLOWUP", { task: "x", in_min: 5 }, { ...ownerCtx, chatId: OTHER_CHAT }));
    expect(out.ok).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE chat_id = ?`).get(OTHER_CHAT)).toEqual({ n: 0 });
  });
});

describe("запуск в срок", () => {
  test("пришёл срок: вступление, ход ответом на него, done", async () => {
    const now = Date.now();
    const due = make(1, now - 2 * MIN);
    const later = make(30, now);
    const { runner, calls } = fakeRunner();
    const stats = await runDueFollowups({ runner, now: () => now });
    expect(stats.ran).toBe(1);
    expect(calls.notify).toEqual(["Проверяю, как обещал: повторить SHOP_QUOTE молока"]);
    expect(calls.run).toHaveLength(1);
    expect(calls.run[0]!.noticeId).toBe(777);
    expect(calls.run[0]!.text).toContain("не новое сообщение владельца");
    expect(calls.run[0]!.text).toContain("повторить SHOP_QUOTE молока");
    expect(getFollowup(due.id)!.status).toBe("done");
    expect(getFollowup(later.id)!.status).toBe("scheduled");
    // Второй проход ничего не повторяет.
    expect((await runDueFollowups({ runner, now: () => now })).ran).toBe(0);
    expect(calls.run).toHaveLength(1);
  });

  test("вступление не ушло — повтор, после MAX_ATTEMPTS failed, хода не было", async () => {
    const now = Date.now();
    const f = make(1, now - 2 * MIN);
    const { runner, calls } = fakeRunner({ notifyFails: true });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runDueFollowups({ runner, now: () => now });
    const row = getFollowup(f.id)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(calls.run).toHaveLength(0);
  });

  test("упавший ход не повторяется", async () => {
    const now = Date.now();
    const f = make(1, now - 2 * MIN);
    const { runner, calls } = fakeRunner({ runFails: true });
    const stats = await runDueFollowups({ runner, now: () => now });
    expect(stats.failed).toBe(1);
    expect(getFollowup(f.id)!.status).toBe("failed");
    await runDueFollowups({ runner, now: () => now });
    expect(calls.run).toHaveLength(1);
  });

  test("застрявший после рестарта running — failed, не перезапуск", async () => {
    const now = Date.now();
    const f = make(1, now - 60 * MIN);
    db.prepare(`UPDATE followups SET status = 'running', claimed_at = ? WHERE id = ?`).run(now - RUNNING_STALE_MS - 1, f.id);
    const { runner, calls } = fakeRunner();
    const stats = await runDueFollowups({ runner, now: () => now });
    expect(stats.stale).toBe(1);
    expect(getFollowup(f.id)!.status).toBe("failed");
    expect(calls.run).toHaveLength(0);
  });

  test("раннера нет — строки ждут", async () => {
    const now = Date.now();
    const f = make(1, now - 2 * MIN);
    await runDueFollowups({ runner: null, now: () => now });
    expect(getFollowup(f.id)!.status).toBe("scheduled");
  });

  test("опоздание называется в тексте хода", () => {
    const now = Date.now();
    const text = renderFollowupTurn({ task: "t", created_at: now - 40 * MIN, due_at: now - 10 * MIN }, now);
    expect(text).toContain("с опозданием");
    expect(renderFollowupTurn({ task: "t", created_at: now - 5 * MIN, due_at: now }, now)).not.toContain("опозданием");
  });
});

test('exhausted shop dependency stops rephrased continuations and preserves failed task', async () => {
 const {blockFollowupDependency}=await import('../lib/followup-execution');
 const now=Date.now()+1000000;
 const made=createFollowup({chatId:OWNER_CHAT,userId:OWNER,agentKey:'orchestrator',task:'dependency regression',inMin:1,now});
 expect(made.ok).toBe(true);if(!made.ok)return;
 const stats=await runDueFollowups({now:()=>now+MIN,runner:{notify:async()=>1,run:async(row)=>{
  const early=createFollowup({chatId:row.chat_id,userId:row.user_id,agentKey:"orchestrator",task:"early continuation",inMin:5,now});
  expect(early.ok).toBe(true);
  blockFollowupDependency(row.chat_id,row.user_id,'shop_browser');
  expect(createFollowup({chatId:row.chat_id,userId:row.user_id,agentKey:'orchestrator',task:'different wording',inMin:5,now}).ok).toBe(false);
 }}});
 expect(stats.failed).toBeGreaterThan(0);
 expect(db.prepare("SELECT status FROM followups WHERE task = ? AND chat_id = ? ORDER BY created_at DESC LIMIT 1").get("early continuation",OWNER_CHAT)).toMatchObject({status:"cancelled"});
 expect(getFollowup(made.followup.id)?.status).toBe('failed');
 expect(getFollowup(made.followup.id)?.task).toBe('dependency regression');
 expect(getFollowup(made.followup.id)?.error).toContain('dependency_blocked');
 // A new owner turn has no inherited failure context.
 expect(createFollowup({chatId:OWNER_CHAT,userId:OWNER,agentKey:'orchestrator',task:'owner resumes',inMin:5,now}).ok).toBe(true);
});
