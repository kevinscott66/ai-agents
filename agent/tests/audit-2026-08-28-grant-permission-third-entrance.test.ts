/**
 * Аудит 2026-08-28: у общего рубежа было три входа, а знал он о двух.
 *
 * Аудит от 2026-08-28 завёл `grantIneffectiveReason` как единственное место,
 * где решают, подействует ли строка `permissions`, и подключил его к команде
 * `/grant` и к `POST /api/permissions`. Его же docstring говорит «обоих
 * входов» — и это ровно счёт ошибки: третий вход, агентский, остался мимо.
 *
 * `handleGrantPermission` (lib/dispatch/permissions.ts) — третий писатель в
 * `setPermission`. Роль `perm` выпускает GRANT_PERMISSION, гейт по
 * ALWAYS_APPROVE_ACTIONS спрашивает владельца, владелец жмёт «одобрить» — и
 * пишется строка, которую гейт никогда не прочтёт. Действие при этом
 * рапортует ok, а diff-строка аудита — успешный переход old → new.
 *
 * Обе стороны исходного дефекта возвращались через эту дверь:
 *   - опасная: ужесточение, которого не будет (`qa.COMMENT_TASK = approval`
 *     — low-friction отвечает allow ДО чтения requires_approval);
 *   - вводящая в заблуждение: `smm.PUBLISH_TO_CHANNEL = auto`, где
 *     ALWAYS_APPROVE стоит выше таблицы.
 * Плюс то, чего даже прежний `/grant` не писал: строки, мёртвые по
 * CALLER_RESTRICTED и ROLE_EXPOSED_TOOLS.
 *
 * Отзыв (`allowed: false`) проверкой не трогаем — он действует всегда, ровно
 * как в Mini App (`body.allowed && ineffective`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  handleGrantPermission,
  validateGrantPermissionPayload,
} from "../lib/dispatch/permissions.ts";
import {
  ALWAYS_APPROVE_ACTIONS,
  CALLER_RESTRICTED,
  getPermission,
  grantCaveat,
  grantIneffectiveReason,
  isToolExposedToRole,
  SEMI_AUTO_RISKY,
  type ActionType,
} from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import type { GrantPermissionPayload } from "../lib/action-payload.ts";

const CTX = { agentKey: "perm", chatId: -100777 };

function payload(
  target: string,
  action: string,
  allowed: boolean,
  requiresApproval: boolean,
): GrantPermissionPayload {
  return {
    target_agent_key: target,
    action_type: action,
    allowed,
    requires_approval: requiresApproval,
    reason: "аудит третьего входа к таблице прав",
  } as GrantPermissionPayload;
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

describe("предпосылки", () => {
  test("вход агентский и живой: GRANT_PERMISSION закреплён за perm и всегда идёт к владельцу", () => {
    expect(CALLER_RESTRICTED.GRANT_PERMISSION).toBe("perm");
    expect(ALWAYS_APPROVE_ACTIONS.has("GRANT_PERMISSION")).toBe(true);
  });

  test("карты, по которым строка мертва, на месте и рубеж их видит", () => {
    expect(grantIneffectiveReason("qa", "COMMENT_TASK", "approval")).toContain(
      "LOW_FRICTION_ACTIONS",
    );
    expect(
      grantIneffectiveReason("smm", "PUBLISH_TO_CHANNEL", "auto"),
    ).toContain("ALWAYS_APPROVE_ACTIONS");
    expect(grantIneffectiveReason("qa", "GRANT_PERMISSION", "auto")).toContain(
      "CALLER_RESTRICTED",
    );
    expect(
      grantIneffectiveReason("qa", "PUBLISH_TO_CHANNEL", "approval"),
    ).toContain("ROLE_EXPOSED_TOOLS");
  });
});

describe("validateGrantPermissionPayload отказывает в мёртвой строке", () => {
  test("ужесточение на low-friction — отказ с адресом карты", () => {
    const err = validateGrantPermissionPayload(
      payload("qa", "COMMENT_TASK", true, true),
    );
    expect(err).toContain("LOW_FRICTION_ACTIONS");
  });

  test("auto на always-approve — отказ с адресом карты", () => {
    const err = validateGrantPermissionPayload(
      payload("smm", "PUBLISH_TO_CHANNEL", true, false),
    );
    expect(err).toContain("ALWAYS_APPROVE_ACTIONS");
  });

  test("право, закреплённое за другой ролью — отказ", () => {
    const err = validateGrantPermissionPayload(
      payload("qa", "GRANT_PERMISSION", true, true),
    );
    expect(err).toContain("CALLER_RESTRICTED");
  });

  test("право, не выданное роли инструментами — отказ", () => {
    const err = validateGrantPermissionPayload(
      payload("qa", "PUBLISH_TO_CHANNEL", true, true),
    );
    expect(err).toContain("ROLE_EXPOSED_TOOLS");
  });

  test("отзыв не блокируем: он действует на любой карте", () => {
    for (const p of [
      payload("qa", "COMMENT_TASK", false, true),
      payload("smm", "PUBLISH_TO_CHANNEL", false, false),
      payload("qa", "PUBLISH_TO_CHANNEL", false, true),
    ]) {
      expect(validateGrantPermissionPayload(p)).toBeNull();
    }
  });

  test("живая строка проходит как раньше", () => {
    expect(
      validateGrantPermissionPayload(payload("smm", "SET_REACTION", true, false)),
    ).toBeNull();
    expect(
      validateGrantPermissionPayload(
        payload("smm", "PUBLISH_TO_CHANNEL", true, true),
      ),
    ).toBeNull();
  });

  test("прежние проверки payload остались первыми", () => {
    // Мёртвая пара + короткий reason: сначала отвечает валидатор payload.
    const p = payload("qa", "COMMENT_TASK", true, true);
    (p as { reason: string }).reason = "ок";
    expect(validateGrantPermissionPayload(p)).toContain("10 characters");
    expect(
      validateGrantPermissionPayload(
        payload("definitely-not-a-role", "COMMENT_TASK", true, true),
      ),
    ).toContain("unknown target_agent_key");
  });
});

describe("handleGrantPermission не пишет строку, которой не будет", () => {
  test("мёртвая строка: ok:false и таблица не тронута", () => {
    const before = getPermission("qa", "COMMENT_TASK");
    restores.push(savePermissions([["qa", "COMMENT_TASK"]]));

    const res = handleGrantPermission(payload("qa", "COMMENT_TASK", true, true), CTX);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("LOW_FRICTION_ACTIONS");
    expect(getPermission("qa", "COMMENT_TASK")).toEqual(before);
  });

  test("живая строка по-прежнему пишется и рапортует переход", () => {
    restores.push(savePermissions([["smm", "SET_REACTION"]]));

    const res = handleGrantPermission(
      payload("smm", "SET_REACTION", true, false),
      CTX,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.target_agent_key).toBe("smm");
      expect(res.result.new).toEqual({ allowed: true, requires_approval: false });
    }
    expect(getPermission("smm", "SET_REACTION")).toMatchObject({
      allowed: true,
      requires_approval: false,
    });
  });
});

describe("оговорка доезжает до владельца, как в двух других входах", () => {
  const risky = [...SEMI_AUTO_RISKY].find(
    (a) => !ALWAYS_APPROVE_ACTIONS.has(a) && isToolExposedToRole(a, "qa"),
  ) as ActionType;

  test("semi_auto-risky: строка живая, но с оговоркой", () => {
    expect(risky).toBeTruthy();
    expect(grantIneffectiveReason("qa", risky, "auto")).toBeNull();
    restores.push(savePermissions([["qa", risky]]));

    const res = handleGrantPermission(payload("qa", risky, true, false), CTX);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.caveat).toContain("SEMI_AUTO_RISKY");
    expect(grantCaveat(risky, "auto")).toContain("SEMI_AUTO_RISKY");
  });

  test("без оговорки поле есть и равно null, а не undefined", () => {
    restores.push(savePermissions([["smm", "SET_REACTION"]]));
    const res = handleGrantPermission(
      payload("smm", "SET_REACTION", true, true),
      CTX,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.caveat).toBeNull();
  });

  test("отзыв оговорки не несёт", () => {
    restores.push(savePermissions([["qa", risky]]));
    const res = handleGrantPermission(payload("qa", risky, false, false), CTX);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.caveat).toBeNull();
  });
});

describe("применение", () => {
  test("третий вход сверяется с рубежом до записи строки", () => {
    const src = readFileSync(
      new URL("../lib/dispatch/permissions.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("grantIneffectiveReason(");
    expect(src.indexOf("grantIneffectiveReason(")).toBeLessThan(
      src.indexOf("setPermission("),
    );
  });

  test("рубеж по-прежнему один — своей копии здесь не завели", () => {
    const src = readFileSync(
      new URL("../lib/dispatch/permissions.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("LOW_FRICTION_ACTIONS.has");
    expect(src).not.toContain("ALWAYS_APPROVE_ACTIONS.has");
  });
});
