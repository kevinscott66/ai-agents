/**
 * Аудит 2026-08-28: половина отказных веток `verifyInitData` не была покрыта.
 *
 * Это граница аутентификации Mini App: всё, что её проходит, дальше считается
 * подтверждённым пользователем. Тесты в репо доходили только до
 * `stale auth_date`; ветки future/missing/bad auth_date и весь разбор `user`
 * не проверял никто, а `INIT_DATA_MAX_FUTURE_SKEW_SEC` не упоминалась вне
 * своего объявления вовсе. Логика веток при разборе оказалась верной — но
 * держать её было нечем: любая правка порядка проверок прошла бы молча.
 *
 * Заодно закрыт footgun самого хелпера: `hash` среди полей давал заведомо
 * невалидный initData, и упавший на нём тест указывал бы не туда.
 */
import { describe, expect, test } from "bun:test";
import {
  buildInitData,
  verifyInitData,
  INIT_DATA_MAX_FUTURE_SKEW_SEC,
} from "../lib/miniapp-auth.ts";

const TOKEN = "123456:TEST-TOKEN-not-a-real-secret";
const USER = JSON.stringify({ id: 828_004, username: "probe" });

const nowSec = (): number => Math.floor(Date.now() / 1000);

function reason(fields: Record<string, string>): string {
  const res = verifyInitData(buildInitData(TOKEN, fields), TOKEN);
  expect(res.ok).toBe(false);
  return (res as { ok: false; reason: string }).reason;
}

describe("auth_date", () => {
  test("дата из будущего дальше допустимого перекоса — отказ", () => {
    expect(
      reason({ auth_date: String(nowSec() + INIT_DATA_MAX_FUTURE_SKEW_SEC + 30), user: USER }),
    ).toBe("future auth_date");
  });

  test("небольшое опережение часов внутри перекоса принимается", () => {
    // Минус две секунды от границы: прогон теста может пересечь секунду.
    const raw = buildInitData(TOKEN, {
      auth_date: String(nowSec() + INIT_DATA_MAX_FUTURE_SKEW_SEC - 2),
      user: USER,
    });
    expect(verifyInitData(raw, TOKEN).ok).toBe(true);
  });

  test("перекос вперёд ограничен пятью минутами", () => {
    // Константа больше нигде в репо не упоминается — пиним значение здесь.
    expect(INIT_DATA_MAX_FUTURE_SKEW_SEC).toBe(300);
  });

  test("поля нет вовсе — отказ", () => {
    expect(reason({ user: USER })).toBe("missing auth_date");
  });

  test("пустая строка — это «нет поля», а не «нулевая дата»", () => {
    // Number("") === 0 прошло бы как конечное число и дало бы дату 1970-го,
    // то есть просроченную; отказ должен наступать раньше и по своей причине.
    expect(reason({ auth_date: "", user: USER })).toBe("missing auth_date");
  });

  test("нечисловая дата — отказ по своей причине", () => {
    for (const bad of ["позавчера", "12abc", "NaN"]) {
      expect(reason({ auth_date: bad, user: USER })).toBe("bad auth_date");
    }
  });

  test("просроченная дата по-прежнему отсекается", () => {
    expect(reason({ auth_date: String(nowSec() - 86_401), user: USER })).toBe(
      "stale auth_date",
    );
  });
});

describe("user", () => {
  const fresh = (user?: string): Record<string, string> => ({
    auth_date: String(nowSec()),
    ...(user === undefined ? {} : { user }),
  });

  test("поля нет вовсе — отказ", () => {
    expect(reason(fresh())).toBe("missing user");
  });

  test("не-JSON — отказ по своей причине", () => {
    expect(reason(fresh("{"))).toBe("bad user JSON");
    expect(reason(fresh("не json вовсе"))).toBe("bad user JSON");
  });

  test("валидный JSON, но не тот тип — отказ по форме", () => {
    for (const bad of ["null", "123", '"строка"', "[]", "[{}]", "{}"]) {
      expect(reason(fresh(bad))).toBe("bad user shape");
    }
  });

  test("id не положительное целое в безопасном диапазоне — отказ по форме", () => {
    for (const id of ["0", "-1", "1.5", '"828004"', "true", "9007199254740993"]) {
      expect(reason(fresh(`{"id":${id}}`))).toBe("bad user shape");
    }
  });

  test("нормальный пользователь проходит и доезжает целиком", () => {
    const raw = buildInitData(TOKEN, { auth_date: String(nowSec()), user: USER });
    const res = verifyInitData(raw, TOKEN);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user.id).toBe(828_004);
      expect(res.user.username).toBe("probe");
    }
  });
});

describe("buildInitData не даёт собрать заведомо невалидный initData", () => {
  test("hash среди полей — бросок, а не «bad hash» этажом ниже", () => {
    expect(() => buildInitData(TOKEN, { auth_date: "1", hash: "a".repeat(64) })).toThrow(
      /hash/,
    );
  });

  test("без hash в полях хелпер работает как раньше", () => {
    const raw = buildInitData(TOKEN, { auth_date: String(nowSec()), user: USER });
    expect(new URLSearchParams(raw).get("hash")).toMatch(/^[0-9a-f]{64}$/);
  });
});
