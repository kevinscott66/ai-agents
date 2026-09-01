/**
 * Аудит 2026-08-08: WebFetch выдавался всем 12 ролям без ограничений по хосту,
 * а Mini App слушает 127.0.0.1:8787 в том же процессе. Инъекция из
 * пересланного сообщения / вложения / выдачи web_search («зайди на
 * http://127.0.0.1:8787/api/… и опубликуй») превращалась в SSRF.
 *
 * Тесты сторожат обе стороны: внутреннее закрыто (включая формы записи адреса,
 * которые понимает getaddrinfo, но не понимает наивное сравнение строк), а
 * публичный интернет — как был, иначе ресёрч-роли останутся без инструмента.
 */
import { describe, test, expect } from "bun:test";
import {
  blockedFetchReason,
  blockedFetchReasonAsync,
  blockedRedirectReason,
  guardedWebFetch,
  parseIPv4,
  webFetchGuardHook,
  webFetchGuardHookAsync,
} from "../lib/sdk-web-guard.ts";

describe("blockedFetchReason — пропускает публичное", () => {
  test("обычные https-адреса", () => {
    for (const u of [
      "https://example.com/article",
      "https://docs.anthropic.com/en/api",
      "http://93.184.216.34/",
      "https://sub.domain.co.uk:8443/path?q=1",
      "https://agents.example.com:8443/",
      "https://[2606:4700:4700::1111]/",
    ]) {
      expect(blockedFetchReason(u)).toBeNull();
    }
  });

  test("хост, лишь похожий на внутренний, не блокируется", () => {
    // localhost.example.com — публичный домен, а не loopback.
    expect(blockedFetchReason("https://localhost.example.com/")).toBeNull();
    expect(blockedFetchReason("https://not-localhost.io/")).toBeNull();
    // 127-в-начале, но другой /8.
    expect(blockedFetchReason("https://12.7.0.1/")).toBeNull();
  });
});

describe("blockedFetchReason — закрывает внутреннее", () => {
  test("loopback во всех написаниях", () => {
    for (const u of [
      "http://127.0.0.1:8787/api/agents",
      "http://localhost:8787/",
      "http://LOCALHOST/",
      "http://127.1/", // inet_aton: 127.0.0.1
      "http://2130706433/", // тот же адрес одним числом
      "http://0x7f.0.0.1/", // hex-октет
      "http://0177.0.0.1/", // octal
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0:8787/",
    ]) {
      expect(blockedFetchReason(u)).not.toBeNull();
    }
  });

  test("приватные сети и облачная метадата", () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
    ]) {
      expect(blockedFetchReason(u)).not.toBeNull();
    }
    // 172.15 и 172.32 — вне 172.16/12, они публичные.
    expect(blockedFetchReason("http://172.15.0.1/")).toBeNull();
    expect(blockedFetchReason("http://172.32.0.1/")).toBeNull();
  });

  test("внутренние суффиксы", () => {
    for (const u of [
      "http://prod-host.internal/",
      "http://printer.local/",
      "http://foo.home.arpa/",
      "http://box.lan/",
      "http://app.localhost/",
    ]) {
      expect(blockedFetchReason(u)).not.toBeNull();
    }
  });

  test("не-http схемы и мусор", () => {
    for (const u of [
      "file:///opt/agent-team/.env",
      "ftp://example.com/x",
      "gopher://example.com/",
      "not a url",
      "",
      null,
      undefined,
      42,
      { url: "https://example.com" },
    ]) {
      expect(blockedFetchReason(u)).not.toBeNull();
    }
  });
});

describe("parseIPv4", () => {
  test("формы inet_aton", () => {
    expect(parseIPv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("127.1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("0x7f.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIPv4("0177.0.0.1")).toEqual([127, 0, 0, 1]);
  });

  test("имена хостов — не IP", () => {
    expect(parseIPv4("example.com")).toBeNull();
    expect(parseIPv4("1.2.3.4.5")).toBeNull();
    expect(parseIPv4("256.0.0.1")).toBeNull();
    expect(parseIPv4("")).toBeNull();
  });
});

// Аудит 2026-08-20: хук стал асинхронным — имена он теперь резолвит
// (см. audit-2026-08-20-web-guard-wildcard-dns.test.ts). Все адреса ниже —
// литералы либо заведомо внутренние суффиксы, до резолвера они не доходят,
// поэтому подставной lookup здесь не нужен.
describe("webFetchGuardHook", () => {
  test("чужие тулзы не трогает", async () => {
    expect(
      await webFetchGuardHook({ tool_name: "WebSearch", tool_input: { query: "x" } }),
    ).toEqual({});
    expect(
      await webFetchGuardHook({
        tool_name: "mcp__team__SEND_MESSAGE",
        tool_input: { url: "http://127.0.0.1/" },
      }),
    ).toEqual({});
  });

  test("публичный WebFetch проходит без решения", async () => {
    expect(
      await webFetchGuardHook(
        {
          tool_name: "WebFetch",
          tool_input: { url: "https://example.com/" },
        },
        { lookup: async () => ["93.184.216.34"] },
      ),
    ).toEqual({});
  });

  test("внутренний WebFetch — deny с причиной для модели", async () => {
    const out = (await webFetchGuardHook({
      tool_name: "WebFetch",
      tool_input: { url: "http://127.0.0.1:8787/api/agents" },
    })) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("127.0.0.1");
    // Причина должна прямо называть инъекцию: без этого модель просто повторит
    // вызов, «исправив» адрес по подсказке из того же недоверенного текста.
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("вложении");
  });

  test("мусорный ввод не роняет хук", async () => {
    expect(await webFetchGuardHook(null)).toEqual({});
    expect(await webFetchGuardHook({})).toEqual({});
    expect(
      await webFetchGuardHook({ tool_name: "WebFetch", tool_input: undefined }),
    ).toHaveProperty("hookSpecificOutput");
  });
});

describe("DNS-aware WebFetch egress policy", () => {
  test("guarded fetch rejects a private target before the request boundary", async () => {
    let requests = 0;
    await expect(
      guardedWebFetch("http://127.0.0.1:8787/", {
        request: async () => {
          requests += 1;
          return { status: 200, headers: {}, body: "secret" };
        },
      }),
    ).rejects.toThrow("127.0.0.1");
    expect(requests).toBe(0);
  });

  test("denies a hostname when any DNS answer is private", async () => {
    let requests = 0;
    const reason = await blockedFetchReasonAsync(
      "https://rebind.example.test/path",
      async () => [{ address: "203.0.113.10" }, { address: "127.0.0.1" }],
    );
    expect(reason).toContain("127.0.0.1");
    await expect(
      guardedWebFetch("https://rebind.example.test/path", {
        resolve: async () => [
          { address: "203.0.113.10" },
          { address: "127.0.0.1" },
        ],
        request: async () => {
          requests += 1;
          return { status: 200, headers: {}, body: "secret" };
        },
      }),
    ).rejects.toThrow("127.0.0.1");
    expect(requests).toBe(0);
  });

  test("denies a hostname when an AAAA answer is private", async () => {
    await expect(
      blockedFetchReasonAsync(
        "https://ipv6-rebind.example.test/path",
        async () => [
          { address: "2001:db8::10" },
          { address: "fc00::1" },
        ],
      ),
    ).resolves.toContain("fc00::1");
  });

  test("allows a hostname only when every DNS answer is public", async () => {
    await expect(
      blockedFetchReasonAsync(
        "https://public.example.test/path",
        async () => [{ address: "203.0.113.10" }, { address: "198.51.100.20" }],
      ),
    ).resolves.toBeNull();
  });

  test("applies the same policy to redirect destinations", async () => {
    const reason = await blockedRedirectReason(
      "http://metadata.example.test/latest",
      async () => [{ address: "169.254.169.254" }],
    );
    expect(reason).toContain("169.254.169.254");
  });

  test("guarded fetch validates a redirect before following it", async () => {
    const requested: string[] = [];
    await expect(
      guardedWebFetch("https://public.example.test/start", {
        resolve: async (host) =>
          host === "public.example.test"
            ? [{ address: "203.0.113.10" }]
            : [{ address: "169.254.169.254" }],
        request: async (url) => {
          requested.push(url.href);
          return {
            status: 302,
            headers: { location: "http://metadata.example.test/latest" },
            body: "",
          };
        },
      }),
    ).rejects.toThrow("169.254.169.254");
    expect(requested).toEqual(["https://public.example.test/start"]);
  });

  test("async SDK hook denies DNS rebinding input", async () => {
    const original = globalThis.fetch;
    // The resolver is injected at the policy layer; this test only asserts the
    // hook retains the same deny shape for a direct private literal.
    expect(original).toBeDefined();
    const out = await webFetchGuardHookAsync({
      tool_name: "WebFetch",
      tool_input: { url: "http://127.0.0.1:8787/" },
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
