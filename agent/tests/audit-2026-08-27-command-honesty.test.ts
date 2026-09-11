/**
 * Аудит 2026-08-27: админ-команды рапортовали о том, чего не делали.
 *
 * Три места, один класс: ответ команды расходится с тем, что реально
 * произошло, и разойтись может только в сторону «сделано больше, чем есть».
 *
 * 1. `/grant smm GENERATE_IMAGE auto` — «права обновлены», строка в БД есть,
 *    гейт по-прежнему отказывает. `checkPermission` смотрит CALLER_RESTRICTED
 *    и ROLE_EXPOSED_TOOLS (permissions.ts) ДО таблицы; обе карты —
 *    решения владельца в коде, из чата не переписываются. Владелец считал, что
 *    выдал доступ, агент продолжал получать отказ.
 * 2. `/perms` печатал такие строки как выданные права. Миграция 010 засеяла
 *    GENERATE_IMAGE всем 12 ролям — отчёт показывал двенадцать «auto» на
 *    инструменте, который выдан двоим.
 * 3. `/tasks smm` печатал ВЕСЬ чат под ролевым заголовком: `cmdTasks` фильтр
 *    умеет, но обработчик глотал аргументы (`_args`).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { cmdGrant, cmdPerms, cmdTasks } from "../lib/commands.ts";
import { ADMIN_COMMANDS } from "../lib/admin-commands.ts";
import {
  getPermission,
  setPermission,
  evaluateGate,
  isToolExposedToRole,
  CALLER_RESTRICTED,
} from "../lib/permissions.ts";
import { createTask } from "../lib/tasks.ts";
import { savePermissions } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const CHAT = -100827033;

afterEach(() => {
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT);
});

describe("/grant не выдаёт того, чего гейт не пропустит", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  test("предпосылка: гейт отказывает раньше таблицы", () => {
    // Пишем строку в обход команды — именно так выглядела БД после /grant.
    restores.push(savePermissions([["smm", "GENERATE_IMAGE"]]));
    setPermission("smm", "GENERATE_IMAGE", {
      allowed: true,
      requires_approval: false,
    });
    expect(getPermission("smm", "GENERATE_IMAGE").allowed).toBe(true);
    const res = evaluateGate({
      agentKey: "smm",
      actionType: "GENERATE_IMAGE",
      chatId: CHAT,
    });
    expect(res.decision).toBe("deny");
  });

  test("роль без экспозиции — отказ с адресом, строку не пишем", () => {
    const before = getPermission("smm", "GENERATE_IMAGE");
    restores.push(savePermissions([["smm", "GENERATE_IMAGE"]]));
    const out = cmdGrant({ args: ["smm", "GENERATE_IMAGE", "auto"] });
    expect(out).toContain("ROLE_EXPOSED_TOOLS");
    expect(out).not.toContain("права обновлены");
    expect(getPermission("smm", "GENERATE_IMAGE").allowed).toBe(before.allowed);
  });

  test("caller-restricted действие — отказ с именем владельца тула", () => {
    expect(CALLER_RESTRICTED.MAC_RUN_CLAUDE).toBe("orchestrator");
    const before = getPermission("qa", "MAC_RUN_CLAUDE");
    restores.push(savePermissions([["qa", "MAC_RUN_CLAUDE"]]));
    const out = cmdGrant({ args: ["qa", "MAC_RUN_CLAUDE", "auto"] });
    expect(out).toContain("orchestrator");
    expect(out).not.toContain("права обновлены");
    expect(getPermission("qa", "MAC_RUN_CLAUDE").allowed).toBe(before.allowed);
  });

  test("законная пара выдаётся как раньше", () => {
    restores.push(savePermissions([["qa", "DELETE_MESSAGE"]]));
    expect(isToolExposedToRole("DELETE_MESSAGE", "qa")).toBe(true);
    const out = cmdGrant({ args: ["qa", "DELETE_MESSAGE", "auto"] });
    expect(out).toContain("права обновлены");
    expect(getPermission("qa", "DELETE_MESSAGE").allowed).toBe(true);
  });
});

describe("/perms не выдаёт мёртвые строки за права", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  test("строка, которую гейт всё равно отвергнет, помечена", () => {
    restores.push(savePermissions([["smm", "GENERATE_IMAGE"]]));
    setPermission("smm", "GENERATE_IMAGE", {
      allowed: true,
      requires_approval: false,
    });
    const out = cmdPerms({ args: ["smm"] });
    const line = out.split("\n").find((l) => l.startsWith("smm:")) ?? "";
    expect(line).toContain("GENERATE_IMAGE=auto (мертва");
  });

  test("живая строка пометки не получает", () => {
    restores.push(savePermissions([["qa", "DELETE_MESSAGE"]]));
    setPermission("qa", "DELETE_MESSAGE", {
      allowed: true,
      requires_approval: false,
    });
    const out = cmdPerms({ args: ["qa"] });
    expect(out).toContain("DELETE_MESSAGE=auto");
    const line = out.split("\n").find((l) => l.startsWith("qa:")) ?? "";
    expect(line.split(", ").find((p) => p.startsWith("DELETE_MESSAGE"))).toBe(
      "DELETE_MESSAGE=auto",
    );
  });

  test("denied не помечается — отказ и так отказ", () => {
    restores.push(savePermissions([["smm", "GENERATE_IMAGE"]]));
    setPermission("smm", "GENERATE_IMAGE", {
      allowed: false,
      requires_approval: false,
    });
    const out = cmdPerms({ args: ["smm"] });
    const line = out.split("\n").find((l) => l.startsWith("smm:")) ?? "";
    expect(line).toContain("GENERATE_IMAGE=denied");
    expect(line).not.toContain("GENERATE_IMAGE=denied (мертва");
  });
});

describe("/tasks: фильтр по роли перестал быть мёртвым", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT);
    createTask({ chatId: CHAT, createdBy: "pm", title: "фронт", assignedTo: "frontend" });
    createTask({ chatId: CHAT, createdBy: "pm", title: "смм", assignedTo: "smm" });
  });

  const tasksHandler = () => {
    const cmd = ADMIN_COMMANDS.find((c) => c.name === "tasks");
    if (!cmd) throw new Error("нет команды tasks");
    return cmd.handler;
  };

  test("обработчик доносит аргумент до фильтра", () => {
    const out = tasksHandler()(["smm"], { chatId: CHAT } as any);
    expect(out).toContain("смм");
    // Суть находки: раньше здесь была и чужая строка.
    expect(out).not.toContain("фронт");
    expect(out).toContain("роли smm");
  });

  test("без аргумента — весь чат, как было", () => {
    const out = tasksHandler()([], { chatId: CHAT } as any);
    expect(out).toContain("смм");
    expect(out).toContain("фронт");
  });

  test("несуществующая роль — отказ, а не молчаливый весь чат", () => {
    const out = tasksHandler()(["нетакойроли"], { chatId: CHAT } as any);
    expect(out).toContain("Неизвестный agent");
    expect(out).not.toContain("фронт");
  });

  test("пустая ролевая выборка называет роль", () => {
    const out = cmdTasks({ chatId: CHAT, agentKey: "qa" });
    expect(out).toBe("Открытых задач роли qa нет.");
  });
});
