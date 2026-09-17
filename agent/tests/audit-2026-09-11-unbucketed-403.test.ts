/**
 * Аудит 2026-09-11, круг 51: два отбоя с кодом 403 не стоили атакующему ничего.
 *
 * 2026-08-12 закрыли ровно этот класс для 401 (`wallRejected` в
 * lib/miniapp-server.ts), и там же записали, почему 403 считать не надо:
 * «отказы `requireAdmin` и origin-проверки приходят от пользователя, который
 * аллоу-лист прошёл и токен уже потратил». Для `requireAdmin` это было правдой.
 * Для двух других мест — нет, и обе ошибки одного рода: проверка стояла ВЫШЕ
 * снятия токена из ведра, то есть отбой уходил раньше, чем кто-либо платил.
 *
 *  • POST с чужим `Origin`: `pickAllowedOrigin(...) === null` → 403 на четыре
 *    строки раньше `consumeRateToken(user.id)`. Ретроспективный анонимный счёт
 *    его тоже не брал (он считает 401 и отбой на стене), так что ответ не
 *    попадал НИ В ОДНО ведро. Держатель живой сессии слал неограниченный поток,
 *    и каждый заход стоил двух HMAC-SHA256 плюс prune() обеих карт сессий в
 *    потоке, которому принадлежат SQLite и все 12 ботов.
 *  • GET /api/events от пользователя, выпавшего из аллоу-листа после выдачи
 *    билета: `isAllowlisted` → 403 выше `consumeRateToken('get:...')`. Дешевле
 *    первого (каждая попытка гасит билет), но дефект тот же и в соседней ветке.
 *
 * Сторож меряет не текст, а поведение: поток отбоев обязан упереться в 429.
 * Проверять «403 идёт после ведра» чтением исходника нельзя — порядок строк
 * переставят, а смысл этой проверки в том, что платит ИМЕННО отбой.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_unbucketed_403";

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  _resetRateLimiter,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { issueSseTicket, _resetSseTickets } from "../lib/sse-ticket.ts";

const BOT_TOKEN = "test_bot_token_unbucketed_403";
const USER_ID = 511001;
/** Был в списке на выдаче билета, выпал к моменту подключения. */
const EX_MEMBER_ID = 511002;

/** POST-ведро: capacity 20 (lib/http-utils.ts, умолчание consumeRateToken). */
const POST_CAPACITY = 20;
/** GET-ведро: capacity 120 (GET_LIMIT в lib/miniapp-server.ts). */
const GET_CAPACITY = 120;

let server: MiniappServerHandle;
let base: string;
const savedOrigins = process.env.MINIAPP_ALLOWED_ORIGINS;

/**
 * Свежий initData на каждый запрос.
 *
 * Анти-реплей помечает отпечаток израсходованным на первой же мутации, а
 * cookie сессии `fetch` здесь не носит. Без уникального `query_id` второй POST
 * получил бы 401 «replayed initData» — то есть мы мерили бы не ту ветку.
 */
function freshInitData(userId: number, nonce: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q403-${nonce}`,
    user: JSON.stringify({ id: userId, username: "u", first_name: "U" }),
  });
}

beforeAll(() => {
  process.env.MINIAPP_ALLOWED_ORIGINS = "https://app.example.test";
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
  if (savedOrigins === undefined) delete process.env.MINIAPP_ALLOWED_ORIGINS;
  else process.env.MINIAPP_ALLOWED_ORIGINS = savedOrigins;
});

beforeEach(() => {
  _resetRateLimiter();
  _resetSseTickets();
});

describe("отбои 403 попадают в ведро, а не в пустоту", () => {
  test("поток POST с чужим Origin упирается в 429", async () => {
    const codes: number[] = [];
    // Запас сверх ёмкости: ведро доливается на 1 токен в секунду, а прогон
    // локальный и укладывается в доли секунды.
    for (let i = 0; i < POST_CAPACITY + 8; i++) {
      const res = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: {
          "x-telegram-init-data": freshInitData(USER_ID, i),
          "content-type": "application/json",
          origin: "https://evil.test",
        },
        body: "{}",
      });
      await res.text().catch(() => {});
      codes.push(res.status);
    }
    // Первые — честный отказ по origin: заявитель свой, Origin чужой.
    expect(codes[0]).toBe(403);
    // Главное: поток конечен. До правки здесь были одни 403 без единого 429.
    expect(codes).toContain(429);
    // И 429 приходит не раньше, чем исчерпана ёмкость, — иначе мы сломали бы
    // обычную работу Mini App, которая шлёт мутации пачками.
    expect(codes.indexOf(429)).toBeGreaterThanOrEqual(POST_CAPACITY);
  });

  test("допустимый Origin по-прежнему проходит стену и ведро", async () => {
    // Сторож на противоположную ошибку: «починить» первый тест можно было бы,
    // отказав всем подряд.
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: {
        "x-telegram-init-data": freshInitData(USER_ID, 900),
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: "{}",
    });
    await res.text().catch(() => {});
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(429);
  });

  test("поток подключений SSE вне аллоу-листа упирается в 429", async () => {
    const codes: number[] = [];
    // GET-ведро доливается по 4 токена в секунду — берём запас пошире.
    for (let i = 0; i < GET_CAPACITY + 40; i++) {
      const { ticket } = issueSseTicket(EX_MEMBER_ID);
      const res = await fetch(
        `${base}/api/events?ticket=${encodeURIComponent(ticket)}`,
      );
      await res.text().catch(() => {});
      codes.push(res.status);
      if (res.status === 429) break;
    }
    expect(codes[0]).toBe(403);
    expect(codes).toContain(429);
    expect(codes.indexOf(429)).toBeGreaterThanOrEqual(GET_CAPACITY);
  });

  test("негодный билет по-прежнему 401, а не 403", async () => {
    // Порядок «сначала билет, потом ведро, потом список» не должен был
    // перемешать коды: 401 у неаутентифицированного, 403 у опознанного чужого.
    const res = await fetch(`${base}/api/events?ticket=nope`);
    await res.text().catch(() => {});
    expect(res.status).toBe(401);
  });
});
