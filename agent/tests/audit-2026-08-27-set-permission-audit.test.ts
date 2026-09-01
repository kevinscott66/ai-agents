/**
 * Аудит 2026-08-27 — смена прав без следа в аудите.
 *
 * `setPermission` — единственная запись в таблицу `permissions`, то есть точка,
 * где ролям выдают и отбирают действия. Аудит писал ровно один из трёх продовых
 * вызовов — `handleGrantPermission` в `dispatch/permissions.ts` (действие
 * агента, которое само по себе проходит через диспетчер). Два оставшихся,
 * человеческих, писали молча:
 *
 *  - `POST /api/permissions` в Mini App (admin-gated);
 *  - команды `/grant` и `/revoke`.
 *
 * Результат: в БД лежит `permissions.allowed = 1`, а кто и когда его поставил —
 * не восстановить ни через Mini App, ни через GET_LOGS, ни SQL-запросом. Ровно
 * тот класс, что чинили для QUERY_DB (`logToolCall`, audit.ts): действие с
 * последствиями обязано оставлять строку.
 *
 * Здесь три вещи: поведение нового необязательного параметра `audit`, обе
 * человеческие ручки end-to-end, и статический гейт — чтобы вызов без аудита
 * не завёлся в продовом коде заново.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_spa";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { getPermission, setPermission } from "../lib/permissions.ts";
import { cmdGrant, cmdRevoke } from "../lib/commands.ts";
import { savePermissions } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "test_bot_token_for_spa";
const ADMIN_ID = 774221;

interface AuditRow {
  agent_key: string;
  chat_id: number | null;
  payload: string | null;
}

/** Строки аудита о смене прав конкретной роли, свежие сначала. */
function permissionAudit(targetAgentKey: string): AuditRow[] {
  const rows = db
    .prepare(
      `SELECT agent_key, chat_id, payload FROM agent_actions
        WHERE action_type = 'GRANT_PERMISSION'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 50`,
    )
    .all() as AuditRow[];
  return rows.filter((r) => {
    try {
      return JSON.parse(r.payload ?? "{}").target_agent_key === targetAgentKey;
    } catch {
      return false;
    }
  });
}

let server: MiniappServerHandle;
let base: string;
let restorePerms: () => void;

beforeAll(() => {
  restorePerms = savePermissions([
    ["qa", "DELETE_MESSAGE"],
    ["qa", "SET_REACTION"],
    ["backend", "SEND_MESSAGE"],
    ["design", "PIN_MESSAGE"],
  ]);
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  restorePerms();
  server.stop();
});

describe("setPermission: параметр audit", () => {
  test("без audit строки в agent_actions не появляется", () => {
    const before = permissionAudit("design").length;
    setPermission("design", "PIN_MESSAGE", {
      allowed: true,
      requires_approval: false,
    });
    expect(permissionAudit("design").length).toBe(before);
  });

  test("с audit пишется диф old → new и канал изменения", () => {
    setPermission("backend", "SEND_MESSAGE", {
      allowed: false,
      requires_approval: false,
    });
    setPermission(
      "backend",
      "SEND_MESSAGE",
      { allowed: true, requires_approval: true },
      { changedBy: "miniapp:42", chatId: 42, source: "miniapp", reason: "why" },
    );

    const row = permissionAudit("backend")[0];
    expect(row).toBeDefined();
    expect(row!.agent_key).toBe("miniapp:42");
    const payload = JSON.parse(row!.payload!);
    expect(payload.action_type).toBe("SEND_MESSAGE");
    expect(payload.old).toEqual({ allowed: false, requires_approval: false });
    expect(payload.new).toEqual({ allowed: true, requires_approval: true });
    expect(payload.source).toBe("miniapp");
    expect(payload.reason).toBe("why");
    expect(payload._diff).toBe(true);
  });
});

describe("человеческие ручки оставляют след", () => {
  test("POST /api/permissions пишет, кто именно поменял", async () => {
    const before = permissionAudit("qa").length;
    const res = await fetch(`${base}/api/permissions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": buildInitData(BOT_TOKEN, {
          auth_date: String(Math.floor(Date.now() / 1000)),
          query_id: "q-spa",
          user: JSON.stringify({ id: ADMIN_ID, username: "spa" }),
        }),
      },
      body: JSON.stringify({
        agentKey: "qa",
        actionType: "DELETE_MESSAGE",
        allowed: true,
        requires_approval: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(getPermission("qa", "DELETE_MESSAGE").allowed).toBe(true);

    const rows = permissionAudit("qa");
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.agent_key).toBe(`miniapp:${ADMIN_ID}`);
    expect(JSON.parse(rows[0]!.payload!).source).toBe("miniapp");
  });

  test("/grant и /revoke пишут актора и чат", () => {
    const before = permissionAudit("qa").length;
    cmdGrant({
      args: ["qa", "SET_REACTION", "approval"],
      changedBy: "tg:900",
      chatId: -100500,
    });
    cmdRevoke({ args: ["qa", "SET_REACTION"], changedBy: "tg:900", chatId: -100500 });

    const rows = permissionAudit("qa");
    expect(rows.length).toBe(before + 2);
    for (const r of rows.slice(0, 2)) {
      expect(r.agent_key).toBe("tg:900");
      expect(r.chat_id).toBe(-100500);
      expect(JSON.parse(r.payload!).source).toBe("command");
    }
    // Последняя по времени — отзыв: allowed:false.
    expect(JSON.parse(rows[0]!.payload!).new).toEqual({
      allowed: false,
      requires_approval: false,
    });
  });

  test("без явного актора команда всё равно пишет строку", () => {
    const before = permissionAudit("qa").length;
    cmdGrant({ args: ["qa", "SET_REACTION", "auto"] });
    const rows = permissionAudit("qa");
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.agent_key).toBe("admin");
  });
});

describe("статический гейт: продовый вызов без аудита не проходит", () => {
  /**
   * `audit` необязателен — им пользуются сиды и тесты, где актора нет. Чтобы
   * послабление не разъехалось обратно, каждый вызов в `agent/lib/**` обязан
   * либо передавать четвёртый аргумент, либо стоять в списке исключений с
   * причиной.
   */
  const EXEMPT = new Map<string, string>([
    // Определение функции.
    ["permissions.ts", "здесь setPermission объявлен"],
    // Пишет собственную строку GRANT_PERMISSION с old/new и reason сразу
    // после вызова — см. handleGrantPermission.
    ["dispatch/permissions.ts", "аудирует отдельным logAction рядом с вызовом"],
  ]);

  function tsFiles(dir: string, prefix = ""): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...tsFiles(join(dir, e.name), rel));
      else if (e.name.endsWith(".ts")) out.push(rel);
    }
    return out;
  }

  test("каждый setPermission( в agent/lib передаёт audit", () => {
    const libDir = join(import.meta.dir, "..", "lib");
    const offenders: string[] = [];
    for (const rel of tsFiles(libDir)) {
      if (EXEMPT.has(rel)) continue;
      const src = readFileSync(join(libDir, rel), "utf8");
      let idx = src.indexOf("setPermission(");
      while (idx !== -1) {
        // Аргументы вызова целиком: от открывающей скобки до парной ей.
        let depth = 0;
        let end = idx + "setPermission".length;
        for (; end < src.length; end++) {
          if (src[end] === "(") depth++;
          else if (src[end] === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        const call = src.slice(idx, end + 1);
        if (!call.includes("source:")) {
          offenders.push(`${rel}: ${call.split("\n")[0]}`);
        }
        idx = src.indexOf("setPermission(", end);
      }
    }
    expect(offenders).toEqual([]);
  });
});
