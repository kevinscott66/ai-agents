/**
 * Аудит 2026-08-20: право «никогда не выдавали» было неотличимо от «владелец
 * отозвал».
 *
 * Права раздаются одноразовыми нумерованными миграциями (006…038), каждая —
 * ручная. Забыть её нечем: `getPermission` на отсутствующую строку возвращает
 * `allowed:false`, и гейт отказывает тем же «permission denied», что и на
 * явном `allowed=0`. На чистой БД так стоят пять типов действий — у каждого
 * есть хендлер, экспозиция инструмента и запись в CALLER_RESTRICTED, то есть
 * функция доехала до прода и там молча не работает.
 *
 * Права здесь НЕ раздаются: какие роли и с каким approval — решение владельца,
 * а речь про самые опасные действия (выдача прав, правка системных промптов,
 * merge в main). Тесты фиксируют, что дыру видно.
 */
import { describe, test, expect } from "bun:test";
import { db } from "../lib/db.ts";
import {
  ACTION_TYPES,
  unseededActionTypes,
  evaluateGate,
  getPermission,
  setPermission,
  type ActionType,
} from "../lib/permissions.ts";

function rowCount(actionType: string): number {
  return (
    db
      .prepare(`SELECT count(*) AS n FROM permissions WHERE action_type = ?`)
      .get(actionType) as { n: number }
  ).n;
}

describe("unseededActionTypes: типы действий без единой строки прав", () => {
  test("возвращает ровно те типы, у которых ноль строк", () => {
    const missing = new Set(unseededActionTypes());
    for (const at of ACTION_TYPES) {
      // Инвариант в обе стороны: ни один тип с правами не попадает в список,
      // ни один тип без прав из него не выпадает.
      expect(missing.has(at)).toBe(rowCount(at) === 0);
    }
  });

  test("список — подмножество ACTION_TYPES без дублей", () => {
    const out = unseededActionTypes();
    expect(new Set(out).size).toBe(out.length);
    for (const at of out) expect(ACTION_TYPES).toContain(at);
  });

  test("появление незасеянного типа видно сразу", () => {
    // Берём тип с правами, временно убираем их все и проверяем, что проверка
    // его называет. Строки восстанавливаются в finally — БД тестов общая.
    const seeded = ACTION_TYPES.find((at) => rowCount(at) > 0);
    expect(seeded).toBeDefined();
    const at = seeded!;
    const saved = db
      .prepare(
        `SELECT agent_key, allowed, requires_approval FROM permissions WHERE action_type = ?`,
      )
      .all(at) as Array<{ agent_key: string; allowed: number; requires_approval: number }>;
    try {
      db.prepare(`DELETE FROM permissions WHERE action_type = ?`).run(at);
      expect(unseededActionTypes()).toContain(at);
    } finally {
      for (const r of saved) {
        setPermission(r.agent_key, at, {
          allowed: !!r.allowed,
          requires_approval: !!r.requires_approval,
        });
      }
    }
    expect(rowCount(at)).toBe(saved.length);
    expect(unseededActionTypes()).not.toContain(at);
  });
});

/** GateDecision — размеченное объединение; expect() тип не сужает. */
function denial(d: ReturnType<typeof evaluateGate>): { decision: string; reason: string } {
  expect(d.decision).toBe("deny");
  return d as { decision: string; reason: string };
}

describe("гейт: отказ по отсутствию строки отличается от отказа по allowed=0", () => {
  // Роль и действие, которые проходят все предыдущие слои гейта
  // (disabled/paused, CALLER_RESTRICTED, ROLE_EXPOSED_TOOLS) и упираются
  // именно в таблицу прав.
  const AGENT = "smm";
  const ACTION: ActionType = "PUBLISH_TO_CHANNEL";

  function withPermissionState(
    state: { row: "none" } | { row: "revoked" },
    fn: () => void,
  ): void {
    const before = getPermission(AGENT, ACTION);
    const existed = !!db
      .prepare(`SELECT 1 FROM permissions WHERE agent_key = ? AND action_type = ?`)
      .get(AGENT, ACTION);
    try {
      db.prepare(`DELETE FROM permissions WHERE agent_key = ? AND action_type = ?`).run(
        AGENT,
        ACTION,
      );
      if (state.row === "revoked") {
        setPermission(AGENT, ACTION, { allowed: false, requires_approval: false });
      }
      fn();
    } finally {
      db.prepare(`DELETE FROM permissions WHERE agent_key = ? AND action_type = ?`).run(
        AGENT,
        ACTION,
      );
      if (existed) setPermission(AGENT, ACTION, before);
    }
  }

  test("нет строки — причина называет незасеянное право", () => {
    withPermissionState({ row: "none" }, () => {
      const d = denial(evaluateGate({ agentKey: AGENT, actionType: ACTION }));
      expect(d.reason).toContain(ACTION);
      expect(d.reason).toContain(AGENT);
      expect(d.reason).toContain("не выдано");
    });
  });

  test("явный allowed=0 — прежняя короткая причина", () => {
    withPermissionState({ row: "revoked" }, () => {
      const d = denial(evaluateGate({ agentKey: AGENT, actionType: ACTION }));
      // Отзыв владельца не должен выглядеть как забытая миграция.
      expect(d.reason).toBe("permission denied");
    });
  });

  test("восстановленное право снова разрешает действие", () => {
    // Страховка на сам тест: если бы finally не возвращал строку, следующие
    // файлы получили бы молчаливо отозванное право.
    const d = evaluateGate({ agentKey: AGENT, actionType: ACTION });
    expect(d.decision).not.toBe("deny");
  });
});
