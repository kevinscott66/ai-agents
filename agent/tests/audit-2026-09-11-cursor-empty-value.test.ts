/**
 * Аудит 2026-09-11: пустой курсор проходил сквозь обе проверки пагинации.
 *
 * Соседние докблоки в `miniapp-server.ts` объявляют класс «фильтр молча не
 * применился» закрытым (аудиты 2026-08-13 и 2026-09-10: «неизвестный id — это
 * 400, а не „покажу с начала"»), но пустая строка — не «неизвестное значение»
 * и не `null`, и валидация её не ловила:
 *
 *  — `?before=` → `Number("") === 0`, то есть конечное число, проверка
 *    пропускала. Дальше `if (before && …)` оказывалось ложным, и вместе с
 *    границей страницы исчезал `before_id`, который живёт только внутри того
 *    же блока. Ответ — 200 с самой свежей страницей: клиент (Logs.tsx)
 *    дописывает её к списку и снова берёт курсором последний показанный
 *    элемент. Хуже того, `?before=&before_id=<id>` обходил и проверку
 *    «before_id без before — 400»: `"" !== null`.
 *  — `?before=%20` доходил до SQL и давал `created_at < 0` — пустую страницу,
 *    неотличимую от конца журнала.
 *
 * Пустое значение теперь значит «курсора нет» (`cursorParam`), а не «курсор в
 * нуле», и дальше работают обычные правила отсутствующего параметра.
 */
process.env.MINIAPP_BOT_TOKEN = "miniapp-cursor-empty-token";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { startMiniappServer, type MiniappServerHandle } from "../lib/miniapp-server.ts";
import { emitAlert } from "../lib/alerting.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "miniapp-cursor-empty-token";
const ADMIN_ID = 74_311;
const CODE = "cursor.empty.probe";

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `cursor-${userId}`,
    user: JSON.stringify({ id: userId, username: "cursor", first_name: "C" }),
  });
}

let server: MiniappServerHandle;

async function get(pathAndQuery: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathAndQuery}`, {
    headers: { "X-Telegram-Init-Data": initData(ADMIN_ID) },
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function logsOf(body: any): any[] {
  return body?.logs ?? body?.auditLogs ?? [];
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  // Строка в журнале нужна, чтобы «пустая страница» отличалась от «страницы».
  emitAlert("warn", CODE, "проба курсора");
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
  db.prepare(`DELETE FROM audit_logs WHERE event_type = ?`).run(`alert.${CODE}`);
});

describe("GET /api/audit-logs — пустой курсор", () => {
  test("пробельный before не превращается в `created_at < 0`", async () => {
    const r = await get("/api/audit-logs?before=%20");
    expect(r.status).toBe(200);
    // До правки здесь был пустой список — «конец журнала» посреди журнала.
    expect(logsOf(r.body).length).toBeGreaterThan(0);
  });

  test("пустой before не проносит before_id мимо проверки", async () => {
    const r = await get("/api/audit-logs?before=&before_id=42");
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("before_id");
  });

  test("пустой before без тай-брейка — это просто первая страница", async () => {
    const r = await get("/api/audit-logs?before=");
    expect(r.status).toBe(200);
    expect(logsOf(r.body).length).toBeGreaterThan(0);
  });

  test("числовой курсор по-прежнему режет выборку", async () => {
    const r = await get("/api/audit-logs?before=1");
    expect(r.status).toBe(200);
    expect(logsOf(r.body).length).toBe(0);
  });
});

describe("GET /api/actions — пустой курсор", () => {
  test("пустой before_id — первая страница, а не `unknown before_id`", async () => {
    const r = await get("/api/actions?before_id=");
    expect(r.status).toBe(200);
  });

  test("пробельный before_id — тоже отсутствие курсора", async () => {
    const r = await get("/api/actions?before_id=%20");
    expect(r.status).toBe(200);
  });

  test("настоящий неизвестный id по-прежнему 400", async () => {
    const r = await get("/api/actions?before_id=no-such-action");
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("before_id");
  });
});
