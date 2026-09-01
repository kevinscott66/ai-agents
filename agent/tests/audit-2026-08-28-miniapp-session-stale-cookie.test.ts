/**
 * Аудит 2026-08-28: гард `cookieFor` не проверял того, ради чего заведён.
 *
 * `cookieFor` — не-бросающий вариант `cookie()`, поставленный туда, где
 * исключение уже некому поймать: единственный боевой вызов стоит в
 * `miniapp-server.ts` ПОСЛЕ catch обработчика, и бросок оттуда уходит прямо в
 * `Bun.serve`, у которого в этом сервере нет опции `error` — готовый ответ
 * заменяется голым 500, а строка access-лога не пишется вовсе.
 *
 * Собственный докблок гарда описывает случай так: TTL пять минут, `prune()`
 * зовётся из `issue()`/`validate()` ПАРАЛЛЕЛЬНОГО запроса, а обработчик,
 * выдавший сессию, может держать ответ дольше. Но проверял он
 * `sessions.has(token)` — обычный lookup, без `prune()` и без сверки
 * `expiresAt`. То есть закрывал ровно ту половину, где кто-то другой уже
 * вычистил запись, и не закрывал вторую: если параллельных запросов не было,
 * протухшая запись всё ещё лежит в Map, `has` отвечает true — и клиент
 * получает cookie с Max-Age на пять минут вперёд под токен, который сервер
 * посчитает мёртвым при первом же `prune()`.
 *
 * Деградация мягкая (следующая мутация переоткрывает сессию), но гард обязан
 * означать то, что написано в его докблоке.
 */
import { describe, expect, test } from "bun:test";
import { MiniAppSessionStore } from "../lib/miniapp-session.ts";

const TTL = 60_000;
const USER = 4242;
const FP = "a".repeat(64);

function storeAt(clock: { t: number }): MiniAppSessionStore {
  return new MiniAppSessionStore({ now: () => clock.t, ttlMs: TTL });
}

describe("cookieFor и срок жизни сессии", () => {
  test("живая сессия отдаёт cookie", () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    const token = store.issue(USER, FP)!;
    clock.t += TTL - 1;
    expect(store.cookieFor(token)).toContain(token);
  });

  test("протухшая сессия не отдаёт cookie, даже если никто не пруннул", () => {
    // Ни одного параллельного запроса: issue/validate между выдачей и
    // выдачей cookie не звались, запись всё ещё лежит в Map.
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    const token = store.issue(USER, FP)!;
    clock.t += TTL;
    expect(store.cookieFor(token)).toBeNull();
  });

  test("протухшую запись гард ещё и убирает, а не только скрывает", () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    const token = store.issue(USER, FP)!;
    clock.t += TTL;
    store.cookieFor(token);
    // Если бы запись осталась, `cookie()` по тому же токену не бросил бы —
    // и следующий вызов вернул бы cookie на мёртвую сессию.
    expect(() => store.cookie(token)).toThrow();
  });

  test("неизвестный токен по-прежнему даёт null, а не бросок", () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    expect(store.cookieFor("нет такого токена")).toBeNull();
  });

  test("cookie() на протухшей сессии бросает — это не тот вызов, что гардят", () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    const token = store.issue(USER, FP)!;
    clock.t += TTL;
    // `cookie()` контракта не меняет: он и был обязан бросать на неизвестной
    // сессии, а после прунинга протухшая — неизвестная.
    store.cookieFor(token);
    expect(() => store.cookie(token)).toThrow();
  });
});
