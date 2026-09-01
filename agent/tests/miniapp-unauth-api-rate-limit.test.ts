/**
 * Аудит 2026-08-12: неудачная аутентификация не стоила НИЧЕГО.
 *
 * Счётчики в miniapp-server расставлены так:
 *   - анонимное ведро (`anon:<ip>`) снимается в обёртке handler'а, но только
 *     если `preAuth` — то есть для не-/api/ путей, OPTIONS и /api/health;
 *   - пользовательские вёдра (`get:<id>` / POST-ное) снимаются ПОСЛЕ стены
 *     `authOr401`, когда user.id уже известен.
 *
 * Запрос `GET /api/tasks` с мусорным `x-telegram-init-data` не попадает ни в
 * одно из них: `preAuth` для него false (путь /api/, не /api/health), а до
 * пользовательского ведра он не доживает — `authOr401` возвращает 401 раньше.
 * Замер: 600 таких запросов подряд → 600 × 401, ни одного 429.
 *
 * Каждый заход при этом считает HMAC-SHA256 по initData в том же потоке, что
 * обслуживает HTTP и владеет SQLite, — то есть бесплатная нагрузка снаружи,
 * причём именно на том пути, который единственный и стоит проверять на подбор.
 * Ровно тот же класс, что чинили для статики и /readyz (см. шапку
 * tests/miniapp-anon-rate-limit.test.ts): «лимит есть, но не там, где вход».
 *
 * Инвариант: отказ аутентификации на /api/ снимает токен из анонимного ведра
 * клиента. Пока токены есть — обычный 401 (никакой новой информации наружу);
 * когда ведро пусто — 429 с retry-after. Успешный запрос анонимное ведро не
 * трогает: у него своё, по user.id, и двойной счёт наказывал бы легитимного
 * пользователя за чужой шум с того же IP.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_unauth_rl";

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
import { consumeRateToken, _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_unauth_rl";
const USER_ID = 88110;

/** Зеркало приватной ANON_LIMIT из miniapp-server — намеренно копия. */
const ANON = { capacity: 300, refillPerSec: 20 };

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [],
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

function initData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q-unauth-rl",
    user: JSON.stringify({ id: USER_ID, username: "rl", first_name: "R" }),
  });
}

function drainAnon(ip: string): void {
  for (let i = 0; i < ANON.capacity; i++) {
    consumeRateToken(`anon:${ip}`, ANON);
  }
}

/**
 * Ведро доливается на 20 токенов/сек, то есть под нагрузкой всего `bun test`
 * между слитием и запросом успевает вернуться токен-другой. Стреляем коротким
 * параллельным залпом и берём первый 429 — как в соседнем файле.
 *
 * 2026-08-19: и залп, и слив теперь внутри хелпера, с повтором — как в
 * `miniapp-anon-rate-limit.test.ts`, где восьми запросов не хватило: в полном
 * прогоне между `drainAnon` и первым `fetch` набегало больше 400 мс, то есть
 * ведро успевало долиться ровно на весь залп. Тот же долив ждёт и здесь.
 */
async function burstUntilLimited(
  make: () => Promise<Response>,
  opts: { drain?: () => void; n?: number; attempts?: number } = {},
): Promise<Response | null> {
  const { drain, n = 24, attempts = 3 } = opts;
  for (let i = 0; i < attempts; i++) {
    drain?.();
    const responses = await Promise.all(
      Array.from({ length: n }, () => make()),
    );
    let limited: Response | null = null;
    for (const r of responses) {
      if (r.status === 429 && !limited) limited = r;
      else await r.text();
    }
    if (limited) return limited;
  }
  return null;
}

/**
 * Запас по таймауту, а не ускорение.
 *
 * Залпы ниже — это сотни НАСТОЯЩИХ HTTP-запросов к поднятому серверу
 * (`ANON.capacity + 200` в первом тесте). Вхолостую тело укладывается в
 * полсекунды, но в полном прогоне на 392 файла те же запросы упирались в
 * дефолтные 5 с бун и краснели «timed out»: результат зависел от загруженности
 * машины, а не от кода. Уменьшать залп нельзя — проверяется ровно то, что
 * потолок наступает и что до него отвечают 401.
 */
const SLOW = 30_000;

describe("отказ аутентификации на /api/ считается", () => {
  test(
    "поток запросов с мусорным initData упирается в 429",
    async () => {
      const ip = "9.9.10.1";
      const N = ANON.capacity + 200;
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          fetch(`${base}/api/tasks`, {
            headers: {
              "x-forwarded-for": ip,
              "x-telegram-init-data": "user=%7B%22id%22%3A1%7D&hash=deadbeef",
            },
          }),
        ),
      );
      const codes = results.map((r) => r.status);
      await Promise.all(results.map((r) => r.text()));
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
      // И это именно потолок, а не сплошной отказ: первые ~300 отвечают 401.
      expect(codes.filter((c) => c === 401).length).toBeGreaterThanOrEqual(200);
    },
    SLOW,
  );

  test(
    "совсем без заголовка — тот же счёт",
    async () => {
      const ip = "9.9.10.2";
      const r = await burstUntilLimited(
        () =>
          fetch(`${base}/api/tasks`, { headers: { "x-forwarded-for": ip } }),
        { drain: () => drainAnon(ip) },
      );
      expect(r).not.toBeNull();
      expect(r!.headers.get("retry-after")).toBeTruthy();
      expect((await r!.json()).error).toBe("rate_limited");
    },
    SLOW,
  );

  test("пока токены есть — обычный 401, а не 429", async () => {
    const ip = "9.9.10.3";
    const r = await fetch(`${base}/api/tasks`, {
      headers: { "x-forwarded-for": ip, "x-telegram-init-data": "hash=nope" },
    });
    expect(r.status).toBe(401);
    await r.text();
  });

  test("успешный запрос анонимное ведро не трогает", async () => {
    // Иначе шум с общего IP (за NAT/прокси) выбивал бы легитимного клиента,
    // у которого и так есть своё ведро по user.id.
    const ip = "9.9.10.4";
    for (let i = 0; i < ANON.capacity - 1; i++) {
      consumeRateToken(`anon:${ip}`, ANON);
    }
    const r = await fetch(`${base}/api/tasks`, {
      headers: { "x-forwarded-for": ip, "x-telegram-init-data": initData() },
    });
    expect(r.status).toBe(200);
    await r.text();
    // Остался тот самый последний токен — значит успешный запрос его не съел.
    expect(consumeRateToken(`anon:${ip}`, ANON).ok).toBe(true);
  });

  test("разные клиенты не мешают друг другу", async () => {
    drainAnon("9.9.10.5");
    const r = await fetch(`${base}/api/tasks`, {
      headers: { "x-forwarded-for": "9.9.10.6", "x-telegram-init-data": "x=1" },
    });
    expect(r.status).toBe(401);
    await r.text();
  });
});
