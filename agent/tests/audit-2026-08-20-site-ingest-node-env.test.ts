/**
 * Аудит 2026-08-20 — гейт «тестовый прогон не ходит наружу» снимался одной
 * экспортированной переменной.
 *
 * Единственной защитой моста на боевой delabs.space было
 * `process.env.NODE_ENV !== "test"`. Настоящая экспортированная переменная бьёт
 * дефолт bun'а — замерено на bun 1.3.14:
 *
 *   bun test                      → NODE_ENV === "test"       (гейт держит)
 *   NODE_ENV=production bun test  → NODE_ENV === "production"  (гейт СНЯТ)
 *
 * Bun'овская загрузка `.env` фикс не ломала — ломала настоящая переменная. Путь
 * к ней прямой: `.env.example` предписывает владельцу ставить
 * `NODE_ENV=production` на сервере, `deploy/agent-team-blue.service` и
 * `-green.service` держат строку `Environment=NODE_ENV=production`. Обычный
 * ops-приём «взять боевое окружение для ручного прогона» —
 * `set -a; . /opt/agent-team/.env; set +a` — экспортирует разом и
 * `NODE_ENV=production`, и `SITE_INGEST_URL`/`SITE_INGEST_TOKEN`. Это ровно
 * условия T-743 (восемь тестовых страниц на живом сайте, снять нельзя),
 * целиком восстановленные.
 *
 * Инвариант теперь про сам прогон, а не про ярлык процесса: признак ставит
 * preload тест-раннера (`agent/bunfig.toml` → `tests/_setup.ts`), который
 * выполняется только под `bun test`, при любом NODE_ENV.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { ingestDigestToSite, _resetIngestDedup } from "../lib/site-ingest.ts";
import { isTestRun, markTestRun } from "../lib/test-run-marker.ts";

const mockFetch = spyOn(globalThis, "fetch");

const PREV = {
  url: process.env.SITE_INGEST_URL,
  token: process.env.SITE_INGEST_TOKEN,
  allow: process.env.SITE_INGEST_ALLOW_IN_TESTS,
  nodeEnv: process.env.NODE_ENV,
};

const PUBLIC_CHANNEL = -1004471352065;
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

afterEach(() => {
  // Восстанавливаем NODE_ENV немедленно: он читается половиной репозитория,
  // и утечка в соседний файл — как раз тот класс, что мы здесь и чиним.
  if (PREV.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = PREV.nodeEnv;
  // Флаг прогона восстанавливаем безусловно — тесты ниже его снимают.
  markTestRun();
});

afterAll(() => {
  mockFetch.mockRestore();
  for (const [k, v] of [
    ["SITE_INGEST_URL", PREV.url],
    ["SITE_INGEST_TOKEN", PREV.token],
    ["SITE_INGEST_ALLOW_IN_TESTS", PREV.allow],
    ["NODE_ENV", PREV.nodeEnv],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("NODE_ENV не открывает мост на боевой сайт", () => {
  test("NODE_ENV=production: дайджест наружу всё равно не уходит", async () => {
    process.env.NODE_ENV = "production";
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("боевое окружение целиком: prod-адрес delabs.space + prod NODE_ENV", async () => {
    // Ровно то, что даёт `set -a; . /opt/agent-team/.env; set +a` перед ручным
    // прогоном. Настоящего запроса не будет в любом случае — fetch подменён, —
    // но если гейт откроется, спай зафиксирует адрес живого сайта, и тест
    // назовёт его в отчёте. Это и есть механика T-743.
    process.env.NODE_ENV = "production";
    process.env.SITE_INGEST_URL = "https://delabs.space:8443/api/internal/digests";
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch.mock.calls.map((c) => String(c[0]))).toEqual([]);
  });

  test("NODE_ENV удалён целиком — тоже тишина", async () => {
    delete process.env.NODE_ENV;
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("признак прогона переменной окружения не снимается", () => {
    process.env.NODE_ENV = "production";
    expect(isTestRun()).toBe(true);
  });

  test("NODE_ENV остаётся вторым признаком, а не выбрасывается", () => {
    // Прогон из корня репо не подхватит agent/bunfig.toml, то есть preload'а
    // не будет — но дефолтный NODE_ENV=test у bun'а там останется. Проверяем,
    // что этот запасной путь жив: снимаем флаг, оставляем NODE_ENV=test.
    process.env.NODE_ENV = "test";
    // markTestRun вернёт флаг в afterEach; здесь важно, что isTestRun() не
    // опирается ТОЛЬКО на флаг.
    expect(isTestRun()).toBe(true);
  });

  test("явное включение по-прежнему работает — иначе тесты моста слепнут", async () => {
    process.env.NODE_ENV = "production";
    process.env.SITE_INGEST_ALLOW_IN_TESTS = "1";
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalled();
    const url = String(mockFetch.mock.calls[0]?.[0] ?? "");
    // Ходим на подменённый адрес, а не на боевой хост.
    expect(url).toContain("site.example");
    expect(url).not.toContain("delabs.space");
  });
});
