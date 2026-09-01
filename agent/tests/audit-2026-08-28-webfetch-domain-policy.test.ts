/**
 * Аудит 2026-08-28: домены оператора не спрашивал никто, кроме web_search.
 *
 * `WEB_SEARCH_ALLOWED_DOMAINS` / `WEB_SEARCH_BLOCKED_DOMAINS` превращались в
 * конфиг ровно в одном месте — `webSearchTool()`. При этом
 * `sdkNativeWebSearchAllowed` на заданных списках выключает нативный поиск
 * СОВСЕМ (домены на SDK-пути неисполнимы), оставляя агента с
 * `mcp__team__WebFetch`. Контур защиты у WebFetch SSRF-овый: схемы, приватные
 * адреса, редиректы, пиннинг. Про домены оператора он не знал ничего.
 *
 * Складывалось наоборот задуманному: оператор сузил веб до белого списка и
 * получил вместо поиска по трём доменам загрузку чего угодно — а на проде
 * USE_AGENT_SDK=true, то есть это основной путь. Блок-лист читается как «на
 * эти домены не ходить», и не ходить через поиск было можно, а ходить
 * напрямую — сколько угодно.
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
  blockedFetchReason,
  blockedFetchReasonAsync,
  blockedRedirectReason,
  type PublicAddressResolver,
} from "../lib/sdk-web-guard.ts";
import { webFetchDomainPolicyReason, _resetWebSearchWarnState } from "../lib/web-search.ts";

const KEYS = ["WEB_SEARCH_ALLOWED_DOMAINS", "WEB_SEARCH_BLOCKED_DOMAINS"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(patch: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    delete process.env[k];
  }
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

/** Резолвер, который всегда отдаёт один публичный адрес. */
const publicResolver: PublicAddressResolver = async () => [{ address: "93.184.216.34" }];

describe("доменная политика на пути WebFetch", () => {
  test("без списков поведение прежнее", () => {
    setEnv({});
    expect(blockedFetchReason("https://example.com/a")).toBeNull();
    expect(blockedFetchReason("https://evil.example/a")).toBeNull();
  });

  test("алоу-лист закрывает всё, чего в нём нет", () => {
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com, docs.anthropic.com" });
    expect(blockedFetchReason("https://coindesk.com/x")).toBeNull();
    // Запись покрывает и поддомены — та же семантика, что у Anthropic.
    expect(blockedFetchReason("https://www.coindesk.com/x")).toBeNull();

    const reason = blockedFetchReason("https://evil.example/x");
    expect(reason).toContain("вне WEB_SEARCH_ALLOWED_DOMAINS");
    // Причина уходит агенту в permissionDecisionReason — в ней должен быть хост.
    expect(reason).toContain("evil.example");
  });

  test("блок-лист закрывает домен и его поддомены", () => {
    setEnv({ WEB_SEARCH_BLOCKED_DOMAINS: "tracker.example" });
    expect(blockedFetchReason("https://tracker.example/p")).toContain(
      "закрыт WEB_SEARCH_BLOCKED_DOMAINS",
    );
    expect(blockedFetchReason("https://a.b.tracker.example/p")).toContain(
      "закрыт WEB_SEARCH_BLOCKED_DOMAINS",
    );
    // Соседний домен с тем же хвостом в имени не считается поддоменом.
    expect(blockedFetchReason("https://nottracker.example/p")).toBeNull();
  });

  test("блок сильнее алоу — как и при сборке web_search", () => {
    setEnv({
      WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com",
      WEB_SEARCH_BLOCKED_DOMAINS: "coindesk.com",
    });
    expect(blockedFetchReason("https://coindesk.com/x")).toContain(
      "закрыт WEB_SEARCH_BLOCKED_DOMAINS",
    );
  });

  test("регистр и FQDN-точка не обходят политику", () => {
    setEnv({ WEB_SEARCH_BLOCKED_DOMAINS: "Tracker.Example" });
    expect(blockedFetchReason("https://TRACKER.example./p")).toContain(
      "закрыт WEB_SEARCH_BLOCKED_DOMAINS",
    );
  });

  test("IP-литерал под доменную политику не подпадает", () => {
    // Иначе отказ получил бы каждый адрес из DNS-ответа: validatedTarget
    // прогоняет их через эту же функцию.
    //
    // Утверждение здесь — про `blockedFetchReason`, и оно осталось верным.
    // Литерал во ВХОДНОМ url белый список с 2026-08-29 всё же не проходит, но
    // решается это уровнем выше, где два вызова различимы: см.
    // audit-2026-08-29-ip-literal-allowlist.
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    expect(blockedFetchReason("https://93.184.216.34/x")).toBeNull();
    expect(blockedFetchReason("https://[2606:4700::1111]/x")).toBeNull();
  });
});

describe("политика доезжает до фактической загрузки", () => {
  test("резолв разрешённого хоста проходит, запрещённого — нет", async () => {
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    expect(await blockedFetchReasonAsync("https://www.coindesk.com/x", publicResolver)).toBeNull();
    expect(await blockedFetchReasonAsync("https://evil.example/x", publicResolver)).toContain(
      "вне WEB_SEARCH_ALLOWED_DOMAINS",
    );
  });

  test("редирект на закрытый домен тоже отбивается", async () => {
    setEnv({ WEB_SEARCH_BLOCKED_DOMAINS: "tracker.example" });
    expect(
      await blockedRedirectReason("https://tracker.example/step2", publicResolver),
    ).toContain("закрыт WEB_SEARCH_BLOCKED_DOMAINS");
  });
});

describe("сама политика", () => {
  test("пустой хост и отсутствие списков дают null", () => {
    setEnv({});
    expect(webFetchDomainPolicyReason("anything.example")).toBeNull();
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    expect(webFetchDomainPolicyReason("")).toBeNull();
  });
});
