/**
 * Аудит 2026-08-12: битый percent-escape в адресе давал белый экран.
 *
 * preact-router при сопоставлении маршрута декодирует сегменты пути и пары
 * query-строки без try/catch. Замер настоящей библиотеки (её же экспорт
 * сопоставления, preact-router 4.1.2):
 *
 *   "/digest/%"           vs /digest/:id → THROW URIError: URI error
 *   "/digest/%E0%A4%A"    vs /digest/:id → THROW URIError: URI error
 *   "/?utm=%"             vs /           → THROW URIError: URI error
 *   "/"                   vs /           → {}
 *   "/digest/ok"          vs /digest/:id → {"id":"ok"}
 *   "/digest/a%20b"       vs /digest/:id → {"id":"a b"}
 *
 * Бросок происходит в render, границы ошибок не было — приложение не
 * монтировалось вовсе. Третья строка тут важнее первой: query-строка
 * разбирается на ЛЮБОМ маршруте, значит `/?utm=%` гасил и главную, а такой
 * хвост приезжает из обрезанной при пересылке ссылки или кривого трекера.
 *
 * Сервер на `/digest/%` отдаёт 200 и оболочку (SPA-фолбэк), так что до правки
 * пользователь получал именно белую страницу, а не 404.
 *
 * Инвариант: любой адрес, включая заведомо битый, роутер переваривает; id при
 * этом остаётся литеральным — дальше обычное «нет такой статьи».
 */
import { describe, expect, test } from "bun:test";
import { exec } from "preact-router";
import { safeRouterUrl } from "./url";

const match = exec as unknown as (
  url: string,
  route: string,
  opts: Record<string, unknown>,
) => unknown;

/** Маршруты App.tsx — Router перебирает их, пока какой-нибудь не совпадёт. */
const APP_ROUTES = [
  "/",
  "/digests",
  "/unlocks",
  "/drops",
  "/activities",
  "/status",
  "/about",
  "/digest/:id",
  "/activity/:id",
];

/** То, что делает Router на одном render: сопоставление со всеми маршрутами. */
function matchAll(url: string): void {
  for (const r of APP_ROUTES) match(url, r, {});
}

const BROKEN = [
  "/digest/%",
  "/digest/%E0%A4%A",
  "/digest/%zz",
  "/digest/%C3%28",
  "/?utm=%",
  "/digests?q=%",
  "/activity/100%",
];

describe("safeRouterUrl", () => {
  test("библиотека действительно падает на этих адресах", () => {
    for (const u of BROKEN) {
      expect(() => matchAll(u)).toThrow();
    }
  });

  test("после починки не падает ни один маршрут", () => {
    for (const u of BROKEN) {
      expect(() => matchAll(safeRouterUrl(u))).not.toThrow();
    }
  });

  test("id остаётся литеральным — это просто «нет такой статьи»", () => {
    expect(match(safeRouterUrl("/digest/%"), "/digest/:id", {})).toEqual({
      id: "%",
    });
    expect(match(safeRouterUrl("/digest/%E0%A4%A"), "/digest/:id", {})).toEqual({
      id: "%E0%A4%A",
    });
  });

  test("исправный адрес не трогаем", () => {
    for (const u of [
      "/",
      "/digest/bittensor-tao-ai-etf-2026-06-18",
      "/digest/a%20b",
      "/digests?q=%D0%B1%D0%B8%D1%82%D0%BA%D0%BE%D0%B8%D0%BD",
      "/activity/x?y=1&z=2",
    ]) {
      expect(safeRouterUrl(u)).toBe(u);
    }
    expect(match(safeRouterUrl("/digest/a%20b"), "/digest/:id", {})).toEqual({
      id: "a b",
    });
  });

  test("проценты экранируются только когда адрес не декодируется", () => {
    expect(safeRouterUrl("/digest/100%25")).toBe("/digest/100%25");
    expect(safeRouterUrl("/digest/100%")).toBe("/digest/100%25");
  });
});
