/**
 * Аудит 2026-08-28 — валидация query-параметров на GET-эндпоинтах Mini App.
 *
 * Две находки, один класс: параметр из строки запроса уезжал в SQL без
 * проверки, а неразобранное значение отвечало кодом 200.
 *
 * F1. `chat_id`. Шесть чтений (`/api/tasks`, `/api/approvals` — обе ветки,
 *     `/api/actions`, `/api/audit-logs`, `/api/autonomy`) делали
 *     `Number(chatIdParam)`, тогда как оба мутирующих POST рядом уже гоняли
 *     то же значение через `strictChatId`. `Number("abc")` — это `NaN`, а
 *     `NaN` в SQLite не равен ничему, включая себя: `WHERE chat_id = NaN`
 *     даёт ноль строк, то есть `200 {"tasks": []}`, неотличимый от честного
 *     «в чате пусто».
 *
 *     Отдельно `/api/autonomy`: там `NaN` не давал даже пустого ответа.
 *     `getAutonomy(NaN, agent)` проходит проверки `chatId !== undefined`,
 *     не находит строк со `scope_id = 'NaN'` и доходит до agent- или
 *     глобального режима. Наружу шёл настоящий `mode` от совсем другой
 *     области и `chat_id: NaN`, который `JSON.stringify` печатает как `null`.
 *
 * F2. `status` у `/api/approvals`. Значение по умолчанию `"pending"`, всё
 *     остальное — прямо в `WHERE status = ?`. Опечатка `?status=aproved`
 *     отвечала `200 {"approvals": []}`: «решений не было» и «ты неправильно
 *     написал статус» выглядели одинаково. У соседнего `/api/tasks` этот
 *     класс закрыт через `TASK_STATUSES` ещё 2026-08-20 — здесь такого
 *     списка просто не существовало, и он заведён (`APPROVAL_STATUSES`).
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_chatid_0828";

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  _resetRateLimiter,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { APPROVAL_STATUSES } from "../lib/approvals.ts";
import { setAutonomy, getAutonomy } from "../lib/permissions.ts";
import { createTask } from "../lib/tasks.ts";
import { cleanupChat } from "./_helpers.ts";

const BOT_TOKEN = "test_bot_token_chatid_0828";
const ADMIN_ID = 828_101;
const CHAT_ID = -1_000_828_101;

function freshInitData(userId = ADMIN_ID): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q${Math.random().toString(36).slice(2)}`,
    user: JSON.stringify({ id: userId, username: "cid", first_name: "C" }),
  });
}

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  cleanupChat(CHAT_ID);
});

beforeEach(() => {
  _resetRateLimiter();
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    headers: { "x-telegram-init-data": freshInitData() },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

/**
 * Эндпоинты, читающие `chat_id`. `/api/audit-logs` и остальные admin-гейтед
 * или нет — здесь неважно: тестовый пользователь и allowlisted, и админ,
 * так что до разбора параметра доходят все.
 */
const CHAT_ID_ROUTES = [
  "/api/tasks",
  "/api/approvals",
  "/api/approvals?status=approved",
  "/api/actions",
  "/api/audit-logs",
  "/api/autonomy",
];

/** Значения, которые `Number()` съедал молча, а `strictChatId` отвергает. */
const BAD_CHAT_IDS = [
  "abc",
  "1.5",
  "-100e3",
  "0x10",
  " 100",
  "",
  // За пределами Number.MAX_SAFE_INTEGER: разбирается в число, но не в то,
  // которое прислали, — молчаливая подмена id чата.
  "99999999999999999999",
];

describe("F1 — chat_id на GET-эндпоинтах", () => {
  for (const route of CHAT_ID_ROUTES) {
    for (const bad of BAD_CHAT_IDS) {
      test(`${route} с chat_id=${JSON.stringify(bad)} → 400`, async () => {
        const sep = route.includes("?") ? "&" : "?";
        const r = await get(`${route}${sep}chat_id=${encodeURIComponent(bad)}`);
        expect(r.status).toBe(400);
        expect(String(r.body?.error)).toMatch(/chat_id must be an integer/);
      });
    }
  }

  for (const route of CHAT_ID_ROUTES) {
    test(`${route} с корректным chat_id по-прежнему 200`, async () => {
      const sep = route.includes("?") ? "&" : "?";
      const r = await get(`${route}${sep}chat_id=${CHAT_ID}`);
      expect(r.status).toBe(200);
    });

    test(`${route} без chat_id по-прежнему 200`, async () => {
      const r = await get(route);
      expect(r.status).toBe(200);
    });
  }

  test("/api/tasks?chat_id=<чат> отдаёт задачи именно этого чата", async () => {
    cleanupChat(CHAT_ID);
    createTask({
      title: "chat-id-scope-0828",
      chatId: CHAT_ID,
      createdBy: "qa",
    });
    const r = await get(`/api/tasks?chat_id=${CHAT_ID}&limit=200`);
    expect(r.status).toBe(200);
    expect(r.body.tasks.length).toBe(1);
    expect(r.body.tasks[0].title).toBe("chat-id-scope-0828");
    cleanupChat(CHAT_ID);
  });

  test("/api/autonomy с мусорным chat_id больше не выдаёт режим чужой области", async () => {
    // Замер бага: чату ставим locked, спрашиваем про несуществующий "abc".
    // До фикса ответ приходил 200 с глобальным режимом и `chat_id: null` —
    // то есть выглядел как честный ответ про глобальный scope.
    setAutonomy("chat", String(CHAT_ID), "locked");
    try {
      const bad = await get("/api/autonomy?chat_id=abc");
      expect(bad.status).toBe(400);
      expect(bad.body?.mode).toBeUndefined();

      const good = await get(`/api/autonomy?chat_id=${CHAT_ID}`);
      expect(good.status).toBe(200);
      expect(good.body.mode).toBe("locked");
      expect(good.body.chat_id).toBe(CHAT_ID);

      // Без параметра — глобальная область, и она не «locked» из-за чата.
      const global = await get("/api/autonomy");
      expect(global.status).toBe(200);
      expect(global.body.chat_id).toBe(null);
      expect(global.body.mode).toBe(getAutonomy());
    } finally {
      cleanupChat(CHAT_ID);
    }
  });
});

describe("F2 — status у /api/approvals", () => {
  test("неизвестный статус → 400 со списком допустимых", async () => {
    const r = await get("/api/approvals?status=aproved");
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(/unknown status: aproved/);
    expect(r.body.allowed).toEqual(APPROVAL_STATUSES);
  });

  test("APPROVAL_STATUSES покрывает весь union", () => {
    expect([...APPROVAL_STATUSES].sort()).toEqual([
      "approved",
      "expired",
      "failed",
      "pending",
      "rejected",
    ]);
  });

  for (const status of ["pending", "approved", "rejected", "failed", "expired"]) {
    test(`статус ${status} принимается → 200`, async () => {
      const r = await get(`/api/approvals?status=${status}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.approvals)).toBe(true);
    });
  }

  test("пустой status → 400, а не молчаливый скан по пустой строке", async () => {
    const r = await get("/api/approvals?status=");
    expect(r.status).toBe(400);
  });
});
