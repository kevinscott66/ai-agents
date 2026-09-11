/**
 * Аудит 2026-08-28: `/grant` врал в ОБЕ стороны, а `/perms` это подтверждал.
 *
 * С 2026-08-27 команда отказывается писать строки, мёртвые по `CALLER_RESTRICTED`
 * и `ROLE_EXPOSED_TOOLS`, — и её собственный комментарий объявлял, что рубежей
 * выше таблицы ровно два. Их четыре.
 *
 *  - `LOW_FRICTION_ACTIONS` (`permissions.ts`) отвечает `allow` РАНЬШЕ, чем
 *    ветви manual/semi_auto — единственные, которые читают `requires_approval`.
 *    `/grant qa COMMENT_TASK approval` рапортовал «права обновлены», флаг ложился
 *    в БД и не читался ни в одном режиме автономии. Владелец ставит тормоз,
 *    получает подтверждение и уходит; апрувов не приходит ни одного, потому что
 *    их не будет. Направление небезопасное: не срабатывает УЖЕСТОЧЕНИЕ.
 *  - `ALWAYS_APPROVE_ACTIONS` (`:853`) — пол выше таблицы. `/grant smm
 *    PUBLISH_TO_CHANNEL auto` отвечал «= auto», а гейт отвечает `approval`
 *    всегда. Владелец рассчитывает на автопубликацию, вместо этого копятся
 *    заявки, которых никто не ждёт.
 *
 * `/perms` считал маркер «мертва» по тем же двум рубежам из четырёх — то есть
 * отчёт, написанный ради разоблачения ложной картины, её подтверждал.
 *
 * Правка: единственный источник истины `grantIneffectiveReason` в
 * `lib/permissions.ts`, общий для `/grant`, `/perms` и `POST /api/permissions`
 * (второй вход к setPermission, у которого не было НИ ОДНОЙ из этих проверок).
 * Расхождение команды с отчётом стало невозможным по конструкции.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { cmdGrant, cmdPerms } from "../lib/commands.ts";
import {
  ALWAYS_APPROVE_ACTIONS,
  LOW_FRICTION_ACTIONS,
  SEMI_AUTO_RISKY,
  evaluateGate,
  getPermission,
  grantCaveat,
  grantIneffectiveReason,
  isToolExposedToRole,
  setPermission,
} from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";

const CHAT = -100828044;

describe("grantIneffectiveReason: рубежи выше таблицы", () => {
  test("предпосылка: low-friction отвечает allow до чтения requires_approval", () => {
    const restore = savePermissions([["qa", "COMMENT_TASK"]]);
    try {
      expect(LOW_FRICTION_ACTIONS.has("COMMENT_TASK")).toBe(true);
      setPermission("qa", "COMMENT_TASK", { allowed: true, requires_approval: true });
      // Флаг в БД стоит — а гейт его не видит ни в одном режиме автономии.
      expect(getPermission("qa", "COMMENT_TASK").requires_approval).toBe(true);
      expect(
        evaluateGate({ agentKey: "qa", actionType: "COMMENT_TASK", chatId: CHAT }).decision,
      ).toBe("allow");
    } finally {
      restore();
    }
  });

  test("предпосылка: always-approve отвечает approval поверх auto", () => {
    const restore = savePermissions([["smm", "PUBLISH_TO_CHANNEL"]]);
    try {
      expect(ALWAYS_APPROVE_ACTIONS.has("PUBLISH_TO_CHANNEL")).toBe(true);
      setPermission("smm", "PUBLISH_TO_CHANNEL", { allowed: true, requires_approval: false });
      expect(
        evaluateGate({ agentKey: "smm", actionType: "PUBLISH_TO_CHANNEL", chatId: CHAT })
          .decision,
      ).toBe("approval");
    } finally {
      restore();
    }
  });

  test("approval на low-friction признан недействующим, auto — нет", () => {
    expect(grantIneffectiveReason("qa", "COMMENT_TASK", "approval")).toContain(
      "LOW_FRICTION_ACTIONS",
    );
    expect(grantIneffectiveReason("qa", "COMMENT_TASK", "auto")).toBeNull();
  });

  test("auto на always-approve признан недействующим, approval — нет", () => {
    expect(grantIneffectiveReason("smm", "PUBLISH_TO_CHANNEL", "auto")).toContain(
      "ALWAYS_APPROVE_ACTIONS",
    );
    expect(grantIneffectiveReason("smm", "PUBLISH_TO_CHANNEL", "approval")).toBeNull();
  });

  test("semi_auto-risky — оговорка, а не отказ: в auto-чате строка работает", () => {
    const risky = [...SEMI_AUTO_RISKY].find(
      (a) => !ALWAYS_APPROVE_ACTIONS.has(a) && isToolExposedToRole(a, "qa"),
    );
    expect(risky).toBeTruthy();
    expect(grantIneffectiveReason("qa", risky!, "auto")).toBeNull();
    expect(grantCaveat(risky!, "auto")).toContain("SEMI_AUTO_RISKY");
    expect(grantCaveat(risky!, "approval")).toBeNull();
  });
});

describe("/grant не рапортует об ужесточении, которого не будет", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  test("approval на low-friction — отказ с адресом, строку не пишем", () => {
    const before = getPermission("qa", "COMMENT_TASK");
    restores.push(savePermissions([["qa", "COMMENT_TASK"]]));
    const out = cmdGrant({ args: ["qa", "COMMENT_TASK", "approval"] });
    expect(out).toContain("LOW_FRICTION_ACTIONS");
    expect(out).not.toContain("права обновлены");
    expect(getPermission("qa", "COMMENT_TASK").requires_approval).toBe(
      before.requires_approval,
    );
  });

  test("auto на always-approve — отказ с адресом, строку не пишем", () => {
    const before = getPermission("smm", "PUBLISH_TO_CHANNEL");
    restores.push(savePermissions([["smm", "PUBLISH_TO_CHANNEL"]]));
    const out = cmdGrant({ args: ["smm", "PUBLISH_TO_CHANNEL", "auto"] });
    expect(out).toContain("ALWAYS_APPROVE_ACTIONS");
    expect(out).not.toContain("права обновлены");
    expect(getPermission("smm", "PUBLISH_TO_CHANNEL").requires_approval).toBe(
      before.requires_approval,
    );
  });

  test("approval на always-approve проходит: строка подействует", () => {
    restores.push(savePermissions([["smm", "PUBLISH_TO_CHANNEL"]]));
    const out = cmdGrant({ args: ["smm", "PUBLISH_TO_CHANNEL", "approval"] });
    expect(out).toContain("права обновлены");
    expect(getPermission("smm", "PUBLISH_TO_CHANNEL").requires_approval).toBe(true);
  });

  test("законная пара по-прежнему выдаётся", () => {
    restores.push(savePermissions([["qa", "DELETE_MESSAGE"]]));
    const out = cmdGrant({ args: ["qa", "DELETE_MESSAGE", "auto"] });
    expect(out).toContain("права обновлены");
    expect(getPermission("qa", "DELETE_MESSAGE").allowed).toBe(true);
  });
});

describe("/perms помечает строки по тем же четырём рубежам", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  test("approval на low-friction помечен мёртвым", () => {
    restores.push(savePermissions([["qa", "COMMENT_TASK"]]));
    setPermission("qa", "COMMENT_TASK", { allowed: true, requires_approval: true });
    const line = cmdPerms({ args: ["qa"] })
      .split("\n")
      .find((l) => l.startsWith("qa:")) ?? "";
    expect(line).toContain("COMMENT_TASK=approval (мертва:");
    expect(line).toContain("LOW_FRICTION_ACTIONS");
  });

  test("auto на always-approve помечен мёртвым", () => {
    restores.push(savePermissions([["smm", "PUBLISH_TO_CHANNEL"]]));
    setPermission("smm", "PUBLISH_TO_CHANNEL", { allowed: true, requires_approval: false });
    const line = cmdPerms({ args: ["smm"] })
      .split("\n")
      .find((l) => l.startsWith("smm:")) ?? "";
    expect(line).toContain("PUBLISH_TO_CHANNEL=auto (мертва:");
    expect(line).toContain("ALWAYS_APPROVE_ACTIONS");
  });

  test("живая строка пометки не получает", () => {
    restores.push(savePermissions([["qa", "DELETE_MESSAGE"]]));
    setPermission("qa", "DELETE_MESSAGE", { allowed: true, requires_approval: false });
    const line = cmdPerms({ args: ["qa"] })
      .split("\n")
      .find((l) => l.startsWith("qa:")) ?? "";
    expect(line).toContain("DELETE_MESSAGE=auto");
    expect(line).not.toContain("DELETE_MESSAGE=auto (мертва");
  });
});

describe("второй вход к setPermission закрыт тем же рубежом", () => {
  test("POST /api/permissions зовёт grantIneffectiveReason", () => {
    const src = readFileSync(new URL("../lib/miniapp-server.ts", import.meta.url), "utf8");
    const route = src.slice(src.indexOf('path === "/api/permissions" && method === "POST"'));
    const body = route.slice(0, route.indexOf("setPermission("));
    expect(body).toContain("grantIneffectiveReason(");
  });

  test("/grant и /perms считают маркер одной функцией", () => {
    const src = readFileSync(new URL("../lib/commands.ts", import.meta.url), "utf8");
    // Возврат к ручному перечислению карт в commands.ts — это и есть регрессия:
    // именно так отчёт разошёлся с гейтом.
    expect(src.match(/grantIneffectiveReason\(/g)?.length).toBe(2);
  });
});
