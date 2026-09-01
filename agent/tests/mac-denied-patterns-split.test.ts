/**
 * Аудит 2026-08-12: половина денилиста MAC_RUN_CLAUDE умирала на разборе, молча.
 *
 * Шаблоны читались так:
 *
 *   const patterns = deniedPatternsEnv.split(",").map(p => p.trim()).filter(Boolean);
 *   for (const pattern of patterns) {
 *     try { if (new RegExp(pattern).test(p.prompt)) return forbidden; }
 *     catch (e) { log.warn(`invalid denied pattern '${pattern}'`); }
 *   }
 *
 * Разделитель — запятая, а запятая в регулярке метасимвол: она стоит внутри
 * квантификатора `{n,m}`. Шаблон `rm\s{1,3}-rf` резался на `rm\s{1` и `3}-rf`.
 * И это НЕ падает: в JS (без флага `u`) незакрытая `{` — обычный литерал,
 * поэтому оба огрызка компилируются успешно и не матчат ничего. Ни warn, ни
 * ошибки — админ видит непустой MAC_DENIED_PROMPT_PATTERNS и считает, что
 * запрет работает.
 *
 * Второе: catch был fail-open. Шаблон, который действительно не компилируется
 * (`[unclosed`), просто выпадал из проверки, и запрос уходил на Mac. У
 * денилиста единственное правильное поведение при сломанном правиле — отказ:
 * мы не знаем, попадал под него промпт или нет.
 *
 * Цена вопроса: MAC_RUN_CLAUDE запускает Claude Code на машине владельца.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { parseDeniedPatterns } from "../lib/dispatch/mac.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_941;
const ENV = "MAC_DENIED_PROMPT_PATTERNS";

/** Мост, который обязан НЕ получить вызова, если гейт отработал. */
function refusingBridge() {
  return {
    isMacConnected: () => true,
    isUserAllowed: () => true,
    sendToMac: async () => {
      throw new Error("should not reach sendToMac");
    },
    stopMac: async () => ({ ok: true }),
  };
}

async function runMac(prompt: string, bridge: ReturnType<typeof refusingBridge>) {
  return dispatchAction(
    "MAC_RUN_CLAUDE",
    { project: "/Users/dobropalm/programs/foo", prompt, mode: "ask", _userId: "42" },
    { agentKey: "orchestrator", chatId: TEST_CHAT, macBridge: bridge },
  );
}

describe("parseDeniedPatterns", () => {
  test("обычный CSV разбирается как раньше", () => {
    expect(parseDeniedPatterns("rm -rf,sudo.*,dangerous")).toEqual([
      "rm -rf",
      "sudo.*",
      "dangerous",
    ]);
  });

  test("пустые и пробельные куски отбрасываются", () => {
    expect(parseDeniedPatterns(" a , ,, b ")).toEqual(["a", "b"]);
  });

  test("запятая внутри квантификатора не делит шаблон", () => {
    const got = parseDeniedPatterns("rm\\s{1,3}-rf,sudo");
    expect(got).toEqual(["rm\\s{1,3}-rf", "sudo"]);
    // И главное — шаблон снова матчит то, ради чего он написан.
    expect(new RegExp(got[0]!).test("please run rm  -rf /")).toBe(true);
  });

  test("экранированная скобка не открывает квантификатор", () => {
    // `\{` — литерал, значит запятая после него обычная и делит.
    expect(parseDeniedPatterns("a\\{x,y")).toEqual(["a\\{x", "y"]);
  });
});

describe("MAC_RUN_CLAUDE и денилист", () => {
  const before = process.env[ENV];
  const savedAutonomy = saveAutonomy();

  afterEach(() => {
    if (before === undefined) delete process.env[ENV];
    else process.env[ENV] = before;
    restoreAutonomy(savedAutonomy);
    cleanupChat(TEST_CHAT);
  });

  test("шаблон с квантификатором запрещает промпт", async () => {
    process.env[ENV] = "rm\\s{1,3}-rf";
    const res = await runMac("please run rm  -rf / to clean up", refusingBridge());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("denied pattern");
  });

  test("некорректный шаблон — отказ, а не проход мимо проверки", async () => {
    process.env[ENV] = "[unclosed";
    const res = await runMac("совершенно безобидный промпт", refusingBridge());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("MAC_DENIED_PROMPT_PATTERNS");
  });
});
