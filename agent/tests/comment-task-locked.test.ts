/**
 * Аудит 2026-08-10: `locked` не останавливал COMMENT_TASK.
 *
 * Набор исключений назывался READONLY_ACTIONS и проверялся ДО того, как гейт
 * вообще узнавал режим автономии. Название описывало содержимое («тут только
 * чтение») и потому прятало ошибку места: COMMENT_TASK не readonly — он пишет
 * в задачу строку, которую читают и другие агенты, и человек в Mini App. А
 * `locked` — это стоп-кран владельца: «эта роль (или этот чат) не действует».
 * Оставался канал, по которому выключенная роль продолжала писать на доску.
 *
 * Фикс — про МЕСТО, а не про состав: исключение не удалено (иначе каждый
 * комментарий агента в `manual` шёл бы человеку на апрув и топил очередь), оно
 * переехало под проверку `locked`.
 *
 * Инвариант: в `locked` не проходит ничего; во всех остальных режимах
 * COMMENT_TASK по-прежнему идёт без апрува.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db.ts";
import { evaluateGate, setAutonomy, setPermission } from "../lib/permissions.ts";
import { saveAutonomy, restoreAutonomy, cleanupChat } from "./_helpers.ts";

const TEST_CHAT = 999_314_002;
// Уникальный ключ: bun гоняет файлы параллельно поверх одной SQLite, а
// setAutonomy("pm", "locked") в середине прогона ронял чужие тесты (T-316).
const AGENT = "lowfriction-pm";

function clearAgentAutonomy(agentKey: string): void {
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`,
  ).run(agentKey);
}

const savedGlobal = saveAutonomy();

function gate() {
  return evaluateGate({
    agentKey: AGENT,
    actionType: "COMMENT_TASK",
    chatId: TEST_CHAT,
  });
}

beforeEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  clearAgentAutonomy(AGENT);
  setPermission(AGENT, "COMMENT_TASK", {
    allowed: true,
    requires_approval: false,
  });
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  clearAgentAutonomy(AGENT);
  // `lowfriction-pm` — не роль из CHARACTERS, а ключ ради проверки
  // LOW_FRICTION_ACTIONS. Строку прав за собой убираем. T-751.
  db.prepare(`DELETE FROM permissions WHERE agent_key = ?`).run(AGENT);
});

describe("locked останавливает и дешёвые действия", () => {
  test("agent=locked — COMMENT_TASK запрещён", () => {
    setAutonomy("chat", String(TEST_CHAT), "auto");
    setAutonomy("agent", AGENT, "locked");
    expect(gate()).toEqual({ decision: "deny", reason: "autonomy locked" });
  });

  test("chat=locked — COMMENT_TASK запрещён", () => {
    setAutonomy("chat", String(TEST_CHAT), "locked");
    expect(gate()).toEqual({ decision: "deny", reason: "autonomy locked" });
  });

  test("requires_approval=true не спасает: locked отказывает раньше", () => {
    setPermission(AGENT, "COMMENT_TASK", {
      allowed: true,
      requires_approval: true,
    });
    setAutonomy("agent", AGENT, "locked");
    expect(gate().decision).toBe("deny");
  });
});

describe("исключение сохранено — апрувами не топим", () => {
  test("manual — комментарий проходит без апрува", () => {
    setAutonomy("chat", String(TEST_CHAT), "manual");
    expect(gate()).toEqual({ decision: "allow" });
  });

  test("semi_auto с requires_approval=true — всё равно без апрува", () => {
    // Дешёвое внутреннее действие: смысл исключения именно в этом.
    setPermission(AGENT, "COMMENT_TASK", {
      allowed: true,
      requires_approval: true,
    });
    setAutonomy("chat", String(TEST_CHAT), "semi_auto");
    expect(gate()).toEqual({ decision: "allow" });
  });

  test("auto — без апрува", () => {
    setAutonomy("chat", String(TEST_CHAT), "auto");
    expect(gate()).toEqual({ decision: "allow" });
  });

  test("allowed=false закрывает действие в любом режиме", () => {
    setPermission(AGENT, "COMMENT_TASK", {
      allowed: false,
      requires_approval: false,
    });
    setAutonomy("chat", String(TEST_CHAT), "auto");
    expect(gate()).toEqual({ decision: "deny", reason: "permission denied" });
  });
});

describe("исключение стоит ниже гейта, а не выше", () => {
  const SRC = readFileSync(
    join(import.meta.dir, "..", "lib", "permissions.ts"),
    "utf8",
  );
  // Комментарии разбирают сам баг и цитируют старое имя — ищем в коде.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("проверка набора идёт после deny по locked", () => {
    const locked = CODE.indexOf('reason: "autonomy locked"');
    // Аргумент в шаблоне обязателен: с 2026-08-28 множество проверяется ещё и
    // в `grantIneffectiveReason` ВЫШЕ по файлу (там аргумент — `action`), и
    // голый `LOW_FRICTION_ACTIONS.has(` находил бы её вместо гейта.
    const exempt = CODE.indexOf("LOW_FRICTION_ACTIONS.has(input.actionType)");
    expect(locked).toBeGreaterThan(-1);
    expect(exempt).toBeGreaterThan(locked);
  });

  test("имя больше не обещает readonly", () => {
    // «Readonly» и было тем словом, из-за которого место набора не проверяли.
    expect(CODE).not.toContain("READONLY_ACTIONS");
  });
});
