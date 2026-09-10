/**
 * Аудит 2026-09-11: два тупика, в которые Mini App заводила допущенного
 * НЕ-админа.
 *
 * 1. `GET /api/budget-settings` закрыт админом с аудита 2026-08-20, и решение
 *    это верное — ручка отдаёт `updated_by`, то есть telegram-id админа.
 *    Обоснование в докблоке кончалось словами «Mini App этим эндпоинтом не
 *    пользуется: `api.budgetSettings()` объявлен, но не вызывается ни из
 *    одного компонента — так что гейт ничего не ломает». Это неправда:
 *    `Settings.tsx` зовёт его в общем `Promise.all` загрузки. Зритель получал
 *    403, страница гнала его в общий `ErrorBox` с кнопкой «Повторить», и под
 *    оранжевой полосой «Просмотр настроек (только для админа)» навсегда висела
 *    красная ошибка про то же самое, с кнопкой, которая не могла сработать.
 *
 * 2. `Approvals.tsx` — единственная страница без признака прав, и при этом с
 *    самыми дорогими кнопками. Зритель видел «Одобрить» на каждой карточке,
 *    проходил `window.confirm` про необратимость (аудит 2026-08-10), карточки
 *    оптимистично исчезали, сервер отвечал 403, `restoreFailed` возвращал их
 *    обратно, и всё кончалось тостом с сырой английской строкой `admin only`.
 *    Ровно то, что у «Задач» закрыл аудит 2026-08-20, у Mac — 2026-08-28, а
 *    инвариант записан в `lib/admin.ts`: про свои права клиенту говорит
 *    сервер, а не коды ошибок.
 *
 * DOM-харнесса у Mini App нет: решение вынесено в чистую функцию, расстановка
 * веток проверяется чтением исходника — как в
 * `audit-2026-08-27-miniapp-silent-load-failures.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { overridesFailure } from "../miniapp/src/pages/Settings.tsx";

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** Только код: докблоки цитируют исправленное и ломали бы проверки. */
function code(s: string): string {
  return s
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const SETTINGS = src("../miniapp/src/pages/Settings.tsx");
const APPROVALS = src("../miniapp/src/pages/Approvals.tsx");
const SERVER = src("../lib/miniapp-server.ts");

describe("403 на своих лимитах — ответ, а не сбой", () => {
  test("ответ пришёл — лимиты известны, тревоги нет", () => {
    expect(overridesFailure(null, "не важно")).toEqual({
      known: true,
      err: null,
    });
  });

  test("403 — красной ошибки нет, но и лимиты неизвестны", () => {
    expect(overridesFailure({ status: 403 }, "нет доступа")).toEqual({
      known: false,
      err: null,
    });
  });

  test("настоящий сбой — админу говорим", () => {
    expect(overridesFailure({ status: 500 }, "HTTP 500")).toEqual({
      known: false,
      err: "HTTP 500",
    });
  });

  test("сеть без кода — тоже сбой, а не «нельзя»", () => {
    expect(overridesFailure({}, "Failed to fetch")).toEqual({
      known: false,
      err: "Failed to fetch",
    });
  });
});

describe("Settings: подпись под пустым полем не выводится из молчания", () => {
  test("подсказка стоит за признаком «лимиты известны»", () => {
    const c = code(SETTINGS);
    expect(c).toContain("overridesKnown");
    expect(c).toMatch(/const hint = overridesKnown\s*\?\s*effectiveHint\(/);
  });

  test("отказ разбирается общей функцией, а не formatApiError в лоб", () => {
    const c = code(SETTINGS);
    expect(c).toContain("overridesFailure(e, formatApiError(e))");
    expect(c).not.toMatch(/overridesFailed\.err = formatApiError/);
  });
});

describe("докстрока роута не утверждает того, чего нет", () => {
  test("Settings.tsx действительно зовёт ручку", () => {
    expect(code(SETTINGS)).toContain("api.budgetSettings()");
  });

  test("сервер про это больше не говорит обратное", () => {
    expect(SERVER).not.toContain("не вызывается ни из одного");
    const i = SERVER.indexOf('path === "/api/budget-settings"');
    expect(i).toBeGreaterThan(0);
    // Причина гейта (`updated_by`) осталась на месте — правится утверждение,
    // а не решение.
    expect(SERVER.slice(0, i)).toContain("updated_by");
  });
});

describe("Approvals: кнопок нет там, где сервер откажет", () => {
  test("права спрашиваются у сервера общим примитивом", () => {
    const c = code(APPROVALS);
    expect(c).toContain('from "../lib/admin"');
    expect(c).toContain("adminFromAutonomy");
    expect(c).toContain("api\n      .autonomy()");
  });

  test("решение закрыто до всякого confirm", () => {
    const c = code(APPROVALS);
    const body = c.slice(c.indexOf("function renderActions"));
    const gate = body.indexOf("if (!canDecide)");
    const confirm = body.indexOf("window.confirm");
    expect(gate).toBeGreaterThan(0);
    expect(confirm).toBeGreaterThan(gate);
  });

  test("отказ на чтении прав читается как «не админ», а не как «админ»", () => {
    const c = code(APPROVALS);
    expect(c).toContain("catch(() => setCanDecide(adminFromAutonomy(null)))");
  });
});
