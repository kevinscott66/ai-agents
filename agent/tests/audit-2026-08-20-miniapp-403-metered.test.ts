/**
 * Аудит 2026-08-20: отказ АЛЛОУ-ЛИСТА не стоил ничего.
 *
 * Ретроспективный счёт в обёртке handler'а смотрел только на
 * `resp.status === 401`. Но `authOr401` отдаёт 403, когда подпись верна, а
 * пользователя нет в аллоу-листе, — и этот отбой происходит на самой стене, до
 * пользовательских вёдер (они снимаются строкой ниже, уже зная user.id).
 * Анонимное ведро на /api/-путях тоже не снимается: `preAuth` для них false.
 * Итого 403 аллоу-листа не попадал НИ В ОДНО ведро.
 *
 * Посторонний тут не гипотетический: initData Telegram выдаёт любому, кто
 * открыл Mini App бота хоть раз, и живёт оно сутки. Каждый заход считает
 * HMAC-SHA256 в том же потоке, где SQLite и все 12 ботов. Ровно тот дефект,
 * который уже чинили для 401 (tests/miniapp-unauth-api-rate-limit.test.ts),
 * просто с другим кодом ответа.
 *
 * Инвариант: отбой на стене — 401 он или 403 — снимает токен из анонимного
 * ведра клиента. Отказы ЗА стеной (requires-admin) анонимное ведро не трогают:
 * их шлёт пользователь, который аллоу-лист прошёл и свой токен уже потратил, и
 * второй счёт наказывал бы соседей по NAT.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_403_metering";

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { _peekRateTokens, _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_403_metering";
/** В аллоу-листе и админ — им отказывает не стена, а requireAdmin. */
const ADMIN_ID = 88_211;
const ALLOWED_ID = 88_212;
/** Подпись валидная, в аллоу-листе нет — тот самый посторонний. */
const OUTSIDER_ID = 88_213;

/** Зеркало приватной ANON_LIMIT из miniapp-server — намеренно копия. */
const ANON = { capacity: 300, refillPerSec: 20 };

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, ALLOWED_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
});

beforeEach(() => {
  _resetRateLimiter();
});

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-403-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

/**
 * Запас по таймауту, а не ускорение: ниже сотни НАСТОЯЩИХ HTTP-запросов к
 * поднятому серверу, и в полном прогоне они упирались бы в дефолтные 5 с — как
 * уже случалось в соседних файлах. Уменьшать залп нельзя: проверяется ровно
 * то, что потолок наступает.
 */
const SLOW = 30_000;

describe("аллоу-лист: 403 со стены считается в анонимное ведро", () => {
  test(
    "поток от постороннего с валидной подписью упирается в 429",
    async () => {
      const ip = "9.9.20.1";
      const N = ANON.capacity + 200;
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          fetch(`${base}/api/tasks`, {
            headers: {
              "x-forwarded-for": ip,
              "x-telegram-init-data": initData(OUTSIDER_ID),
            },
          }),
        ),
      );
      const codes = results.map((r) => r.status);
      await Promise.all(results.map((r) => r.text()));
      // До фикса здесь было N × 403 и ни одного 429.
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
      // И это потолок, а не сплошной отказ: первые ~300 честно отвечают 403.
      expect(codes.filter((c) => c === 403).length).toBeGreaterThanOrEqual(200);
    },
    SLOW,
  );

  test(
    "один запрос постороннего снимает ровно один токен",
    async () => {
      // Свежий адрес: ведра по нему ещё нет, поэтому проверка не зависит от
      // долива — она про сам факт «ведро завели и сняли единицу».
      const ip = "9.9.20.2";
      const key = `anon:${ip}`;
      expect(_peekRateTokens(key)).toBeNull();
      const r = await fetch(`${base}/api/tasks`, {
        headers: {
          "x-forwarded-for": ip,
          "x-telegram-init-data": initData(OUTSIDER_ID),
        },
      });
      await r.text();
      expect(r.status).toBe(403);
      expect(_peekRateTokens(key)).toBe(ANON.capacity - 1);
    },
    SLOW,
  );
});

describe("отказы ЗА стеной анонимное ведро не трогают", () => {
  test(
    "403 от requireAdmin не снимает анонимный токен",
    async () => {
      const ip = "9.9.20.3";
      const key = `anon:${ip}`;
      expect(_peekRateTokens(key)).toBeNull();
      const r = await fetch(`${base}/api/budgets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": ip,
          "x-telegram-init-data": initData(ALLOWED_ID),
        },
        body: JSON.stringify({ agentKey: "qa", dailyInputTokens: 1000 }),
      });
      await r.text();
      expect(r.status).toBe(403);
      // Ведра так и не завели: этот отказ пришёл ЗА стеной.
      expect(_peekRateTokens(key)).toBeNull();
    },
    SLOW,
  );

  test(
    "успешный запрос допущенного пользователя анонимное ведро не трогает",
    async () => {
      const ip = "9.9.20.4";
      const key = `anon:${ip}`;
      expect(_peekRateTokens(key)).toBeNull();
      const r = await fetch(`${base}/api/tasks`, {
        headers: {
          "x-forwarded-for": ip,
          "x-telegram-init-data": initData(ALLOWED_ID),
        },
      });
      await r.text();
      expect(r.status).toBe(200);
      expect(_peekRateTokens(key)).toBeNull();
    },
    SLOW,
  );
});
