/**
 * T-743. Прогон тестов публиковал страницы на живом delabs.space.
 *
 * Измерено 2026-08-12 по публичному `/api/digests`: на сайте лежат ВОСЕМЬ
 * записей с заголовком «Крючок.», описанием «Крючок. Живой пост.», пустым
 * телом и нулём источников — `2026-08-02-крючок`, `-08-03`, `-08-04`, `-08-07`,
 * `-08-08`, `-08-09`, `-08-10`, `-08-12`. Строка «**Крючок.** Живой пост.» —
 * это фикстура наших же тестов (`tests/publish-to-channel.test.ts:64` и
 * четыре соседних publish-теста). То есть `bun test` на VPS проходил по
 * настоящему `PUBLISH_TO_CHANNEL`, дёргал `ingestDigestToSite` с боевыми
 * SITE_INGEST_URL/TOKEN из `/opt/agent-team/.env` и рождал публичную страницу
 * плюс запись в RSS. Снять её обратно нельзя — RSS уже разошёлся.
 *
 * Два позднейших фильтра (канал и «нет источников — не дайджест») этот
 * конкретный текст сегодня заглушили бы, но живут они только в ветке
 * `fix/audit-2026-08-02`, а прод крутит `main`. И оба — про содержимое поста,
 * не про то, кто его отправил: первый же тест, публикующий нормальный дайджест
 * в публичный канал, снова уйдёт на боевой сайт. Инварианта «тестовый прогон
 * не ходит наружу» в `lib/` не было ни одной — grep по
 * `NODE_ENV.*test|BUN_TEST|isTestEnv` возвращал пусто.
 *
 * Инвариант: под `bun test` мост молчит по умолчанию. Тесты самого моста
 * включают его явно (`SITE_INGEST_ALLOW_IN_TESTS=1`) и ходят на подменённый
 * fetch. Fail-closed: любое другое значение переменной — по-прежнему тишина,
 * потому что цена ошибки здесь необратима.
 */
import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { ingestDigestToSite, _resetIngestDedup } from "../lib/site-ingest.ts";
import { isTestRun } from "../lib/test-run-marker.ts";

const mockFetch = spyOn(globalThis, "fetch");

const PREV = {
  url: process.env.SITE_INGEST_URL,
  token: process.env.SITE_INGEST_TOKEN,
  allow: process.env.SITE_INGEST_ALLOW_IN_TESTS,
};

const PUBLIC_CHANNEL = -1004471352065;

/** Настоящий дайджест: канал тот, источники есть — всё, кроме прогона, «за». */
const DIGEST = [
  "**Итоги недели**",
  "",
  "Разобрали активности недели.",
  "",
  "🔹 [Monad тестнет](https://testnet.monad.xyz) — фаза 2",
].join("\n");

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  _resetIngestDedup();
  process.env.SITE_INGEST_URL = "https://site.example/api/internal/digests";
  process.env.SITE_INGEST_TOKEN = "secret-token";
  delete process.env.SITE_INGEST_ALLOW_IN_TESTS;
});

afterAll(() => {
  mockFetch.mockRestore();
  for (const [k, v] of [
    ["SITE_INGEST_URL", PREV.url],
    ["SITE_INGEST_TOKEN", PREV.token],
    ["SITE_INGEST_ALLOW_IN_TESTS", PREV.allow],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("мост молчит под bun test", () => {
  test("сам прогон помечен, и не переменной окружения", () => {
    // На этом и стоит вся защита — если однажды перестанет, тест упадёт здесь,
    // а не тихой публикацией на боевом сайте.
    //
    // Аудит 2026-08-20: раньше здесь стояло `expect(process.env.NODE_ENV)
    // .toBe("test")` — утверждение о ПРЕДУСЛОВИИ, которое гейту нужно, а не о
    // поведении гейта при враждебном предусловии. Под `NODE_ENV=production bun
    // test` этот тест краснел — но краснел в своём файле, а bun не прерывает
    // прогон на первом падении: соседний publish-тест с нормальным дайджестом
    // успевал уйти на боевой сайт в том же прогоне. Теперь признак ставит
    // preload тест-раннера, и переменной его не снять.
    expect(isTestRun()).toBe(true);
  });

  test("идеальный дайджест в публичный канал наружу не уходит", async () => {
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("фикстура publish-тестов «Крючок» — тем более", async () => {
    // Ровно та строка, что породила восемь страниц на delabs.space.
    await ingestDigestToSite("**Крючок.** Живой пост.", PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("повторные вызовы ничего не копят и не прорываются", async () => {
    for (let i = 0; i < 5; i++) await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("явное включение — только для тестов самого моста", () => {
  test("SITE_INGEST_ALLOW_IN_TESTS=1 возвращает отправку", async () => {
    process.env.SITE_INGEST_ALLOW_IN_TESTS = "1";
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("fail-closed: любое другое значение не включает мост", async () => {
    for (const v of ["true", "yes", "0", "", " 1", "on"]) {
      process.env.SITE_INGEST_ALLOW_IN_TESTS = v;
      _resetIngestDedup();
      await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
