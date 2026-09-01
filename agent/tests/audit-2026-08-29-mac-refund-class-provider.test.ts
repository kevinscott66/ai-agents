/**
 * Аудит 2026-08-29: три находки на диспатче MAC_RUN_CLAUDE и SPAWN_ROLE.
 *
 * 1. `handleMacRunClaude` возвращал слот рейт-лимита за провал, который УЖЕ
 *    написал в чат. Финальное сообщение (`[mac][done]` / `[mac][fail]` плюс
 *    хвост вывода) отправляется безусловно, а провал возвращался голым
 *    `{ok:false}` без `sideEffect`. В `action-dispatch.ts` рефанд снимается
 *    только флагом (`if (res.sideEffect) refundNeeded = false;`), а
 *    MAC_RUN_CLAUDE не входит в `NO_REFUND_ACTIONS` — то есть слот честно
 *    возвращался. Это ровно тот случай, который комментарий там запрещает.
 *
 *    Важно не спутать с уже благословлённым таймаутом: все транспортные
 *    отказы моста (`mac_offline`, `mac_busy`, `mac_send_dropped`,
 *    `mac_timeout`) РЕЖЕКТЯТ промис и уходят в catch ДО отправки — их рефанд
 *    правильный, и `rate-limits.ts` про него написано отдельно. Резолв с
 *    `ok:false` — это ответ демона: `project_not_allowed`, `spawn_failed`,
 *    ненулевой код выхода CLI. Каждый уже оставил след в чате.
 *
 *    Сценарий: `MAC_AUTONOMOUS=true`, оркестратор просит путь вне `MAC_ROOTS`.
 *    Каждая попытка пишет в чат `[mac][fail] project_not_allowed …` и
 *    возвращает слот. Модель видит провал, повторяет, лимит не убывает.
 *
 * 2. `parseDeniedPatterns` резал CSV, не зная про классы символов. Запятая
 *    внутри `[…]` считалась разделителем, а `{` внутри класса — открытием
 *    квантификатора. `rm\s+-[rf,]+,sudo` распадался на `rm\s+-[rf`, `]+`,
 *    `sudo`; первый огрызок не компилируется, и денилист закрывался целиком —
 *    каждый MAC_RUN_CLAUDE отвечал «некорректный шаблон» с текстом, которого
 *    в конфиге нет. `echo\s+[{]` вместо этого ронял разбор на `depth > 0`.
 *
 *    Это отказ, а не обход: любое деление класса пополам оставляет незакрытую
 *    `[`, то есть fail-closed. Цена — MAC_RUN_CLAUDE мёртв, и диагностика
 *    уводит в сторону («у меня сломана регулярка»), пока кто-нибудь не
 *    перечитает сплиттер. `.env.example` при этом прямо приглашает писать
 *    настоящие регулярки: «CSV РЕГУЛЯРОК (не подстрок)».
 *
 * 3. `handleSpawnRole` брал провайдера через `??`, а он пропускает пустую
 *    строку. `SPAWN_ROLE_PROVIDER=` в .env — обычный способ снять значение,
 *    которое .env.example показывает как `internal`. Пустая строка доезжала до
 *    `selectRoleProvider`, там `String("").trim()` не входит в `ROLE_PROVIDERS`
 *    и бросается `unknown provider` — вместо дефолта. Действие сейчас не
 *    подключено (`DISPATCH_ONLY_ACTIONS`, вызывающего нет), так что это спящий
 *    дефект, но исполнитель у него живой: `orchestrator-team.ts` поднимает
 *    воркер очереди ролей. Тот же дефект уже чинили в `miniapp-entry.ts`.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { handleMacRunClaude, parseDeniedPatterns, type MacBridge } from "../lib/dispatch/mac.ts";
import { handleSpawnRole } from "../lib/dispatch/spawn-role.ts";
import type { RoleQueueItem } from "../lib/role-runtime.ts";

const DENY_ENV = "MAC_DENIED_PROMPT_PATTERNS";
const PROVIDER_ENV = "SPAWN_ROLE_PROVIDER";

const savedDeny = process.env[DENY_ENV];
const savedProvider = process.env[PROVIDER_ENV];

afterEach(() => {
  if (savedDeny === undefined) delete process.env[DENY_ENV];
  else process.env[DENY_ENV] = savedDeny;
  if (savedProvider === undefined) delete process.env[PROVIDER_ENV];
  else process.env[PROVIDER_ENV] = savedProvider;
});

const PAYLOAD = {
  project: "/tmp/x",
  prompt: "hi",
  mode: "ask" as const,
  _userId: "42",
};

function bridgeWith(over: Partial<MacBridge>): MacBridge {
  return {
    isMacConnected: () => true,
    isMacOnline: () => true,
    sendToMac: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    stopMac: async () => ({ ok: true }),
    isUserAllowed: () => true,
    ...over,
  } as MacBridge;
}

/** Телеграм-заглушка, считающая отправки. */
function fakeTg() {
  const sent: string[] = [];
  return {
    sent,
    tg: {
      sendMessage: async (_chatId: unknown, text: string) => {
        sent.push(String(text));
        return { message_id: sent.length };
      },
    },
  };
}

describe("провал MAC_RUN_CLAUDE после сообщения в чат не рефандится", () => {
  test("демон ответил ok:false — наружу уходит sideEffect", async () => {
    const { tg, sent } = fakeTg();
    const res = await handleMacRunClaude(PAYLOAD as any, {
      agentKey: "backend",
      chatId: -1,
      telegram: tg as any,
      macBridge: bridgeWith({
        sendToMac: async () => ({
          ok: false,
          code: 1,
          stdout: "",
          stderr: "",
          error: "project_not_allowed: /etc",
        }),
      }),
    });
    expect(res.ok).toBe(false);
    // Сообщение действительно ушло — значит след снаружи есть.
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("[mac][fail]");
    // До фикса здесь было undefined, и слот лимита возвращался.
    expect((res as { sideEffect?: boolean }).sideEffect).toBe(true);
  });

  test("ненулевой код выхода CLI — тоже след снаружи", async () => {
    const { tg, sent } = fakeTg();
    const res = await handleMacRunClaude(PAYLOAD as any, {
      agentKey: "backend",
      chatId: -1,
      telegram: tg as any,
      macBridge: bridgeWith({
        sendToMac: async () => ({
          ok: false,
          code: 1,
          stdout: "tests failed",
          stderr: "",
        }),
      }),
    });
    expect(res.ok).toBe(false);
    expect(sent.length).toBe(1);
    expect((res as { sideEffect?: boolean }).sideEffect).toBe(true);
  });

  test("без telegram-контекста флага нет — рефанд по-прежнему уместен", async () => {
    const res = await handleMacRunClaude(PAYLOAD as any, {
      agentKey: "backend",
      chatId: -1,
      macBridge: bridgeWith({
        sendToMac: async () => ({
          ok: false,
          code: 1,
          stdout: "",
          stderr: "",
          error: "spawn_failed",
        }),
      }),
    });
    expect(res.ok).toBe(false);
    expect((res as { sideEffect?: boolean }).sideEffect).toBeUndefined();
  });

  test("отправка упала — следа нет, флага нет", async () => {
    const res = await handleMacRunClaude(PAYLOAD as any, {
      agentKey: "backend",
      chatId: -1,
      telegram: {
        sendMessage: async () => {
          throw new Error("chat not found");
        },
      } as any,
      macBridge: bridgeWith({
        sendToMac: async () => ({ ok: false, code: 1, stdout: "", stderr: "" }),
      }),
    });
    expect(res.ok).toBe(false);
    expect((res as { sideEffect?: boolean }).sideEffect).toBeUndefined();
  });

  test("контроль: таймаут моста режектит ДО отправки — рефанд остаётся", async () => {
    const { tg, sent } = fakeTg();
    const res = await handleMacRunClaude(PAYLOAD as any, {
      agentKey: "backend",
      chatId: -1,
      telegram: tg as any,
      macBridge: bridgeWith({
        sendToMac: async () => {
          throw new Error("mac_timeout");
        },
      }),
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("mac_timeout");
    expect(sent.length).toBe(0);
    expect((res as { sideEffect?: boolean }).sideEffect).toBeUndefined();
  });

  test("контроль: успешный прогон не обзавёлся лишним полем", async () => {
    const { tg, sent } = fakeTg();
    const res = await handleMacRunClaude(PAYLOAD as any, {
      agentKey: "backend",
      chatId: -1,
      telegram: tg as any,
      macBridge: bridgeWith({}),
    });
    expect(res.ok).toBe(true);
    expect(sent[0]).toContain("[mac][done]");
    expect((res as { sideEffect?: boolean }).sideEffect).toBeUndefined();
  });
});

describe("parseDeniedPatterns знает про классы символов", () => {
  test("запятая внутри [...] не делит правило", () => {
    const out = parseDeniedPatterns(String.raw`rm\s+-[rf,]+,sudo`);
    expect(out).toEqual([String.raw`rm\s+-[rf,]+`, "sudo"]);
    // И оба огрызка теперь настоящие правила: компилируются и работают.
    expect(new RegExp(out[0]!).test("rm -rf /")).toBe(true);
    expect(new RegExp(out[1]!).test("sudo reboot")).toBe(true);
  });

  test("фигурная скобка внутри класса не открывает квантификатор", () => {
    // До фикса это ловил `depth > 0` и разбор падал целиком.
    expect(parseDeniedPatterns(String.raw`echo\s+[{]`)).toEqual([
      String.raw`echo\s+[{]`,
    ]);
  });

  test("незакрытый класс — явная ошибка, а не мусорное правило", () => {
    expect(() => parseDeniedPatterns(String.raw`rm -[rf`)).toThrow(/незакрытая '\['/);
  });

  test("экранированная скобка класса не открывает", () => {
    expect(parseDeniedPatterns(String.raw`a\[,b`)).toEqual([String.raw`a\[`, "b"]);
  });

  test("контроль: квантификатор {n,m} по-прежнему цел", () => {
    expect(parseDeniedPatterns(String.raw`rm\s{1,3}-rf,sudo`)).toEqual([
      String.raw`rm\s{1,3}-rf`,
      "sudo",
    ]);
  });

  test("контроль: незакрытая { по-прежнему ошибка", () => {
    expect(() => parseDeniedPatterns(String.raw`rm\s{1,3-rf,sudo`)).toThrow(
      /незакрытая '\{'/,
    );
  });

  test("сквозь handleMacRunClaude: правило с классом ловит промпт", async () => {
    process.env[DENY_ENV] = String.raw`rm\s+-[rf,]+,sudo`;
    const res = await handleMacRunClaude({ ...PAYLOAD, prompt: "rm -rf /" } as any, {
      agentKey: "backend",
      chatId: -1,
      macBridge: bridgeWith({
        sendToMac: async () => {
          throw new Error("мост не должен вызываться");
        },
      }),
    });
    expect(res.ok).toBe(false);
    // Именно совпадение, а не «денилист не разобрался».
    expect((res as { error: string }).error).toBe(
      "forbidden: prompt matches denied pattern",
    );
  });

  test("сквозь handleMacRunClaude: безобидный промпт доезжает до моста", async () => {
    process.env[DENY_ENV] = String.raw`rm\s+-[rf,]+,sudo`;
    let reached = 0;
    const res = await handleMacRunClaude({ ...PAYLOAD, prompt: "run tests" } as any, {
      agentKey: "backend",
      chatId: -1,
      macBridge: bridgeWith({
        sendToMac: async () => {
          reached++;
          return { ok: true, code: 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(res.ok).toBe(true);
    expect(reached).toBe(1);
  });
});

describe("SPAWN_ROLE: пустой SPAWN_ROLE_PROVIDER — это дефолт, а не ошибка", () => {
  const item: RoleQueueItem = {
    id: "q1",
    taskId: "t1",
    roleSlug: "helper",
    systemPrompt: "sp",
    taskHint: "hint",
    provider: "internal",
    state: "queued",
    chatId: -1,
    createdBy: "orchestrator",
    createdAt: 0,
  };
  const payload = {
    name: "Helper",
    system_prompt: "sp",
    task_hint: "hint",
  };
  const deps = { enqueue: () => item };

  test("SPAWN_ROLE_PROVIDER='' падает в internal", async () => {
    process.env[PROVIDER_ENV] = "";
    const res = await handleSpawnRole(
      payload as any,
      { agentKey: "orchestrator", chatId: -1 },
      deps as any,
    );
    expect(res.ok).toBe(true);
    expect((res as any).result.provider).toBe("internal");
  });

  test("пустой provider в payload тоже падает в internal", async () => {
    delete process.env[PROVIDER_ENV];
    const res = await handleSpawnRole(
      { ...payload, provider: "" } as any,
      { agentKey: "orchestrator", chatId: -1 },
      deps as any,
    );
    expect(res.ok).toBe(true);
    expect((res as any).result.provider).toBe("internal");
  });

  test("контроль: заполненный SPAWN_ROLE_PROVIDER читается как раньше", async () => {
    process.env[PROVIDER_ENV] = "internal";
    const res = await handleSpawnRole(
      payload as any,
      { agentKey: "orchestrator", chatId: -1 },
      deps as any,
    );
    expect(res.ok).toBe(true);
    expect((res as any).result.provider).toBe("internal");
  });

  test("контроль: неизвестный провайдер по-прежнему отклоняется", async () => {
    process.env[PROVIDER_ENV] = "nope";
    const res = await handleSpawnRole(
      payload as any,
      { agentKey: "orchestrator", chatId: -1 },
      deps as any,
    );
    expect(res.ok).toBe(false);
  });
});
