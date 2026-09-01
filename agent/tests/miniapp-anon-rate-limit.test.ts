/**
 * Потолок ресурсов ДО стены аутентификации (повторный аудит 2026-08-04).
 *
 * Рейт-лимит в miniapp-server стоял только на ветках, где уже известен
 * `user.id`. Всё, что обслуживается раньше, лимита не видело вовсе:
 *   - статика (`/`, `/assets/*`) — на каждый запрос arrayBuffer + Bun.hash +
 *     gzipSync СИНХРОННО в том же потоке, где живёт SQLite;
 *   - `/readyz` — дёргает БД;
 *   - OPTIONS-преflight;
 *   - `/api/events` — стоял выше общей GET-ветки, имел потолок одновременных
 *     соединений, но не потолок частоты: цикл open→abort его обходил.
 *
 * Второй сюжет — ключ анонимного ведра. За nginx сокет всегда 127.0.0.1, так
 * что peer бесполезен, а `$proxy_add_x_forwarded_for` ДОПИСЫВАЕТ remote_addr
 * к присланному клиентом заголовку: начало XFF полностью подконтрольно
 * атакующему. Довериться первому элементу — значит отдать ему ключ ведра и
 * тем самым сам лимит.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_anon_rl";

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { sseUrl } from "./_sse.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import {
  clientIpKey,
  consumeRateToken,
  _resetRateLimiter,
  _rateLimiterSize,
} from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_anon_rl";
const USER_ID = 88010;

/**
 * Зеркала приватных констант miniapp-server (ANON_LIMIT / GET_LIMIT). Держим
 * копию осознанно: тест не должен уметь менять лимит, который проверяет, —
 * иначе он пройдёт и после того, как потолок молча поднимут до бесконечности.
 * Расхождение ловится тестами ниже, которые сливают ведро ровно `capacity`
 * токенов и требуют 429 на следующем запросе.
 */
const ANON = { capacity: 300, refillPerSec: 20 };
const GET = { capacity: 120, refillPerSec: 4 };

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
    query_id: "q-anon-rl",
    user: JSON.stringify({ id: USER_ID, username: "rl", first_name: "R" }),
  });
}

/** Слить анонимное ведро клиента `ip` досуха, не гоняя 300 живых запросов. */
function drainAnon(ip: string): void {
  for (let i = 0; i < ANON.capacity; i++) {
    consumeRateToken(`anon:${ip}`, ANON);
  }
}

/**
 * Слитое ведро доливается на 20 токенов/сек — то есть уже через 50 мс после
 * drainAnon один токен возвращается. Под нагрузкой (весь `bun test`) столько
 * запросто уходит на установку соединения, и одиночный запрос отвечал 200
 * вместо 429: тесты ниже флакали не из-за логики, а из-за долива.
 *
 * Стреляем коротким залпом: параллельные запросы укладываются в единицы
 * миллисекунд, так что долив покроет максимум один из них. Возвращаем первый
 * 429 — по нему проверяем заголовки и тело.
 *
 * 2026-08-19: залпа в 8 запросов оказалось мало. В полном прогоне на 394 файла
 * между `drainAnon` и первым `fetch` проходило больше 400 мс — а это восемь
 * долитых токенов, ровно весь залп, и «429 несёт retry-after» краснел на
 * `expect(r).not.toBeNull()`. Поэтому слив теперь делает сам хелпер
 * непосредственно перед выстрелом и повторяет цикл: время между сливом и
 * запросами сжато до минимума, а если планировщик всё же вклинился — следующая
 * попытка сливает ведро заново. Залп поднят до 24: долив за такой залп — доли
 * токена, и один 429 гарантирован даже при пропуске кванта.
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

describe("clientIpKey — ключ анонимного ведра", () => {
  test("за локальным прокси берётся ПОСЛЕДНИЙ элемент XFF, не первый", () => {
    expect(clientIpKey("203.0.113.7, 10.0.0.5", "127.0.0.1")).toBe(
      "anon:10.0.0.5",
    );
  });

  test("подделанное начало XFF не расщепляет ведро", () => {
    // Атакующий волен написать в заголовок что угодно; nginx припишет свой
    // remote_addr в хвост. Ключ обязан зависеть только от хвоста, иначе
    // достаточно менять первый элемент, чтобы каждый запрос попадал в новое
    // ведро и лимита фактически не было.
    const a = clientIpKey("1.1.1.1, 10.0.0.5", "127.0.0.1");
    const b = clientIpKey("2.2.2.2, 9.9.9.9, 10.0.0.5", "127.0.0.1");
    const c = clientIpKey("10.0.0.5", "127.0.0.1");
    expect(a).toBe("anon:10.0.0.5");
    expect(b).toBe("anon:10.0.0.5");
    expect(c).toBe("anon:10.0.0.5");
  });

  test("прямое обращение снаружи XFF игнорирует", () => {
    // Сокет не с локального адреса — значит запрос пришёл мимо прокси, и
    // заголовок целиком написан клиентом. Ключ — реальный peer.
    expect(clientIpKey("10.0.0.5", "203.0.113.9")).toBe("anon:203.0.113.9");
  });

  test("обе IPv6-формы loopback считаются локальными", () => {
    expect(clientIpKey("10.0.0.5", "::1")).toBe("anon:10.0.0.5");
    expect(clientIpKey("10.0.0.5", "::ffff:127.0.0.1")).toBe("anon:10.0.0.5");
  });

  test("пустой или мусорный XFF откатывается на peer", () => {
    expect(clientIpKey(null, "127.0.0.1")).toBe("anon:127.0.0.1");
    expect(clientIpKey("  ,  ", "127.0.0.1")).toBe("anon:127.0.0.1");
    expect(clientIpKey(undefined, null)).toBe("anon:unknown");
  });
});

describe("анонимный потолок стоит ДО статики, /readyz и OPTIONS", () => {
  test("поток неаутентифицированных GET за статикой упирается в 429", async () => {
    // Настоящий залп, а не слив ведра из теста: важно, что счётчик снимается
    // до `serveStatic` + `applyCompressionAndEtag`, то есть до чтения файла и
    // синхронного gzip.
    const ip = "9.9.9.10";
    const N = ANON.capacity + 200;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        fetch(`${base}/`, { headers: { "x-forwarded-for": ip } }),
      ),
    );
    const codes = results.map((r) => r.status);
    await Promise.all(results.map((r) => r.text()));
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    // И залп не должен превратиться в сплошной отказ: первые ~300 обслужены.
    // Считаем «не 429», а не «200»: miniapp/dist в git не лежит (генерится
    // сборкой), так что на чистом CI-чекауте тот же путь отдаёт 404 — а тест
    // про потолок, а не про наличие ассетов. Первая редакция требовала 200 и
    // зелёная локально падала на CI ровно из-за этого.
    expect(codes.filter((c) => c !== 429).length).toBeGreaterThanOrEqual(200);
  });

  test("429 несёт retry-after", async () => {
    const ip = "9.9.9.11";
    const r = await burstUntilLimited(
      () => fetch(`${base}/`, { headers: { "x-forwarded-for": ip } }),
      { drain: () => drainAnon(ip) },
    );
    expect(r).not.toBeNull();
    expect(r!.headers.get("retry-after")).toBeTruthy();
    expect((await r!.json()).error).toBe("rate_limited");
  });

  test("/readyz за тем же ведром — БД не дёргается сверх лимита", async () => {
    const ip = "9.9.9.12";
    const r = await burstUntilLimited(
      () => fetch(`${base}/readyz`, { headers: { "x-forwarded-for": ip } }),
      { drain: () => drainAnon(ip) },
    );
    expect(r).not.toBeNull();
    await r!.text();
  });

  test("OPTIONS-преflight тоже считается", async () => {
    const ip = "9.9.9.13";
    const r = await burstUntilLimited(
      () =>
        fetch(`${base}/api/tasks`, {
          method: "OPTIONS",
          headers: { "x-forwarded-for": ip, origin: "https://example.test" },
        }),
      { drain: () => drainAnon(ip) },
    );
    expect(r).not.toBeNull();
    await r!.text();
  });

  test("запрос считается ровно один раз", async () => {
    // Первая редакция ставила anonLimit и внутри route(), и перед serveStatic:
    // не-/api/ пути (/healthz, /readyz, /metrics) платили по два токена.
    const ip = "9.9.9.14";
    for (let i = 0; i < ANON.capacity - 1; i++) {
      consumeRateToken(`anon:${ip}`, ANON);
    }
    // Остался ровно один токен — значит запрос обязан пройти.
    const r = await fetch(`${base}/healthz`, {
      headers: { "x-forwarded-for": ip },
    });
    expect(r.status).toBe(200);
    await r.text();
  });

  test("разные клиенты не мешают друг другу", async () => {
    const victim = "9.9.9.15";
    drainAnon(victim);
    const r = await fetch(`${base}/healthz`, {
      headers: { "x-forwarded-for": "9.9.9.16" },
    });
    expect(r.status).toBe(200);
    await r.text();
  });
});

describe("/api/events — потолок частоты, а не только одновременности", () => {
  test("цикл open→abort упирается в 429", async () => {
    // Соединения закрываются сразу, так что кап `sseConns` не срабатывает
    // никогда; без частотного лимита цикл крутится бесконечно, а каждый заход
    // проходит валидацию initData (HMAC) и подписку на шину.
    // Билет берём ДО того, как выпить ведро: он выдаётся POST'ом, у которого
    // своё ведро, а проверяем здесь именно GET-лимит на самом потоке.
    const url = await sseUrl(base, initData());
    for (let i = 0; i < GET.capacity; i++) {
      consumeRateToken(`get:${USER_ID}`, GET);
    }
    const r = await fetch(url);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    await r.text();
  });

  test("ведро общее с остальными GET'ами", async () => {
    // /api/events и обычные GET'ы должны брать из одного ведра `get:<id>`,
    // иначе потолок обходится чередованием.
    for (let i = 0; i < GET.capacity; i++) {
      consumeRateToken(`get:${USER_ID}`, GET);
    }
    const r = await fetch(`${base}/api/tasks`, {
      headers: { "x-telegram-init-data": initData() },
    });
    expect(r.status).toBe(429);
    await r.text();
  });
});

describe("вытеснение вёдер — карта не растёт бесконечно", () => {
  const MAX = 10_000;
  const TTL = 120_000;
  const T0 = 1_700_000_000_000;

  test("протухшие вёдра вычищаются при попытке превысить потолок", () => {
    for (let i = 0; i < MAX; i++) {
      consumeRateToken(`k${i}`, { now: () => T0 });
    }
    expect(_rateLimiterSize()).toBe(MAX);
    consumeRateToken("newcomer", { now: () => T0 + TTL + 1 });
    // Все MAX вёдер старше TTL — удалены, осталось одно новое.
    expect(_rateLimiterSize()).toBe(1);
  });

  test("живые вёдра не выбрасываются, даже если карта переполнена", () => {
    // Осознанный выбор в пользу LRU: вытеснять по возрасту безопасно (ведро,
    // к которому не обращались дольше времени полного восстановления, УЖЕ
    // полное), а LRU выбросил бы как раз опустошённое ведро атакующего и
    // выдал бы ему полный лимит заново. Цена — карта может временно вырасти
    // выше MAX при настоящем всплеске уникальных клиентов.
    for (let i = 0; i < MAX; i++) {
      consumeRateToken(`k${i}`, { now: () => T0 });
    }
    consumeRateToken("newcomer", { now: () => T0 + 500 });
    expect(_rateLimiterSize()).toBe(MAX + 1);
  });

  test("вытеснение не возвращает токены активному отправителю", () => {
    const opts = { capacity: 5, refillPerSec: 0.0001, now: () => T0 };
    for (let i = 0; i < 5; i++) {
      expect(consumeRateToken("flooder", opts).ok).toBe(true);
    }
    expect(consumeRateToken("flooder", opts).ok).toBe(false);

    // Забиваем карту чужими вёдрами, чтобы запустить проверку вытеснения.
    for (let i = 0; i < MAX; i++) {
      consumeRateToken(`k${i}`, { now: () => T0 + 500 });
    }
    // Ведро флудера свежее TTL — уцелело, и лимит для него по-прежнему закрыт.
    expect(
      consumeRateToken("flooder", { ...opts, now: () => T0 + 600 }).ok,
    ).toBe(false);
  });
});
