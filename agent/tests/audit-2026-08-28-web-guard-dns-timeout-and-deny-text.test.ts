/**
 * Аудит 2026-08-28 — `agent/lib/sdk-web-guard.ts`.
 *
 * F1. Потолок на резолв не применялся НИ НА ОДНОМ прод-пути. `DNS_TIMEOUT_MS`
 *     и `withTimeout` жили только в `blockedFetchReasonResolved`, у которого
 *     прод-вызовов нет: PreToolUse-хук — `webFetchGuardHookAsync`
 *     (`agent-sdk-runtime.ts:660`), загрузка — `guardedWebFetch`, и оба звали
 *     голый `dnsLookup`. У него таймаута нет вообще, потолок держит только
 *     системный резолвер (десятки секунд), и так на каждый из 11 возможных
 *     хопов редиректа. При этом `dns.lookup` блокирует слот libuv-пула (4 по
 *     умолчанию) в том же процессе, где 12 ботов и HTTP Mini App.
 *
 * F2. Ответ больше 5 МБ рвался через `req.destroy(new Error(...))`, а этот
 *     Error пропадал: ответ уже шёл, поэтому первым срабатывал `aborted` на
 *     ответе. Промис отклонялся строкой `aborted` — ни модель, ни
 *     `agent_actions` не узнавали, что упёрлись в лимит размера.
 *
 * F3. Текст отказа был один на все причины и утверждал, что адрес подсунули в
 *     переписке или во вложении ради кражи внутренних данных. Тот же текст
 *     уходил модели на пустой `tool_input.url` и на разовый сбой DNS по
 *     публичному домену.
 */
import { describe, expect, test } from "bun:test";
import * as http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DNS_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  blockedFetchReasonAsync,
  blockedRedirectReason,
  guardedWebFetch,
  pinnedRequest,
  webFetchGuardHook,
  webFetchGuardHookAsync,
} from "../lib/sdk-web-guard.ts";

/** Резолвер, который не отвечает никогда — «блэкхол» вместо nameserver-а. */
const HANGS = () => new Promise<Array<{ address: string }>>(() => {});

type Deny = {
  hookSpecificOutput: {
    permissionDecision: string;
    permissionDecisionReason: string;
  };
};

describe("F1 — потолок на резолв на прод-пути", () => {
  test("blockedFetchReasonAsync не висит на мёртвом резолвере", async () => {
    const t0 = Date.now();
    const reason = await blockedFetchReasonAsync(
      "https://example.com/x",
      HANGS,
      40,
    );
    const spent = Date.now() - t0;
    expect(reason).toContain("не разрешается через DNS");
    // Причина называет именно таймаут, а не «имени нет»: иначе оператор чинит
    // не то — DNS-запись на месте, лежит резолвер.
    expect(reason).toContain("резолв дольше");
    expect(spent).toBeLessThan(2_000);
  });

  test("отказ по таймауту — fail-closed, не «пустили внутрь»", async () => {
    expect(await blockedFetchReasonAsync("http://example.com/", HANGS, 30))
      .not.toBeNull();
    expect(await blockedRedirectReason("http://example.com/", HANGS, 30))
      .not.toBeNull();
  });

  test("guardedWebFetch не висит на мёртвом резолвере", async () => {
    const t0 = Date.now();
    let msg = "";
    try {
      await guardedWebFetch("https://example.com/", {
        resolve: HANGS,
        request: async () => {
          throw new Error("до сокета дойти не должны");
        },
        totalTimeoutMs: 60,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("WebFetch blocked");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("литерал адреса резолвер не дёргает вовсе", async () => {
    // Иначе один потолок множился бы на каждый хоп там, где DNS не нужен.
    let called = 0;
    const reason = await blockedFetchReasonAsync(
      "http://93.184.216.34/",
      async () => {
        called += 1;
        return [{ address: "93.184.216.34" }];
      },
      40,
    );
    expect(reason).toBeNull();
    expect(called).toBe(0);
  });

  test("потолок реально навешен на прод-резолв (source guard)", async () => {
    // Проверка текстом: сам вызов `defaultPublicAddressResolver` подменить
    // нечем, а именно он ходит в сеть из хука и из загрузки.
    const src = readFileSync(
      join(import.meta.dir, "../lib/sdk-web-guard.ts"),
      "utf8",
    );
    expect(src).toContain("withTimeout(resolve(host)");
    expect(src).not.toContain("addresses = await resolve(host);");
    expect(DNS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DNS_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("F2 — ответ сверх лимита называет причину", () => {
  async function serveBytes(total: number) {
    const CHUNK = Buffer.alloc(256 * 1024, 0x61);
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      let sent = 0;
      const push = () => {
        while (sent < total) {
          const n = Math.min(CHUNK.length, total - sent);
          sent += n;
          if (!res.write(CHUNK.subarray(0, n))) {
            res.once("drain", push);
            return;
          }
        }
        res.end();
      };
      push();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    return { srv, port: (srv.address() as { port: number }).port };
  }

  test("больше MAX_RESPONSE_BYTES — «too large», а не «aborted»/«timed out»", async () => {
    const { srv, port } = await serveBytes(MAX_RESPONSE_BYTES + 512 * 1024);
    try {
      const t0 = Date.now();
      let msg = "";
      try {
        await pinnedRequest(
          new URL(`http://127.0.0.1:${port}/big`),
          "127.0.0.1",
          { timeoutMs: 8_000 },
        );
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toBe("WebFetch response too large");
      // И промис закрывается сразу, а не по дедлайну.
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      srv.close();
    }
  }, 20_000);

  test("ответ в пределах лимита по-прежнему приезжает целиком", async () => {
    const { srv, port } = await serveBytes(64 * 1024);
    try {
      const out = await pinnedRequest(
        new URL(`http://127.0.0.1:${port}/ok`),
        "127.0.0.1",
        { timeoutMs: 8_000 },
      );
      expect(out.status).toBe(200);
      expect(out.body.length).toBe(64 * 1024);
    } finally {
      srv.close();
    }
  }, 20_000);
});

describe("F3 — обвинение в инъекции только по политике адресов", () => {
  test("внутренний адрес — прежний текст про переписку и вложение", async () => {
    const out = (await webFetchGuardHookAsync({
      tool_name: "mcp__team__WebFetch",
      tool_input: { url: "http://127.0.0.1:8787/api/agents" },
    })) as Deny;
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("вложении");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("127.0.0.1");
  });

  test("внутренний суффикс — тоже про инъекцию", async () => {
    const out = (await webFetchGuardHookAsync({
      tool_name: "mcp__team__WebFetch",
      tool_input: { url: "http://vps.internal/secrets" },
    })) as Deny;
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("вложении");
  });

  test("пустой url — отказ без обвинения в инъекции", async () => {
    const out = (await webFetchGuardHookAsync({
      tool_name: "mcp__team__WebFetch",
      tool_input: {},
    })) as Deny;
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("url не строка");
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain("вложении");
  });

  test("неразбираемый url — отказ без обвинения в инъекции", async () => {
    const out = (await webFetchGuardHookAsync({
      tool_name: "mcp__team__WebFetch",
      tool_input: { url: "http://[oops" },
    })) as Deny;
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain("вложении");
  });

  test("сбой DNS по публичному домену — отказ без обвинения в инъекции", async () => {
    const out = (await webFetchGuardHook(
      {
        tool_name: "mcp__team__WebFetch",
        tool_input: { url: "https://docs.anthropic.com/ru/docs" },
      },
      {
        lookup: async () => {
          throw new Error("EAI_AGAIN");
        },
      },
    )) as Deny;
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("docs.anthropic.com");
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain("вложении");
  });

  test("wildcard-DNS в loopback — по-прежнему про инъекцию", async () => {
    const out = (await webFetchGuardHook(
      {
        tool_name: "mcp__team__WebFetch",
        tool_input: { url: "http://127.0.0.1.nip.io:8787/api" },
      },
      { lookup: async () => ["127.0.0.1"] },
    )) as Deny;
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("вложении");
  });

  test("публичный адрес хук пропускает", async () => {
    expect(
      await webFetchGuardHookAsync({
        tool_name: "mcp__team__WebFetch",
        tool_input: { url: "http://93.184.216.34/" },
      }),
    ).toEqual({});
  });
});
