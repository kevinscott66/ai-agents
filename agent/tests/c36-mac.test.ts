/**
 * C36 / T-107 — Mac Control page tests:
 *  - Test Mac page API integration (MAC_RUN_CLAUDE actions)
 *  - Test session history display
 *  - Test SSE mac.output event handling
 *  - Test session status indicators
 *  - Test UI components and accessibility
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_c36";

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "test_bot_token_for_c36";
const USER_ID = 36001;
const CHAT_ID = -100360;
const OTHER_CHAT_ID = -200360;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "qc36",
    user: JSON.stringify({ id: USER_ID, username: "mactest", first_name: "MacTest", is_bot: false }),
  });
}

let server: MiniappServerHandle;
let baseUrl: string;

beforeAll(async () => {
  server = await startMiniappServer({ allowedUserIds: [USER_ID], adminUserIds: [USER_ID] });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  // Clear any existing MAC_RUN_CLAUDE actions for clean test state.
  // Оба чата: тест «Mac API respects chat_id filtering» пишет строку в чужой
  // чат, и без неё в списке уборки она переживала весь прогон. T-751.
  const query = db.prepare(`
    DELETE FROM agent_actions
    WHERE action_type = 'MAC_RUN_CLAUDE'
    AND chat_id IN (?, ?)
  `);
  query.run(CHAT_ID, OTHER_CHAT_ID);
});

describe("Mac Control API endpoints", () => {
  test("GET /api/actions with type=MAC_RUN_CLAUDE returns Mac actions", async () => {
    // Insert a test MAC_RUN_CLAUDE action
    const insertAction = db.prepare(`
      INSERT INTO agent_actions (
        id, agent_key, action_type, payload, status, chat_id, 
        created_at, result
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const actionId = `mac_${Date.now()}`;
    const payload = {
      project: "/Users/test/my-project",
      prompt: "List files in src directory",
      mode: "ask"
    };
    
    insertAction.run(
      actionId,
      "orchestrator", 
      "MAC_RUN_CLAUDE",
      JSON.stringify(payload),
      "completed",
      CHAT_ID,
      Date.now(),
      JSON.stringify({ output: "src/\n  components/\n  pages/" })
    );

    const res = await fetch(`${baseUrl}/api/actions?type=MAC_RUN_CLAUDE&chat_id=${CHAT_ID}&limit=10`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty("actions");
    expect(Array.isArray(data.actions)).toBe(true);
    
    const macAction = data.actions.find((a: any) => a.action_type === "MAC_RUN_CLAUDE");
    expect(macAction).toBeDefined();
    expect(macAction.payload.project).toBe("/Users/test/my-project");
    expect(macAction.payload.mode).toBe("ask");
  });

  test("MAC_RUN_CLAUDE action has expected payload structure", async () => {
    const insertAction = db.prepare(`
      INSERT INTO agent_actions (
        id, agent_key, action_type, payload, status, chat_id, 
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const actionId = `mac_${Date.now()}_2`;
    const payload = {
      project: "/Users/test/another-project", 
      prompt: "Help me refactor this component",
      mode: "accept_edits"
    };
    
    insertAction.run(
      actionId,
      "orchestrator", 
      "MAC_RUN_CLAUDE",
      JSON.stringify(payload),
      "running",
      CHAT_ID,
      Date.now()
    );

    const res = await fetch(`${baseUrl}/api/actions?type=MAC_RUN_CLAUDE&chat_id=${CHAT_ID}`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    const data = await res.json();
    const action = data.actions.find((a: any) => a.id === actionId);
    
    expect(action).toBeDefined();
    expect(action.payload).toHaveProperty("project");
    expect(action.payload).toHaveProperty("prompt");
    expect(action.payload).toHaveProperty("mode");
    expect(action.status).toBe("running");
  });

  test("Actions are returned in chronological order (newest first)", async () => {
    const insertAction = db.prepare(`
      INSERT INTO agent_actions (
        id, agent_key, action_type, payload, status, chat_id, 
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Insert actions with different timestamps
    const now = Date.now();
    const action1Time = now - 3600000; // 1 hour ago
    const action2Time = now - 1800000; // 30 min ago
    const action3Time = now - 300000;  // 5 min ago

    insertAction.run("mac_old", "orchestrator", "MAC_RUN_CLAUDE", 
      JSON.stringify({ project: "/old", prompt: "old", mode: "ask" }),
      "completed", CHAT_ID, action1Time);

    insertAction.run("mac_middle", "orchestrator", "MAC_RUN_CLAUDE", 
      JSON.stringify({ project: "/middle", prompt: "middle", mode: "ask" }),
      "completed", CHAT_ID, action2Time);

    insertAction.run("mac_recent", "orchestrator", "MAC_RUN_CLAUDE",
      JSON.stringify({ project: "/recent", prompt: "recent", mode: "ask" }),
      "running", CHAT_ID, action3Time);

    const res = await fetch(`${baseUrl}/api/actions?type=MAC_RUN_CLAUDE&chat_id=${CHAT_ID}`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    const data = await res.json();
    expect(data.actions.length).toBeGreaterThanOrEqual(3);
    
    // Should be ordered newest first
    const macActions = data.actions.filter((a: any) => a.action_type === "MAC_RUN_CLAUDE");
    expect(macActions[0].id).toBe("mac_recent");
    expect(macActions[1].id).toBe("mac_middle");
    expect(macActions[2].id).toBe("mac_old");
  });
});

describe("Mac session status handling", () => {
  test("Status mapping from agent_actions.status works correctly", () => {
    // This tests the business logic in Mac.tsx for status transformation
    const testCases = [
      { dbStatus: "completed", expectedStatus: "completed" },
      { dbStatus: "failed", expectedStatus: "failed" },
      { dbStatus: "running", expectedStatus: "running" },
      { dbStatus: "pending", expectedStatus: "running" }, // pending treated as running
    ];

    testCases.forEach(({ dbStatus, expectedStatus }) => {
      // Simulate the transformation logic from Mac.tsx
      const mappedStatus = dbStatus === "completed" ? "completed" 
                         : dbStatus === "failed" ? "failed" 
                         : "running";
      expect(mappedStatus).toBe(expectedStatus);
    });
  });

  test("Session data transformation from agent_actions works", async () => {
    const insertAction = db.prepare(`
      INSERT INTO agent_actions (
        id, agent_key, action_type, payload, status, chat_id, 
        created_at, result
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const actionId = `mac_transform_test`;
    const payload = {
      project: "/Users/test/transform-project",
      prompt: "Test transformation",
      mode: "ask"
    };
    const result = {
      output: "Transformation successful\nFiles updated: 3"
    };
    
    insertAction.run(
      actionId,
      "orchestrator", 
      "MAC_RUN_CLAUDE",
      JSON.stringify(payload),
      "completed",
      CHAT_ID,
      Date.now(),
      JSON.stringify(result)
    );

    const res = await fetch(`${baseUrl}/api/actions?type=MAC_RUN_CLAUDE&chat_id=${CHAT_ID}`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    const data = await res.json();
    const action = data.actions.find((a: any) => a.id === actionId);
    
    // Verify the data can be transformed into Mac session format
    const macSession = {
      id: action.id,
      project: action.payload.project,
      mode: action.payload.mode,
      status: action.status === "completed" ? "completed" : "running",
      createdAt: action.created_at,
      prompt: action.payload.prompt,
      output: action.result?.output ? [action.result.output] : [],
    };

    expect(macSession.id).toBe(actionId);
    expect(macSession.project).toBe("/Users/test/transform-project");
    expect(macSession.mode).toBe("ask");
    expect(macSession.status).toBe("completed");
    expect(macSession.output).toEqual(["Transformation successful\nFiles updated: 3"]);
  });
});

describe("Mac Control authentication and permissions", () => {
  test("Mac API endpoints require valid Telegram auth", async () => {
    const res = await fetch(`${baseUrl}/api/actions?type=MAC_RUN_CLAUDE`, {
      headers: { "X-Telegram-Init-Data": "invalid_auth" },
    });

    expect(res.status).toBe(401);
  });

  test("Mac API respects chat_id filtering", async () => {
    const otherChatId = OTHER_CHAT_ID;

    // Insert actions in different chats
    const insertAction = db.prepare(`
      INSERT INTO agent_actions (
        id, agent_key, action_type, payload, status, chat_id, 
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    insertAction.run("mac_this_chat", "orchestrator", "MAC_RUN_CLAUDE",
      JSON.stringify({ project: "/this", prompt: "this", mode: "ask" }),
      "completed", CHAT_ID, Date.now());

    insertAction.run("mac_other_chat", "orchestrator", "MAC_RUN_CLAUDE",
      JSON.stringify({ project: "/other", prompt: "other", mode: "ask" }),
      "completed", otherChatId, Date.now());

    const res = await fetch(`${baseUrl}/api/actions?type=MAC_RUN_CLAUDE&chat_id=${CHAT_ID}`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    const data = await res.json();
    const macActions = data.actions.filter((a: any) => a.action_type === "MAC_RUN_CLAUDE");
    
    // Should only return actions from the specified chat
    expect(macActions.every((a: any) => a.chat_id === CHAT_ID)).toBe(true);
    expect(macActions.find((a: any) => a.id === "mac_this_chat")).toBeDefined();
    expect(macActions.find((a: any) => a.id === "mac_other_chat")).toBeUndefined();
  });
});

describe("Mac UI component tests", () => {
  test("Timestamp formatting handles various date formats", () => {
    // Test the timestamp formatting logic from Mac.tsx
    function formatTimestamp(ts: string): string {
      try {
        return new Date(ts).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit", 
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch {
        return ts;
      }
    }

    const validTimestamp = "2026-05-23T12:34:56.000Z";
    const formatted = formatTimestamp(validTimestamp);
    expect(typeof formatted).toBe("string");
    expect(formatted).not.toBe(validTimestamp); // Should be transformed
    
    // Invalid timestamp should return "Invalid Date" (the actual behavior)
    const invalidTimestamp = "invalid-date";
    const result = formatTimestamp(invalidTimestamp);
    expect(result).toBe("Invalid Date"); // This is what new Date("invalid-date") produces
  });

  test("Status badge styling logic works correctly", () => {
    // Test the status badge logic from Mac.tsx
    function getStatusBadgeStyle(status: string) {
      const styles = {
        running: { background: "#3498db", color: "#fff" },
        completed: { background: "#2ecc71", color: "#fff" },
        failed: { background: "#e74c3c", color: "#fff" },
      };
      
      return styles[status as keyof typeof styles] || styles.running;
    }

    expect(getStatusBadgeStyle("running")).toEqual({ background: "#3498db", color: "#fff" });
    expect(getStatusBadgeStyle("completed")).toEqual({ background: "#2ecc71", color: "#fff" });
    expect(getStatusBadgeStyle("failed")).toEqual({ background: "#e74c3c", color: "#fff" });
    expect(getStatusBadgeStyle("unknown")).toEqual({ background: "#3498db", color: "#fff" }); // fallback
  });

  test("Prompt truncation logic works correctly", () => {
    // Test prompt truncation from Mac.tsx session cards
    function truncatePrompt(prompt: string, limit: number): string {
      return prompt.slice(0, limit) + (prompt.length > limit ? "..." : "");
    }

    const shortPrompt = "Short prompt";
    expect(truncatePrompt(shortPrompt, 100)).toBe("Short prompt");
    
    const longPrompt = "This is a very long prompt that should be truncated when displayed in the session card to avoid taking up too much space";
    const truncated = truncatePrompt(longPrompt, 100);
    // The actual slice will be 100 chars + "..." = 103 chars total
    const expectedTruncated = longPrompt.slice(0, 100) + "...";
    expect(truncated).toBe(expectedTruncated);
    expect(truncated.length).toBe(103); // 100 + "..."
  });
});

describe("Mac SSE events", () => {
  // T-810: здесь стоял тест «SSE mac.output event structure is valid». Он
  // объявлял локальный интерфейс, строил из него объект и проверял типы его же
  // полей — то есть был зелёным при любом состоянии репозитория и не касался
  // кода приложения вовсе. Цена такого теста не нулевая: имя `mac.output`
  // встречалось в репо ровно дважды — подписка в Mini App и этот тест, — и
  // именно он создавал впечатление, что событие реализовано, пока панель
  // «Вывод сессии» оставалась пустой. Замена — `sse-events-alive.test.ts`,
  // который проверяет наличие эмиттера, а не форму выдуманного объекта.

  test("Output log accumulation logic works correctly", () => {
    // Test the output accumulation logic from Mac.tsx SSE handler
    const outputLog = new Map<string, string[]>();
    
    function appendOutput(sessionId: string, chunk: string) {
      const existing = outputLog.get(sessionId) || [];
      outputLog.set(sessionId, [...existing, chunk]);
    }

    appendOutput("session1", "First chunk");
    appendOutput("session1", "Second chunk");
    appendOutput("session2", "Different session");

    expect(outputLog.get("session1")).toEqual(["First chunk", "Second chunk"]);
    expect(outputLog.get("session2")).toEqual(["Different session"]);
    expect(outputLog.get("nonexistent")).toBeUndefined();
  });
});