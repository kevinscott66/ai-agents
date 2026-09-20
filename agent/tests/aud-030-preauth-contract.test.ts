/**
 * AUD-20260919-030, срез: граница «кто отвечает до стены аутентификации».
 *
 * Что здесь проверяется и чего НЕ проверял никто до этого.
 *
 * Про стену уже есть сторож — `audit-2026-09-11-miniapp-preauth-exceptions`.
 * Он сверяет ДВЕ стороны: шапку lib/miniapp-server.ts и настоящий набор веток
 * выше `authOr401`. Сторона третья — по какому правилу тот же запрос попадает
 * в анонимное ведро — не проверялась ничем: правило было выражением внутри
 * `fetch()`, набор маршрутов — ветками внутри `route()`, и совпадали они лишь
 * потому, что оба трогал один человек за один заход.
 *
 * Цена расхождения не гипотетическая. Маршрут под /api/, поставленный выше
 * стены и отвечающий 200, не попадает НИ В ОДНО ведро: пользовательские
 * снимаются за стеной, до которой он не доходит, а анонимное — только если
 * `isPreAuthRequest` вернул true, чего для /api/-пути не бывает. При этом
 * такой маршрут честно пройдёт существующего сторожа: тот требует лишь, чтобы
 * путь был назван в шапке. Ретроспективный счёт ниже по `fetch()` тоже не
 * поможет — он считает только 401 и отбой на стене.
 *
 * Поэтому контракт двусторонний: каждая ветка выше стены либо покрыта
 * правилом, либо названа в `SELF_LIMITED_PRE_WALL` — и каждая запись оттуда
 * обязана и вправду стоять выше стены и снимать токен сама.
 *
 * ЧЕГО ЭТОТ ТЕСТ НЕ ДЕЛАЕТ. Он не поднимает сервер и не меряет лимиты (это
 * `miniapp-anon-rate-limit`), не проверяет достаточность самой стены и, как и
 * соседний сторож, не видит веток, где путь собирается из переменной.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPreAuthRequest,
  SELF_LIMITED_PRE_WALL,
} from "../lib/miniapp-preauth.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "lib", "miniapp-server.ts"),
  "utf8",
);
const LINES = SRC.split("\n");

const ROUTE = LINES.findIndex((l) => l.includes("async function route("));
const WALL = LINES.findIndex((l) =>
  l.includes("const auth = authOr401(req, url);"),
);
const PRE_WALL = LINES.slice(ROUTE, WALL).join("\n");

/** Пути из веток `path === "..."`, стоящих выше стены. */
function pathsAboveWall(): string[] {
  const out = new Set<string>();
  for (const m of PRE_WALL.matchAll(/path === "(\/[a-z0-9/-]+)"/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

describe("правило pre-auth отвечает по форме пути", () => {
  test("всё не под /api/ обслуживается до стены", () => {
    for (const p of ["/", "/index.html", "/assets/app.js", "/healthz", "/readyz", "/metrics"]) {
      expect(isPreAuthRequest(p, "GET")).toBe(true);
    }
  });

  test("/api/health — единственный /api/-путь по имени", () => {
    expect(isPreAuthRequest("/api/health", "GET")).toBe(true);
    expect(isPreAuthRequest("/api/tasks", "GET")).toBe(false);
    expect(isPreAuthRequest("/api/events", "GET")).toBe(false);
  });

  test("OPTIONS обслуживается до стены на любом пути", () => {
    expect(isPreAuthRequest("/api/tasks", "OPTIONS")).toBe(true);
    // Регистр метода не должен менять ответ: сюда приходит и строка из теста.
    expect(isPreAuthRequest("/api/tasks", "options")).toBe(true);
    expect(isPreAuthRequest("/api/tasks", "Options")).toBe(true);
  });

  test("/api/healthz и /api/health/x правилом не покрыты", () => {
    // Сравнение точное, а не по префиксу: иначе любой /api/health* уезжал бы
    // из-под лимита вместе с пробой живости.
    expect(isPreAuthRequest("/api/healthz", "GET")).toBe(false);
    expect(isPreAuthRequest("/api/health/details", "GET")).toBe(false);
  });
});

describe("правило сходится с настоящим набором маршрутов выше стены", () => {
  test("предпосылка: route() и стена найдены, стена ниже", () => {
    expect(ROUTE).toBeGreaterThan(0);
    expect(WALL).toBeGreaterThan(ROUTE);
    expect(pathsAboveWall().length).toBeGreaterThan(0);
  });

  test("каждый путь выше стены либо покрыт правилом, либо назван как самоограниченный", () => {
    for (const p of pathsAboveWall()) {
      const covered = isPreAuthRequest(p, "GET");
      const listed = SELF_LIMITED_PRE_WALL.includes(p);
      // Сообщение важнее проверки: тот, кто уронит этот тест, ставит маршрут
      // выше стены и должен узнать, что он оказался вообще вне лимитов.
      expect(
        covered || listed,
        `${p} отвечает выше стены, но не попадает ни в анонимное ведро, ни в пользовательское: ` +
          `либо правило в lib/miniapp-preauth.ts, либо свой рейт-лимит и запись в SELF_LIMITED_PRE_WALL`,
      ).toBe(true);
    }
  });

  test("в списке самоограниченных нет записей про несуществующие маршруты", () => {
    // Обратная сторона: список — это долги, а не индульгенция. Убрали маршрут
    // выше стены — убирайте и запись, иначе она однажды оправдает чужой путь.
    for (const p of SELF_LIMITED_PRE_WALL) {
      expect(pathsAboveWall()).toContain(p);
    }
  });

  test("каждый самоограниченный маршрут и правда снимает токен у себя", () => {
    for (const p of SELF_LIMITED_PRE_WALL) {
      const from = PRE_WALL.indexOf(`path === "${p}"`);
      expect(from).toBeGreaterThan(-1);
      // Смотрим тело ветки до конца pre-wall куска: обработчик /api/events
      // тянется до самой стены, резать его по следующей ветке нечем.
      const body = PRE_WALL.slice(from);
      expect(
        body.includes("consumeRateToken("),
        `${p} назван самоограниченным, но consumeRateToken в его ветке нет`,
      ).toBe(true);
    }
  });
});

describe("сервер не объявляет правило заново", () => {
  test("miniapp-server зовёт isPreAuthRequest и не считает preAuth на месте", () => {
    expect(SRC).toContain('import { isPreAuthRequest } from "./miniapp-preauth.ts"');
    expect(SRC).toMatch(/const preAuth = isPreAuthRequest\(url\.pathname, req\.method\);/);
    // Ровно та форма, что стояла здесь до выноса. Вернуть её — значит завести
    // вторую копию правила, а разъезжаются именно копии.
    expect(SRC).not.toMatch(
      /const preAuth =\s*\n\s*!url\.pathname\.startsWith\("\/api\/"\)/,
    );
  });

  test("шапка сервера отсылает к модулю, а не пересказывает правило", () => {
    const head = SRC.slice(0, SRC.indexOf("*/"));
    expect(head).toContain("lib/miniapp-preauth.ts");
  });
});
