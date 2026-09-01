/**
 * Аудит 2026-08-08: ROLE_EXPOSED_TOOLS не был границей для гейтованных действий.
 *
 * Шапка ROLE_EXPOSED_TOOLS в lib/permissions.ts описывает решения владельца
 * («картинки генерит ТОЛЬКО дизайнер», «постить в канал — контентные роли»),
 * но evaluateGate этот список не читал. Для инлайновых тулзов проверка есть
 * (executeTool в tools-schema.ts), а для гейтованных ограничение держалось на
 * том, что модели не отдали такой инструмент в списке.
 *
 * Для tool_use это почти правда — API не даст вызвать необъявленный тул. Но
 * есть путь, где действие называется свободным JSON'ом вне всякого списка:
 * self-diag просит aieng предложить ретрай, и системный промпт прямо разрешает
 * предложить ДРУГОЕ действие. `parsed.action` идёт сразу в гейт.
 *
 * Цена щели — деньги: миграция 010 засеяла GENERATE_IMAGE всем 12 ролям как
 * allowed=1, requires_approval=0, и ни в CALLER_RESTRICTED, ни в
 * SEMI_AUTO_RISKY его нет. То есть гейт отвечал `allow` любой роли.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  evaluateGate,
  setPermission,
  getPermission,
  ROLE_EXPOSED_TOOLS,
  ACTION_TYPES,
  type ActionType,
} from "../lib/permissions.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const CHAT = -100999001;

// Каждая запись в permissions снимается перед изменением и возвращается в
// afterEach. Файл ставит права нескольким ролям, в том числе выбранным на лету
// (`outsider` в проверке-свойстве), и без этого они утекали в другие файлы:
// строка qa/GENERATE_IMAGE оставалась allowed=false до конца прогона. T-751.
const restores: Array<() => void> = [];

function grant(
  agent: string,
  action: ActionType,
  p: { allowed: boolean; requires_approval: boolean },
): void {
  restores.push(savePermissions([[agent, action]]));
  setPermission(agent, action, p);
}

afterEach(() => {
  while (restores.length) restores.pop()!();
  db.prepare(`DELETE FROM autonomy_modes WHERE scope = 'chat' AND scope_id = ?`).run(
    String(CHAT),
  );
});

describe("ROLE_EXPOSED_TOOLS — ограничение, а не подсказка в промпте", () => {
  test("копирайтер не сгенерит платную картинку, хотя права в таблице разрешают", () => {
    // Ровно состояние прода после миграции 010.
    grant("copy", "GENERATE_IMAGE", {
      allowed: true,
      requires_approval: false,
    });
    setAutonomy("chat", String(CHAT), "auto");

    const d = evaluateGate({
      agentKey: "copy",
      actionType: "GENERATE_IMAGE",
      chatId: CHAT,
    });
    expect(d.decision).toBe("deny");

    // Именно экспозиция, а не «нет прав»: строка в permissions разрешающая.
    expect(getPermission("copy", "GENERATE_IMAGE").allowed).toBe(true);
    if (d.decision === "deny") expect(d.reason).toContain("GENERATE_IMAGE");
  });

  test("дизайнеру и лиду картинки по-прежнему доступны", () => {
    for (const role of ["design", "orchestrator"]) {
      grant(role, "GENERATE_IMAGE", {
        allowed: true,
        requires_approval: false,
      });
      const d = evaluateGate({
        agentKey: role,
        actionType: "GENERATE_IMAGE",
        chatId: CHAT,
      });
      expect(d.decision).not.toBe("deny");
    }
  });

  test("каждое ограниченное действие закрыто для роли вне списка", () => {
    // Свойство, а не перечисление: следующая запись в ROLE_EXPOSED_TOOLS
    // получит проверку автоматически.
    const gated = Object.keys(ROLE_EXPOSED_TOOLS).filter((t) =>
      (ACTION_TYPES as readonly string[]).includes(t),
    ) as ActionType[];
    expect(gated.length).toBeGreaterThan(0);

    for (const action of gated) {
      const allowedRoles = ROLE_EXPOSED_TOOLS[action]!;
      const outsider = ["copy", "qa", "backend", "pm"].find(
        (r) => !allowedRoles.includes(r),
      )!;
      grant(outsider, action, { allowed: true, requires_approval: false });
      const d = evaluateGate({
        agentKey: outsider,
        actionType: action,
        chatId: CHAT,
      });
      expect(`${action}/${outsider}: ${d.decision}`).toBe(
        `${action}/${outsider}: deny`,
      );
    }
  });

  test("обычные действия не задеты — любая роль по-прежнему пишет в чат", () => {
    grant("copy", "SEND_MESSAGE", {
      allowed: true,
      requires_approval: false,
    });
    setAutonomy("chat", String(CHAT), "auto");
    const d = evaluateGate({
      agentKey: "copy",
      actionType: "SEND_MESSAGE",
      chatId: CHAT,
    });
    expect(d.decision).toBe("allow");
  });

  test("отказ по экспозиции идёт раньше проверки прав — роль не узнает, есть ли у неё строка", () => {
    grant("qa", "GENERATE_IMAGE", {
      allowed: false,
      requires_approval: false,
    });
    const d = evaluateGate({ agentKey: "qa", actionType: "GENERATE_IMAGE" });
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).not.toBe("permission denied");
  });
});
