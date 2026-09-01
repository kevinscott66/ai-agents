/**
 * Аудит 2026-08-28: ручки оператора web_search на SDK-пути.
 *
 * `WEB_SEARCH_ENABLED` починили 2026-08-21, а `WEB_SEARCH_MAX_USES`,
 * `WEB_SEARCH_ALLOWED_DOMAINS` и `WEB_SEARCH_BLOCKED_DOMAINS` остались
 * декорацией: `sdkAllowedTools` кладёт в алоулист CLI голую строку
 * "WebSearch", а `webSearchTool()` — единственное место, где эти три
 * переменные превращаются в конфиг, — из agent-sdk-runtime.ts не зовётся.
 * На проде USE_AGENT_SDK=true, то есть на боевом пути они не делали ничего.
 *
 * Домены на этом пути неисполнимы в принципе (в sdk.d.ts конфигурации
 * нативного WebSearch нет, а PreToolUse видит запрос, но не домены выдачи) —
 * значит закрываемся. Потолок вызовов исполним и держится хуком.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sdkNativeWebSearchAllowed,
  makeSdkWebSearchLimiter,
  webSearchTool,
  _resetWebSearchWarnState,
} from "../lib/web-search.ts";
import { sdkAllowedTools } from "../lib/agent-sdk-runtime.ts";

const RUNTIME_SRC = readFileSync(join(import.meta.dir, "../lib/agent-sdk-runtime.ts"), "utf-8");

const KEYS = [
  "WEB_SEARCH_ENABLED",
  "WEB_SEARCH_MAX_USES",
  "WEB_SEARCH_ALLOWED_DOMAINS",
  "WEB_SEARCH_BLOCKED_DOMAINS",
] as const;

const saved = new Map<string, string | undefined>();
function setEnv(patch: Record<string, string | undefined>): void {
  for (const k of KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
  }
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) process.env[k] = v;
  }
  _resetWebSearchWarnState();
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  _resetWebSearchWarnState();
});

/** Только сетевые имена — остальное в алоулисте нас здесь не интересует. */
function webToolsOf(out: string[]): string[] {
  return out.filter((t) => /(^|__)(WebSearch|WebFetch)$/.test(t));
}

describe("домены оператора: SDK-путь закрывается, а не игнорирует", () => {
  test("без списков доменов нативный WebSearch выдаётся как раньше", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true" });
    expect(sdkNativeWebSearchAllowed()).toBe(true);
    expect(webToolsOf(sdkAllowedTools(["SEARCH_WIKI"], undefined))).toEqual([
      "WebSearch",
      "mcp__team__WebFetch",
    ]);
  });

  test("задан алоулист доменов — нативный WebSearch не выдаётся", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true", WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    expect(sdkNativeWebSearchAllowed()).toBe(false);
    expect(webToolsOf(sdkAllowedTools(["SEARCH_WIKI"], undefined))).toEqual([
      "mcp__team__WebFetch",
    ]);
  });

  test("задан блок-лист доменов — нативный WebSearch не выдаётся", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true", WEB_SEARCH_BLOCKED_DOMAINS: "evil.example" });
    expect(sdkNativeWebSearchAllowed()).toBe(false);
    expect(webToolsOf(sdkAllowedTools(["SEARCH_WIKI"], undefined))).toEqual([
      "mcp__team__WebFetch",
    ]);
  });

  test("наш guardedWebFetch домены не трогают — он остаётся", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true", WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    expect(sdkAllowedTools(["SEARCH_WIKI"], undefined)).toContain("mcp__team__WebFetch");
  });

  test("выключенный поиск остаётся выключенным", () => {
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    expect(sdkNativeWebSearchAllowed()).toBe(false);
    expect(webToolsOf(sdkAllowedTools(["SEARCH_WIKI"], undefined))).toEqual([]);
  });

  test("потолок исполнителя по-прежнему сильнее: пустой allowedTools — пусто", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true" });
    expect(sdkAllowedTools(["SEARCH_WIKI"], [])).toEqual([]);
  });

  test("capabilityAllowlist без WebSearch не возвращает его и при разрешённых доменах", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true" });
    const out = sdkAllowedTools(["SEARCH_WIKI"], undefined, ["SEARCH_WIKI"]);
    expect(webToolsOf(out)).toEqual([]);
  });

  test("raw-путь не изменился: там домены как раз применяются", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true", WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    expect(webSearchTool()?.allowed_domains).toEqual(["coindesk.com"]);
  });
});

describe("потолок вызовов: WEB_SEARCH_MAX_USES держится хуком", () => {
  test("по умолчанию три вызова, четвёртый отклонён", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true" });
    const limit = makeSdkWebSearchLimiter();
    expect(limit("WebSearch")).toBeNull();
    expect(limit("WebSearch")).toBeNull();
    expect(limit("WebSearch")).toBeNull();
    const denied = limit("WebSearch");
    expect(denied).toContain("WEB_SEARCH_MAX_USES=3");
  });

  test("значение переменной уважается", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true", WEB_SEARCH_MAX_USES: "1" });
    const limit = makeSdkWebSearchLimiter();
    expect(limit("WebSearch")).toBeNull();
    expect(limit("WebSearch")).toContain("WEB_SEARCH_MAX_USES=1");
  });

  test("чужие инструменты не тратят бюджет поиска", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true", WEB_SEARCH_MAX_USES: "1" });
    const limit = makeSdkWebSearchLimiter();
    expect(limit("mcp__team__WebFetch")).toBeNull();
    expect(limit("mcp__team__SEARCH_WIKI")).toBeNull();
    expect(limit(undefined)).toBeNull();
    expect(limit("WebSearch")).toBeNull();
    expect(limit("WebSearch")).not.toBeNull();
  });

  test("бюджет у каждого прогона свой", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true", WEB_SEARCH_MAX_USES: "1" });
    const a = makeSdkWebSearchLimiter();
    expect(a("WebSearch")).toBeNull();
    expect(a("WebSearch")).not.toBeNull();
    const b = makeSdkWebSearchLimiter();
    expect(b("WebSearch")).toBeNull();
  });

  test("мусор в переменной откатывается к трём, а не к нулю", () => {
    setEnv({ WEB_SEARCH_ENABLED: "true", WEB_SEARCH_MAX_USES: "не число" });
    const limit = makeSdkWebSearchLimiter();
    expect(limit("WebSearch")).toBeNull();
    expect(limit("WebSearch")).toBeNull();
    expect(limit("WebSearch")).toBeNull();
    expect(limit("WebSearch")).toContain("WEB_SEARCH_MAX_USES=3");
  });
});

describe("охранители по исходнику", () => {
  test("хуки строятся на прогон, а не константой модуля", () => {
    expect(RUNTIME_SRC).toContain("function sdkHooks()");
    expect(RUNTIME_SRC).not.toContain("const SDK_HOOKS");
    expect(RUNTIME_SRC.split("hooks: sdkHooks(),").length - 1).toBe(2);
  });

  test("лимитер создаётся внутри билдера — иначе счётчик общий на процесс", () => {
    const body = RUNTIME_SRC.slice(
      RUNTIME_SRC.indexOf("function sdkHooks()"),
      RUNTIME_SRC.indexOf("export { buildSubscriptionEnv };"),
    );
    expect(body).toContain("makeSdkWebSearchLimiter()");
    expect(body).toContain('permissionDecision: "deny"');
    expect(body).toContain("webFetchGuardHookAsync(input)");
  });

  test("WebSearch в алоулисте гейтится решением по доменам", () => {
    expect(RUNTIME_SRC).toContain("sdkNativeWebSearchAllowed()");
  });
});
