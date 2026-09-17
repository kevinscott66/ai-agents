/**
 * Аудит 2026-09-11: объяснение про low-friction врало человеку про режимы.
 *
 * `grantIneffectiveReason` (lib/permissions.ts) отказывается писать
 * `requires_approval=1` на low-friction действие и объясняет отказ строкой,
 * которую человек читает дословно в четырёх местах: `/grant` и `/perms`
 * (commands.ts), `POST /api/permissions` (miniapp-server.ts) и валидация
 * инструмента GRANT_PERMISSION (dispatch/permissions.ts). Строка обещала, что
 * гейт «отвечает allow … во всех режимах автономии».
 *
 * Решение (строку не писать) верное, объяснение — нет: в `evaluateGate`
 * проверка `locked` и ветка `forceApproval` стоят ВЫШЕ LOW_FRICTION_ACTIONS,
 * то есть в `locked` ответ — deny, а при forceApproval — approval. Обещание
 * «allow во всех режимах» прямо противоречит аудиту 2026-08-10, который этот
 * набор под `locked` и переносил, и аудиту 2026-08-21, поднявшему `locked`
 * первым из режимных рубежей.
 *
 * Дефект документации, не привилегий: `locked` реально отказывает. Но это тот
 * же класс, что и врущий комментарий, только текст видит не следующий агент, а
 * владелец — и видит как утверждение о безопасности.
 *
 * Здесь пришпилены обе стороны: ЧТО строка говорит и ЧТО гейт делает.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db.ts";
import {
  evaluateGate,
  grantIneffectiveReason,
  setAutonomy,
  setPermission,
  LOW_FRICTION_ACTIONS,
} from "../lib/permissions.ts";
import { saveAutonomy, restoreAutonomy, cleanupChat } from "./_helpers.ts";

const TEST_CHAT = 999_314_911;
// Свой ключ роли: bun гоняет файлы параллельно поверх одной SQLite, и
// setAutonomy на живой роли ронял бы чужие тесты (T-316).
const AGENT = "lfexplain-pm";
const ACTION = "COMMENT_TASK";

function clearAgentAutonomy(agentKey: string): void {
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`,
  ).run(agentKey);
}

const savedGlobal = saveAutonomy();

beforeEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  clearAgentAutonomy(AGENT);
  setPermission(AGENT, ACTION, { allowed: true, requires_approval: false });
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  clearAgentAutonomy(AGENT);
  db.prepare(`DELETE FROM permissions WHERE agent_key = ?`).run(AGENT);
});

describe("объяснение про low-friction не обещает allow во всех режимах", () => {
  test("предпосылка: COMMENT_TASK действительно low-friction", () => {
    expect(LOW_FRICTION_ACTIONS.has(ACTION)).toBe(true);
  });

  test("в locked гейт отвечает deny — значит «allow везде» было бы ложью", () => {
    setAutonomy("agent", AGENT, "locked");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: ACTION,
      chatId: TEST_CHAT,
    });
    expect(d.decision).toBe("deny");
    // Не expect(...).toBe: сужение типа даёт доступ к `reason`, которого у
    // allow-ветки GateDecision нет.
    if (d.decision !== "deny") throw new Error("ожидался deny");
    expect(d.reason).toBe("autonomy locked");
  });

  test("при forceApproval гейт отвечает approval, а не allow", () => {
    setAutonomy("agent", AGENT, "auto");
    const d = evaluateGate({
      agentKey: AGENT,
      actionType: ACTION,
      chatId: TEST_CHAT,
      forceApproval: true,
      forceApprovalReason: "owner voice",
    });
    expect(d.decision).toBe("approval");
  });

  test("строка не утверждает того, что опровергают два теста выше", () => {
    const s = grantIneffectiveReason("qa", ACTION, "approval");
    expect(s).toBeTruthy();
    // Старая формулировка — ровно то, что опровергнуто выше.
    expect(s!).not.toContain("отвечает allow");
    expect(s!).not.toMatch(/allow[^.]{0,40}во всех режимах/);
    // Адрес карты и общий для всех режимов факт остаются на месте.
    expect(s!).toContain("LOW_FRICTION_ACTIONS");
    expect(s!).toContain("requires_approval");
    // Режимы, в которых ответ НЕ allow, названы явно.
    expect(s!).toContain("locked");
    expect(s!).toContain("deny");
  });

  test("копий этой строки нет: все четыре показа зовут одну функцию", () => {
    // «Копия правила — это правило, действующее на N−1 из N мест»: текст живёт
    // в одном месте, остальные его только показывают. Если завтра кто-то
    // впишет свой вариант рядом с показом, тест выше про него не узнает.
    const root = join(import.meta.dir, "..");
    for (const rel of [
      "lib/commands.ts",
      "lib/miniapp-server.ts",
      "lib/dispatch/permissions.ts",
    ]) {
      const src = readFileSync(join(root, rel), "utf8");
      expect(src).toContain("grantIneffectiveReason");
      expect(src).not.toContain("LOW_FRICTION_ACTIONS, lib/permissions.ts");
    }
  });
});
