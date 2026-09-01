/**
 * Аудит 2026-08-20: SSRF-гейт смотрел только на ТЕКСТ хоста.
 *
 * `blockedFetchReason` отказывала, если хост разбирался как приватный
 * IP-литерал или заканчивался на один из INTERNAL_SUFFIXES. Любое публичное
 * DNS-имя, которое отдаёт приватный адрес, проходило насквозь:
 *
 *   ALLOW  http://127.0.0.1.nip.io:8787/api/agents
 *   ALLOW  http://127-0-0-1.nip.io:8787/api/agents
 *   ALLOW  http://localtest.me:8787/
 *   ALLOW  https://169.254.169.254.nip.io/latest/meta-data/
 *   block  http://127.0.0.1:8787/api/agents        ← только литерал и ловился
 *
 * Список суффиксов эту дыру не закрывает в принципе: имя выбирает атакующий,
 * и владелец любого домена может прописать A-запись на 127.0.0.1 — в имени
 * при этом не будет ни одной цифры (`localtest.me`). Единственная рабочая
 * проверка — резолв.
 *
 * Резолвер здесь всегда подставной: тесты в DNS не ходят.
 */
import { describe, test, expect } from "bun:test";
import {
  blockedFetchReason,
  blockedFetchReasonResolved,
  webFetchGuardHook,
  DNS_TIMEOUT_MS,
  type HostLookup,
} from "../lib/sdk-web-guard.ts";

/** Резолвер по таблице; всё, чего в таблице нет, считается несуществующим. */
function fakeDns(table: Record<string, string[]>): HostLookup {
  return async (host) => {
    const a = table[host];
    if (!a) throw new Error("ENOTFOUND");
    return a;
  };
}

const WILDCARD = fakeDns({
  "127.0.0.1.nip.io": ["127.0.0.1"],
  "127-0-0-1.nip.io": ["127.0.0.1"],
  "localtest.me": ["127.0.0.1"],
  "169.254.169.254.nip.io": ["169.254.169.254"],
  "vps.internal.example": ["10.0.0.5"],
  "v6.example.test": ["::1"],
  "example.com": ["93.184.216.34"],
  "split.example.test": ["93.184.216.34", "127.0.0.1"],
});

describe("wildcard-DNS в обход SSRF-гейта", () => {
  test("публичное имя, отдающее loopback, закрыто", async () => {
    for (const u of [
      "http://127.0.0.1.nip.io:8787/api/agents",
      "http://127-0-0-1.nip.io:8787/api/agents",
      "http://localtest.me:8787/",
    ]) {
      // Текстовая проверка их не видит — это и была дыра.
      expect(blockedFetchReason(u)).toBeNull();
      const reason = await blockedFetchReasonResolved(u, { lookup: WILDCARD });
      expect(reason).not.toBeNull();
      expect(reason).toContain("127.0.0.1");
    }
  });

  test("облачная метадата через wildcard-DNS закрыта", async () => {
    const reason = await blockedFetchReasonResolved(
      "https://169.254.169.254.nip.io/latest/meta-data/",
      { lookup: WILDCARD },
    );
    expect(reason).toContain("169.254.169.254");
  });

  test("имя во внутреннюю сеть и имя в IPv6-loopback закрыты", async () => {
    expect(
      await blockedFetchReasonResolved("https://vps.internal.example/", {
        lookup: WILDCARD,
      }),
    ).toContain("10.0.0.5");
    expect(
      await blockedFetchReasonResolved("https://v6.example.test/", {
        lookup: WILDCARD,
      }),
    ).toContain("::1");
  });

  test("приватный адрес среди нескольких ответов закрывает весь хост", async () => {
    // Атакующий отдаёт две A-записи: публичную «для проверки» и loopback.
    expect(
      await blockedFetchReasonResolved("https://split.example.test/", {
        lookup: WILDCARD,
      }),
    ).toContain("127.0.0.1");
  });

  test("публичное имя с публичным адресом по-прежнему проходит", async () => {
    expect(
      await blockedFetchReasonResolved("https://example.com/docs", {
        lookup: WILDCARD,
      }),
    ).toBeNull();
  });
});

describe("резолв: fail-closed и отсутствие лишних запросов", () => {
  const explode: HostLookup = async () => {
    throw new Error("резолвер не должен вызываться для литерала");
  };

  test("IP-литералы решаются без DNS", async () => {
    // Ни один из этих вызовов не должен дойти до резолвера.
    expect(
      await blockedFetchReasonResolved("http://127.0.0.1:8787/api/agents", {
        lookup: explode,
      }),
    ).toContain("127.0.0.1");
    expect(
      await blockedFetchReasonResolved("http://[::1]/", { lookup: explode }),
    ).not.toBeNull();
    expect(
      await blockedFetchReasonResolved("https://93.184.216.34/", {
        lookup: explode,
      }),
    ).toBeNull();
  });

  test("нерезолвящееся имя — отказ, а не пропуск", async () => {
    const reason = await blockedFetchReasonResolved("https://nowhere.invalid/", {
      lookup: WILDCARD,
    });
    expect(reason).not.toBeNull();
    expect(reason).toContain("nowhere.invalid");
  });

  test("пустой ответ резолвера — отказ", async () => {
    expect(
      await blockedFetchReasonResolved("https://empty.example.test/", {
        lookup: async () => [],
      }),
    ).not.toBeNull();
  });

  test("зависший резолвер не пропускает и не вешает хук", async () => {
    const hang: HostLookup = () => new Promise<string[]>(() => {});
    const started = Date.now();
    const reason = await blockedFetchReasonResolved("https://slow.example.test/", {
      lookup: hang,
      timeoutMs: 20,
    });
    expect(reason).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("потолок резолва — секунды, а не минуты", () => {
    expect(DNS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DNS_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("webFetchGuardHook на wildcard-DNS", () => {
  test("deny с причиной, которая называет инъекцию", async () => {
    const out = (await webFetchGuardHook(
      {
        tool_name: "WebFetch",
        tool_input: { url: "http://127.0.0.1.nip.io:8787/api/agents" },
      },
      { lookup: WILDCARD },
    )) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("127.0.0.1");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("вложении");
  });

  test("публичный адрес хук пропускает", async () => {
    expect(
      await webFetchGuardHook(
        { tool_name: "WebFetch", tool_input: { url: "https://example.com/" } },
        { lookup: WILDCARD },
      ),
    ).toEqual({});
  });
});
