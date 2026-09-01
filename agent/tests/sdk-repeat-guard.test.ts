/**
 * Аудит 2026-08-08: на SDK-пути не было анти-зацикливания.
 *
 * У raw-пути есть C12 — «не больше двух вызовов одного инструмента за ход
 * модели» (tool-loop.ts). На SDK-пути такого счётчика не было вовсе, а на проде
 * USE_AGENT_SDK=true: зациклившийся агент мог выполнить SEND_MESSAGE
 * четырнадцать раз подряд (по числу ходов) и высыпать это всё в чат.
 *
 * Порог здесь выше, чем C12, и это осознанно: границ хода модели изнутри
 * MCP-колбэка не видно, поэтому счётчик живёт на весь прогон, а в прогоне до
 * MAX_TOOL_ITERS ходов и в каждом два вызова легальны. Это backstop, а не
 * эквивалент C12.
 *
 * Правка 2026-08-28: «дошло до исполнения» проверяется по ответу самого
 * инструмента, а не по `stats.executed`. Счётчик перестал двигаться на
 * read-only тулзах (SDK_SIDE_EFFECT_FREE_TOOLS) — он отвечает на вопрос
 * «можно ли переигрывать ход», а чтение на него ответа не меняет. GET_LOGS
 * и SEARCH_WIKI здесь как раз такие, поэтому у них ожидается ноль.
 */
// Аудит 2026-08-28: раньше здесь стоял GET_METRICS. Инструмент сузили до
// aieng/orchestrator (телеметрия прода — см. ROLE_EXPOSED_TOOLS), а этому
// файлу нужна просто инлайновая read-only тулза, доступная роли ниже.
import { describe, test, expect } from "bun:test";
import {
  buildTeamMcp,
  SDK_MAX_CALLS_PER_TOOL,
} from "../lib/agent-sdk-runtime.ts";

const AGENT = "backend";
const CHAT = -1_000_811;

function harness() {
  const opts = {
    agentKey: AGENT,
    chatId: CHAT,
    allowedTools: ["GET_LOGS", "SEARCH_WIKI"],
  } as never;
  const ctx = { agentKey: AGENT, chatId: CHAT } as never;
  const built = buildTeamMcp(opts, ctx);
  const byName = new Map(built.tools.map((t) => [t.name, t]));
  return { built, byName };
}

async function callTool(
  t: { handler: (a: never, e: unknown) => Promise<unknown> },
): Promise<{ isError?: boolean; content: { text: string }[] }> {
  return (await t.handler({} as never, {})) as never;
}

describe("SDK anti-loop", () => {
  test("порог задан и заведомо выше C12", () => {
    expect(SDK_MAX_CALLS_PER_TOOL).toBeGreaterThan(2);
    expect(SDK_MAX_CALLS_PER_TOOL).toBeLessThanOrEqual(16);
  });

  test("первые SDK_MAX_CALLS_PER_TOOL вызовов доходят до исполнения", async () => {
    const { built, byName } = harness();
    const t = byName.get("GET_LOGS");
    expect(t).toBeTruthy();
    for (let i = 0; i < SDK_MAX_CALLS_PER_TOOL; i++) {
      const out = await callTool(t as never);
      expect(out.content[0].text).not.toContain("зациклиться");
    }
    // GET_LOGS — чтение: ход после него переигрывать по-прежнему безопасно.
    expect(built.stats.executed).toBe(0);
  });

  test("следующий вызов отбивается — с isError и без побочных эффектов", async () => {
    const { built, byName } = harness();
    const t = byName.get("GET_LOGS") as never;
    for (let i = 0; i < SDK_MAX_CALLS_PER_TOOL; i++) await callTool(t);
    const refused = await callTool(t);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("зациклиться");
    // executed — это флаг «переигрывать ход уже нельзя». Отбитый вызов до
    // executeTool не дошёл, значит и счётчик двигать нечего; чтения до него
    // тоже ничего не изменили.
    expect(built.stats.executed).toBe(0);
  });

  test("счётчик по имени инструмента, а не общий", async () => {
    const { built, byName } = harness();
    const a = byName.get("GET_LOGS") as never;
    const b = byName.get("SEARCH_WIKI") as never;
    expect(b).toBeTruthy();
    for (let i = 0; i < SDK_MAX_CALLS_PER_TOOL; i++) await callTool(a);
    const other = await callTool(b);
    // SEARCH_WIKI без аргументов сам вернёт ok:false — важно, что это ЕГО
    // отказ, а не анти-луп, и что до исполнения дело дошло.
    expect(other.content[0].text).not.toContain("зациклиться");
    expect(built.stats.executed).toBe(0);
  });

  test("счётчик живёт в прогоне: новый buildTeamMcp начинает с нуля", async () => {
    const first = harness();
    const ft = first.byName.get("GET_LOGS") as never;
    for (let i = 0; i <= SDK_MAX_CALLS_PER_TOOL; i++) await callTool(ft);
    const second = harness();
    const st = second.byName.get("GET_LOGS") as never;
    const fresh = await callTool(st);
    expect(fresh.content[0].text).not.toContain("зациклиться");
    expect(second.built.stats.executed).toBe(0);
  });
});
