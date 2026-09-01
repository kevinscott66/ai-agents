/**
 * Аудит 2026-08-27: cookie сессии Mini App — атрибуты и имя.
 *
 * Две находки ревью PR #627, обе ломают не «строгость», а работу:
 *
 * 1. `SameSite=Strict`. Telegram Web и Desktop открывают Mini App во фрейме на
 *    своём домене — наш origin там третья сторона, и Strict-cookie браузер
 *    обратно не присылает. Сессия не подтверждается, отпечаток initData уже
 *    израсходован → 401 «replayed initData» на каждую мутацию после первой.
 *    Лечится `SameSite=None; Secure; Partitioned` (CHIPS), а НЕ выдачей
 *    существующей сессии на повторный initData без cookie: это ровно та дыра,
 *    ради которой отпечаток и заводился.
 *
 * 2. Одно фиксированное имя cookie на все запуски. Отпечаток свой у каждого
 *    запуска, слот был один: вторая вкладка затирала cookie первой, и первая
 *    получала 401 до перезагрузки.
 */
import { describe, expect, test } from "bun:test";
import { MiniAppSessionStore } from "../lib/miniapp-session.ts";

const FP_A = MiniAppSessionStore.fingerprint("query_id=a&hash=aa");
const FP_B = MiniAppSessionStore.fingerprint("query_id=b&hash=bb");

function cookieFor(store: MiniAppSessionStore, fingerprint: string): string {
  const token = store.issue(4242, fingerprint);
  expect(token).toBeString();
  return store.cookie(token!);
}

describe("cookie сессии Mini App", () => {
  test("атрибуты позволяют вернуть cookie из фрейма Telegram", () => {
    const cookie = cookieFor(new MiniAppSessionStore(), FP_A);
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; SameSite=None");
    expect(cookie).toContain("; Partitioned");
    expect(cookie).not.toContain("SameSite=Strict");
    expect(cookie).not.toContain("SameSite=Lax");
  });

  test("префикс __Host- подкреплён своими условиями", () => {
    const cookie = cookieFor(new MiniAppSessionStore(), FP_A);
    expect(cookie.startsWith("__Host-")).toBe(true);
    expect(cookie).toContain("; Path=/");
    // Domain запрещён префиксом: иначе поддомен смог бы подсунуть свою cookie.
    expect(cookie.toLowerCase()).not.toContain("; domain=");
  });

  test("у каждого запуска свой слот — вкладки не затирают друг друга", () => {
    const store = new MiniAppSessionStore();
    const nameA = MiniAppSessionStore.cookieName(FP_A);
    const nameB = MiniAppSessionStore.cookieName(FP_B);
    expect(nameA).not.toBe(nameB);
    expect(cookieFor(store, FP_A).startsWith(`${nameA}=`)).toBe(true);
    expect(cookieFor(store, FP_B).startsWith(`${nameB}=`)).toBe(true);
  });

  test("токен читается только из своего слота", () => {
    const store = new MiniAppSessionStore();
    const tokenA = store.issue(4242, FP_A)!;
    const req = new Request("https://miniapp.test/api/tasks", {
      method: "POST",
      headers: { cookie: `${MiniAppSessionStore.cookieName(FP_A)}=${tokenA}` },
    });
    expect(MiniAppSessionStore.tokenFromRequest(req, FP_A)).toBe(tokenA);
    // Чужой отпечаток — чужое имя: подставить токен другой вкладки нельзя.
    expect(MiniAppSessionStore.tokenFromRequest(req, FP_B)).toBeNull();
  });

  test("cookie для неизвестного токена не выдаётся", () => {
    expect(() => new MiniAppSessionStore().cookie("нет такого")).toThrow();
  });
});
