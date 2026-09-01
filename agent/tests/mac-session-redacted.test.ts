/**
 * Аудит 2026-08-12: скрытые от не-админа записи Mac показывались как
 * «Unknown project».
 *
 * Сервер не отдаёт наблюдателю тела действий: redactContent (lib/miniapp-server.ts)
 * заменяет payload/result/error строкой «(скрыто: доступно администратору)» и
 * ставит `redacted: true`. Страница Mac читала payload как объект:
 *
 *   const payload = (action.payload ?? {}) as MacPayload;
 *   project: payload.project || "Unknown project",
 *   prompt: payload.prompt || "",
 *
 * У строки нет поля `project`, поэтому в списке появлялась запись «Unknown
 * project» с пустым промптом — выглядит как порча данных или сломанный бэкенд,
 * хотя это работающее ограничение доступа. Плюс единственная английская
 * строка в русском интерфейсе.
 *
 * Инвариант: скрытая запись подписана причиной, а не подставляется заглушкой
 * «неизвестно»; обычная запись разбирается как раньше.
 */
import { describe, test, expect } from "bun:test";
import {
  toMacSession,
  REDACTED_NOTE,
} from "../miniapp/src/lib/mac-session.ts";
import type { AgentAction } from "../miniapp/src/lib/types.ts";

function action(over: Partial<AgentAction> = {}): AgentAction {
  return {
    id: "a1",
    agent_key: "aieng",
    task_id: null,
    chat_id: -100_1,
    action_type: "MAC_RUN_CLAUDE",
    payload: { project: "ai_agents", mode: "ask", prompt: "почини тесты" },
    status: "ok",
    result: { output: "готово" },
    error: null,
    created_at: 1_770_000_000_000,
    ...over,
  } as AgentAction;
}

describe("toMacSession: скрытые записи", () => {
  test("payload-строка от redactContent не даёт «Unknown project»", () => {
    const s = toMacSession(
      action({ payload: REDACTED_NOTE, result: REDACTED_NOTE } as any),
    );
    expect(s.project).toBe(REDACTED_NOTE);
    expect(s.project).not.toInclude("Unknown");
  });

  test("флаг redacted проставлен — интерфейс может отличить", () => {
    const s = toMacSession(action({ payload: REDACTED_NOTE } as any));
    expect(s.redacted).toBe(true);
  });

  test("промпт скрытой записи пуст, а не обрывок заглушки", () => {
    const s = toMacSession(action({ payload: REDACTED_NOTE } as any));
    expect(s.prompt).toBe("");
  });

  test("обычная запись разбирается как раньше", () => {
    const s = toMacSession(action());
    expect({
      project: s.project,
      mode: s.mode,
      prompt: s.prompt,
      status: s.status,
      redacted: s.redacted,
      output: s.output,
    }).toEqual({
      project: "ai_agents",
      mode: "ask",
      prompt: "почини тесты",
      status: "completed",
      redacted: false,
      output: ["готово"],
    });
  });

  test("статусы переводятся как раньше", () => {
    expect(toMacSession(action({ status: "error" as any })).status).toBe("failed");
    expect(toMacSession(action({ status: "running" as any })).status).toBe(
      "running",
    );
  });

  test("payload без project — русская подпись, а не английская заглушка", () => {
    const s = toMacSession(action({ payload: {} }));
    expect(s.project).not.toInclude("Unknown");
    expect(s.redacted).toBe(false);
  });
});
