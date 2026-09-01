/**
 * Аудит 2026-08-20: чтение настроек бюджета отдавало Telegram-ID админа
 * любому допущенному пользователю.
 *
 * `GET /api/budget-settings` не был закрыт `requireAdmin`, а
 * `getAllBudgetSettings` выбирает колонку `updated_by`. Пишет её `POST
 * /api/budgets` — единственная ручка, меняющая бюджеты, закрытая админ-гейтом,
 * — в виде `miniapp:<user.id>`. То есть допущенный не-админ («наблюдатель»)
 * одним GET'ом читал сырой Telegram-ID админа: ровно ту величину, которую
 * access-лог этажом ниже прогоняет через `redactUserId`.
 *
 * Комментарий у POST это состояние даже фиксировал («GET /api/budget-settings
 * отдаёт колонку любому allowlisted-пользователю») — но как аргумент за то,
 * чтобы не верить `body.updatedBy` на записи. Сторону чтения не закрыли.
 *
 * Инвариант: чтение закрыто тем же гейтом, что и запись — у них здесь один
 * смысл «кто управляет бюджетами». Числа расхода допущенным по-прежнему видны:
 * их отдаёт GET /api/budgets, и он открыт намеренно.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_budget_gate";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";
import { setBudget } from "../lib/token-budget.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "test_bot_token_for_budget_gate";
const ADMIN_ID = 88_311;
const VIEWER_ID = 88_312;
const AGENT_KEY = "qa";

let server: MiniappServerHandle;
let base: string;

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-budget-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

function get(path: string, userId: number): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: { "X-Telegram-Init-Data": initData(userId) },
  });
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, VIEWER_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
  // Строка с актором именно того вида, который пишет POST /api/budgets.
  setBudget(AGENT_KEY, 12_345, `miniapp:${ADMIN_ID}`);
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
  db.prepare(`DELETE FROM budget_settings WHERE agent_key = ?`).run(AGENT_KEY);
});

describe("GET /api/budget-settings", () => {
  test("допущенный не-админ получает 403 и ничего не читает", async () => {
    const r = await get("/api/budget-settings", VIEWER_ID);
    const text = await r.text();
    expect(r.status).toBe(403);
    // И в теле отказа тоже нет ни ID админа, ни самих настроек.
    expect(text).not.toContain(String(ADMIN_ID));
    expect(text).not.toContain(AGENT_KEY);
  });

  test("админ читает настройки вместе с актором", async () => {
    const r = await get("/api/budget-settings", ADMIN_ID);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      settings: Array<{ agentKey: string; updatedBy: string }>;
    };
    const row = body.settings.find((s) => s.agentKey === AGENT_KEY);
    expect(row?.updatedBy).toBe(`miniapp:${ADMIN_ID}`);
  });

  test("расход бюджета не-админу по-прежнему виден", async () => {
    // Гейт не должен утащить за собой соседнюю ручку: числа расхода — это то,
    // ради чего наблюдателя и пускают.
    const r = await get("/api/budgets", VIEWER_ID);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { budgets: unknown[]; admin: boolean };
    expect(Array.isArray(body.budgets)).toBe(true);
    expect(body.admin).toBe(false);
  });
});
