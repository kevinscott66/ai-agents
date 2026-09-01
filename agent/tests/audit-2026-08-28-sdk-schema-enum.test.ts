/**
 * Аудит 2026-08-28: SDK-путь терял `enum` из tool-схем.
 *
 * Raw-путь отдаёт модели `input_schema` как есть, а SDK-путь пересобирает схему
 * в zod (`propToZod`) — и всякий `enum: [...]` схлопывался в `z.string()`. На
 * проде USE_AGENT_SDK=true, то есть модель не видела допустимых значений ни в
 * одном из пятнадцати мест: ROLE_KEYS у ASSIGN_TASK/DELEGATE_TO_ROLE/GET_LOGS,
 * TASK_STATUSES у UPDATE_TASK_STATUS, roles у SPLIT_TASK и CREATE_TEAM_CHANNEL,
 * size/quality/background у GENERATE_IMAGE, режим разрешений у MAC_RUN_CLAUDE.
 * Угадать ROLE_KEYS нельзя, а промах ронял делегирование ходом позже — и без
 * подсказки, чем заменить.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTeamMcp } from "../lib/agent-sdk-runtime.ts";
import { TOOLS } from "../lib/tools-schema.ts";

const SRC = readFileSync(join(import.meta.dir, "../lib/agent-sdk-runtime.ts"), "utf-8");

const AGENT = "orchestrator";
const CHAT = -1_000_812;

/** Схемы тулзов так, как их увидит CLI. */
function schemas(names: string[]): Map<string, Record<string, any>> {
  const opts = { agentKey: AGENT, chatId: CHAT, allowedTools: names } as never;
  const ctx = { agentKey: AGENT, chatId: CHAT } as never;
  const built = buildTeamMcp(opts, ctx);
  return new Map(
    (built.tools as any[]).map((t) => [t.name as string, t.inputSchema as Record<string, any>]),
  );
}

function field(tool: string, name: string): any {
  const s = schemas([tool]).get(tool);
  expect(s, `тул ${tool} не собрался`).toBeTruthy();
  const f = s![name];
  expect(f, `поле ${tool}.${name} не собралось`).toBeTruthy();
  return f;
}

describe("enum доезжает до модели", () => {
  test("ASSIGN_TASK.assignedTo принимает роль и отбивает не-роль", () => {
    const f = field("ASSIGN_TASK", "assignedTo");
    expect(f.safeParse("backend").success).toBe(true);
    expect(f.safeParse("designer").success).toBe(false);
    expect(f.safeParse("").success).toBe(false);
  });

  test("UPDATE_TASK_STATUS.status ограничен FSM", () => {
    const f = field("UPDATE_TASK_STATUS", "status");
    expect(f.safeParse("done").success).toBe(true);
    expect(f.safeParse("finished").success).toBe(false);
  });

  test("GENERATE_IMAGE.size/quality/background — необязательные, но перечисленные", () => {
    const s = schemas(["GENERATE_IMAGE"]).get("GENERATE_IMAGE")!;
    expect(s.size.safeParse(undefined).success).toBe(true);
    expect(s.size.safeParse("1024x1536").success).toBe(true);
    expect(s.size.safeParse("2048x2048").success).toBe(false);
    expect(s.quality.safeParse("high").success).toBe(true);
    expect(s.quality.safeParse("ultra").success).toBe(false);
    expect(s.background.safeParse("transparent").success).toBe(true);
    expect(s.background.safeParse("blurred").success).toBe(false);
  });

  test("MAC_RUN_CLAUDE.mode — только объявленные режимы разрешений", () => {
    const f = field("MAC_RUN_CLAUDE", "mode");
    expect(f.safeParse("plan").success).toBe(true);
    expect(f.safeParse("bypass").success).toBe(true);
    expect(f.safeParse("yolo").success).toBe(false);
  });

  test("enum внутри array items тоже доезжает (SPLIT_TASK.roles)", () => {
    const f = field("SPLIT_TASK", "roles");
    expect(f.safeParse(["backend", "qa"]).success).toBe(true);
    expect(f.safeParse(["backend", "designer"]).success).toBe(false);
  });

  test("GET_LOGS: и роль, и статус ограничены списком", () => {
    const s = schemas(["GET_LOGS"]).get("GET_LOGS")!;
    expect(s.agentKey.safeParse("design").success).toBe(true);
    expect(s.agentKey.safeParse("designer").success).toBe(false);
    expect(s.status.safeParse("error").success).toBe(true);
    expect(s.status.safeParse("failed").success).toBe(false);
  });

  test("поля без enum остались свободными строками", () => {
    const f = field("ASSIGN_TASK", "taskId");
    expect(f.safeParse("T-123").success).toBe(true);
    expect(f.safeParse("что угодно").success).toBe(true);
  });

  test("обязательность полей не поехала: required без enum и с enum", () => {
    const s = schemas(["UPDATE_TASK_STATUS"]).get("UPDATE_TASK_STATUS")!;
    expect(s.status.safeParse(undefined).success).toBe(false);
    expect(s.output.safeParse(undefined).success).toBe(true);
  });
});

describe("охранители", () => {
  test("каждое enum-поле схем действительно ограничено в zod", () => {
    // Полный обход: пропуск нового enum-а в схеме больше не пройдёт молча.
    const names = TOOLS.map((t) => t.name);
    const built = schemas(names);
    let checked = 0;
    for (const t of TOOLS) {
      const props = ((t.input_schema as any)?.properties ?? {}) as Record<string, any>;
      const shape = built.get(t.name);
      if (!shape) continue;
      for (const [k, v] of Object.entries(props)) {
        const list: string[] | undefined =
          Array.isArray(v?.enum) ? v.enum : Array.isArray(v?.items?.enum) ? v.items.enum : undefined;
        if (!list?.length || !shape[k]) continue;
        const bad = `__не-из-списка-${k}__`;
        const probe = Array.isArray(v?.items?.enum) ? [bad] : bad;
        expect(shape[k].safeParse(probe).success, `${t.name}.${k} принял «${bad}»`).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  test("enum читается отдельным хелпером, а не размазан по propToZod", () => {
    expect(SRC).toContain("function enumValues(prop: any): string[] | null");
    expect(SRC).toContain("const values = enumValues(prop);");
  });
});
