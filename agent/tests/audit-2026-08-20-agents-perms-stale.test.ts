/**
 * Аудит 2026-08-20 — права из закрытой карточки роли не должны попадать в
 * открытую, и тем более не должны в неё записываться.
 *
 * Что было. `openAgent(a)` в pages/Agents.tsx звал `api.permissions(a.key)` и
 * безусловно клал ответ в состояние. Ответы сети не упорядочены, а карточку
 * можно закрыть по оверлею и тут же открыть другую — то есть последователь-
 * ность «клик по backend → закрыть → клик по frontend» укладывается в один
 * round-trip. Ответ для backend приезжал вторым и перерисовывал открытую
 * карточку frontend.
 *
 * Дальше это переставало быть косметикой: `toggle()` слал в API
 * `agentKey: next.agentKey`, то есть ключ ИЗ СТРОКИ. Строки в этот момент
 * принадлежат backend. Админ, видя заголовок «frontend», выдавал право
 * backend'у — молча и без единого признака в интерфейсе. Ровно тот класс,
 * который в этом репозитории уже закрыт для Tasks и Approvals примитивом
 * `lib/stale.ts`.
 *
 * Проверяем обе половины. Чистая половина — `canWritePermission`. Проводку
 * (openAgent под `useLatestRun`) — чтением исходника: DOM-харнесса у Mini App
 * в прогоне нет, а импортировать страницу нельзя — она тянет preact-хуки.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { canWritePermission } from "../miniapp/src/pages/Agents.tsx";

const SRC = readFileSync(
  new URL("../miniapp/src/pages/Agents.tsx", import.meta.url),
  "utf8",
);

describe("canWritePermission", () => {
  test("строка принадлежит открытой карточке → писать можно", () => {
    expect(canWritePermission("backend", "backend")).toBe(true);
  });

  test("строка от другой роли → писать нельзя", () => {
    expect(canWritePermission("backend", "frontend")).toBe(false);
  });

  test("карточка закрыта (null) → писать некуда", () => {
    expect(canWritePermission("backend", null)).toBe(false);
  });

  test("пустой ключ открытой карточки не совпадает ни с чем", () => {
    expect(canWritePermission("", "")).toBe(false);
    expect(canWritePermission("backend", "")).toBe(false);
  });

  test("сравнение точное, без учёта регистра и подстрок", () => {
    expect(canWritePermission("Backend", "backend")).toBe(false);
    expect(canWritePermission("backend", "backend2")).toBe(false);
    expect(canWritePermission("back", "backend")).toBe(false);
  });
});

describe("проводка Agents.tsx", () => {
  test("страница берёт примитив устаревания из lib/stale.ts", () => {
    expect(SRC).toContain('from "../lib/stale"');
    expect(SRC).toContain("useLatestRun");
  });

  test("openAgent открывает прогон ДО запроса прав", () => {
    const begin = SRC.indexOf("const isCurrent = beginPerms();");
    const call = SRC.indexOf("api.permissions(a.key)");
    expect(begin).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(call);
  });

  test("каждая запись в состояние прав стоит под предикатом", () => {
    const body = SRC.slice(
      SRC.indexOf("async function openAgent"),
      SRC.indexOf("async function toggle("),
    );
    expect(body).toContain("if (!isCurrent()) return;");
    // Скелетон тоже: устаревший ответ не должен гасить индикатор, пока
    // актуальный ещё в пути.
    const guard = body.indexOf("if (!isCurrent()) return;");
    // Именно записи ПОСЛЕ ответа. Сбросы в начале функции (`setPermErr(null)`,
    // `setReadonly(false)`) синхронные — им предикат не нужен и не положен.
    for (const setter of [
      "setPermsLoading(false)",
      "setPerms(permsRes.value.permissions)",
      'setPermErr("Права доступны',
      // Текст ошибки собирает formatApiError — сообщение исключения наружу
      // больше не идёт дословно; предикат нужен ровно так же.
      "setPermErr(formatApiError(e))",
      "setReadonly(true)",
    ]) {
      expect(body.indexOf(setter)).toBeGreaterThan(guard);
    }
  });

  test("список действий остаётся вне предиката — он адресован по ключу", () => {
    const body = SRC.slice(
      SRC.indexOf("async function openAgent"),
      SRC.indexOf("async function toggle("),
    );
    // setRecentActions пишет в словарь по a.key, поэтому устаревший ответ
    // ничего не портит: он заполняет свою же ячейку. Гасить его — потерять
    // уже полученные данные.
    expect(body.indexOf("setRecentActions")).toBeLessThan(
      body.indexOf("if (!isCurrent()) return;"),
    );
  });

  test("toggle сверяет строку с открытой карточкой и шлёт её ключ", () => {
    const body = SRC.slice(
      SRC.indexOf("async function toggle("),
      SRC.indexOf("return (", SRC.indexOf("async function toggle(")),
    );
    expect(body).toContain("canWritePermission(");
    expect(body).toContain("selected");
    // Ключ в запрос идёт от открытой карточки, а не из строки.
    expect(body).not.toContain("agentKey: next.agentKey");
  });
});
