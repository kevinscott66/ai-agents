/**
 * Аудит 2026-08-21: отказ по аллоу-листу Mini App не называл отказанного.
 *
 * `uidHint` — единственный проверенный источник id для строки access-лога
 * (правило заведено аудитом 2026-08-13, комментарий в miniapp-server.ts:1583).
 * Писали в него ровно две аутентификации, и обе — уже ЗА проверкой аллоу-листа:
 *
 *   const auth = authOr401(req, url);
 *   if (!auth.ok) return auth.resp;   // ← 403 уходит здесь, hint не поставлен
 *   uidHint.set(req, auth.user.id);
 *
 * Между тем отказ по списку — это отказ ПРОВЕРЕННОМУ: `verifyInitData` уже
 * сошёлся по HMAC с токеном бота, id настоящий. В журнал он ложился как
 *
 *   [miniapp] GET /api/tasks uid=- -> 403
 *
 * то есть неотличимо от запроса с подделанной подписью. Владелец, разбирающий
 * «почему коллега не может открыть приложение», и разбор «кто ломился» видят
 * одно и то же «-». Само событие редкое: чтобы его получить, нужен валидный
 * initData, подписанный токеном бота.
 *
 * Правка ставит hint для проверенного-но-отказанного и НЕ трогает 401: у
 * запроса без подписи id по-прежнему нет, и придумывать его нельзя — ровно это
 * чинил аудит 2026-08-13, тесты ниже стерегут обе стороны.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_403";

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  spyOn,
} from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { issueSseTicket } from "../lib/sse-ticket.ts";
import { redactUserId } from "../lib/log.ts";

const BOT_TOKEN = "test_bot_token_403";
/** Свой: в аллоу-листе. */
const INSIDER = 44006001;
/** Чужой: подпись настоящая, в списке его нет. */
const OUTSIDER = 44006002;

function initDataFor(id: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q403",
    user: JSON.stringify({
      id,
      username: `u${id}`,
      first_name: "T",
      is_bot: false,
    }),
  });
}

/** Правильная форма, подписи нет. */
const FORGED = `user=${encodeURIComponent(
  JSON.stringify({ id: OUTSIDER }),
)}&auth_date=${Math.floor(Date.now() / 1000)}&hash=deadbeef`;

let server: MiniappServerHandle;
let baseUrl: string;
let lines: string[] = [];
const logSpy = spyOn(console, "log");

beforeAll(async () => {
  server = await startMiniappServer({
    adminUserIds: [INSIDER],
    allowedUserIds: [INSIDER],
  });
  baseUrl = `http://localhost:${server.port}`;
  logSpy.mockImplementation(((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as unknown as typeof console.log);
});

afterAll(async () => {
  logSpy.mockRestore();
  await server.stop();
});

beforeEach(() => {
  lines = [];
});

const lineFor = (path: string): string | undefined =>
  lines.filter((l) => l.includes("[miniapp] ")).find((l) => l.includes(path));

describe("Mini App: 403 по аллоу-листу называет отказанного", () => {
  test("проверенный, но не в списке — id в access-логе", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      headers: { "X-Telegram-Init-Data": initDataFor(OUTSIDER) },
    });
    expect(res.status).toBe(403);

    const line = lineFor("/api/tasks");
    expect(line).toBeDefined();
    expect(line).toContain(`uid=${redactUserId(OUTSIDER)}`);
    // Ровно то, что стояло в строке до правки.
    expect(line).not.toContain("uid=-");
  });

  test("id редактируется, а не пишется целиком", async () => {
    await fetch(`${baseUrl}/api/tasks`, {
      headers: { "X-Telegram-Init-Data": initDataFor(OUTSIDER) },
    });
    // Политика lib/log.ts одна для всех строк, отказ не исключение.
    expect(lineFor("/api/tasks")).not.toContain(`uid=${OUTSIDER}`);
  });

  test("SSE-билет чужого — тоже отказ с id", async () => {
    // Билет выдаётся по заголовку, а список мог измениться, пока поток висел;
    // проверка на входе в /api/events для этого и стоит.
    const { ticket } = issueSseTicket(OUTSIDER);
    const res = await fetch(`${baseUrl}/api/events?ticket=${ticket}`);
    expect(res.status).toBe(403);

    const line = lineFor("/api/events");
    expect(line).toBeDefined();
    expect(line).toContain(`uid=${redactUserId(OUTSIDER)}`);
  });
});

describe("401 по-прежнему без id — правку 2026-08-13 не откатываем", () => {
  test("подделанная подпись: uid=-", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      headers: { "X-Telegram-Init-Data": FORGED },
    });
    expect(res.status).toBe(401);

    const line = lineFor("/api/tasks");
    expect(line).toContain("uid=-");
    expect(line).not.toContain(String(OUTSIDER));
  });

  test("заголовка нет вовсе: uid=-", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(401);
    expect(lineFor("/api/tasks")).toContain("uid=-");
  });

  test("протухший билет: uid=- (id из непроверенного ticket не берём)", async () => {
    const res = await fetch(`${baseUrl}/api/events?ticket=nosuchticket`);
    expect(res.status).toBe(401);
    expect(lineFor("/api/events")).toContain("uid=-");
  });
});

describe("свой пользователь не задет", () => {
  test("в списке — 200 и тот же id в строке", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      headers: { "X-Telegram-Init-Data": initDataFor(INSIDER) },
    });
    expect(res.status).toBe(200);
    expect(lineFor("/api/tasks")).toContain(`uid=${redactUserId(INSIDER)}`);
  });
});
