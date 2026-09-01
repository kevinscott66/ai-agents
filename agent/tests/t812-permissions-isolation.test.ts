/**
 * T-812: до правки таблица `permissions` жила на одной SQLite между файлами и
 * между тестами не сбрасывалась — сбрасывались только `autonomy_modes` и
 * рейт-лимиты. Тест, поправивший строку прав и не вернувший её, ронял чужие
 * файлы, причём недетерминированно: порядок файлов у bun не фиксирован.
 *
 * Замер (PR #435): пять тестов из четырёх файлов упали в CI с одним и тем же
 * `expect(p.requires_approval).toBe(false) → Received: true`, а `gh run rerun
 * --failed` на том же коммите прошёл зелёным.
 *
 * Тесты ниже нарочно оставляют за собой грязь: следующий тест в файле обязан
 * увидеть посеянное состояние. Порядок внутри файла у bun — порядок объявления.
 */
import { test, expect, describe } from "bun:test";
import { db } from "../lib/db.ts";
import { getPermission, setPermission } from "../lib/permissions.ts";

const AGENT = "qa";
const ACTION = "SET_REACTION" as const;

function seeded() {
  return getPermission(AGENT, ACTION);
}

describe("T-812: изоляция таблицы прав между тестами", () => {
  test("исходное состояние — посеянное миграцией", () => {
    const p = seeded();
    expect(p.allowed).toBe(true);
    expect(p.requires_approval).toBe(false);
  });

  test("портим строку и НЕ возвращаем её", () => {
    setPermission(AGENT, ACTION, { allowed: false, requires_approval: true });
    expect(seeded()).toEqual({ allowed: false, requires_approval: true });
  });

  test("следующий тест видит посев, а не чужую правку", () => {
    expect(seeded()).toEqual({ allowed: true, requires_approval: false });
  });

  test("удаляем строку целиком и НЕ возвращаем её", () => {
    db.prepare(
      `DELETE FROM permissions WHERE agent_key = ? AND action_type = ?`,
    ).run(AGENT, ACTION);
    // Удаление — не «состояние по умолчанию»: getPermission на пустой строке
    // отдаёт «запрещено», то есть противоположность посеянному разрешению.
    expect(seeded()).toEqual({ allowed: false, requires_approval: false });
  });

  test("удалённая строка восстановлена, а не осталась дырой", () => {
    expect(seeded()).toEqual({ allowed: true, requires_approval: false });
  });

  test("добавляем лишнюю строку и НЕ убираем её", () => {
    setPermission("qa", "MAC_RUN_CLAUDE", { allowed: true, requires_approval: false });
    expect(getPermission("qa", "MAC_RUN_CLAUDE").allowed).toBe(true);
  });

  test("лишняя строка снята — подпись ловит и добавление", () => {
    expect(getPermission("qa", "MAC_RUN_CLAUDE").allowed).toBe(false);
  });

  test("восстановление не рвёт остальную таблицу", () => {
    const n = (
      db.prepare(`SELECT count(*) AS n FROM permissions`).get() as { n: number }
    ).n;
    expect(n).toBeGreaterThan(200);
    expect(getPermission("orchestrator", "SEND_MESSAGE").allowed).toBe(true);
  });
});
