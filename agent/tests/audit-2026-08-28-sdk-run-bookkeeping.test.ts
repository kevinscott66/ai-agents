/**
 * Аудит 2026-08-28: учёт прогона на SDK-пути.
 *
 * (1) `stats.executed` считал ЛЮБОЙ вызов инструмента, включая чтение. От него
 *     зависит `sideEffects` в AgentSdkRunError, а от того — `shouldFallbackToRaw`.
 *     Агент, успевший сделать SEARCH_WIKI и упёршийся в падение CLI, метил ход
 *     как «побочные эффекты уже случились», и переигрывать его на raw-пути
 *     запрещалось. Ответа пользователь не получал там, где безопасный повтор
 *     был прямо доступен, — а чтение почти всегда идёт первым.
 *
 * (2) Инлайновый WebFetch писал аудит без `requestId`, единственный такой на
 *     обоих путях. Строка ложилась в agent_actions с request_id = NULL и
 *     выпадала из связки «один запрос — все его действия», по которой Mini App
 *     и GET_LOGS собирают ход. Ровно та попытка, ради видимости которой аудит
 *     сюда и добавляли (сходить на 169.254.169.254), оказывалась ни к чему не
 *     привязана.
 */
// Аудит 2026-08-28: раньше здесь стоял GET_METRICS. Инструмент сузили до
// aieng/orchestrator (телеметрия прода — см. ROLE_EXPOSED_TOOLS), а этому
// файлу нужна просто инлайновая read-only тулза, доступная роли ниже.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTeamMcp,
  SDK_SIDE_EFFECT_FREE_TOOLS,
  shouldFallbackToRaw,
  AgentSdkRunError,
} from "../lib/agent-sdk-runtime.ts";
import { INLINE_TOOL_NAMES } from "../lib/tools-schema.ts";

const SRC = readFileSync(join(import.meta.dir, "../lib/agent-sdk-runtime.ts"), "utf-8");

const CHAT = -1_000_813;

function harness(agentKey: string, allowedTools: string[]) {
  const opts = { agentKey, chatId: CHAT, allowedTools } as never;
  const ctx = { agentKey, chatId: CHAT, requestId: "req-bookkeeping" } as never;
  const built = buildTeamMcp(opts, ctx);
  const byName = new Map((built.tools as any[]).map((t) => [t.name as string, t]));
  return { built, byName };
}

async function call(t: any, args: Record<string, unknown> = {}): Promise<string> {
  const out = (await t.handler(args as never, {})) as { content: { text: string }[] };
  return out.content[0].text;
}

describe("stats.executed: чтение не запрещает повтор хода", () => {
  test("read-only тулзы счётчик не двигают", async () => {
    const { built, byName } = harness("backend", ["GET_LOGS", "SEARCH_WIKI", "READ_WIKI"]);
    await call(byName.get("GET_LOGS"));
    await call(byName.get("SEARCH_WIKI"), { query: "что-нибудь" });
    await call(byName.get("READ_WIKI"), { path: "нет-такого" });
    expect(built.stats.executed).toBe(0);
  });

  test("меняющая состояние тулза счётчик двигает — даже если отказала", async () => {
    const { built, byName } = harness("backend", ["UPDATE_TASK_STATUS"]);
    const t = byName.get("UPDATE_TASK_STATUS");
    expect(t).toBeTruthy();
    await call(t, { taskId: "T-нет-такой", status: "done" });
    // Считаем ПОПЫТКУ: снаружи не видно, успела ли она дать эффект.
    expect(built.stats.executed).toBe(1);
  });

  test("чтение перед мутацией не маскирует мутацию", async () => {
    const { built, byName } = harness("backend", ["GET_LOGS", "UPDATE_TASK_STATUS"]);
    await call(byName.get("GET_LOGS"));
    expect(built.stats.executed).toBe(0);
    await call(byName.get("UPDATE_TASK_STATUS"), { taskId: "T-нет", status: "failed" });
    expect(built.stats.executed).toBe(1);
  });

  test("ради этого всё и делалось: ход с одним чтением переигрывается", () => {
    const readOnlyRun = new AgentSdkRunError("CLI умер", {
      sideEffects: false,
      partialText: "",
    });
    expect(shouldFallbackToRaw(readOnlyRun)).toBe(true);
    const mutatingRun = new AgentSdkRunError("CLI умер", {
      sideEffects: true,
      partialText: "",
    });
    expect(shouldFallbackToRaw(mutatingRun)).toBe(false);
  });
});

describe("набор безопасных тулзов", () => {
  test("это read-only блок диспатчера минус единственная мутация в нём", () => {
    expect([...SDK_SIDE_EFFECT_FREE_TOOLS].sort()).toEqual(
      [
        "GET_BOT_INFO",
        "GET_CHANNEL_STATS",
        "GET_FIGMA_FILE",
        "GET_GITHUB_STATUS",
        "GET_LOGS",
        "GET_METRICS",
        "GET_PROMPT_HISTORY",
        "QUERY_DB",
        "READ_WIKI",
        "SEARCH_WIKI",
        "LIST_SCHEDULED_POSTS",
      ].sort(),
    );
  });

  test("CANCEL_SCHEDULED_POST в наборе нет, хотя он инлайновый", () => {
    expect(INLINE_TOOL_NAMES.has("CANCEL_SCHEDULED_POST")).toBe(true);
    expect(SDK_SIDE_EFFECT_FREE_TOOLS.has("CANCEL_SCHEDULED_POST")).toBe(false);
  });

  test("ничего лишнего: набор — подмножество INLINE_TOOL_NAMES", () => {
    for (const n of SDK_SIDE_EFFECT_FREE_TOOLS) {
      expect(INLINE_TOOL_NAMES.has(n), `${n} не инлайновый`).toBe(true);
    }
  });

  test("отправляющих и публикующих тулзов там быть не может", () => {
    for (const n of [
      "SEND_MESSAGE",
      "SEND_PHOTO",
      "SEND_DOCUMENT",
      "PUBLISH_TO_CHANNEL",
      "WRITE_WIKI",
      "SCHEDULE_POST",
      "CREATE_TEAM_CHANNEL",
      "MAC_RUN_CLAUDE",
      "DELETE_MESSAGE",
      "DELEGATE_TO_ROLE",
    ]) {
      expect(SDK_SIDE_EFFECT_FREE_TOOLS.has(n), `${n} помечен безопасным`).toBe(false);
    }
  });
});

describe("охранители по исходнику", () => {
  test("аудит WebFetch пишет requestId", () => {
    const block = SRC.slice(SRC.indexOf('logToolCall("WebFetch"'), SRC.length);
    const call = block.slice(0, block.indexOf("});"));
    expect(call).toContain("requestId: ctx.requestId,");
  });

  test("счётчик прикрыт проверкой набора", () => {
    expect(SRC).toContain("if (!SDK_SIDE_EFFECT_FREE_TOOLS.has(t.name)) stats.executed += 1;");
    expect(SRC).not.toContain("\n      stats.executed += 1;");
  });
});
