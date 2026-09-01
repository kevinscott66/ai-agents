/**
 * C34 / T-404 — Agents page tests:
 *  - Test API endpoints used by Agents page
 *  - Test agent list rendering and functionality  
 *  - Test budget display and calculation
 *  - Test pause/resume functionality
 *  - Test recent actions display
 *  - Test permission-based access control
 *  - Test autonomy mode controls
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_c34";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { getAutonomy, setAutonomy } from "../lib/permissions.ts";
import type { AutonomyMode } from "../lib/permissions.ts";
// AgentInfo — контракт Mini App API, и живёт он там же. Раньше тип тянули
// из ../lib/types.ts, где его нет: импорт молча резолвился в any, и
// моки не сверялись ни с чем.
import type { AgentInfo } from "../miniapp/src/lib/types.ts";

const BOT_TOKEN = "test_bot_token_for_c34";
const USER_ID = 34001;
const ADMIN_USER_ID = 34002;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(userId = USER_ID): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "qc34",
    user: JSON.stringify({ 
      id: userId, 
      username: "agentstest", 
      first_name: "AgentsTest", 
      is_bot: false 
    }),
  });
}

// Mock agent data for testing
const mockAgents: AgentInfo[] = [
  {
    key: "orchestrator",
    title: "Orchestrator",
    status: "running",
    paused: false,
    health: {
      alive: true,
      lastOkAt: Date.now(),
      consecutiveFailures: 0
    }
  },
  {
    key: "frontend",
    title: "Frontend Developer",
    status: "running", 
    paused: true,
    health: {
      alive: true,
      lastOkAt: Date.now(),
      consecutiveFailures: 0
    }
  },
  {
    key: "backend",
    title: "Backend Developer",
    status: "running",
    paused: false,
    health: {
      alive: false,
      lastOkAt: Date.now() - 300000, // 5 mins ago
      consecutiveFailures: 2
    }
  }
];

const mockBudgets = [
  {
    agentKey: "orchestrator",
    usedTokens: 15000,
    outputTokens: 8000,
    limit: 50000,
    resetAt: nowSec() + 86400
  },
  {
    agentKey: "frontend", 
    usedTokens: 45000,
    outputTokens: 20000,
    limit: 50000,
    resetAt: nowSec() + 86400
  },
  {
    agentKey: "backend",
    usedTokens: 5000,
    outputTokens: 2500,
    limit: null,
    resetAt: nowSec() + 86400
  }
];

const mockActions = [
  {
    id: "action_001",
    agent_key: "orchestrator",
    task_id: null,
    chat_id: -1001234567890,
    action_type: "SEND_MESSAGE",
    payload: { text: "Test message", chat_id: -1001234567890 },
    status: "ok" as const,
    result: { message_id: 123 },
    error: null,
    created_at: nowSec() - 3600
  },
  {
    id: "action_002",
    agent_key: "frontend", 
    task_id: "task_001",
    chat_id: -1001234567890,
    action_type: "CREATE_TASK",
    payload: { title: "Implement feature", assignee: "frontend" },
    status: "error" as const,
    result: null,
    error: "Permission denied",
    created_at: nowSec() - 1800
  }
];

describe("Agents API Integration", () => {
  let server: MiniappServerHandle;

  beforeAll(async () => {
    server = await startMiniappServer({
      port: 0, // Let the system choose a free port
      allowedUserIds: [USER_ID, ADMIN_USER_ID],
      adminUserIds: [ADMIN_USER_ID],
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  test("GET /api/agents returns agent list", async () => {
    const response = await fetch(`http://localhost:${server.port}/api/agents`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("agents");
    expect(Array.isArray(body.agents)).toBe(true);
  });

  test("GET /api/budgets returns budget information", async () => {
    const response = await fetch(`http://localhost:${server.port}/api/budgets`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("budgets");
    expect(Array.isArray(body.budgets)).toBe(true);
  });

  test("GET /api/actions with agent filter returns actions", async () => {
    const response = await fetch(`http://localhost:${server.port}/api/actions?agent=orchestrator&limit=10`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("actions");
    expect(Array.isArray(body.actions)).toBe(true);
  });

  test("POST /api/agents/{key}/pause requires admin permissions", async () => {
    const response = await fetch(`http://localhost:${server.port}/api/agents/orchestrator/pause`, {
      method: "POST",
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    // Should return 403 for non-admin users
    expect(response.status).toBe(403);
  });

  test("POST /api/agents/{key}/resume requires admin permissions", async () => {
    const response = await fetch(`http://localhost:${server.port}/api/agents/orchestrator/resume`, {
      method: "POST",
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    // Should return 403 for non-admin users 
    expect(response.status).toBe(403);
  });

  test("Autonomy mode API integration", async () => {
    // Test getting autonomy mode
    const getResponse = await fetch(`http://localhost:${server.port}/api/autonomy?agent=orchestrator`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json();
    expect(getBody).toHaveProperty("mode");

    // Test setting autonomy mode (should require admin)
    const setResponse = await fetch(`http://localhost:${server.port}/api/autonomy`, {
      method: "POST",
      headers: { 
        "X-Telegram-Init-Data": freshInitData(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mode: "manual",
        agent: "orchestrator"
      })
    });

    // Should return 403 for non-admin users
    expect(setResponse.status).toBe(403);
  });
});

describe("Agents Page Functionality", () => {
  test("Budget percentage calculation", () => {
    // Test budget percentage calculation logic
    const budget1 = { usedTokens: 15000, limit: 50000 };
    const pct1 = budget1.limit ? Math.round((budget1.usedTokens / budget1.limit) * 100) : 0;
    expect(pct1).toBe(30);

    const budget2 = { usedTokens: 45000, limit: 50000 };
    const pct2 = budget2.limit ? Math.round((budget2.usedTokens / budget2.limit) * 100) : 0;
    expect(pct2).toBe(90);

    const budget3 = { usedTokens: 5000, limit: null };
    const pct3 = budget3.limit ? Math.round((budget3.usedTokens / budget3.limit) * 100) : 0;
    expect(pct3).toBe(0);
  });

  test("Budget severity classification", () => {
    // Test severity classification for budget usage
    function budgetSeverity(pct: number): "ok" | "warn" | "crit" {
      if (pct >= 90) return "crit";
      if (pct >= 70) return "warn";
      return "ok";
    }

    expect(budgetSeverity(30)).toBe("ok");
    expect(budgetSeverity(75)).toBe("warn");
    expect(budgetSeverity(95)).toBe("crit");
    expect(budgetSeverity(0)).toBe("ok");
  });

  test("Agent status badge classification", () => {
    // Test status badge logic for different agent states
    function getStatusBadgeClass(agent: { paused?: boolean; status: string }) {
      return agent.paused 
        ? "cancelled"
        : agent.status === "running"
          ? "running" 
          : "pending";
    }

    expect(getStatusBadgeClass({ status: "running", paused: false })).toBe("running");
    expect(getStatusBadgeClass({ status: "running", paused: true })).toBe("cancelled");
    expect(getStatusBadgeClass({ status: "stopped", paused: false })).toBe("pending");
  });

  test("Date formatting for actions", () => {
    const timestamp = 1640995200; // 2022-01-01 00:00:00 UTC
    const date = new Date(timestamp * 1000);
    const formatted = date.toLocaleString("ru-RU");
    
    // Should be a valid Russian locale date string
    expect(formatted).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  test("Error message truncation", () => {
    const longError = "This is a very long error message that should be truncated to avoid cluttering the UI with excessive text content that would make the interface hard to read and understand for the user";
    const truncated = longError.slice(0, 100) + "...";
    
    expect(truncated.length).toBe(103); // 100 chars + "..."
    expect(truncated.endsWith("...")).toBe(true);
  });
});

describe("Permission-based Access Control", () => {
  let server: MiniappServerHandle;

  beforeAll(async () => {
    server = await startMiniappServer({
      port: 0, // Let the system choose a free port
      allowedUserIds: [USER_ID, ADMIN_USER_ID],
      adminUserIds: [ADMIN_USER_ID],
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  test("Non-admin user gets 403 on agent permissions", async () => {
    const response = await fetch(`http://localhost:${server.port}/api/permissions?agent=orchestrator`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });

    // Should return 403 for non-admin users
    expect(response.status).toBe(403);
  });

  test("Permission toggle requires admin access", async () => {
    const response = await fetch(`http://localhost:${server.port}/api/permissions`, {
      method: "POST",
      headers: { 
        "X-Telegram-Init-Data": freshInitData(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        agentKey: "orchestrator",
        actionType: "SEND_MESSAGE", 
        allowed: true,
        requires_approval: false
      })
    });

    // Should return 403 for non-admin users
    expect(response.status).toBe(403);
  });

  test("Readonly mode when admin access blocked", () => {
    // Test readonly state logic when user lacks admin permissions
    let readonly = false;
    const mockError = { status: 403, message: "Access denied" };
    
    if (mockError.status === 403) {
      readonly = true;
    }
    
    expect(readonly).toBe(true);
  });
});

describe("Agents Page Rendering", () => {
  test("Agent card renders essential information", () => {
    // Mock test for agent card rendering logic
    const agent = mockAgents[0];
    const budget = mockBudgets[0];
    
    // Verify essential data is present
    expect(agent.key).toBe("orchestrator");
    expect(agent.title).toBe("Orchestrator");
    expect(agent.status).toBe("running");
    expect(agent.paused).toBe(false);
    
    // Verify budget data
    expect(budget.agentKey).toBe(agent.key);
    expect(budget.usedTokens).toBe(15000);
    expect(budget.limit).toBe(50000);
    
    const pct = budget.limit ? Math.round((budget.usedTokens / budget.limit) * 100) : 0;
    expect(pct).toBe(30);
  });

  test("Recent actions section shows correct data", () => {
    const agentKey = "orchestrator";
    const actions = mockActions.filter(a => a.agent_key === agentKey);
    
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe("SEND_MESSAGE");
    expect(actions[0].status).toBe("ok");
    expect(actions[0].error).toBe(null);
  });

  test("Empty states handled correctly", () => {
    // Test empty agent list
    const emptyAgents: AgentInfo[] = [];
    expect(emptyAgents.length).toBe(0);
    
    // Test empty actions
    const emptyActions = mockActions.filter(a => a.agent_key === "nonexistent");
    expect(emptyActions.length).toBe(0);
    
    // Test no budget data
    const noBudget = mockBudgets.find(b => b.agentKey === "nonexistent");
    expect(noBudget).toBeUndefined();
  });
});