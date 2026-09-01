/**
 * T-541: Userbot router tests
 * 
 * Tests the multi-session userbot router functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { 
  UserbotRouter, 
  setUserbotRouter, 
  getUserbotRouter,
  getUserbotHandle,
  type UserbotRouterOpts,
  type AgentSessionConfig 
} from "../lib/userbot-router.ts";
import type { UserbotHandle } from "../lib/userbot.ts";

// Test session directory
const TEST_SESSION_DIR = "/tmp/userbot-router-test";

// Mock userbot handle for testing
const createMockHandle = (isNoop: boolean = false): UserbotHandle => ({
  async setReaction(chatId, msgId, emoji) {
    if (isNoop) throw new Error("userbot not available");
  },
  async deleteMessage(chatId, msgId) {
    if (isNoop) throw new Error("userbot not available");
  },
  // Роутер в этих тестах гоняет только реакции и удаление. Остальные методы
  // UserbotHandle обязаны существовать по контракту — пусть падают явно.
  async sendMessage(): Promise<never> {
    throw new Error("sendMessage не ожидается в этом тесте");
  },
  async createTeamChannel(): Promise<never> {
    throw new Error("createTeamChannel не ожидается в этом тесте");
  },
  async publishPost(): Promise<never> {
    throw new Error("publishPost не ожидается в этом тесте");
  },
  async stop() {},
  isNoop,
});

// Test setup helpers
function createTestSessionFile(filename: string, content: string = "test-session-string"): string {
  const path = join(TEST_SESSION_DIR, filename);
  writeFileSync(path, content);
  return path;
}

function setupTestDir(): void {
  if (!existsSync(TEST_SESSION_DIR)) {
    import("node:fs").then(fs => fs.mkdirSync(TEST_SESSION_DIR, { recursive: true }));
  }
}

function cleanupTestDir(): void {
  if (existsSync(TEST_SESSION_DIR)) {
    rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
  }
}

describe("UserbotRouter", () => {
  let router: UserbotRouter;
  let mockMessages: any[] = [];

  const routerOpts: UserbotRouterOpts = {
    onMessage: (msg) => mockMessages.push(msg),
    defaultAllowedChatIds: [12345, 67890],
  };

  beforeEach(() => {
    setupTestDir();
    mockMessages = [];
    router = new UserbotRouter(routerOpts);
    setUserbotRouter(router);
  });

  afterEach(() => {
    setUserbotRouter(null);
    cleanupTestDir();
  });

  describe("Configuration Management", () => {
    it("should register agent configurations", () => {
      const sessionPath = createTestSessionFile("test-agent.session");
      const config: AgentSessionConfig = {
        sessionFile: sessionPath,
        allowedChatIds: [12345],
      };

      router.registerAgent("test-agent", config);

      const status = router.getAgentStatus("test-agent");
      expect(status.registered).toBe(true);
      expect(status.active).toBe(false);
      expect(status.sessionFile).toBe(sessionPath);
    });

    it("should track multiple agent configurations", () => {
      const session1 = createTestSessionFile("agent1.session");
      const session2 = createTestSessionFile("agent2.session");

      router.registerAgent("agent1", { sessionFile: session1, allowedChatIds: [111] });
      router.registerAgent("agent2", { sessionFile: session2, allowedChatIds: [222] });

      const configs = router.getAllConfigs();
      expect(configs.size).toBe(2);
      expect(configs.get("agent1")?.sessionFile).toBe(session1);
      expect(configs.get("agent2")?.sessionFile).toBe(session2);
    });
  });

  describe("Session Management", () => {
    it("should return null for unregistered agents", async () => {
      const handle = await router.getAgentHandle("non-existent");
      expect(handle).toBeNull();
    });

    it("should return null for agents with missing session files", async () => {
      router.registerAgent("missing-session", {
        sessionFile: "/non/existent/path.session",
        allowedChatIds: [12345],
      });

      const handle = await router.getAgentHandle("missing-session");
      expect(handle).toBeNull();
    });

    it("should handle session startup errors gracefully", async () => {
      const sessionPath = createTestSessionFile("bad-session.session", "invalid-session-data");
      router.registerAgent("bad-agent", {
        sessionFile: sessionPath,
        allowedChatIds: [12345],
      });

      // This should not throw but return null
      const handle = await router.getAgentHandle("bad-agent");
      expect(handle).toBeNull();
    });
  });

  describe("Action Delegation", () => {
    it("should delegate setReaction to specific agent when available", async () => {
      const mockHandle = createMockHandle(false);
      let reactionCalls = 0;
      mockHandle.setReaction = async () => { reactionCalls++; };

      // Mock the getAgentHandle to return our mock
      router.getAgentHandle = async (agentKey: string) => {
        return agentKey === "test-agent" ? mockHandle : null;
      };

      await router.setReaction("test-agent", 12345, 67890, "👍");
      expect(reactionCalls).toBe(1);
    });

    it("should delegate deleteMessage to specific agent when available", async () => {
      const mockHandle = createMockHandle(false);
      let deleteCalls = 0;
      mockHandle.deleteMessage = async () => { deleteCalls++; };

      router.getAgentHandle = async (agentKey: string) => {
        return agentKey === "test-agent" ? mockHandle : null;
      };

      await router.deleteMessage("test-agent", 12345, 67890);
      expect(deleteCalls).toBe(1);
    });

    it("should throw when no userbot sessions available", async () => {
      // No agent handle, no fallback
      router.getAgentHandle = async () => null;

      await expect(router.setReaction("missing-agent", 12345, 67890, "👍"))
        .rejects.toThrow("No userbot session available");

      await expect(router.deleteMessage("missing-agent", 12345, 67890))
        .rejects.toThrow("No userbot session available");
    });
  });

  describe("Lifecycle Management", () => {
    it("should stop all active sessions", async () => {
      const handle1 = createMockHandle(false);
      const handle2 = createMockHandle(false);
      let stop1Called = false;
      let stop2Called = false;

      handle1.stop = async () => { stop1Called = true; };
      handle2.stop = async () => { stop2Called = true; };

      // Manually add to sessions for testing
      (router as any).sessions.set("agent1", handle1);
      (router as any).sessions.set("agent2", handle2);

      await router.stopAll();

      expect(stop1Called).toBe(true);
      expect(stop2Called).toBe(true);
      expect(router.getActiveAgents()).toHaveLength(0);
    });

    it("should handle stop errors gracefully", async () => {
      const handle = createMockHandle(false);
      handle.stop = async () => { throw new Error("Stop failed"); };

      (router as any).sessions.set("error-agent", handle);

      // Should not throw
      await router.stopAll();
      expect(router.getActiveAgents()).toHaveLength(0);
    });
  });

  describe("Status Reporting", () => {
    it("should report correct agent status", () => {
      const sessionPath = createTestSessionFile("status-test.session");
      router.registerAgent("status-agent", {
        sessionFile: sessionPath,
        allowedChatIds: [12345],
      });

      const status = router.getAgentStatus("status-agent");
      expect(status.registered).toBe(true);
      expect(status.active).toBe(false);
      expect(status.sessionFile).toBe(sessionPath);

      // Test unregistered agent
      const unregistered = router.getAgentStatus("unknown");
      expect(unregistered.registered).toBe(false);
      expect(unregistered.active).toBe(false);
    });

    it("should track active agents", () => {
      expect(router.getActiveAgents()).toHaveLength(0);

      // Manually add active sessions for testing
      (router as any).sessions.set("agent1", createMockHandle(false));
      (router as any).sessions.set("agent2", createMockHandle(false));

      const active = router.getActiveAgents();
      expect(active).toHaveLength(2);
      expect(active).toContain("agent1");
      expect(active).toContain("agent2");
    });
  });
});

describe("Global Router Access", () => {
  beforeEach(() => {
    setUserbotRouter(null);
  });

  it("should manage global router instance", () => {
    expect(getUserbotRouter()).toBeNull();

    const router = new UserbotRouter({
      onMessage: () => {},
      defaultAllowedChatIds: [],
    });

    setUserbotRouter(router);
    expect(getUserbotRouter()).toBe(router);

    setUserbotRouter(null);
    expect(getUserbotRouter()).toBeNull();
  });

  it("getUserbotHandle should use router when available", async () => {
    const router = new UserbotRouter({
      onMessage: () => {},
      defaultAllowedChatIds: [],
    });

    const mockHandle = createMockHandle(false);
    router.getAgentHandle = async (agentKey: string) => {
      return agentKey === "test-agent" ? mockHandle : null;
    };

    setUserbotRouter(router);

    const handle = await getUserbotHandle("test-agent");
    expect(handle).toBe(mockHandle);
  });

  it("getUserbotHandle should fallback to singleton when router unavailable", async () => {
    setUserbotRouter(null);

    // Mock the singleton fallback
    const { setCurrentUserbot } = await import("../lib/userbot.ts");
    const fallbackHandle = createMockHandle(false);
    setCurrentUserbot(fallbackHandle);

    const handle = await getUserbotHandle("any-agent");
    expect(handle).toBe(fallbackHandle);

    // Cleanup
    setCurrentUserbot(null);
  });
});