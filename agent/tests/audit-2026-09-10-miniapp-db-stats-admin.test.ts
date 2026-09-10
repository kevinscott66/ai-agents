/**
 * Аудит 2026-09-10: `GET /api/db-stats` был открыт любому допущенному.
 *
 * Ручка называется «дашборд обслуживания БД», но стоит она дороже названия.
 * `dbStats` (db-maint.ts:930) делает `COUNT(*)` по всем девятнадцати таблицам
 * `STAT_TABLES` — в том числе по `messages`, `messages_archive` и
 * `agent_actions_archive` — и вдобавок зовёт `dbstatByOwner`, про который его
 * собственный комментарий говорит прямо: «`dbstat` — полный скан БД».
 *
 * `bun:sqlite` синхронна, а поток у процесса один: на нём же сидят 12 ботов,
 * HTTP Mini App и раздача SSE. То есть скан блокирует не того, кто его
 * запросил, а всех. GET-ведро этой ручки — `{capacity: 120, refillPerSec: 4}`,
 * так что четыре полных скана БД в секунду, бесконечно, — это ещё В ПРЕДЕЛАХ
 * политики, а не обход её.
 *
 * MINIAPP_ALLOWED_USER_IDS и MINIAPP_ADMIN_USER_IDS — разные списки, и
 * «наблюдатель без прав» здесь предусмотренная роль (см. докблок у
 * `redactContent`). Именно ей `redactContent` не отдаёт ни одного тела — а
 * размеры и число строк по таблицам отдавались целиком.
 *
 * Гейт поставлен тот же, что у соседей по смыслу: `/api/audit-logs`,
 * `/api/permissions`, `/api/budget-settings` — операторская интроспекция под
 * админом. Экрана «БД» во фронтенде нет (`miniapp/src/pages` его не
 * содержит), так что гейт ничего не ломает.
 */
process.env.MINIAPP_BOT_TOKEN = "miniapp-db-stats-admin-token";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { startMiniappServer, type MiniappServerHandle } from "../lib/miniapp-server.ts";

const BOT_TOKEN = "miniapp-db-stats-admin-token";
const ADMIN_ID = 74311;
const VIEWER_ID = 74312;
// Bun 1.3.14 в этой мастерской не умеет биндить эфемерный порт 0 — берём
// свободный фиксированный, как в соседних HTTP-тестах.
const TEST_PORT = Number(process.env.MINIAPP_DB_STATS_TEST_PORT ?? "28913");

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `db-stats-${userId}`,
    user: JSON.stringify({ id: userId, username: "dbstats", first_name: "D" }),
  });
}

let server: MiniappServerHandle;

async function get(userId: number): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/db-stats`, {
    headers: { "X-Telegram-Init-Data": initData(userId) },
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // Тело может быть пустым — тесту хватит статуса.
  }
  return { status: response.status, body };
}

beforeAll(() => {
  server = startMiniappServer({
    port: TEST_PORT,
    botToken: BOT_TOKEN,
    // Наблюдатель допущен, но не админ — ровно та роль, ради которой
    // разделены два списка.
    allowedUserIds: [ADMIN_ID, VIEWER_ID],
    adminUserIds: [ADMIN_ID],
  });
});

afterAll(() => server.stop());

describe("GET /api/db-stats — операторская интроспекция под админом", () => {
  test("допущенный не-админ получает 403, а не полный скан БД", async () => {
    const r = await get(VIEWER_ID);
    expect(r.status).toBe(403);
    expect(String(r.body?.error)).toBe("admin only");
    // Отказ должен быть ДО работы: ни строк, ни размеров в теле.
    expect(r.body?.stats).toBeUndefined();
  });

  test("админ по-прежнему получает статистику", async () => {
    const r = await get(ADMIN_ID);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body?.stats)).toBe(true);
    // Ручка живая, а не выключенная: сводка по файлу БД на месте.
    expect(r.body.stats.some((s: any) => s.table === "__db_file__")).toBe(true);
  });
});
