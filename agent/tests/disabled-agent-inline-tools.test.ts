/**
 * Аудит 2026-08-09: продолжение истории paused-agent-inline-tools.
 *
 * Тот фикс закрыл инлайновый путь для `paused` — и ровно на этом остановился,
 * хотя `disabled` живёт в соседней колонке той же строки agent_states и до
 * гейта доходит так же редко. `setAgentStatus` намеренно не трогает `paused`,
 * поэтому у выключенного агента почти всегда `paused = 0`: любая проверка
 * «а не на паузе ли он» пропускала его насквозь. За пределами evaluateGate
 * `isAgentDisabled` не звался вообще нигде.
 *
 * Заодно проверяется autonomy=locked — стоп-кран владельца на чат. Гейт по
 * нему отказывает всему, включая read-only (LIST_RECENT_MESSAGES убрали из
 * набора исключений именно ради этого — см. comment-task-locked.test.ts, где
 * тот же набор переехал под проверку `locked`), а инлайновый путь отдавал
 * QUERY_DB по всей операционной БД и отменял запланированные посты.
 */
// Аудит 2026-08-28: раньше здесь стоял GET_METRICS. Инструмент сузили до
// aieng/orchestrator (телеметрия прода — см. ROLE_EXPOSED_TOOLS), а этому
// файлу нужна просто инлайновая read-only тулза, доступная роли ниже.
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -100779;
const ROLE = "backend";

function setStatus(agentKey: string, status: "active" | "disabled") {
  db.prepare(
    `INSERT INTO agent_states(agent_key, paused, updated_at, status)
     VALUES (?, 0, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(agentKey, Date.now(), status);
}

function clearState(agentKey: string) {
  db.prepare("DELETE FROM agent_states WHERE agent_key = ?").run(agentKey);
}

function callAs(role: string, name: string, input: Record<string, unknown> = {}) {
  return executeTool(name, input, { agentKey: role, chatId: CHAT }).then(
    (raw) => JSON.parse(raw) as { ok: boolean; error?: string },
  );
}

afterEach(() => {
  clearState(ROLE);
  clearState("smm");
});

describe("выключенный агент не ходит в инлайновые инструменты", () => {
  const saved = saveAutonomy();
  setAutonomy("global", "*", "auto");
  afterEach(() => {
    setAutonomy("global", "*", "auto");
  });

  test("до выключения GET_LOGS работает", async () => {
    const res = await callAs(ROLE, "GET_LOGS", {});
    expect(res.ok).toBe(true);
  });

  test("disabled режет чтение операционной БД", async () => {
    setStatus(ROLE, "disabled");
    const res = await callAs(ROLE, "QUERY_DB", { sql: "SELECT 1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("disabled");
  });

  test("disabled режет мутацию календаря", async () => {
    // CANCEL_SCHEDULED_POST — единственная мутация в «read-only» инлайновом
    // блоке. Роль smm, а не backend: проверка выдачи роли стоит раньше.
    setStatus("smm", "disabled");
    const res = await callAs("smm", "CANCEL_SCHEDULED_POST", { postId: "nope" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("disabled");
  });

  test("disabled режет и обычные гейтованные действия", async () => {
    setStatus(ROLE, "disabled");
    const res = await callAs(ROLE, "COMMENT_TASK", { taskId: "x", text: "y" });
    expect(res.ok).toBe(false);
  });

  test("возврат в active восстанавливает доступ", async () => {
    setStatus(ROLE, "disabled");
    expect((await callAs(ROLE, "GET_LOGS", {})).ok).toBe(false);
    setStatus(ROLE, "active");
    expect((await callAs(ROLE, "GET_LOGS", {})).ok).toBe(true);
  });

  test("формулировка отказа отличает disabled от paused", async () => {
    // «disabled» снимается только запросом к perm, «paused» — кнопкой
    // владельца. Одинаковый текст отказа увёл бы модель не туда.
    setStatus(ROLE, "disabled");
    const dis = await callAs(ROLE, "GET_LOGS", {});
    clearState(ROLE);
    db.prepare(
      `INSERT INTO agent_states(agent_key, paused, updated_at)
       VALUES (?, 1, ?)`,
    ).run(ROLE, Date.now());
    const pau = await callAs(ROLE, "GET_LOGS", {});
    expect(dis.error).not.toBe(pau.error);
    expect(pau.error).toContain("paused");
  });

  restoreAutonomy(saved);
});

describe("autonomy locked действует и на инлайновом пути", () => {
  const saved = saveAutonomy();
  afterEach(() => {
    setAutonomy("global", "*", "auto");
  });

  test("locked не пускает в операционную БД", async () => {
    setAutonomy("chat", String(CHAT), "locked");
    const res = await callAs(ROLE, "QUERY_DB", { sql: "SELECT 1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("locked");
  });

  test("locked не даёт отменить запланированный пост", async () => {
    setAutonomy("chat", String(CHAT), "locked");
    const res = await callAs("smm", "CANCEL_SCHEDULED_POST", { postId: "nope" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("locked");
  });

  test("собственная вика команды под locked остаётся читаемой", async () => {
    // Единственное исключение: ни PII, ни денег, ни мутации. Без него агент
    // в locked-чате перестаёт помнить даже свои заметки.
    setAutonomy("chat", String(CHAT), "locked");
    const res = await callAs(ROLE, "SEARCH_WIKI", { query: "деплой" });
    expect(res.ok).toBe(true);
  });

  test("в auto тот же вызов проходит", async () => {
    setAutonomy("chat", String(CHAT), "auto");
    const res = await callAs(ROLE, "QUERY_DB", { sql: "SELECT 1" });
    expect(res.ok).toBe(true);
  });

  restoreAutonomy(saved);
});
