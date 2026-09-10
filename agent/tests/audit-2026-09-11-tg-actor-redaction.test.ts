/**
 * Аудит 2026-09-11: у решения по заявке ДВА писателя, а редакция знала одного.
 *
 * `redactContent` укорачивает актора по ЗНАЧЕНИЮ (аудит 2026-08-21), и шаблон
 * там ровно один — `miniapp:<цифры>`. Но `approvals.decided_by` пишет не
 * только Mini App: `/approve` и `/reject` в Telegram кладут туда
 * `deciderIdentity(ctx)` = `tg:<id> (@username)` (admin-commands.ts:172).
 * Строка такого вида шаблону не соответствовала и уезжала наружу целиком.
 *
 * Ручка `GET /api/approvals` админа не требует — по политике модуля читалки
 * живут на allowlist, а мутирующие ручки на списке админов. То есть
 * наблюдатель, которому тела заявок уже закрыли, открывал список решённых и
 * читал сырой Telegram-ID владельца плюс его @username — по любому из двух
 * открывается профиль. Это та же дыра, что закрывали в 2026-08-21, просто с
 * другого писателя.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { createApproval, decideApproval } from "../lib/approvals.ts";
import { logAction } from "../lib/audit.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_tg_actor_redaction";
// Цифры админа и чата не пересекаются: иначе проверка «сырого ID нет во всём
// ответе» ловила бы chat_id и была бы красной независимо от редакции.
const ADMIN_ID = 744_556_677;
const VIEWER_ID = 744_556_688; // в allowlist, но не админ
const CHAT_ID = -100_944_712;

/** Ровно то, что кладёт `deciderIdentity` при решении из Telegram. */
const TG_ACTOR = `tg:${ADMIN_ID} (@ownerhandle)`;
const TG_ACTOR_SHORT = "tg:…6677";
/** Апдейт без from.id — id нет, прятать нечего. */
const TG_UNKNOWN = "tg:unknown";

function initDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

let server: MiniappServerHandle;
let base: string;
let approvedId: string;
let unknownId: string;

async function get(path: string, userId: number): Promise<any> {
  const r = await fetch(`${base}${path}`, {
    headers: { "X-Telegram-Init-Data": initDataFor(userId) },
  });
  expect(r.status).toBe(200);
  return r.json();
}

function decided(status: "approved" | "rejected", by: string): string {
  const actionId = logAction({
    agentKey: "smm",
    chatId: CHAT_ID,
    actionType: "SEND_MESSAGE",
    payload: { chatId: CHAT_ID },
    status: "pending_approval",
  }).id;
  const id = createApproval({
    actionId,
    chatId: CHAT_ID,
    requestedBy: "smm",
    actionType: "SEND_MESSAGE",
    payload: { chatId: CHAT_ID },
  }).id;
  decideApproval(id, status, by);
  return id;
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, VIEWER_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
  approvedId = decided("approved", TG_ACTOR);
  unknownId = decided("rejected", TG_UNKNOWN);
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT_ID);
});

describe("решение из Telegram не выдаёт наблюдателю личность админа", () => {
  test("decided_by укорочен, ни ID, ни @username в ответе нет", async () => {
    const body = await get(
      `/api/approvals?status=approved&chat_id=${CHAT_ID}&limit=200`,
      VIEWER_ID,
    );
    // Утечка была именно здесь.
    expect(JSON.stringify(body)).not.toContain(String(ADMIN_ID));
    expect(JSON.stringify(body)).not.toContain("ownerhandle");
    const mine = body.approvals.find((a: any) => a.id === approvedId);
    expect(mine).toBeTruthy();
    expect(mine.decided_by).toBe(TG_ACTOR_SHORT);
    // Список остаётся читаемым: кто просил, что и чем кончилось.
    expect(mine.requested_by).toBe("smm");
    expect(mine.status).toBe("approved");
  });

  test("`tg:unknown` прятать нечего — проходит как есть", async () => {
    const body = await get(
      `/api/approvals?status=rejected&chat_id=${CHAT_ID}&limit=200`,
      VIEWER_ID,
    );
    const row = body.approvals.find((a: any) => a.id === unknownId);
    expect(row).toBeTruthy();
    expect(row.decided_by).toBe(TG_UNKNOWN);
  });

  test("админу решение видно целиком", async () => {
    const body = await get(
      `/api/approvals?status=approved&chat_id=${CHAT_ID}&limit=200`,
      ADMIN_ID,
    );
    expect(body.approvals.find((a: any) => a.id === approvedId).decided_by).toBe(
      TG_ACTOR,
    );
  });
});
