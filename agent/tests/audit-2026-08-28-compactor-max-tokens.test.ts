/**
 * Аудит 2026-08-28: raw-путь компактора обрывал собственный ответ по лимиту.
 *
 * SYSTEM компактора прямо приглашает модель вернуть
 * `"content": "<markdown до 800 символов>"` плюс заголовок до 120 символов и
 * НЕ ограничивает число ops в батче — а вызов уходил с литералом
 * `max_tokens: 600`. Две page-op — это уже ~1840 символов кириллицы, заметно
 * больше 600 токенов. Ответ обрывался на полуслове, `extractJSON`/`JSON.parse`
 * падали, прогон уходил в ветку «bad JSON, skip», и вся память хода терялась.
 *
 * Хуже потери — неотличимость: `stop_reason` никто не читал, поэтому обрезка
 * по лимиту в журнале выглядела ровно как кривой ответ модели. Ищешь баг в
 * промпте, а он в одной цифре.
 *
 * Затронут только raw-путь: в SDK-ветке компактор идёт через
 * `runTextViaAgentSdk` вообще без потолка токенов, а прод крутится на
 * `USE_AGENT_SDK=true`. То есть это дефект фолбэка — того самого, который
 * включается, когда основной путь уже сломан.
 *
 * Клиент подменяем параметром: `callAnthropic(params, override, agentKey)`
 * принимает готовый Anthropic, поэтому `mock.module` (запрещённый в этом
 * наборе — см. handoff-budget-per-turn.test.ts) не нужен.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { runCompactor, _compactorInternals } from "../lib/compactor.ts";

const { COMPACTOR_MAX_TOKENS, MAX_PAGE_CONTENT, MAX_TITLE, SYSTEM } =
  _compactorInternals;

const SRC = readFileSync(
  new URL("../lib/compactor.ts", import.meta.url),
  "utf8",
);

type Call = Anthropic.MessageCreateParamsNonStreaming;

/** Клиент, который отдаёт заданный ответ и запоминает параметры вызова. */
function fakeClient(
  text: string,
  stopReason: Anthropic.Message["stop_reason"],
): { client: Anthropic; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    messages: {
      create: async (params: Call) => {
        calls.push(params);
        return {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [{ type: "text", text }],
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const CTX = {
  agentKey: "backend",
  chatId: "-1000900",
  userText: "какой у нас потолок на страницу вики",
  // Короче 30 символов компактор пропускает молча — держим длиннее.
  agentReply:
    "Потолок страницы 12000 символов, режется скользящим окном по секциям.",
  recentContext: "—",
};

let logged: string[] = [];
let origLog: typeof console.log;
let envSnapshot: string | undefined;
let envHad = false;

beforeEach(() => {
  logged = [];
  origLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  };
  envHad = "USE_AGENT_SDK" in process.env;
  envSnapshot = process.env.USE_AGENT_SDK;
  // Явно гасим SDK-ветку: иначе тест ушёл бы поднимать CLI.
  process.env.USE_AGENT_SDK = "false";
});

afterEach(() => {
  console.log = origLog;
  if (envHad) process.env.USE_AGENT_SDK = envSnapshot as string;
  else delete process.env.USE_AGENT_SDK;
});

/** Все строки журнала одной склейкой — искать подстроку удобнее. */
function journal(): string {
  return logged.join("\n");
}

describe("потолок ответа", () => {
  test("в запрос уходит COMPACTOR_MAX_TOKENS, а не прежние 600", async () => {
    const { client, calls } = fakeClient('{"ops":[{"op":"noop"}]}', "end_turn");
    await runCompactor(client, CTX);
    expect(calls).toHaveLength(1);
    expect(calls[0].max_tokens).toBe(COMPACTOR_MAX_TOKENS);
    expect(calls[0].max_tokens).not.toBe(600);
  });

  test("потолок покрывает то, что разрешает нормализация", () => {
    // Кириллица — примерно 1 токен на 1.5 символа. Одна page-op после clip
    // это MAX_PAGE_CONTENT + MAX_TITLE символов плюс JSON-обвязка; батч из
    // трёх должен пролезать, иначе мы просто передвинули обрыв.
    const perOpChars = MAX_PAGE_CONTENT + MAX_TITLE + 120;
    const perOpTokens = Math.ceil(perOpChars / 1.5);
    expect(COMPACTOR_MAX_TOKENS).toBeGreaterThanOrEqual(perOpTokens * 3);
  });

  test("SYSTEM всё ещё приглашает 800 символов — цифры не разъехались", () => {
    // Если потолок в промпте поменяют, а константу забудут — тест упадёт
    // здесь, а не в проде через тихую потерю памяти.
    expect(SYSTEM).toContain("800");
    expect(MAX_PAGE_CONTENT).toBe(800);
  });

  test("литерала max_tokens: 600 в исходнике не осталось", () => {
    expect(SRC).not.toContain("max_tokens: 600");
    expect(SRC).toContain("max_tokens: COMPACTOR_MAX_TOKENS,");
  });

  test("константа экспортирована для тестов", () => {
    expect(typeof COMPACTOR_MAX_TOKENS).toBe("number");
    expect(Number.isInteger(COMPACTOR_MAX_TOKENS)).toBe(true);
  });
});

describe("диагностика обрыва", () => {
  test("stop_reason=max_tokens логируется отдельной строкой", async () => {
    // Реальная форма обрыва: объект не закрылся.
    const { client } = fakeClient(
      '{"ops":[{"op":"upsert_team_page","slug":"x","title":"X","content":"длинн',
      "max_tokens",
    );
    await runCompactor(client, CTX);
    const j = journal();
    expect(j).toContain("обрезан по max_tokens");
    expect(j).toContain("backend");
  });

  test("обрыв не подменяет собой прежний путь — обе строки на месте", async () => {
    const { client } = fakeClient('{"ops":[{"op":"team_log","line":"длинн', "max_tokens");
    await runCompactor(client, CTX);
    const j = journal();
    // Диагноз (почему) и последствие (что потеряли) должны читаться вместе.
    expect(j).toContain("обрезан по max_tokens");
    expect(j).toContain("[compactor]");
    expect(j).toMatch(/no JSON in reply|bad JSON/);
  });

  test("нормальный ответ такой строки не даёт", async () => {
    const { client } = fakeClient('{"ops":[{"op":"noop"}]}', "end_turn");
    await runCompactor(client, CTX);
    expect(journal()).not.toContain("обрезан по max_tokens");
  });

  test("stop_reason=null (форма без поля) ничего не ломает", async () => {
    // Не все клиенты/прокси отдают stop_reason — проверка не должна падать.
    const { client } = fakeClient('{"ops":[{"op":"noop"}]}', null);
    await expect(runCompactor(client, CTX)).resolves.toBeUndefined();
    expect(journal()).not.toContain("обрезан по max_tokens");
  });

  test("проверка стоит ДО разбора JSON", () => {
    // Иначе на обрыве мы бы выходили по `return` из ветки no-JSON и
    // причину так и не записали.
    const iStop = SRC.indexOf('completion.stop_reason === "max_tokens"');
    const iParse = SRC.indexOf("const json = extractJSON(text);");
    expect(iStop).toBeGreaterThan(-1);
    expect(iParse).toBeGreaterThan(-1);
    expect(iStop).toBeLessThan(iParse);
  });
});

describe("границы правки", () => {
  test("SDK-ветка потолком токенов не обзавелась", () => {
    // runTextViaAgentSdk вызывается без max_tokens — там лимита нет и не было.
    const sdkCall = SRC.slice(
      SRC.indexOf("runTextViaAgentSdk({"),
      SRC.indexOf('agentKey: "_compactor",') + 40,
    );
    expect(sdkCall).not.toContain("max_tokens");
  });

  test("MAX_TITLE не трогали", () => {
    expect(MAX_TITLE).toBe(120);
  });
});
