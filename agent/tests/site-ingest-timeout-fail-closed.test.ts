/**
 * Аудит 2026-08-20: таймаут ответа сайта позволял родить ВТОРУЮ публичную
 * страницу.
 *
 * `ingestDigestToSite` обрывает запрос своим AbortController на пятой секунде
 * (`REQUEST_TIMEOUT_MS`). Обрыв происходит на НАШЕЙ стороне: сервер к этому
 * моменту мог принять POST, создать страницу и отдать её в RSS — не успел
 * вернуться только ответ.
 *
 * А следов от запроса не оставалось никаких: `rememberSent` стоит под
 * `res.ok`, `inFlight.delete` — в `finally`. Следующая публикация того же
 * дайджеста (ретрай после потерянного ответа Telegram — сценарий, ради
 * которого дедуп и писали) уезжала заново и создавала дубль.
 *
 * Это ровно класс инцидента T-743: восемь тестовых страниц на delabs.space
 * пришлось снимать руками, а RSS уже разошёлся. Цена ошибок несимметрична —
 * пропущенная карточка невидима и добавляется повторной публикацией, лишняя
 * публичная страница необратима.
 *
 * Инвариант: по ТАЙМАУТУ мост закрывается (ключ считается отправленным), по
 * отказу соединения — нет: туда запрос не дошёл, повтор безопасен.
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

/**
 * fetch, который ведёт себя как настоящий при обрыве: слушает `signal` и
 * реджектит AbortError ровно тогда, когда контроллер сработал. Так проверяется
 * реальный путь (`controller.abort()` → catch), а не подставная ошибка.
 */
const FAST = { _timeoutMs: 25 };

function abortingFetch(): void {
  mockFetch.mockImplementation(((_u: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_res, rej) => {
      signal?.addEventListener("abort", () => {
        const e = new Error("The operation was aborted.");
        e.name = "AbortError";
        rej(e);
      });
    });
  }) as unknown as typeof fetch);
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  _resetIngestDedup();
  process.env.SITE_INGEST_URL = "https://site.example/api/internal/digests";
  process.env.SITE_INGEST_TOKEN = "test-token";
  delete process.env.SITE_INGEST_CHANNEL_ID;
  delete process.env.DELABS_CHANNEL_ID;
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

describe("таймаут ответа сайта", () => {
  test("после таймаута повтор того же дайджеста НЕ уходит вторым POST", async () => {
    abortingFetch();
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL, FAST);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Сайт, возможно, страницу уже создал — ответ просто не вернулся.
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  }, 30_000);

  test("таймаут не блокирует ДРУГОЙ дайджест", async () => {
    abortingFetch();
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL, FAST);

    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const other = DIGEST.replace("Итоги недели", "Отработка активностей");
    await ingestDigestToSite(other, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 30_000);

  test("отказ соединения по-прежнему разрешает повтор — туда запрос не дошёл", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 30_000);

  test("таймаут не роняет публикацию — функция не бросает", async () => {
    abortingFetch();
    await expect(
      ingestDigestToSite(DIGEST, PUBLIC_CHANNEL, FAST),
    ).resolves.toBeUndefined();
  }, 30_000);
});
