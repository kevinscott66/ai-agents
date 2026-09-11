/**
 * Страница «Задачи» показывала не-админу кнопки, которые ему не нажать.
 *
 * Сервер закрывает админом создание задачи (`POST /api/tasks`) и смену
 * статуса (`POST /api/tasks/:id/status`) — обе ветки в lib/miniapp-server.ts
 * зовут `requireAdmin`. Клиент об этом не знал ничего: «+ Новая задача», быстрые действия
 * ✓/✗/⊘ и кнопки переходов в карточке рисовались всем одинаково. Не-админ
 * заполнял форму, жал «Создать» и получал тост «admin only» — сырой английской
 * строкой, на полторы секунды.
 *
 * Инвариант в проекте уже сформулирован (tests/miniapp-admin-flag.test.ts,
 * аудит 2026-08-12): сервер сам сообщает клиенту, админ ли тот, а не оставляет
 * клиенту гадать по кодам ошибок. Settings и Dashboard по нему уже живут,
 * Tasks — нет. `GET /api/autonomy` отдаёт этот признак любому allowlisted
 * пользователю — `requireAdmin` там как раз НЕ стоит, — оттуда его и берём,
 * ровно как это делает Dashboard.tsx.
 *
 * Проводка проверяется чтением исходника: DOM-харнесса у Mini App нет.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { adminFromAutonomy } from "../miniapp/src/lib/admin.ts";

describe("adminFromAutonomy", () => {
  test("админ — можно", () => {
    expect(adminFromAutonomy({ admin: true })).toBe(true);
  });

  test("не админ — нельзя", () => {
    expect(adminFromAutonomy({ admin: false })).toBe(false);
  });

  test("поля нет — старый бэкенд, ведём себя как раньше", () => {
    // Гейт появился на сервере позже клиента; при рассинхроне версий отбирать
    // кнопки у настоящего админа было бы хуже, чем показать лишнюю.
    expect(adminFromAutonomy({})).toBe(true);
  });

  test("запрос не удался — кнопок не показываем", () => {
    // Отказ читается как «не знаем» и трактуется в сторону тишины: показать
    // кнопку, которая гарантированно вернёт 403, хуже, чем не показать её.
    expect(adminFromAutonomy(null)).toBe(false);
  });
});

describe("проводка Tasks.tsx", () => {
  const RAW = readFileSync(
    new URL("../miniapp/src/pages/Tasks.tsx", import.meta.url),
    "utf8",
  );
  // Комментарии цитируют старый код — проверяем исполняемый текст.
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("признак берётся с сервера, а не угадывается", () => {
    expect(SRC).toMatch(/api\s*\.\s*autonomy\(\)/);
    expect(SRC).toContain("adminFromAutonomy(");
  });

  test("кнопка создания закрыта", () => {
    expect(SRC).toMatch(/disabled=\{!canEdit\}[\s\S]{0,80}\+ Новая задача/);
  });

  test("быстрые действия закрыты", () => {
    expect(SRC).toContain("disabled={busy || !canEdit}");
  });

  test("кнопки переходов в карточке закрыты", () => {
    expect(SRC).toContain("disabled={!!busyIds[selected.id] || !canEdit}");
  });

  test("причина названа, а не просто отобраны кнопки", () => {
    // Молча выключенная кнопка читается как поломка. Один и тот же текст, что
    // на странице ролей — про MINIAPP_ADMIN_USER_IDS.
    expect(SRC).toContain("MINIAPP_ADMIN_USER_IDS");
    expect(SRC).toMatch(/!canEdit\s*&&/);
  });

  test("отказ не ломает список задач", () => {
    // Автономия — не то, ради чего открывают страницу. Её ошибка не должна
    // ни ронять загрузку задач, ни попадать в ErrorBox над списком.
    expect(SRC).toMatch(/adminFromAutonomy\(null\)/);
  });
});
