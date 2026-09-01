/**
 * Аудит 2026-08-12: Mini App угадывала права пользователя, и угадывала неверно.
 *
 * Settings.tsx (строки 105-113) выводил readonly из 403 на ЧТЕНИИ бюджетов:
 *
 *   api.budgets().catch((e: any) => {
 *     if (e.status === 403) { setReadonly(true); return { budgets: [] }; }
 *     throw e;
 *   })
 *
 * Но GET /api/budgets админом не закрыт (lib/miniapp-server.ts: обработчик
 * `path === "/api/budgets" && method === "GET"` — без requireAdmin; гейт стоит
 * только на POST). Значит 403 не приходит никогда, readonly остаётся false, и
 * не-админ получает редактируемые поля и кнопку «Сохранить», которая падает
 * 403 на каждом ключе по отдельности — после того, как он ввёл цифры.
 *
 * Соседний случай того же класса — Dashboard.tsx:
 *
 *   setCanChangeAutonomy(true); // Assume yes for now
 *
 * то есть переключатель режима автономии показывается всем, а POST
 * /api/autonomy требует админа.
 *
 * Инвариант: сервер сам сообщает клиенту, админ ли он (`admin` в ответе GET
 * /api/budgets и GET /api/autonomy), а не оставляет клиенту гадать по кодам
 * ошибок ручки, которая этих ошибок не отдаёт.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_admin_flag_placeholder";
const ADMIN_ID = 900_701;
/** Пущен в приложение, но не админ — именно он видел редактируемые поля. */
const PLAIN_ID = 900_702;

let server: MiniappServerHandle;
let base: string;
const sessionCookies = new Map<number, string>();

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

async function call(
  path: string,
  userId: number,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "X-Telegram-Init-Data": initData(userId),
      ...(sessionCookies.has(userId) ? { Cookie: sessionCookies.get(userId)! } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) sessionCookies.set(userId, setCookie.split(";", 1)[0]);
  return response;
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, PLAIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
});

describe("права приходят с сервера, а не угадываются по 403", () => {
  test("GET /api/budgets не отдаёт 403 не-админу — детект по ошибке нерабочий", async () => {
    const r = await call("/api/budgets", PLAIN_ID);
    expect(r.status).toBe(200);
  });

  test("но POST /api/budgets ему запрещён — вот откуда падение при сохранении", async () => {
    const r = await call("/api/budgets", PLAIN_ID, {
      method: "POST",
      body: JSON.stringify({ agentKey: "backend", dailyInputTokens: 1000 }),
    });
    expect(r.status).toBe(403);
  });

  test("GET /api/budgets сообщает admin:false не-админу", async () => {
    const r = await call("/api/budgets", PLAIN_ID);
    expect(await r.json()).toMatchObject({ admin: false });
  });

  test("GET /api/budgets сообщает admin:true админу", async () => {
    const r = await call("/api/budgets", ADMIN_ID);
    expect(await r.json()).toMatchObject({ admin: true });
  });

  test("GET /api/autonomy сообщает, можно ли менять режим", async () => {
    const plain = await call("/api/autonomy", PLAIN_ID);
    const admin = await call("/api/autonomy", ADMIN_ID);
    expect([
      (await plain.json()).admin,
      (await admin.json()).admin,
    ]).toEqual([false, true]);
  });

  test("флаг согласован с реальным гейтом POST /api/autonomy", async () => {
    const flag = (await (await call("/api/autonomy", PLAIN_ID)).json()).admin;
    const post = await call("/api/autonomy", PLAIN_ID, {
      method: "POST",
      body: JSON.stringify({ mode: "manual" }),
    });
    expect({ flag, allowed: post.status !== 403 }).toEqual({
      flag: false,
      allowed: false,
    });
  });
});
