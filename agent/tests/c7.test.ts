/**
 * C7: anti-duplication, watchdog, self-diagnosis lite.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import type { ChatRow } from "../lib/db.ts";
import type { RunningBot } from "../lib/types.ts";
import { shouldAllowTools } from "../lib/anti-dup.ts";
import {
  startWatchdog,
  markSeen,
  _resetWatchdogState,
} from "../lib/watchdog.ts";
import { dispatchAndAudit } from "../lib/action-dispatch.ts";
import {
  cleanupChat,
  saveAutonomy,
  restoreAutonomy,
} from "./_helpers.ts";

const TEST_CHAT = -1_000_707;

let savedGlobal = saveAutonomy();
afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT, "orchestrator");
  cleanupChat(TEST_CHAT, "aieng");
  _resetWatchdogState();
});

function row(p: Partial<ChatRow>): ChatRow {
  return {
    id: 0,
    chat_id: String(TEST_CHAT),
    agent_key: null,
    is_bot: 0,
    from_user_id: "0",
    from_name: null,
    text: "",
    ts: Date.now(),
    ...p,
  };
}

function fakeBot(key: string, username: string, id = 1000): RunningBot {
  return {
    def: { key } as any,
    bot: {} as any,
    username,
    id,
  };
}

describe("anti-dup: shouldAllowTools", () => {
  const bots: RunningBot[] = [
    fakeBot("orchestrator", "dlb_lead_bot", 1),
    fakeBot("design", "dlb_design_bot", 2),
    fakeBot("qa", "dlb_qa_bot", 3),
  ];

  // Автономность-фикс 2026-06-10: история БОЛЬШЕ не отключает инструменты —
  // иначе оркестратор после ответа коллеги не мог делегировать дальше.
  test("Lead + recent с сообщением другого бота + обычный текст → true (был false)", () => {
    const recent: ChatRow[] = [
      row({ is_bot: 1, agent_key: "design", text: "вот опрос" }),
    ];
    expect(
      shouldAllowTools({ key: "orchestrator" }, recent, "ок, продолжай цепочку", bots),
    ).toBe(true);
  });

  test("Lead + @design в ИСТОРИИ, но обычный текущий текст → true (был false)", () => {
    const recent: ChatRow[] = [
      row({ text: "@dlb_design_bot создай опрос" }),
    ];
    expect(
      shouldAllowTools(
        { key: "orchestrator" },
        recent,
        "подтверждаю",
        bots,
      ),
    ).toBe(true);
  });

  test("Lead + чистый recent + обычный вопрос → true", () => {
    const recent: ChatRow[] = [row({ text: "привет команда" })];
    expect(
      shouldAllowTools({ key: "orchestrator" }, recent, "как дела?", bots),
    ).toBe(true);
  });

  test("Не-Lead → всегда true", () => {
    const recent: ChatRow[] = [
      row({ is_bot: 1, agent_key: "design", text: "вот опрос" }),
    ];
    expect(
      shouldAllowTools({ key: "design" }, recent, "ок", bots),
    ).toBe(true);
  });

  test("Lead + @-mention в текущем сообщении → false", () => {
    const recent: ChatRow[] = [row({ text: "привет" })];
    expect(
      shouldAllowTools(
        { key: "orchestrator" },
        recent,
        "@dlb_design_bot сделай опрос",
        bots,
      ),
    ).toBe(false);
  });
});

describe("watchdog", () => {
  test("chat-alert ТОЛЬКО для chatAlertKeys; роль-боты с privacy mode молчат без алёрта", async () => {
    const bots: RunningBot[] = [
      fakeBot("orchestrator", "MultiAgentPanelbot", 1),
      fakeBot("design", "dlb_design_bot", 2),
      fakeBot("qa", "dlb_qa_bot", 3),
    ];
    // Все трое «молчат давно».
    const past = Date.now() - 10_000;
    markSeen("orchestrator", past);
    markSeen("design", past);
    markSeen("qa", past);

    const calls: string[] = [];
    const wd = startWatchdog({
      bots,
      alert: async (msg) => {
        calls.push(msg);
      },
      intervalMs: 30,
      silenceMs: 100,
      // default chatAlertKeys = {orchestrator}
    });
    await new Promise((r) => setTimeout(r, 200));
    wd.stop();

    const keys = calls.map((c) => c.match(/бот (\w+)/)?.[1]).filter(Boolean);
    // orchestrator (privacy-off) → chat-alert; design/qa (privacy-on) → НЕТ.
    expect(keys).toContain("orchestrator");
    expect(keys).not.toContain("design");
    expect(keys).not.toContain("qa");
  });

  test("кастомный chatAlertKeys включает роль-бота в алёрт", async () => {
    const bots: RunningBot[] = [fakeBot("qa", "dlb_qa_bot", 3)];
    markSeen("qa", Date.now() - 10_000);
    const calls: string[] = [];
    const wd = startWatchdog({
      bots,
      alert: async (msg) => {
        calls.push(msg);
      },
      intervalMs: 30,
      silenceMs: 100,
      chatAlertKeys: new Set(["qa"]),
    });
    await new Promise((r) => setTimeout(r, 150));
    wd.stop();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test("markSeen прерывает тишину — alert не дёргается повторно", async () => {
    const bots: RunningBot[] = [fakeBot("design", "dlb_design_bot", 2)];
    markSeen("design", Date.now()); // только что
    const calls: string[] = [];
    const wd = startWatchdog({
      bots,
      alert: async (msg) => {
        calls.push(msg);
      },
      intervalMs: 30,
      silenceMs: 10_000,
    });
    await new Promise((r) => setTimeout(r, 120));
    wd.stop();
    expect(calls.length).toBe(0);
  });
});

describe("self-diagnosis lite", () => {
  test("runtime-ошибка SEND_MESSAGE без telegram → создана diagnostic task для aieng", async () => {
    const before = db
      .prepare(
        `SELECT COUNT(*) as n FROM tasks WHERE chat_id = ? AND assigned_to = 'aieng'`,
      )
      .get(TEST_CHAT) as { n: number };

    const res = await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hi" } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);

    const rows = db
      .prepare(
        `SELECT id, title, assigned_to FROM tasks WHERE chat_id = ? AND assigned_to = 'aieng'`,
      )
      .all(TEST_CHAT) as { id: string; title: string; assigned_to: string }[];
    expect(rows.length).toBe(before.n + 1);
    const last = rows[rows.length - 1];
    expect(last.title).toContain("Tool error");
    expect(last.title).toContain("SEND_MESSAGE");
    expect(last.assigned_to).toBe("aieng");
  });

  test("CREATE_TASK с ошибкой НЕ создаёт diagnostic task (anti-recursion)", async () => {
    // parentId, которого нет → createTask бросит, dispatchAction вернёт ok:false.
    const before = db
      .prepare(`SELECT COUNT(*) as n FROM tasks WHERE chat_id = ?`)
      .get(TEST_CHAT) as { n: number };

    const res = await dispatchAndAudit(
      "CREATE_TASK",
      {
        title: "broken",
        parentId: "non-existent-parent-id-xyz",
      } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);

    const after = db
      .prepare(`SELECT COUNT(*) as n FROM tasks WHERE chat_id = ?`)
      .get(TEST_CHAT) as { n: number };
    expect(after.n).toBe(before.n);
  });

  test("payload._diag=true гасит self-diag", async () => {
    const before = db
      .prepare(
        `SELECT COUNT(*) as n FROM tasks WHERE chat_id = ? AND assigned_to = 'aieng'`,
      )
      .get(TEST_CHAT) as { n: number };

    const res = await dispatchAndAudit(
      "SEND_MESSAGE",
      { text: "hi", _diag: true } as any,
      { agentKey: "orchestrator", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);

    const after = db
      .prepare(
        `SELECT COUNT(*) as n FROM tasks WHERE chat_id = ? AND assigned_to = 'aieng'`,
      )
      .get(TEST_CHAT) as { n: number };
    expect(after.n).toBe(before.n);
  });
});
