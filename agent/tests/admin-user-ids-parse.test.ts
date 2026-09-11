/**
 * Аудит 2026-08-12: список админов Telegram разбирался двумя разными
 * способами, и оба неверны.
 *
 * 1) Фолбэк не работал ровно в той конфигурации, которую предлагает
 *    .env.example:
 *
 *      process.env.TELEGRAM_ADMIN_USER_IDS ?? process.env.MINIAPP_ADMIN_USER_IDS
 *
 *    `??` срабатывает на undefined/null, а строка `TELEGRAM_ADMIN_USER_IDS=` в
 *    .env (и в systemd EnvironmentFile) даёт ПУСТУЮ СТРОКУ — не nullish. Значит
 *    при `TELEGRAM_ADMIN_USER_IDS=` (как в .env.example, где рядом написано
 *    «Пусто = падает обратно на MINIAPP_ADMIN_USER_IDS») список админов пуст, и
 *    владелец на /approve получает «⛔ только для администраторов». В логе при
 *    этом «sender is not an admin» — то есть причина названа неверно: дело не в
 *    отправителе, а в том, что список не прочитан.
 *
 * 2) `parseInt` разбирает префикс: `parseInt("12345x678")` = 12345. Опечатка в
 *    CSV не отбрасывается, а превращается в ДРУГОЙ валидный id — на границе,
 *    которая решает, кто может одобрять рискованные действия и раздавать права.
 *    Mini App тот же список читает через `Number()` + `n > 0` и такую строку
 *    отбрасывает. Один и тот же .env давал разный набор админов в двух местах.
 *
 * Инвариант: пустая строка = не задано (фолбэк работает), разбор строгий и
 * совпадает с Mini App, мусор не превращается в id.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { parseAdminUserIds } from "../lib/admin-commands.ts";
import { parseAllowedIds } from "../lib/miniapp-server.ts";

const SAVED = {
  tg: process.env.TELEGRAM_ADMIN_USER_IDS,
  mini: process.env.MINIAPP_ADMIN_USER_IDS,
};

function setEnv(tg: string | undefined, mini: string | undefined): void {
  if (tg === undefined) delete process.env.TELEGRAM_ADMIN_USER_IDS;
  else process.env.TELEGRAM_ADMIN_USER_IDS = tg;
  if (mini === undefined) delete process.env.MINIAPP_ADMIN_USER_IDS;
  else process.env.MINIAPP_ADMIN_USER_IDS = mini;
}

afterEach(() => {
  setEnv(SAVED.tg, SAVED.mini);
});

describe("parseAdminUserIds: фолбэк", () => {
  test("пустая строка = не задано → берём Mini App список", () => {
    setEnv("", "111,222");
    expect(parseAdminUserIds()).toEqual([111, 222]);
  });

  test("строка из пробелов — тоже не задано", () => {
    setEnv("   ", "333");
    expect(parseAdminUserIds()).toEqual([333]);
  });

  test("заданный список побеждает Mini App", () => {
    setEnv("444", "555");
    expect(parseAdminUserIds()).toEqual([444]);
  });

  test("не задано нигде → пусто, то есть fail-closed", () => {
    setEnv(undefined, undefined);
    expect(parseAdminUserIds()).toEqual([]);
  });
});

describe("parseAdminUserIds: строгость разбора", () => {
  test("мусор не превращается в id", () => {
    setEnv("12345x678", undefined);
    expect(parseAdminUserIds()).toEqual([]);
  });

  test("отрицательные и нулевые id не проходят", () => {
    setEnv("-1,0,777", undefined);
    expect(parseAdminUserIds()).toEqual([777]);
  });

  test("пробелы и пустые элементы CSV не мешают", () => {
    setEnv(" 1 , ,2 ,", undefined);
    expect(parseAdminUserIds()).toEqual([1, 2]);
  });

  test("совпадает с разбором того же списка в Mini App", () => {
    for (const raw of ["1,2,3", "12345x678", "-1,0,7", " 9 , ,10 ", "abc"]) {
      setEnv(raw, undefined);
      expect({ raw, ids: parseAdminUserIds() }).toEqual({
        raw,
        ids: parseAllowedIds(raw),
      });
    }
  });
});
