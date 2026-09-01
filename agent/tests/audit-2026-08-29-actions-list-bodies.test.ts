/**
 * Список действий Mini App не должен читать тела (аудит 2026-08-29).
 *
 * Аудит 2026-08-28 уже проходил ровно по этому месту и записал инвариант в
 * `lib/audit.ts`: «список — метаданные, точечное чтение (`getAction`) — с
 * телами. Так «контент не показываем» держится строением кода, а не
 * дисциплиной каждого следующего вызывающего». Тогда починили `listActions`:
 * `SELECT *` заменили на `SUMMARY_COLUMNS`.
 *
 * Второй список остался. `GET /api/actions` и блок «последние действия» в
 * `/api/dashboard` собирают строки не через `listActions`, а сами: сначала
 * `SELECT id`, потом `getAction(id)` на КАЖДУЮ строку. То есть тот же
 * `SELECT *`, только N раз — до 200 на `/api/actions` и 20 на дашборде.
 *
 * Тела не игрушечные (цитата из того же docblock): `SEND_DOCUMENT` пропускает
 * до 2 МБ в `payload.content`, `WRITE_WIKI` кладёт туда страницу целиком. Их
 * читают из базы, разбирают `JSON.parse`, а наблюдателю тут же затирают в
 * `redactContent` — работа ради выброшенного результата.
 *
 * Наблюдаемое следствие ровно одно — число точечных чтений, поэтому тесты
 * ниже считают именно его, подменяя `db.prepare`. Ответ при этом обязан
 * остаться прежним: у наблюдателя — заглушки и `redacted`, у админа — тела
 * целиком (это поведение закреплено в `miniapp-viewer-scope`, ломать его тут
 * нельзя).
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  spyOn,
} from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { logAction } from "../lib/audit.ts";
import { db } from "../lib/db.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_actions_list_bodies";
const ADMIN_ID = 900_301;
const VIEWER_ID = 900_302;
const CHAT_ID = -100_900_301;

const REDACTED_NOTE = "(скрыто: доступно администратору)";
const BODY_TEXT = "тело действия, которое наблюдателю не показывают";

let server: MiniappServerHandle;
let base: string;
const ids: string[] = [];

function initDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

/**
 * Сколько раз за время запроса база читала строку действия целиком.
 *
 * `getAction` — единственный `SELECT * FROM agent_actions WHERE id = ?` в
 * коде, так что счётчик по тексту запроса считает именно точечные чтения.
 * Подменяем с проходом в оригинал: ответ должен остаться настоящим.
 */
async function fetchCountingBodyReads(
  path: string,
  userId: number,
): Promise<{ status: number; body: any; bodyReads: number }> {
  let bodyReads = 0;
  const orig = db.prepare.bind(db);
  const spy = spyOn(db, "prepare");
  spy.mockImplementation(((sql: string) => {
    if (sql.includes("SELECT * FROM agent_actions WHERE id = ?")) bodyReads++;
    return orig(sql);
  }) as never);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "X-Telegram-Init-Data": initDataFor(userId) },
    });
    const body = await res.json();
    return { status: res.status, body, bodyReads };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, VIEWER_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;

  for (let i = 0; i < 3; i++) {
    ids.push(
      logAction({
        agentKey: "smm",
        chatId: CHAT_ID,
        actionType: "SEND_DOCUMENT",
        payload: { chatId: CHAT_ID, content: `${BODY_TEXT} #${i}` },
        status: "ok",
        result: { messageId: 100 + i, echo: BODY_TEXT },
      }).id,
    );
  }
  // Действие без тел вообще: у него не должно появиться ни заглушек, ни
  // флага `redacted` — иначе «скрыто» будет написано над пустотой.
  ids.push(
    logAction({
      agentKey: "smm",
      chatId: CHAT_ID,
      actionType: "PIN_MESSAGE",
      status: "ok",
    }).id,
  );
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT_ID);
});

describe("наблюдателю тела не читают из базы", () => {
  test("GET /api/actions: ни одного точечного чтения строки", async () => {
    const { status, body, bodyReads } = await fetchCountingBodyReads(
      `/api/actions?chat_id=${CHAT_ID}&limit=200`,
      VIEWER_ID,
    );
    expect(status).toBe(200);
    expect(body.actions).toHaveLength(4);
    expect(bodyReads).toBe(0);
  });

  test("GET /api/dashboard: ни одного точечного чтения строки", async () => {
    const { status, bodyReads } = await fetchCountingBodyReads(
      `/api/dashboard`,
      VIEWER_ID,
    );
    expect(status).toBe(200);
    expect(bodyReads).toBe(0);
  });

  test("ответ прежний: заглушки вместо тел и флаг redacted", async () => {
    const { body } = await fetchCountingBodyReads(
      `/api/actions?chat_id=${CHAT_ID}&limit=200`,
      VIEWER_ID,
    );
    const mine = body.actions.find((a: any) => a.id === ids[0]);
    expect(mine.payload).toBe(REDACTED_NOTE);
    expect(mine.result).toBe(REDACTED_NOTE);
    expect(mine.redacted).toBe(true);
    expect(JSON.stringify(body)).not.toContain(BODY_TEXT);
  });

  test("метаданные остаются на месте", async () => {
    const { body } = await fetchCountingBodyReads(
      `/api/actions?chat_id=${CHAT_ID}&limit=200`,
      VIEWER_ID,
    );
    const mine = body.actions.find((a: any) => a.id === ids[0]);
    expect(mine.action_type).toBe("SEND_DOCUMENT");
    expect(mine.agent_key).toBe("smm");
    expect(mine.status).toBe("ok");
    expect(mine.chat_id).toBe(CHAT_ID);
    expect(typeof mine.created_at).toBe("number");
  });

  test("у действия без тел нет ни заглушек, ни флага redacted", async () => {
    const { body } = await fetchCountingBodyReads(
      `/api/actions?chat_id=${CHAT_ID}&limit=200`,
      VIEWER_ID,
    );
    const empty = body.actions.find((a: any) => a.id === ids[3]);
    expect(empty.redacted).toBeUndefined();
    expect(empty.payload ?? null).toBeNull();
    expect(empty.result ?? null).toBeNull();
  });
});

describe("админу тела по-прежнему отдаются", () => {
  test("GET /api/actions: payload и result целиком", async () => {
    const { status, body, bodyReads } = await fetchCountingBodyReads(
      `/api/actions?chat_id=${CHAT_ID}&limit=200`,
      ADMIN_ID,
    );
    expect(status).toBe(200);
    const mine = body.actions.find((a: any) => a.id === ids[0]);
    expect(mine.payload).toMatchObject({ content: `${BODY_TEXT} #0` });
    expect(mine.result).toMatchObject({ echo: BODY_TEXT });
    expect(mine.redacted).toBeUndefined();
    // Тела админу нужны, но приезжают одним запросом: точечных чтений нет и
    // у него — иначе `limit=200` это двести отдельных `SELECT *`.
    expect(bodyReads).toBe(0);
  });
});
