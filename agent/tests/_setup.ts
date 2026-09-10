/**
 * Test preload (registered via agent/bunfig.toml `[test] preload`).
 *
 * Two responsibilities:
 *
 *  1. Isolate the test DB from the live dev/prod database. `lib/db.ts` reads
 *     `process.env.MEMORY_DB_PATH` at module-load time, so `./_db-path.ts` is
 *     imported FIRST (and is dependency-free) to set that env var before any
 *     DB-opening module is evaluated.
 *
 *  2. Reset volatile cross-test state before every test. Even with a fresh DB
 *     per run, state leaks BETWEEN test files within a single run:
 *       - the in-memory rate-limit buckets (lib/rate-limits.ts)
 *       - the Mini App HTTP token buckets (lib/http-utils.ts) — см. P2bis ниже
 *       - the alert cooldown map (lib/alerting.ts) — см. P2bis ниже
 *       - leftover `autonomy_modes` overrides at scope 'agent'/'chat' that a
 *         prior test set and never cleaned up — these silently flip gate
 *         decisions in later, unrelated tests (e.g. an agent:pm:locked row
 *         leaking into a CREATE_TASK test that assumed the global default).
 *       - T-812: строки `permissions`, которые тест поменял и не вернул.
 *     Resetting before each test gives every test a clean slate while leaving
 *     the global autonomy default intact (tests set their own overrides in the
 *     test body, which runs after this hook).
 *
 * P2bis (nightly, 2026-09-10). Оба верхних пункта добавлены сюда потому, что
 * `bun test tests --rerun-each=5` в nightly был красным четыре ночи подряд, а
 * обычный гейт на том же коде — зелёным. Разница ровно в накоплении:
 *
 *   - `lib/http-utils.ts` держит вёдра Mini App (POST: ёмкость 20, +1/с;
 *     GET: 120, +4/с). Одного прохода тесту хватает, пяти подряд — нет: со
 *     второго-третьего повтора API отдаёт 429, и `expect(200)` падает. Это
 *     давали ~118 из 162 падений прогона 34334251616. Двадцать файлов уже
 *     звали `_resetRateLimiter()` у себя в `beforeEach` — здесь ровно тот же
 *     вызов, но для всех, а не для тех, кто вспомнил.
 *   - `lib/alerting.ts` держит карту кулдаунов: сработавший алерт молчит
 *     заданное число минут. На повторе `checkApprovalBacklog`/
 *     `checkRateLimitStorm` возвращали false — не потому, что порог не
 *     превышен, а потому, что кулдаун с прошлого повтора ещё не истёк.
 *
 * Сбрасывать глобально безопасно: ни один тест не строит состояние ЧЕРЕЗ
 * границу `test()` — те, что проверяют сам лимитер и сами кулдауны
 * (`miniapp-anon-rate-limit`, `rate-limiter-hard-cap`,
 * `miniapp-unauth-api-rate-limit`, `alerting-storm-sampling`,
 * `audit-2026-08-09-small-holes`, `audit-2026-08-29-db-maint-hourly-tick`),
 * набирают его внутри одного теста и уже сбрасывают его сами.
 */
import "./_db-path.ts"; // MUST be first — sets MEMORY_DB_PATH before db opens.

// Аудит 2026-08-20: отметить прогон как тестовый способом, который не
// подделывается переменной окружения. `NODE_ENV=production bun test` даёт
// NODE_ENV === "production" и снимал единственный гейт моста на боевой сайт
// (условия T-743). Preload выполняется только под тест-раннером — подробности
// в lib/test-run-marker.ts.
import { markTestRun } from "../lib/test-run-marker.ts";
markTestRun();

// Keep HTTP fixtures browser-like without weakening the production server.
// Bun's fetch does not persist Set-Cookie between requests, while most legacy
// Mini App tests intentionally use small raw-fetch helpers. Scope the jar to
// localhost API POSTs and the exact initData credential so unrelated tests do
// not observe or share these cookies.
const testFetch = globalThis.fetch.bind(globalThis);
const miniappCookies = new Map<string, string>();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const headers = new Headers(init?.headers ?? request?.headers);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const rawInitData = headers.get("x-telegram-init-data");
  const isMiniAppMutation =
    method === "POST" &&
    url.pathname.startsWith("/api/") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    !!rawInitData;
  const cookieKey = isMiniAppMutation ? `${url.origin}\n${rawInitData}` : null;
  if (cookieKey && !headers.has("cookie")) {
    const cookie = miniappCookies.get(cookieKey);
    if (cookie) headers.set("cookie", cookie);
  }
  const response = await testFetch(input, { ...init, headers });
  if (cookieKey) {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) miniappCookies.set(cookieKey, setCookie.split(";", 1)[0]!);
  }
  return response;
}) as typeof globalThis.fetch;

import { beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";
import { _resetAlertCooldowns } from "../lib/alerting.ts";

/**
 * T-812: таблица `permissions` (293 строки после миграций) живёт на одной
 * SQLite между файлами тестов, а сбрасывалась только `autonomy_modes`. Тест,
 * который правил строку прав и не возвращал её, ронял чужие файлы — и ронял
 * НЕДЕТЕРМИНИРОВАННО, потому что порядок файлов у bun не фиксирован. Так упал
 * PR #435: пять тестов из четырёх разных файлов, все с одним и тем же
 * `expect(p.requires_approval).toBe(false) → Received: true`; `rerun --failed`
 * на том же коммите прошёл зелёным.
 *
 * Сбросить строки нельзя — их отсутствие НЕ равно состоянию по умолчанию:
 * `getPermission` на пустой строке отдаёт `{allowed:false}`, то есть «запрещено»
 * вместо посеянного миграцией разрешения. Поэтому снимок при загрузке и
 * восстановление при расхождении.
 *
 * Восстановление идёт по подписи, а не безусловно: полный перезалив 293 строк
 * перед каждым из 2585 тестов — это три четверти миллиона записей на прогон
 * ради состояния, которое трогают 19 файлов. Подпись считается одним запросом
 * по первичному ключу и ловит и правку флагов, и добавление, и удаление строки.
 */
interface PermSnapshotRow {
  agent_key: string;
  action_type: string;
  allowed: number;
  requires_approval: number;
}

const SIGNATURE_SQL = `SELECT group_concat(
    agent_key || ':' || action_type || ':' || allowed || ':' || requires_approval, '|'
  ) AS sig FROM (SELECT * FROM permissions ORDER BY agent_key, action_type)`;

function permissionsSignature(): string {
  const row = db.prepare(SIGNATURE_SQL).get() as { sig: string | null };
  return row.sig ?? "";
}

const permSnapshot = db
  .prepare(
    `SELECT agent_key, action_type, allowed, requires_approval FROM permissions`,
  )
  .all() as PermSnapshotRow[];
const permSignature = permissionsSignature();

function restorePermissions(): void {
  const insert = db.prepare(
    `INSERT INTO permissions(agent_key, action_type, allowed, requires_approval)
     VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM permissions`).run();
    for (const r of permSnapshot) {
      insert.run(r.agent_key, r.action_type, r.allowed, r.requires_approval);
    }
  })();
}

beforeEach(() => {
  _resetRateLimits();
  _resetRateLimiter();
  _resetAlertCooldowns();
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope IN ('agent', 'chat')`,
  ).run();
  if (permissionsSignature() !== permSignature) restorePermissions();
});
