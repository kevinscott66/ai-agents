/**
 * Аудит 2026-08-12: постраничная выдача журналов Mini App теряла строки на
 * границе страницы.
 *
 * Курсор был построен на одном только времени:
 *
 *   /api/actions:     getAction(before_id).created_at → `created_at < ?`
 *   /api/audit-logs:  ?before=<ms>                    → `created_at < ?`
 *
 * а сортировка — `ORDER BY created_at DESC` без второго ключа. `created_at`
 * это `Date.now()` в миллисекундах, и один тик держит сразу пачку записей:
 * дispatcher внутри одного хода агента пишет в agent_actions по строке на
 * действие, alerting — по строке на алерт. Всё, что делит миллисекунду с
 * последней строкой страницы, отсекается строгим `<` и не попадает НИ на одну
 * страницу. Порядок внутри одинакового created_at при этом не определён, так
 * что и сама первая страница от запроса к запросу могла отдавать разные строки.
 *
 * Хуже всего то, как это выглядит: Logs.tsx:139 держит `hasMore` как
 * `r.actions.length === PAGE`. Страница, у которой пропали строки, приходит
 * короче лимита — и UI объявляет «это конец списка». То есть потеря данных
 * маскируется под нормальное завершение пагинации.
 *
 * Тот же класс, что уже чинили в порядке сообщений (`ORDER BY ts DESC, id DESC`,
 * коммит dcbac3c): при равных ключах нужен тай-брейк, и он же должен входить в
 * курсор.
 *
 * Инвариант: пролистав страницами, читатель видит КАЖДУЮ строку ровно один раз,
 * даже если все они записаны в одну миллисекунду.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_pagination_tiebreak";
const ADMIN_ID = 900_501;
const CHAT_ID = -100_900_501;
const AGENT_KEY = "pagination_tiebreak_probe";
const EVENT_TYPE = "pagination_tiebreak_probe";

/** Все записи в одной миллисекунде — то, что делает диспетчер за один ход. */
const SAME_MS = 1_770_000_000_000;
const N = 6;
const PAGE = 3;

/**
 * Аудит 2026-08-20: файл поднимает настоящий HTTP-сервер и ходит в него
 * `fetch`. Утверждения здесь про ДАННЫЕ, а не про скорость, но дефолтный
 * таймаут теста — пять секунд, и на нагруженной машине в полном прогоне файл
 * краснел, хотя в одиночку идёт за треть секунды. `bun test` перед push обязан
 * давать один и тот же ответ на одном и том же коде, поэтому таймаут задан
 * явно и с запасом: он ловит зависший сервер, а не занятый ноутбук.
 */
const IO_TIMEOUT_MS = 30_000;

let server: MiniappServerHandle;
let base: string;

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

async function get(path: string): Promise<any> {
  const r = await fetch(`${base}${path}`, {
    headers: { "X-Telegram-Init-Data": initData(ADMIN_ID) },
  });
  expect(r.status).toBe(200);
  return r.json();
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;

  const insAction = db.prepare(
    `INSERT INTO agent_actions
       (id, agent_key, task_id, chat_id, action_type, payload, status, result, error, created_at)
     VALUES (?, ?, NULL, ?, 'SEND_MESSAGE', '{}', 'ok', NULL, NULL, ?)`,
  );
  const insAudit = db.prepare(
    `INSERT INTO audit_logs (id, agent_key, chat_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, '{}', ?)`,
  );
  for (let i = 0; i < N; i++) {
    // id-шки заведомо не в том же порядке, что вставка, — тай-брейк должен
    // давать устойчивый порядок сам по себе, а не совпадать с insert order.
    const suffix = String((i * 7) % 10) + String(i);
    insAction.run(`ptb_act_${suffix}`, AGENT_KEY, CHAT_ID, SAME_MS);
    insAudit.run(`ptb_log_${suffix}`, AGENT_KEY, CHAT_ID, EVENT_TYPE, SAME_MS);
  }
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
  db.prepare(`DELETE FROM agent_actions WHERE agent_key = ?`).run(AGENT_KEY);
  db.prepare(`DELETE FROM audit_logs WHERE event_type = ?`).run(EVENT_TYPE);
});

describe("/api/actions: пагинация при одинаковом created_at", () => {
  test("пролистывание отдаёт все строки ровно по одному разу", async () => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ agent: AGENT_KEY, limit: String(PAGE) });
      if (before) qs.set("before_id", before);
      const r = await get(`/api/actions?${qs}`);
      if (r.actions.length === 0) break;
      for (const a of r.actions) seen.push(a.id);
      before = r.actions[r.actions.length - 1].id;
      if (r.actions.length < PAGE) break;
    }
    expect({ total: seen.length, unique: new Set(seen).size }).toEqual({
      total: N,
      unique: N,
    });
  }, IO_TIMEOUT_MS);

  test("порядок внутри одинакового created_at детерминирован", async () => {
    const a = await get(`/api/actions?agent=${AGENT_KEY}&limit=${N}`);
    const b = await get(`/api/actions?agent=${AGENT_KEY}&limit=${N}`);
    const ids = a.actions.map((x: any) => x.id);
    expect(ids).toEqual(b.actions.map((x: any) => x.id));
    // DESC по id — единственный доступный устойчивый порядок при равном времени.
    expect(ids).toEqual([...ids].sort().reverse());
  }, IO_TIMEOUT_MS);
});

describe("/api/audit-logs: пагинация при одинаковом created_at", () => {
  test("пролистывание по nextBefore/nextBeforeId отдаёт все строки", async () => {
    const seen: string[] = [];
    let before: number | null = null;
    let beforeId: string | null = null;
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({
        event_type: EVENT_TYPE,
        limit: String(PAGE),
      });
      if (before !== null) qs.set("before", String(before));
      if (beforeId) qs.set("before_id", beforeId);
      const r = await get(`/api/audit-logs?${qs}`);
      if (r.logs.length === 0) break;
      for (const l of r.logs) seen.push(l.id);
      if (r.nextBefore === null) break;
      before = r.nextBefore;
      beforeId = r.nextBeforeId ?? null;
    }
    expect({ total: seen.length, unique: new Set(seen).size }).toEqual({
      total: N,
      unique: N,
    });
  }, IO_TIMEOUT_MS);

  test("курсор отдаётся вместе с id последней строки", async () => {
    const r = await get(`/api/audit-logs?event_type=${EVENT_TYPE}&limit=${PAGE}`);
    expect(r.nextBefore).toBe(SAME_MS);
    expect(r.nextBeforeId).toBe(r.logs[r.logs.length - 1].id);
  }, IO_TIMEOUT_MS);
});
