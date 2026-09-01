// T-web: Anthropic server-side web_search tool, off by default, env-configurable.
import { test, expect, describe, afterEach } from "bun:test";
import { webSearchTool, webSearchEnabled } from "../lib/web-search.ts";

const KEYS = [
  "WEB_SEARCH_ENABLED",
  "WEB_SEARCH_MAX_USES",
  "WEB_SEARCH_ALLOWED_DOMAINS",
  "WEB_SEARCH_BLOCKED_DOMAINS",
] as const;
const saved: Record<string, string | undefined> = {};
function set(k: string, v: string | undefined) {
  if (saved[k] === undefined && !(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});

describe("web_search tool (T-web)", () => {
  test("disabled by default → null", () => {
    set("WEB_SEARCH_ENABLED", undefined);
    expect(webSearchEnabled()).toBe(false);
    expect(webSearchTool()).toBe(null);
  });

  test("enabled → server tool with default max_uses 3", () => {
    set("WEB_SEARCH_ENABLED", "true");
    set("WEB_SEARCH_MAX_USES", undefined);
    const t = webSearchTool();
    expect(t).not.toBe(null);
    expect(t!.type).toBe("web_search_20250305");
    expect(t!.name).toBe("web_search");
    expect(t!.max_uses).toBe(3);
  });

  // Аудит 2026-08-29: ноль переехал из «невалидно» в «ноль». Он тут стоял
  // рядом с «nope» как один из мусорных вводов, но это разные вещи: «nope» —
  // опечатка, а `0` — записанное решение оператора, и отвечать на него тремя
  // поисками значит делать обратное сказанному. Подробнее —
  // tests/audit-2026-08-29-web-search-config-fail-open.test.ts.
  test("max_uses honored; 0 disables; invalid falls back to 3", () => {
    set("WEB_SEARCH_ENABLED", "true");
    set("WEB_SEARCH_MAX_USES", "5");
    expect(webSearchTool()!.max_uses).toBe(5);
    set("WEB_SEARCH_MAX_USES", "0");
    expect(webSearchTool()).toBeNull();
    set("WEB_SEARCH_MAX_USES", "nope");
    expect(webSearchTool()!.max_uses).toBe(3);
  });

  // Списки у Anthropic взаимоисключающие, поэтому уезжает только allowed —
  // но с 2026-08-20 из него вычитается блок-лист (здесь списки не пересекаются,
  // так что вычитать нечего). Перекрывающиеся случаи — в
  // tests/audit-2026-08-20-web-search-domain-lists.test.ts.
  test("непересекающийся blocked_domains не меняет allowed_domains", () => {
    set("WEB_SEARCH_ENABLED", "true");
    set("WEB_SEARCH_ALLOWED_DOMAINS", "docs.anthropic.com, telegram.org");
    set("WEB_SEARCH_BLOCKED_DOMAINS", "evil.example");
    const t = webSearchTool()!;
    expect(t.allowed_domains).toEqual(["docs.anthropic.com", "telegram.org"]);
    expect(t.blocked_domains).toBeUndefined();
  });
});
