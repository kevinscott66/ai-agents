/**
 * SSE-подключение больше не носит initData в query-строке (аудит 2026-08-04).
 *
 * Было: клиент открывал `/api/events?initData=<...>`, потому что EventSource не
 * умеет заголовки. Это полноценный credential — он валиден сутки
 * (verifyInitData, maxAgeSec=86400) и принимается ВСЕМИ ручками /api/*, — и он
 * ехал в query-строке, которую пишет access-лог nginx. Одна строка лога = сутки
 * полной имперсонации пользователя, включая POST'ы.
 *
 * Стало: POST /api/sse-ticket (initData заголовком, за общей стеной со всеми её
 * проверками) выдаёт одноразовый токен на 30 секунд, и только он попадает в URL.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_sse_ticket";

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  issueSseTicket,
  redeemSseTicket,
  TICKET_TTL_MS,
  _resetSseTickets,
  _sseTicketCount,
} from "../lib/sse-ticket.ts";

const BOT_TOKEN = "test_bot_token_for_sse_ticket";
const USER_ID = 771001;
const OUTSIDER_ID = 771002;

function initDataFor(id: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q-ticket",
    user: JSON.stringify({ id, username: "t", first_name: "T" }),
  });
}

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [USER_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

async function getTicket(id: number = USER_ID): Promise<string> {
  const r = await fetch(`${base}/api/sse-ticket`, {
    method: "POST",
    headers: { "X-Telegram-Init-Data": initDataFor(id) },
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { ticket: string }).ticket;
}

/** Открыть поток и сразу закрыть — тесту важен только код ответа. */
async function openStream(qs: string): Promise<number> {
  const ctrl = new AbortController();
  try {
    const r = await fetch(`${base}/api/events${qs}`, { signal: ctrl.signal });
    return r.status;
  } finally {
    ctrl.abort();
  }
}

describe("хранилище билетов", () => {
  beforeEach(_resetSseTickets);

  test("билет гасится при первом предъявлении", () => {
    const { ticket } = issueSseTicket(42);
    expect(redeemSseTicket(ticket)).toBe(42);
    // Второй раз — уже нет: перехваченный из лога билет бесполезен даже
    // внутри своих 30 секунд, если клиент им уже воспользовался.
    expect(redeemSseTicket(ticket)).toBeNull();
  });

  test("протухший билет не пускает и не остаётся в памяти", () => {
    const now = Date.now();
    const { ticket } = issueSseTicket(42, now);
    expect(redeemSseTicket(ticket, now + TICKET_TTL_MS + 1)).toBeNull();
    expect(_sseTicketCount()).toBe(0);
  });

  test("неизвестный токен — не 500 и не пропуск", () => {
    expect(redeemSseTicket("нет такого")).toBeNull();
    expect(redeemSseTicket("")).toBeNull();
    expect(redeemSseTicket(null)).toBeNull();
  });

  test("билеты не копятся: протухшие вычищаются при выдаче", () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) issueSseTicket(i, t0);
    expect(_sseTicketCount()).toBe(5);
    issueSseTicket(9, t0 + TICKET_TTL_MS + 1);
    expect(_sseTicketCount()).toBe(1);
  });

  test("два билета не совпадают", () => {
    expect(issueSseTicket(1).ticket).not.toBe(issueSseTicket(1).ticket);
  });
});

describe("POST /api/sse-ticket", () => {
  test("без initData билета не будет", async () => {
    const r = await fetch(`${base}/api/sse-ticket`, { method: "POST" });
    expect(r.status).toBe(401);
  });

  test("чужой пользователь не получает билет", async () => {
    const r = await fetch(`${base}/api/sse-ticket`, {
      method: "POST",
      headers: { "X-Telegram-Init-Data": initDataFor(OUTSIDER_ID) },
    });
    expect(r.status).toBe(403);
  });

  test("свой получает токен и срок жизни", async () => {
    const r = await fetch(`${base}/api/sse-ticket`, {
      method: "POST",
      headers: { "X-Telegram-Init-Data": initDataFor(USER_ID) },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ticket: string; expiresInSec: number };
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThan(20);
    expect(body.expiresInSec).toBeGreaterThan(0);
    expect(body.expiresInSec).toBeLessThanOrEqual(60);
  });
});

describe("GET /api/events", () => {
  test("initData в query больше не пускает", async () => {
    // Ровно та ссылка, что раньше лежала в access-логе nginx.
    const qs = `?initData=${encodeURIComponent(initDataFor(USER_ID))}`;
    expect(await openStream(qs)).toBe(401);
  });

  test("без билета — 401", async () => {
    expect(await openStream("")).toBe(401);
    expect(await openStream("?ticket=подделка")).toBe(401);
  });

  test("по билету поток открывается", async () => {
    const ticket = await getTicket();
    expect(await openStream(`?ticket=${encodeURIComponent(ticket)}`)).toBe(200);
  });

  test("повторное использование билета закрыто", async () => {
    const ticket = await getTicket();
    const qs = `?ticket=${encodeURIComponent(ticket)}`;
    expect(await openStream(qs)).toBe(200);
    expect(await openStream(qs)).toBe(401);
  });
});

describe("структура решения", () => {
  test("authOr401 не читает credential из query", () => {
    const src = readFileSync(
      new URL("../lib/auth-middleware.ts", import.meta.url),
      "utf8",
    );
    // Пока параметр вроде acceptQueryParam существует, его снова кто-нибудь
    // включит — поэтому пина два: нет чтения query и нет самого флага.
    expect(src).not.toMatch(/searchParams\.get\(/);
    expect(src).not.toMatch(/acceptQueryParam\??:/);
  });

  test("клиент берёт билет POST'ом, а не кладёт initData в URL", () => {
    const src = readFileSync(
      new URL("../miniapp/src/lib/sse.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/\/api\/events\?ticket=/);
    expect(src).not.toMatch(/\/api\/events\?initData=/);
  });
});
