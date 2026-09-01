/**
 * C18: daily team digest aggregation + scheduler.
 *
 * No LLM, no Telegram — purely SQL + a mocked sender.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "../lib/db.ts";
import { createTask, updateTaskStatus } from "../lib/tasks.ts";
import { logAction } from "../lib/audit.ts";
import { createApproval } from "../lib/approvals.ts";
import { recordUsage, todayUTC } from "../lib/token-budget.ts";
import { buildDigest, startDigestScheduler } from "../lib/digest.ts";

const TEST_CHAT = -1018180001;
const AGENT_PREFIX = "c18_";

function cleanup(): void {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE agent_key LIKE 'c18_%'`).run();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM agent_token_usage WHERE agent_key LIKE 'c18_%'`).run();
}

beforeEach(cleanup);
afterEach(cleanup);

describe("C18 buildDigest", () => {
  test("builds with all section headers and does not throw", () => {
    const out = buildDigest({ now: new Date("2026-05-20T06:00:00Z") });
    expect(out).toContain("📊 Daily digest — 2026-05-20");
    expect(out).toContain("Tasks (last 24h)");
    expect(out).toContain("Top agents");
    expect(out).toContain("Approvals");
    expect(out).toContain("Token usage");
    expect(out).toContain("Errors");
    // No raw "(error: ..." section markers — i.e. no SQL crash.
    expect(out).not.toContain("(error:");
  });

  test("buildDigest with no data in window → (no data) appears (using future since)", () => {
    // Pick a "since" 1 second in the future so nothing matches the 24h window.
    const future = new Date(Date.now() + 60_000);
    const out = buildDigest({ now: future, since: future });
    expect(out).toContain("(no data)");
  });

  test("seeded tasks → status counts appear", () => {
    const t1 = createTask({
      chatId: TEST_CHAT,
      createdBy: `${AGENT_PREFIX}lead`,
      title: "A",
    });
    const t2 = createTask({
      chatId: TEST_CHAT,
      createdBy: `${AGENT_PREFIX}lead`,
      title: "B",
    });
    const t3 = createTask({
      chatId: TEST_CHAT,
      createdBy: `${AGENT_PREFIX}lead`,
      title: "C",
    });
    updateTaskStatus(t1.id, "running");
    updateTaskStatus(t1.id, "done");
    updateTaskStatus(t2.id, "running");
    updateTaskStatus(t2.id, "failed");
    // t3 stays pending.

    // Restrict the window to just now so prior tests' data doesn't leak in.
    const now = new Date();
    const since = new Date(now.getTime() - 60_000);
    const out = buildDigest({ now, since });
    // Count statuses for OUR three test tasks only (others may also be in window
    // from sibling tests; assert at least the expected counts are present).
    expect(out).toMatch(/pending: [1-9]/);
    expect(out).toMatch(/done: [1-9]/);
    expect(out).toMatch(/failed: [1-9]/);
  });

  test("seeded actions → top agents ranked by count", () => {
    // Секция Errors считает failed-действия ГЛОБАЛЬНО: buildDigest фильтрует
    // agent_actions только по created_at, без chat_id. Соседние тесты пишут
    // свои status='error' в то же 24-часовое окно, поэтому точное
    // «failed actions: 1» было утверждением про весь прогон, а не про наши
    // данные — и падало от одного лишь порядка обхода файлов (на APFS локально
    // и на ext4 в CI он разный, bun сортировку не гарантирует). Снимаем
    // базовый уровень до посева и проверяем прирост.
    const errorsBefore =
      (db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_actions
           WHERE status = 'error' AND created_at >= ?`,
        )
        .get(Date.now() - 24 * 60 * 60 * 1000) as { n: number }).n;

    // «Top agents» — это `GROUP BY agent_key ORDER BY n DESC LIMIT 5` по всему
    // окну, без chat_id. Пятёрка — общая на весь прогон: фиксированные 5 и 2
    // держались только пока соседние файлы писали в agent_actions меньше, чем
    // мы. При `--randomize` c18_beta с двумя действиями вылетал из пятёрки, и
    // тест падал не на ранжировании, а на попадании в лимит. Поэтому сеем не
    // константу, а «выше текущего максимума» — тогда первые два места наши по
    // построению, и утверждение остаётся про порядок, а не про фон. T-751.
    const maxN = (
      db
        .prepare(
          `SELECT COALESCE(MAX(n), 0) AS n FROM (
             SELECT COUNT(*) AS n FROM agent_actions
             WHERE created_at >= ? GROUP BY agent_key
           )`,
        )
        .get(Date.now() - 24 * 60 * 60 * 1000) as { n: number }
    ).n;
    const alphaN = maxN + 2;
    const betaN = maxN + 1;

    for (let i = 0; i < alphaN; i++) {
      logAction({
        agentKey: `${AGENT_PREFIX}alpha`,
        chatId: TEST_CHAT,
        actionType: "SEND_MESSAGE",
        status: "ok",
      });
    }
    for (let i = 0; i < betaN; i++) {
      logAction({
        agentKey: `${AGENT_PREFIX}beta`,
        chatId: TEST_CHAT,
        actionType: "SEND_MESSAGE",
        status: "ok",
      });
    }
    logAction({
      agentKey: `${AGENT_PREFIX}gamma`,
      chatId: TEST_CHAT,
      actionType: "SEND_MESSAGE",
      status: "error",
    });

    const out = buildDigest({ now: new Date() });
    const topIdx = out.indexOf("Top agents");
    const tokenIdx = out.indexOf("Token usage");
    const topSection = out.slice(topIdx, tokenIdx);
    const aIdx = topSection.indexOf("c18_alpha");
    const bIdx = topSection.indexOf("c18_beta");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(bIdx); // alpha (maxN+2) ranked above beta (maxN+1)
    expect(topSection).toContain(`c18_alpha: ${alphaN} actions`);

    // Errors section should also see the one failed action we just seeded.
    const reported = out.match(/failed actions: (\d+)/);
    expect(reported).not.toBeNull();
    expect(Number(reported![1])).toBe(errorsBefore + 1);
  });

  test("seeded approvals + token usage render", () => {
    const action = logAction({
      agentKey: `${AGENT_PREFIX}alpha`,
      chatId: TEST_CHAT,
      actionType: "SEND_MESSAGE",
      status: "pending_approval",
    });
    createApproval({
      actionId: action.id,
      chatId: TEST_CHAT,
      requestedBy: `${AGENT_PREFIX}alpha`,
      actionType: "SEND_MESSAGE",
      payload: { chatId: TEST_CHAT, text: "hi" },
    });
    recordUsage(`${AGENT_PREFIX}alpha`, 1234, 567, todayUTC());

    const out = buildDigest({ now: new Date() });
    expect(out).toMatch(/pending: [1-9]/);
    expect(out).toContain("c18_alpha: in=1234 out=567");
  });
});

describe("C18 scheduler", () => {
  test("_runNow posts exactly once per day even if called twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "c18-"));
    const markerPath = join(root, ".digest-last");
    const sent: { chatId: string | number; text: string }[] = [];
    const sender = {
      sendMessage: async (chatId: string | number, text: string) => {
        sent.push({ chatId, text });
      },
    };

    const handle = startDigestScheduler({
      sender,
      chatIds: ["111", "222"],
      hourUTC: 6,
      intervalMs: 60_000,
      markerPath,
      nowProvider: () => new Date("2026-05-20T06:05:00Z"),
    });

    const r1 = await handle._runNow();
    const r2 = await handle._runNow();
    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(sent.length).toBe(2); // two chats, one digest each
    expect(sent[0].text).toContain("📊 Daily digest");
    expect(existsSync(markerPath)).toBe(true);

    handle.stop();
    handle.stop(); // idempotent
    rmSync(root, { recursive: true, force: true });
  });

  test("stop before any tick: no sends", async () => {
    const root = mkdtempSync(join(tmpdir(), "c18-"));
    const markerPath = join(root, ".digest-last");
    const sent: unknown[] = [];
    const handle = startDigestScheduler({
      sender: {
        sendMessage: async () => {
          sent.push(1);
        },
      },
      chatIds: ["111"],
      hourUTC: 6,
      intervalMs: 60_000,
      markerPath,
      nowProvider: () => new Date("2026-05-20T06:05:00Z"),
    });
    handle.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});
