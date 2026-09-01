/**
 * Аудит 2026-08-09: пауза агента действовала ровно на половину инструментов.
 *
 * `isAgentPaused` во всём проекте читается из одного места — `evaluateGate`
 * (lib/permissions.ts). А инлайновые инструменты executeTool обслуживает сам,
 * замыкаясь ДО `gateOrDispatch`, то есть до гейта они не доходят вовсе.
 * Поставленный на паузу агент продолжал ходить в QUERY_DB (произвольный SELECT
 * по операционной БД), GET_LOGS, GET_PROMPT_HISTORY, а CANCEL_SCHEDULED_POST —
 * это ещё и мутация календаря.
 *
 * Ровно тот же класс, что и раньше в этом аудите: гарантия закрыта на одном
 * входе из двух. Тест проверяет ОБА входа одним и тем же переключателем.
 */
// Аудит 2026-08-28: раньше здесь стоял GET_METRICS. Инструмент сузили до
// aieng/orchestrator (телеметрия прода — см. ROLE_EXPOSED_TOOLS), а этому
// файлу нужна просто инлайновая read-only тулза, доступная роли ниже.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { setAutonomy, setPermission } from "../lib/permissions.ts";
import {
  saveAutonomy,
  restoreAutonomy,
  savePermissions,
} from "./_helpers.ts";

const ROLE = "backend";
const CHAT = -100777;

function setPaused(agentKey: string, paused: 0 | 1) {
  db.prepare(
    `INSERT INTO agent_states(agent_key, paused, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       paused = excluded.paused,
       updated_at = excluded.updated_at`,
  ).run(agentKey, paused, Date.now());
}

/** executeTool отдаёт короткий JSON-текст для tool_result. */
function callAs(role: string, name: string, input: Record<string, unknown> = {}) {
  return executeTool(name, input, { agentKey: role, chatId: CHAT }).then(
    (raw) => JSON.parse(raw) as { ok: boolean; error?: string },
  );
}

function call(name: string, input: Record<string, unknown> = {}) {
  return callAs(ROLE, name, input);
}

describe("пауза закрывает и инлайновые инструменты, а не только гейт", () => {
  let savedAutonomy = saveAutonomy();

  // backend — настоящая роль: снимок строки прав возвращается вместе с
  // autonomy, иначе она уезжает в следующий файл. T-751.
  let restorePerms: () => void;

  beforeEach(() => {
    savedAutonomy = saveAutonomy();
    setAutonomy("global", "*", "auto");
    db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run(ROLE);
    restorePerms = savePermissions([[ROLE, "LIST_RECENT_MESSAGES"]]);
    setPermission(ROLE, "LIST_RECENT_MESSAGES", {
      allowed: true,
      requires_approval: false,
    });
  });

  afterEach(() => {
    restorePerms();
    restoreAutonomy(savedAutonomy);
    db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run(ROLE);
  });

  test("до паузы инлайновый инструмент работает", async () => {
    const r = await call("GET_LOGS");
    expect(r.ok).toBe(true);
  });

  test("на паузе GET_LOGS отклонён", async () => {
    setPaused(ROLE, 1);
    const r = await call("GET_LOGS");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("paused");
  });

  test("на паузе QUERY_DB не читает БД", async () => {
    setPaused(ROLE, 1);
    const r = await call("QUERY_DB", { sql: "SELECT 1 AS x" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("paused");
  });

  test("на паузе CANCEL_SCHEDULED_POST не мутирует календарь", async () => {
    // Берём smm: у backend этот инструмент отобран и так, отказ пришёл бы
    // раньше — а нам нужен именно тот, кому мутировать календарь МОЖНО.
    // Это единственная мутация в инлайновом блоке, мимо гейта.
    try {
      setPaused("smm", 1);
      const r = await callAs("smm", "CANCEL_SCHEDULED_POST", { id: 1 });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("paused");
    } finally {
      db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run("smm");
    }
  });

  test("на паузе гейтованный инструмент тоже отклонён — оба входа заперты", async () => {
    setPaused(ROLE, 1);
    const r = await call("LIST_RECENT_MESSAGES", { limit: 5 });
    expect(r.ok).toBe(false);
  });

  test("resume возвращает инлайновые инструменты в строй", async () => {
    setPaused(ROLE, 1);
    expect((await call("GET_LOGS")).ok).toBe(false);
    setPaused(ROLE, 0);
    expect((await call("GET_LOGS")).ok).toBe(true);
  });
});
