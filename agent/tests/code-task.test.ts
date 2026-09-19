/**
 * Самоулучшение, пункт 9: CODE_TASK. Задача с подтверждением владельца уходит
 * на Mac, демон проверяет список файлов и открывает PR; мержа нет нигде.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  buildCodeTaskPrompt,
  codeTaskBranchName,
  codeTaskDisallowedTools,
  codeTaskPrBody,
  isCodeTaskPath,
  parseCodeTask,
  parseCodeTaskOutcome,
  CODE_TASK_GOAL_MAX,
} from "../lib/code-task.ts";
import {
  CODE_TASK_MAX_PER_DAY,
  CODE_TASK_STALE_MS,
  _setSendCodeTaskForTests,
  codeTaskFollowupTask,
  getCodeTask,
  handleCodeTask,
} from "../lib/code-tasks.ts";
import { db } from "../lib/db.ts";
import { activeFollowups } from "../lib/followups.ts";
import { approvalPreview } from "../lib/approvals.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import { ALWAYS_APPROVE_ACTIONS, CALLER_RESTRICTED, evaluateGate, setAutonomy, setPermission } from "../lib/permissions.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { parseBridgeMsg } from "../mac-daemon/protocol.ts";
import { runCodeTask, type CodeTaskDeps } from "../mac-daemon/code-task.ts";
import type { CmdResult } from "../mac-daemon/selector-repair.ts";
import { savePermissions } from "./_helpers.ts";

const OWNER = "700000001";
const OWNER_CHAT = Number(OWNER);
const task = { title: "Добавить время в сводку", goal: "Сводка дня не показывает время.\nНужно HH:MM у каждой строки." };
const PR = "https://github.com/o/r/pull/9";
const char = (code: number) => String.fromCodePoint(code);
const bctx = { agentKey: "orchestrator", chatId: OWNER_CHAT } as never;

describe("формат задачи", () => {
  test("строгий разбор: два поля, служебные метки допустимы", () => {
    expect(parseCodeTask(task)).toEqual(task);
    expect(parseCodeTask({ ...task, _userId: "1", _delegated: false })).toEqual(task);
    expect(parseCodeTask({ ...task, extra: 1 })).toBeNull();
    expect(parseCodeTask({ title: task.title })).toBeNull();
    expect(parseCodeTask({ title: " x", goal: "y" })).toBeNull();
    expect(parseCodeTask({ title: "a\nb", goal: "y" })).toBeNull();
    expect(parseCodeTask({ title: "x".repeat(101), goal: "y" })).toBeNull();
    expect(parseCodeTask({ title: "x", goal: "y".repeat(CODE_TASK_GOAL_MAX + 1) })).toBeNull();
  });

  test("невидимые и управляющие символы — отказ, перевод строки в цели можно", () => {
    for (const c of [0x200b, 0x202e, 0x2028, 0x0000, 0x001b]) {
      expect(parseCodeTask({ title: "x", goal: `a${char(c)}b` })).toBeNull();
    }
    expect(buildPayload("CODE_TASK", { title: `a${char(0x200b)}`, goal: "y" }, bctx).ok).toBe(false);
    expect(buildPayload("CODE_TASK", task, bctx)).toEqual({ ok: true, payload: task });
  });

  test("пути: код и тесты можно, CI, зависимости, выкатку и политику — нет", () => {
    for (const ok of ["agent/lib/digest.ts", "agent/tests/digest.test.ts", "docs/digest.md", "ios/Agent/ChatView.swift", "agent/miniapp/src/App.tsx"]) {
      expect(isCodeTaskPath(ok)).toBe(true);
    }
    for (const bad of [
      ".github/workflows/ci.yml", ".claude/settings.json", "agent/.env", ".gitattributes",
      "agent/package.json", "agent/bun.lock", "agent/bunfig.toml", "deploy/deploy.sh", "agent/scripts/run.sh",
      "site/web/index.html", "agent/mac-daemon/daemon.ts", "agent/lib/permissions.ts", "agent/lib/approval-policy.ts",
      "agent/lib/code-task.ts", "CLAUDE.md", "agent/AGENTS.md", "../x.ts", "/etc/hosts", "a//b.ts", "agent\\lib\\x.ts",
    ]) {
      expect(isCodeTaskPath(bad)).toBe(false);
    }
  });

  test("ветка, команды исполнителя, задание и тело PR", () => {
    expect(codeTaskBranchName(new Date("2026-09-19T08:05:00Z"))).toBe("claude/improve-20260919-0805");
    expect(codeTaskDisallowedTools()).toEqual(expect.arrayContaining(["Bash(git:*)", "Bash(gh:*)", "Bash(bun install:*)", "WebFetch"]));
    const prompt = buildCodeTaskPrompt(task);
    expect(prompt).toContain(task.goal);
    expect(prompt.indexOf("ЗАДАЧА>>>")).toBeLessThan(prompt.indexOf("Правила:"));
    const body = codeTaskPrBody(task, ["agent/lib/digest.ts"], true);
    expect(body).toContain(task.goal);
    expect(body).toContain("`agent/lib/digest.ts`");
    expect(body).toEndWith("🤖 Generated with [Claude Code](https://claude.com/claude-code)");
  });

  test("ответ демона: последняя строка JSON, ссылка только на PR GitHub", () => {
    const ok = { ok: true as const, branch: "b", pr_url: PR, changed: ["x"], typecheck_ok: true };
    expect(parseCodeTaskOutcome(`шум\n${JSON.stringify(ok)}\n`)).toEqual(ok);
    expect(parseCodeTaskOutcome(JSON.stringify({ ...ok, pr_url: "https://evil.example/pull/1" }))).toBeNull();
    expect(parseCodeTaskOutcome(JSON.stringify({ ok: false, code: "code_task_busy" }))).toEqual({ ok: false, code: "code_task_busy" });
    expect(parseCodeTaskOutcome(JSON.stringify({ ok: false, code: "other" }))).toBeNull();
    expect(parseCodeTaskOutcome("не json")).toBeNull();
  });

  test("кадр code_task разбирается строго", () => {
    expect(parseBridgeMsg(JSON.stringify({ type: "code_task", id: "r1", task }))).toEqual({ type: "code_task", id: "r1", task });
    expect(parseBridgeMsg(JSON.stringify({ type: "code_task", id: "r1", task: { ...task, prompt: "x" } }))).toBeNull();
    expect(parseBridgeMsg(JSON.stringify({ type: "code_task", id: "x".repeat(101), task }))).toBeNull();
  });
});

describe("демон Mac", () => {
  const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });
  function deps(status: string, over: Partial<CodeTaskDeps> = {}) {
    const calls: string[][] = [];
    const d: CodeTaskDeps = {
      repo: "/repo",
      claudeBin: "claude",
      runCmd: async (argv) => {
        calls.push(argv);
        if (argv[0] === "git" && argv[1] === "status") return ok(status);
        if (argv[0] === "gh") return ok(`${PR}\n`);
        return ok();
      },
      runClaude: async (argv, cwd) => {
        calls.push([...argv, `cwd=${cwd}`]);
        return ok("вывод исполнителя");
      },
      now: () => new Date("2026-09-19T08:05:00Z"),
      log: () => {},
      ...over,
    };
    return { d, calls };
  }

  test("правка в разрешённых файлах — коммит, пуш и PR, мержа нет", async () => {
    const { d, calls } = deps(" M agent/lib/digest.ts\n?? agent/tests/digest.test.ts\n");
    const out = await runCodeTask(task, d);
    expect(out).toEqual({ ok: true, branch: "claude/improve-20260919-0805", pr_url: PR, changed: ["agent/lib/digest.ts", "agent/tests/digest.test.ts"], typecheck_ok: true });
    const claude = calls.find((c) => c[0] === "claude")!;
    expect(claude.at(-1)).toBe("cwd=/repo/.claude/worktrees/improve-20260919-0805");
    expect(calls).toContainEqual(["git", "add", "--", "agent/lib/digest.ts", "agent/tests/digest.test.ts"]);
    expect(calls).toContainEqual(["git", "push", "-u", "origin", "claude/improve-20260919-0805"]);
    expect(calls.some((c) => c.includes("merge"))).toBe(false);
    const pr = calls.find((c) => c[0] === "gh")!;
    expect(pr.join(" ")).not.toContain("вывод исполнителя");
  });

  test("запрещённый путь — ничего не коммитится", async () => {
    const { d, calls } = deps(" M agent/lib/digest.ts\n M .github/workflows/ci.yml\n");
    expect(await runCodeTask(task, d)).toEqual({ ok: false, code: "code_task_forbidden_paths", branch: "claude/improve-20260919-0805", changed: [".github/workflows/ci.yml"] });
    expect(calls.some((c) => c[1] === "add" || c[1] === "push" || c[0] === "gh")).toBe(false);
  });

  test("нет правки, нет клона, вторая задача параллельно", async () => {
    expect((await runCodeTask(task, deps("").d))).toMatchObject({ ok: false, code: "code_task_no_change" });
    expect(await runCodeTask(task, deps("", { repo: null }).d)).toEqual({ ok: false, code: "code_task_disabled" });
    let release!: () => void;
    const slow = deps("", { runClaude: () => new Promise((r) => { release = () => r(ok()); }) }).d;
    const first = runCodeTask(task, slow);
    await new Promise((r) => setTimeout(r, 5));
    expect(await runCodeTask(task, deps("").d)).toEqual({ ok: false, code: "code_task_busy" });
    release();
    expect(await first).toMatchObject({ code: "code_task_no_change" });
  });
});

describe("сервер", () => {
  let savedOwners: string | undefined;
  let restorePerms: () => void;
  beforeAll(() => {
    savedOwners = process.env.MINIAPP_ADMIN_USER_IDS;
    process.env.MINIAPP_ADMIN_USER_IDS = OWNER;
    restorePerms = savePermissions([["orchestrator", "CODE_TASK"]]);
  });
  afterAll(() => {
    if (savedOwners === undefined) delete process.env.MINIAPP_ADMIN_USER_IDS;
    else process.env.MINIAPP_ADMIN_USER_IDS = savedOwners;
    _setSendCodeTaskForTests(null);
    restorePerms();
  });
  afterEach(() => {
    db.prepare(`DELETE FROM code_tasks`).run();
    db.prepare(`DELETE FROM followups WHERE chat_id = ?`).run(OWNER_CHAT);
    _resetRateLimits();
  });

  const payload = { ...task, _userId: OWNER, _delegated: false };
  const ctx = { agentKey: "orchestrator", chatId: OWNER_CHAT };
  const flush = () => new Promise((r) => setTimeout(r, 10));
  function pendingSend() {
    let finish!: (stdout: string) => void;
    const sent: unknown[] = [];
    _setSendCodeTaskForTests((t) => {
      sent.push(t);
      return new Promise((resolve) => { finish = (stdout) => resolve({ ok: true, stdout, stderr: "" }); });
    });
    return { sent, finish: (s: string) => finish(s) };
  }

  test("подтверждение в любом режиме, только оркестратор", () => {
    expect(ALWAYS_APPROVE_ACTIONS.has("CODE_TASK")).toBe(true);
    expect(CALLER_RESTRICTED.CODE_TASK).toBe("orchestrator");
    setAutonomy("chat", OWNER, "auto");
    setPermission("orchestrator", "CODE_TASK", { allowed: true, requires_approval: false });
    expect(evaluateGate({ agentKey: "orchestrator", actionType: "CODE_TASK", chatId: OWNER_CHAT }).decision).toBe("approval");
    expect(evaluateGate({ agentKey: "qa", actionType: "CODE_TASK", chatId: OWNER_CHAT }).decision).toBe("deny");
  });

  test("карточка показывает весь текст задачи", () => {
    const goal = `Начало. ${"подробность ".repeat(60)}Конец.`;
    const preview = approvalPreview("CODE_TASK", { title: "Заголовок", goal });
    expect(preview).toStartWith("задача на код для Mac → PR в публичный репозиторий. «Заголовок»: Начало.");
    expect(preview).toEndWith("Конец.");
  });

  test("не оркестратор, группа, чужой и делегированный — отказ без запуска", async () => {
    const s = pendingSend();
    expect((await handleCodeTask(payload, { ...ctx, agentKey: "backend" })).ok).toBe(false);
    expect((await handleCodeTask(payload, { ...ctx, chatId: -100 })).ok).toBe(false);
    expect((await handleCodeTask({ ...payload, _userId: "5" }, { ...ctx, chatId: 5 })).ok).toBe(false);
    expect((await handleCodeTask({ ...payload, _delegated: true }, ctx)).ok).toBe(false);
    expect(s.sent).toEqual([]);
  });

  test("запуск отвечает сразу, итог с PR приходит проверкой", async () => {
    const s = pendingSend();
    const out = await handleCodeTask(payload, ctx);
    expect(out.ok).toBe(true);
    const id = (out as { result: { id: string } }).result.id;
    expect(s.sent).toEqual([task]);
    expect(getCodeTask(id)!.status).toBe("running");
    s.finish(JSON.stringify({ ok: true, branch: "claude/improve-x", pr_url: PR, changed: ["a.ts"], typecheck_ok: true }));
    await flush();
    expect(getCodeTask(id)).toMatchObject({ status: "done", pr_url: PR, branch: "claude/improve-x" });
    const [f] = activeFollowups(OWNER_CHAT);
    expect(f.task).toContain(PR);
    expect(f.task).toContain("Сам не мержи");
  });

  test("одна одновременно, пять в сутки, застрявшая становится failed", async () => {
    pendingSend();
    const now = Date.now();
    expect((await handleCodeTask(payload, ctx, now)).ok).toBe(true);
    const busy = await handleCodeTask(payload, ctx, now + 1000);
    expect(busy.ok).toBe(false);
    expect(String((busy as { error: string }).error)).toContain("ещё идёт");
    // Через 70 минут без ответа строка считается брошенной.
    expect((await handleCodeTask(payload, ctx, now + CODE_TASK_STALE_MS + 1000)).ok).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM code_tasks WHERE error = 'stale'`).get()).toEqual({ n: 1 });
    db.prepare(`UPDATE code_tasks SET status = 'failed'`).run();
    for (let i = 0; i < CODE_TASK_MAX_PER_DAY - 2; i++) {
      db.prepare(`INSERT INTO code_tasks (id, title, goal, chat_id, user_id, status, created_at) VALUES (?, 't', 'g', ?, ?, 'failed', ?)`).run(`x${i}`, OWNER_CHAT, OWNER, now);
    }
    const capped = await handleCodeTask(payload, ctx, now + CODE_TASK_STALE_MS + 2000);
    expect(String((capped as { error: string }).error)).toContain(`максимум ${CODE_TASK_MAX_PER_DAY}`);
  });

  test("Mac не ответил — failed и сообщение владельцу", async () => {
    _setSendCodeTaskForTests(async () => { throw new Error("mac_offline"); });
    const out = await handleCodeTask(payload, ctx);
    await flush();
    const id = (out as { result: { id: string } }).result.id;
    expect(getCodeTask(id)).toMatchObject({ status: "failed", error: "mac_offline" });
    expect(activeFollowups(OWNER_CHAT)[0].task).toContain("не дала ответа Mac");
  });

  test("задача проверки влезает в 300 символов", () => {
    const title = "x".repeat(100);
    const many = Array.from({ length: 20 }, (_, i) => `agent/lib/very-long-file-name-${i}.ts`);
    for (const o of [
      null,
      { ok: true as const, branch: "b", pr_url: PR, changed: [], typecheck_ok: false },
      { ok: false as const, code: "code_task_forbidden_paths" as const, changed: many },
      { ok: false as const, code: "code_task_no_change" as const },
      { ok: false as const, code: "code_task_push_failed" as const },
    ]) {
      expect(codeTaskFollowupTask(title, o).length).toBeLessThanOrEqual(300);
    }
  });
});
