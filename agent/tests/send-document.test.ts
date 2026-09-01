/**
 * P1 (2026-06-09): SEND_DOCUMENT — агенты могут прислать текстовый файл в чат.
 * Покрывает: executeTool happy-path, валидацию (content/filename required,
 * слишком большой content), path-sanitization имени файла, миграцию-сид прав,
 * и gate в semi_auto (auto-allowed, не в SEMI_AUTO_RISKY).
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import {
  getPermission,
  evaluateGate,
  setAutonomy,
} from "../lib/permissions.ts";
import { CHARACTERS } from "../characters/index.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_809;
const TEST_AGENT = "qa";

let savedGlobal = saveAutonomy();
afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT, TEST_AGENT);
});

function fakeTg() {
  return {
    // Параметры объявлены не для красоты: тест читает mock.calls[0][1], а у
    // мока без сигнатуры аргументы вызова типизируются пустым кортежем.
    sendDocument: mock(
      (
        _chatId: number,
        _document: { source: Buffer; filename: string },
        _extra?: Record<string, unknown>,
      ) => Promise.resolve({ message_id: 77 }),
    ),
  };
}

describe("migration 033: seed SEND_DOCUMENT permission", () => {
  test("все агенты имеют allowed=1, requires_approval=0", () => {
    for (const c of CHARACTERS) {
      const p = getPermission(c.key, "SEND_DOCUMENT");
      expect(p.allowed).toBe(true);
      expect(p.requires_approval).toBe(false);
    }
  });
});

describe("executeTool: SEND_DOCUMENT", () => {
  test("content + filename → sendDocument вызван как Buffer, ok:true", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const tg = fakeTg();
    const out = await executeTool(
      "SEND_DOCUMENT",
      { content: "# Audit\nall good", filename: "audit.md", caption: "отчёт" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
    );
    const parsed = JSON.parse(out) as { ok: boolean; messageId?: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.messageId).toBe(77);
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    const docArg = tg.sendDocument.mock.calls[0][1];
    expect(Buffer.isBuffer(docArg.source)).toBe(true);
    expect(docArg.source.toString("utf8")).toBe("# Audit\nall good");
    expect(docArg.filename).toBe("audit.md");
  });

  test("без content → ok:false", async () => {
    const tg = fakeTg();
    const out = await executeTool(
      "SEND_DOCUMENT",
      { filename: "x.txt" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error ?? "")).toMatch(/content is required/);
    expect(tg.sendDocument).toHaveBeenCalledTimes(0);
  });

  test("без filename → ok:false", async () => {
    const tg = fakeTg();
    const out = await executeTool(
      "SEND_DOCUMENT",
      { content: "hi" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error ?? "")).toMatch(/filename is required/);
  });

  test("слишком большой content → ok:false", async () => {
    const tg = fakeTg();
    const big = "x".repeat(2_000_001);
    const out = await executeTool(
      "SEND_DOCUMENT",
      { content: big, filename: "big.txt" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error ?? "")).toMatch(/too large/);
  });

  test("path-разделители в filename вычищаются", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const tg = fakeTg();
    const out = await executeTool(
      "SEND_DOCUMENT",
      { content: "data", filename: "../../etc/passwd" },
      { agentKey: TEST_AGENT, chatId: TEST_CHAT, telegram: tg as never },
    );
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    const docArg = tg.sendDocument.mock.calls[0][1];
    expect(docArg.filename).not.toContain("/");
    expect(docArg.filename).toBe(".._.._etc_passwd");
  });
});

describe("evaluateGate: SEND_DOCUMENT в semi_auto → allow", () => {
  test("auto-allowed (не в SEMI_AUTO_RISKY)", () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const g = evaluateGate({ agentKey: TEST_AGENT, actionType: "SEND_DOCUMENT" });
    expect(g.decision).toBe("allow");
  });
});
