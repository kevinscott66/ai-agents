/**
 * Аудит 2026-08-08: кнопка «Пауза» в Mini App была декорацией.
 *
 * POST /api/agents/:key/pause писал agent_states.paused=1, карточка меняла
 * подпись на «paused» — и всё. Флаг читали только сам список агентов и выбор
 * запасного исполнителя в role-skills; гейт действий про него не знал, поэтому
 * поставленный на паузу агент продолжал отвечать в Telegram. UI показывал
 * состояние, которого в системе не существовало.
 *
 * Тесты проверяют именно ГЕЙТ, а не запись флага: пауза должна отклонять
 * действия и сниматься /resume.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  evaluateGate,
  isAgentPaused,
  setAutonomy,
  setPermission,
} from "../lib/permissions.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TARGET = "_test_paused_agent";

function setPaused(agentKey: string, paused: 0 | 1) {
  db.prepare(
    `INSERT INTO agent_states(agent_key, paused, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       paused = excluded.paused,
       updated_at = excluded.updated_at`,
  ).run(agentKey, paused, Date.now());
}

describe("пауза агента — это гейт, а не подпись", () => {
  // Режим автономности гейт берёт из БД, а не из аргумента: поле `autonomy`
  // в GateInput не существует и раньше молча игнорировалось. Ставим режим
  // явно, иначе «иначе разрешено» проверяется при чужом ambient-режиме.
  let savedAutonomy = saveAutonomy();

  afterEach(() => {
    restoreAutonomy(savedAutonomy);
    // `_test_paused_agent` в сиде нет: строки, заведённые тестом, сносим,
    // иначе таблица прав копит несуществующие роли. T-751.
    db.prepare(`DELETE FROM permissions WHERE agent_key = ?`).run(TARGET);
  });

  beforeEach(() => {
    savedAutonomy = saveAutonomy();
    setAutonomy("global", "*", "auto");
    db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run(TARGET);
    setPermission(TARGET, "SEND_MESSAGE", { allowed: true, requires_approval: false });
  });

  test("нет строки → не на паузе", () => {
    expect(isAgentPaused(TARGET)).toBe(false);
  });

  test("paused=1 отклоняет действие, которое иначе разрешено", () => {
    const before = evaluateGate({
      agentKey: TARGET,
      actionType: "SEND_MESSAGE",
    });
    expect(before.decision).not.toBe("deny");

    setPaused(TARGET, 1);
    const after = evaluateGate({
      agentKey: TARGET,
      actionType: "SEND_MESSAGE",
    });
    expect(after).toEqual({ decision: "deny", reason: "agent paused" });
  });

  test("причина отличается от disabled — человеку видно, чем снимать", () => {
    setPaused(TARGET, 1);
    const r = evaluateGate({
      agentKey: TARGET,
      actionType: "SEND_MESSAGE",
    });
    expect((r as { reason: string }).reason).toBe("agent paused");
    expect((r as { reason: string }).reason).not.toBe("agent disabled");
  });

  // Раньше здесь стоял GET_METRICS — он не ActionType, а инлайновый тул: до
  // evaluateGate он не доходит вообще (executeTool замыкает INLINE_TOOL_NAMES
  // раньше gateOrDispatch), так что о паузе тест не проверял ничего. Берём
  // LIST_RECENT_MESSAGES — настоящее read-only действие, идущее через гейт.
  test("readonly-действия на паузе тоже отклоняются — агент замолкает целиком", () => {
    setPermission(TARGET, "LIST_RECENT_MESSAGES", { allowed: true, requires_approval: false });
    setPaused(TARGET, 1);
    const r = evaluateGate({
      agentKey: TARGET,
      actionType: "LIST_RECENT_MESSAGES",
    });
    expect(r.decision).toBe("deny");
  });

  test("resume (paused=0) возвращает агента в строй", () => {
    setPaused(TARGET, 1);
    expect(isAgentPaused(TARGET)).toBe(true);
    setPaused(TARGET, 0);
    expect(isAgentPaused(TARGET)).toBe(false);
    const r = evaluateGate({
      agentKey: TARGET,
      actionType: "SEND_MESSAGE",
    });
    expect(r.decision).not.toBe("deny");
  });

  test("пауза не трогает status — снимать её не нужно через perm", () => {
    setPaused(TARGET, 1);
    const row = db
      .prepare(`SELECT status FROM agent_states WHERE agent_key = ?`)
      .get(TARGET) as { status: string };
    expect(row.status).toBe("active");
  });
});
