/**
 * Починка селекторов (этап 4 автономии): общий модуль, самопроверка вёрстки и
 * порядок действий демона на Mac. Главное — границы: правка только файлов
 * вёрстки и тестов, git/gh у починщика нет, мержа нет, замок покупок снят всегда.
 */
import { describe, expect, test } from "bun:test";
import {
  buildRepairPrompt,
  isRepairablePath,
  parseRepairOutcome,
  parseRepairRequest,
  repairBranchName,
  repairDisallowedTools,
  repairPrBody,
} from "../lib/selector-repair.ts";
import { changedPaths, parseSelfcheck, repairClaudeCommand, runSelectorRepair, type CmdResult, type RepairDeps } from "../mac-daemon/selector-repair.ts";
import { classifyUrl, sanitizeInventory } from "../mac-daemon/shop-selfcheck.ts";
import { parseBridgeMsg } from "../mac-daemon/protocol.ts";

describe("запрос и границы", () => {
  test("только известные service и code, лишнее отброшено", () => {
    expect(parseRepairRequest({ service: "lavka", code: "unexpected_page", prompt: "rm -rf" })).toEqual({ service: "lavka", code: "unexpected_page" });
    expect(parseRepairRequest({ service: "taxi", code: "unexpected_page" })).toBeNull();
    expect(parseRepairRequest({ service: "eda", code: "captcha" })).toBeNull();
    expect(parseRepairRequest(null)).toBeNull();
  });

  test("кадр repair: без свободного текста и с id", () => {
    expect(parseBridgeMsg(JSON.stringify({ type: "repair", id: "r1", request: { service: "market", code: "price_unreadable", x: 1 } }))).toEqual({
      type: "repair",
      id: "r1",
      request: { service: "market", code: "price_unreadable" },
    });
    expect(parseBridgeMsg(JSON.stringify({ type: "repair", id: "r1", request: { service: "market" } }))).toBeNull();
    expect(parseBridgeMsg(JSON.stringify({ type: "repair", request: { service: "lavka", code: "unexpected_page" } }))).toBeNull();
  });

  test("править можно только вёрстку и тесты", () => {
    expect(isRepairablePath("agent/mac-daemon/shop-selectors.ts")).toBe(true);
    expect(isRepairablePath("agent/mac-daemon/eda-playwright.ts")).toBe(true);
    expect(isRepairablePath("agent/tests/shop-selectors.test.ts")).toBe(true);
    for (const bad of [
      "agent/mac-daemon/shop.ts",
      "agent/mac-daemon/protocol.ts",
      "agent/lib/permissions.ts",
      "agent/tests/../lib/x.test.ts",
      "agent/tests/sub/x.test.ts",
      "/etc/passwd",
      "mac-daemon/shop-selectors.ts",
      ".github/workflows/ci.yml",
    ]) expect(isRepairablePath(bad)).toBe(false);
  });

  test("починщику не выдаются git, gh и сеть", () => {
    const cmd = repairClaudeCommand("/bin/claude");
    const denied = cmd[cmd.indexOf("--disallowedTools") + 1];
    for (const t of ["Bash(git:*)", "Bash(gh:*)", "WebFetch", "Bash(curl:*)"]) expect(denied).toContain(t);
    expect(repairDisallowedTools()).toContain("Bash(rm:*)");
    expect(cmd).not.toContain("bypassPermissions");
  });

  test("ветка и задание", () => {
    expect(repairBranchName("eda", new Date("2026-09-18T07:05:00Z"))).toBe("claude/selector-repair-eda-20260918-0705");
    const p = buildRepairPrompt({ service: "market", code: "price_unreadable" });
    expect(p).toContain("mac-daemon/market-selectors.ts");
    expect(p).toContain("selfcheck market");
    expect(p).toContain("git и gh тебе недоступны");
    expect(p).not.toContain("shop-selectors.ts");
  });

  test("тело PR — только то, что знает демон", () => {
    const body = repairPrBody({ service: "lavka", code: "unexpected_page" }, ["agent/mac-daemon/shop-selectors.ts"], { status: "ok", selectors: { price: 0, card: 3 } }, { status: "ok", selectors: { price: 5, card: 3 } });
    expect(body).toContain("`price`");
    expect(body).toContain("Мерж и выкатка — за владельцем");
    expect(body.trim().endsWith("🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toBe(true);
  });

  test("итог демона: ссылка только на github PR, коды — из списка", () => {
    const ok = { ok: true as const, branch: "b", pr_url: "https://github.com/o/r/pull/12", changed: [] as string[], empty_before: [] as string[], empty_after: [] as string[] };
    expect(parseRepairOutcome(`шум\n${JSON.stringify(ok)}`)).toEqual(ok);
    expect(parseRepairOutcome(JSON.stringify({ ...ok, pr_url: "https://evil.example/pull/1" }))).toBeNull();
    expect(parseRepairOutcome(JSON.stringify({ ok: false, code: "repair_busy" }))).toEqual({ ok: false, code: "repair_busy" });
    expect(parseRepairOutcome(JSON.stringify({ ok: false, code: "whatever" }))).toBeNull();
    expect(parseRepairOutcome("не json")).toBeNull();
  });
});

describe("самопроверка вёрстки", () => {
  test("инвентарь без текста страницы и без длинных номеров", () => {
    const inv = sanitizeInventory({
      "data-testid": ["product-card", "cartItem-1789672288320", "cartItem-1789672288321", "Москва, ул. Ленина 1", "ivan@example.com", 5],
      "data-auto": ["snippet-price-current"],
    });
    expect(inv["data-testid"]).toEqual(["cartItem-#", "product-card"]);
    expect(inv["data-auto"]).toEqual(["snippet-price-current"]);
    expect(inv["data-zone-name"]).toEqual([]);
  });

  test("классификация адреса страницы", () => {
    expect(classifyUrl("lavka", "https://lavka.yandex.ru/search?text=x", [])).toBe("ok");
    expect(classifyUrl("lavka", "https://passport.yandex.ru/auth", [])).toBe("login_required");
    expect(classifyUrl("lavka", "https://example.com/", [])).toBe("unexpected_page");
  });

  test("разбор вывода selfcheck", () => {
    expect(parseSelfcheck(`лог\n{"status":"ok","selectors":{"a":1,"b":"x"},"inventory":{}}`)).toEqual({ status: "ok", selectors: { a: 1 } });
    expect(parseSelfcheck("")).toBeNull();
  });

  test("git status → пути, включая оба имени переименования", () => {
    expect(changedPaths(" M agent/a.ts\n?? agent/tests/b.test.ts\nR  agent/x.ts -> agent/y.ts\n")).toEqual([
      "agent/a.ts",
      "agent/tests/b.test.ts",
      "agent/x.ts",
      "agent/y.ts",
    ]);
  });
});

describe("демон: порядок починки", () => {
  const REQ = { service: "lavka", code: "unexpected_page" } as const;
  const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });

  function deps(opts: { status?: string; claudeCode?: number; hold?: boolean; failOn?: string; repo?: string | null } = {}) {
    const calls: string[][] = [];
    let released = 0;
    let claudeRuns = 0;
    const d: RepairDeps = {
      repo: opts.repo === undefined ? "/repo" : opts.repo,
      claudeBin: "/bin/claude",
      hold: async () => (opts.hold === false ? null : () => void released++),
      runCmd: async (argv) => {
        calls.push(argv);
        const key = argv.slice(0, 2).join(" ");
        if (opts.failOn === key) return { code: 1, stdout: "", stderr: "boom" };
        if (key === "git status") return ok(opts.status ?? " M agent/mac-daemon/shop-selectors.ts\n");
        if (key === "bun mac-daemon/shop.ts") return ok(`{"status":"ok","selectors":{"price":${claudeRuns ? 4 : 0}}}`);
        if (key === "gh pr") return ok("https://github.com/o/r/pull/77\n");
        return ok();
      },
      runClaude: async () => {
        claudeRuns++;
        return { code: opts.claudeCode ?? 0, stdout: "готово", stderr: "" };
      },
      now: () => new Date("2026-09-18T10:00:00Z"),
      log: () => {},
    };
    return { d, calls, released: () => released, claudeRuns: () => claudeRuns };
  }

  test("выключено без SELECTOR_REPAIR_REPO", async () => {
    const t = deps({ repo: null });
    expect(await runSelectorRepair(REQ, t.d)).toEqual({ ok: false, code: "repair_disabled" });
    expect(t.calls).toEqual([]);
  });

  test("покупки заняты — не начинает", async () => {
    const t = deps({ hold: false });
    expect(await runSelectorRepair(REQ, t.d)).toEqual({ ok: false, code: "repair_busy" });
    expect(t.calls).toEqual([]);
  });

  test("успех: коммит названных путей, пуш ветки, PR в main — без мержа", async () => {
    const t = deps();
    const out = await runSelectorRepair(REQ, t.d);
    expect(out).toMatchObject({ ok: true, pr_url: "https://github.com/o/r/pull/77", empty_before: ["price"], empty_after: [] });
    expect(t.calls).toContainEqual(["git", "add", "--", "agent/mac-daemon/shop-selectors.ts"]);
    expect(t.calls).toContainEqual(["git", "push", "-u", "origin", "claude/selector-repair-lavka-20260918-1000"]);
    const pr = t.calls.find((c) => c[0] === "gh")!;
    expect(pr.slice(0, 7)).toEqual(["gh", "pr", "create", "--base", "main", "--head", "claude/selector-repair-lavka-20260918-1000"]);
    expect(t.calls.some((c) => c.includes("merge"))).toBe(false);
    expect(t.calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("main"))).toBe(false);
    expect(t.released()).toBe(1);
  });

  test("правка вне вёрстки — ничего не коммитится", async () => {
    const t = deps({ status: " M agent/mac-daemon/shop-selectors.ts\n M agent/mac-daemon/shop.ts\n" });
    expect(await runSelectorRepair(REQ, t.d)).toMatchObject({ ok: false, code: "repair_forbidden_paths" });
    expect(t.calls.some((c) => c[1] === "add" || c[1] === "commit" || c[1] === "push")).toBe(false);
    expect(t.released()).toBe(1);
  });

  test("нечего менять — no_change", async () => {
    const t = deps({ status: "" });
    expect(await runSelectorRepair(REQ, t.d)).toMatchObject({ ok: false, code: "repair_no_change" });
    expect(t.released()).toBe(1);
  });

  test("починщик упал — run_failed, пуша нет", async () => {
    const t = deps({ claudeCode: 1 });
    expect(await runSelectorRepair(REQ, t.d)).toMatchObject({ ok: false, code: "repair_run_failed" });
    expect(t.calls.some((c) => c[1] === "push")).toBe(false);
    expect(t.released()).toBe(1);
  });

  test("сбой подготовки — починщик не запускается", async () => {
    const t = deps({ failOn: "git worktree" });
    expect(await runSelectorRepair(REQ, t.d)).toMatchObject({ ok: false, code: "repair_setup_failed" });
    expect(t.claudeRuns()).toBe(0);
    expect(t.released()).toBe(1);
  });

  test("пуш не прошёл — push_failed", async () => {
    const t = deps({ failOn: "git push" });
    expect(await runSelectorRepair(REQ, t.d)).toMatchObject({ ok: false, code: "repair_push_failed" });
    expect(t.calls.some((c) => c[0] === "gh")).toBe(false);
  });

  test("исключение внутри — замок всё равно снят", async () => {
    const t = deps();
    t.d.runClaude = async () => {
      throw new Error("spawn failed");
    };
    expect(await runSelectorRepair(REQ, t.d)).toMatchObject({ ok: false, code: "repair_setup_failed" });
    expect(t.released()).toBe(1);
  });
});
