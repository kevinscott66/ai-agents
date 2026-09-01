/**
 * Аудит 2026-08-04 — валидация входа мутирующих ручек Mini App.
 *
 * Три дыры одного класса: значение из тела запроса уходило в БД как ключ, но
 * никто не проверял, что такой ключ существует.
 *
 * 1. /api/permissions POST — `agentKey` не сверялся с CHARACTERS. Опечатка
 *    ("Backend" вместо "backend") записывала строку в permissions и возвращала
 *    200 с эхом «право выдано». evaluateGate ищет agent_key='backend' и этой
 *    строки не видит НИКОГДА — молчаливый no-op, показанный админу как успех.
 *    Симметрично опасно в обе стороны: и «выдал право, а его нет», и «отозвал
 *    право, а оно осталось».
 * 2. /api/budgets POST — то же самое с лимитом токенов.
 * 3. /api/autonomy POST — то же самое в агентской ветке; плюс chat_id
 *    приводился голым String(), так что `{}` становился "[object Object]".
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_akv";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { getAutonomy } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "test_bot_token_for_akv";
const ADMIN_ID = 771001;

function initData(userId = ADMIN_ID): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q-akv",
    user: JSON.stringify({ id: userId, username: "akv", first_name: "A" }),
  });
}

let server: MiniappServerHandle;
let base: string;

// Файл проверяет ручку, которая ПИШЕТ права, — и пишет их по-настоящему, на
// живую роль. Без снимка `backend/SEND_MESSAGE` оставался с
// requires_approval=true до конца прогона, и c3.test.ts («12 ролей × 6 действий
// по сиду») падал, если запускался после. T-751.
let restorePerms: () => void;

beforeAll(() => {
  restorePerms = savePermissions([["backend", "SEND_MESSAGE"]]);
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

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-init-data": initData(),
    },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {}
  return { status: res.status, body: parsed };
}

describe("Mini App: agentKey сверяется с реестром ролей", () => {
  test("POST /api/permissions на несуществующую роль → 400, в БД ничего", async () => {
    const r = await post("/api/permissions", {
      agentKey: "Backend", // верхний регистр — не ключ роли
      actionType: "PUBLISH_TO_CHANNEL",
      allowed: true,
      requires_approval: false,
    });
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("unknown agentKey");

    const row = db
      .prepare(`SELECT 1 AS x FROM permissions WHERE agent_key = ?`)
      .get("Backend");
    expect(row).toBeFalsy();
  });

  // Ручка пишет РЕАЛЬНУЮ таблицу permissions, и до 2026-08-14 backend ×
  // SEND_MESSAGE так и оставался с requires_approval=1 до конца прогона. Это
  // ровно вторая выборка в c3 («permissions: default seed»), и в CI, где
  // порядок файлов другой, тот падал на чужой единице. Возвращаем как было.
  test("POST /api/permissions на реальную роль по-прежнему работает", async () => {
    // Через хелпер, а не `getPermission` + `setPermission`: на отсутствующей
    // строке `getPermission` отдаёт `{allowed:false}`, и «восстановление»
    // оставило бы явный запрет там, где строки не было вовсе.
    const restore = savePermissions([["backend", "SEND_MESSAGE"]]);
    try {
      const r = await post("/api/permissions", {
        agentKey: "backend",
        actionType: "SEND_MESSAGE",
        allowed: true,
        requires_approval: true,
      });
      expect(r.status).toBe(200);
      expect(r.body?.permission?.agentKey).toBe("backend");
    } finally {
      restore();
    }
  });

  test("POST /api/budgets на несуществующую роль → 400", async () => {
    const r = await post("/api/budgets", {
      agentKey: "nosuchrole",
      dailyInputTokens: 12345,
    });
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("unknown agentKey");
  });

  test("POST /api/autonomy с agent=несуществующий → 400, режим не записан", async () => {
    const r = await post("/api/autonomy", {
      agent: "Orchestrator",
      mode: "auto",
    });
    expect(r.status).toBe(400);
    const row = db
      .prepare(
        `SELECT 1 AS x FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`,
      )
      .get("Orchestrator");
    expect(row).toBeFalsy();
  });

  test("POST /api/autonomy с agent=реальный работает", async () => {
    const r = await post("/api/autonomy", { agent: "qa", mode: "manual" });
    expect(r.status).toBe(200);
    expect(getAutonomy(undefined, "qa")).toBe("manual");
  });
});

describe("Mini App: chat_id больше не приводится голым String()", () => {
  test("объект вместо chat_id → 400, а не scope_key '[object Object]'", async () => {
    const r = await post("/api/autonomy", { chat_id: {}, mode: "auto" });
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("chat_id");

    const row = db
      .prepare(
        `SELECT 1 AS x FROM autonomy_modes WHERE scope = 'chat' AND scope_id = ?`,
      )
      .get("[object Object]");
    expect(row).toBeFalsy();
  });

  test("нечисловая строка → 400", async () => {
    const r = await post("/api/autonomy", { chat_id: "all", mode: "auto" });
    expect(r.status).toBe(400);
  });

  test("число и числовая строка принимаются", async () => {
    const a = await post("/api/autonomy", { chat_id: -100777, mode: "manual" });
    expect(a.status).toBe(200);
    expect(getAutonomy(-100777)).toBe("manual");

    const b = await post("/api/autonomy", { chat_id: "-100778", mode: "auto" });
    expect(b.status).toBe(200);
    expect(getAutonomy(-100778)).toBe("auto");
  });
});
