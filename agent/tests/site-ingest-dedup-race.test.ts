/**
 * Аудит 2026-08-14: дедуп публикаций на сайт пропускал одновременный дубль.
 *
 * `sentAt` закрывает повтор только ПОСЛЕ доставки, а доставленным пост
 * помечается по факту `res.ok` — между `alreadySent()` и `rememberSent()` лежит
 * `await fetch`. `ingestDigestToSite` — fire-and-forget, её зовут без await из
 * обработчика PUBLISH_POST, поэтому два одинаковых поста подряд (ретрай
 * публикации после потерянного ответа Telegram — ровно тот сценарий, ради
 * которого дедуп и писали; два агента с одним дайджестом) успевали оба пройти
 * проверку до того, как первый запишет результат.
 *
 * Цена промаха несимметрична: на delabs.space появляются две одинаковые
 * карточки и две записи в /rss.xml, а RSS уже разошёлся — снять обратно нельзя.
 *
 * Инвариант: пока запрос по ключу в полёте, второй такой же — no-op. При этом
 * сохраняется свойство, ради которого `rememberSent` стоит под `res.ok`: если
 * запрос упал (сеть, non-ok), ключ освобождается и следующая попытка уедет.
 *
 * Аудит 2026-08-20: из этого списка вычеркнут таймаут — см.
 * site-ingest-timeout-fail-closed.test.ts. Обрыв по AbortController происходит
 * на НАШЕЙ стороне, и создал ли сайт страницу — неизвестно; повторять в такой
 * ситуации нельзя.
 */
import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { ingestDigestToSite, _resetIngestDedup } from "../lib/site-ingest.ts";

const mockFetch = spyOn(globalThis, "fetch");

const PREV = {
  url: process.env.SITE_INGEST_URL,
  token: process.env.SITE_INGEST_TOKEN,
  chan: process.env.SITE_INGEST_CHANNEL_ID,
  delabs: process.env.DELABS_CHANNEL_ID,
  allow: process.env.SITE_INGEST_ALLOW_IN_TESTS,
};

const PUBLIC_CHANNEL = -1004471352065;

const DIGEST = [
  "**Итоги недели**",
  "",
  "Разобрали активности недели.",
  "",
  "🔹 [Monad тестнет](https://testnet.monad.xyz) — фаза 2",
].join("\n");

/** fetch, который зависает до ручного `release()` — так ловится «в полёте». */
function pendingFetch() {
  let release!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const started: Promise<void>[] = [];
  let startedCount = 0;
  const promise = new Promise<Response>((res, rej) => {
    release = res;
    reject = rej;
  });
  mockFetch.mockImplementation((() => {
    startedCount += 1;
    return promise;
  }) as unknown as typeof fetch);
  return {
    started,
    get startedCount() {
      return startedCount;
    },
    ok: () => release(new Response("{}", { status: 200 })),
    fail: (e: unknown) => reject(e),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  _resetIngestDedup();
  process.env.SITE_INGEST_URL = "https://site.example/api/internal/digests";
  process.env.SITE_INGEST_TOKEN = "test-token";
  delete process.env.SITE_INGEST_CHANNEL_ID;
  delete process.env.DELABS_CHANNEL_ID;
  // T-743: под `bun test` мост закрыт по умолчанию; здесь проверяется он сам
  // и fetch подменён — включаем явно.
  process.env.SITE_INGEST_ALLOW_IN_TESTS = "1";
});

afterAll(() => {
  mockFetch.mockRestore();
  for (const [k, v] of [
    ["SITE_INGEST_URL", PREV.url],
    ["SITE_INGEST_TOKEN", PREV.token],
    ["SITE_INGEST_CHANNEL_ID", PREV.chan],
    ["DELABS_CHANNEL_ID", PREV.delabs],
    ["SITE_INGEST_ALLOW_IN_TESTS", PREV.allow],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("одновременный дубль не создаёт вторую карточку", () => {
  test("второй вызов при незавершённом первом — no-op", async () => {
    const gate = pendingFetch();

    const first = ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    // Даём первому вызову дойти до fetch и там повиснуть.
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.startedCount).toBe(1);

    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(gate.startedCount).toBe(1);

    gate.ok();
    await first;
    expect(gate.startedCount).toBe(1);
  });

  test("три параллельных вызова дают ровно один POST", async () => {
    const gate = pendingFetch();

    const all = [
      ingestDigestToSite(DIGEST, PUBLIC_CHANNEL),
      ingestDigestToSite(DIGEST, PUBLIC_CHANNEL),
      ingestDigestToSite(DIGEST, PUBLIC_CHANNEL),
    ];
    gate.ok();
    await Promise.all(all);

    expect(gate.startedCount).toBe(1);
  });

  test("после успешной доставки повтор ловит уже sentAt", async () => {
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("разные посты друг друга не блокируют", async () => {
    const other = DIGEST.replace("Итоги недели", "Отработка активностей");
    await Promise.all([
      ingestDigestToSite(DIGEST, PUBLIC_CHANNEL),
      ingestDigestToSite(other, PUBLIC_CHANNEL),
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("резервирование не превращается в вечную блокировку", () => {
  test("сетевой сбой освобождает ключ — следующая попытка уедет", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("non-ok ответ освобождает ключ — следующая попытка уедет", async () => {
    mockFetch.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("успешная доставка тоже снимает резерв (иначе TTL был бы вечным)", async () => {
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    _resetIngestDedup(); // забываем sentAt — остаться должен только чистый inFlight
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("форма исправления", () => {
  const SRC = Bun.file(
    new URL("../lib/site-ingest.ts", import.meta.url),
  ).text();

  test("резерв ставится ДО fetch и снимается в finally", async () => {
    const src = await SRC;
    const add = src.indexOf("inFlight.add(key)");
    const fetchAt = src.indexOf("await fetch(url");
    const del = src.indexOf("inFlight.delete(key)");
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeLessThan(fetchAt);
    expect(del).toBeGreaterThan(fetchAt);
  });

  test("rememberSent — только под res.ok и под таймаутом, больше нигде", async () => {
    const src = await SRC;
    expect(src).toContain("if (res.ok) {");
    const okAt = src.indexOf("if (res.ok) {");
    const remember = src.indexOf("rememberSent(key, now)");
    expect(remember).toBeGreaterThan(okAt);

    // Аудит 2026-08-20: вызовов стало ДВА, и это осознанно. Второй —
    // в ветке `if (timedOut)`: оборвав запрос на своей стороне, мы не знаем,
    // создал ли сайт страницу, а лишняя публичная страница необратима
    // (класс инцидента T-743). Прежний инвариант «ровно один вызов» защищал
    // от того, чтобы пометка не расползлась в общий путь ошибки, — это
    // свойство здесь и проверяется, теперь адресно.
    expect(src.split("rememberSent(key, now)").length - 1).toBe(2);
    const timedOutBranch = src.indexOf("if (timedOut) {");
    expect(timedOutBranch).toBeGreaterThan(-1);
    const secondRemember = src.indexOf("rememberSent(key, now)", remember + 1);
    expect(secondRemember).toBeGreaterThan(timedOutBranch);
    // Общий путь сетевого сбоя пометки не ставит — он рethrow'ит наружу.
    expect(src).toContain("} else {\n        throw e;");
  });

  test("тест-хук чистит и sentAt, и inFlight", async () => {
    const src = await SRC;
    const hook = src.slice(src.indexOf("export function _resetIngestDedup"));
    const body = hook.slice(0, hook.indexOf("\n}"));
    expect(body).toContain("sentAt.clear()");
    expect(body).toContain("inFlight.clear()");
  });
});
