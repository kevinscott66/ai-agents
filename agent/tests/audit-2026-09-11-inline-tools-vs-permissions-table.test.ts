/**
 * Аудит 2026-09-11, круг 51: почему строка `permissions` на инлайновый
 * инструмент не может ни подействовать, ни соврать.
 *
 * ЧТО ПРОВЕРЯЛОСЬ. Инлайновые инструменты (`INLINE_TOOL_NAMES`) `executeTool`
 * обслуживает сам, коротким замыканием до `gateOrDispatch`, и таблицу
 * `permissions` на этом пути не читает никто. Отсюда напрашивается вывод, что
 * `/grant qa QUERY_DB` запишет мёртвую строку и ответит «права обновлены», а
 * `/perms` покажет `QUERY_DB=denied` при работающем инструменте — то есть
 * отчёт о правах разойдётся с гейтом в ту сторону, в которую врать дороже
 * всего: владелец снимает доступ, получает подтверждение и уходит.
 *
 * ЧЕМ ЭТО КОНЧИЛОСЬ. Вывод неверен, и неверен по одной причине: инлайновые
 * инструменты и типы действий — РАЗНЫЕ ПРОСТРАНСТВА ИМЁН. Ни одно из 12 имён
 * `INLINE_TOOL_NAMES` не входит в `ACTION_TYPES`, а все три входа записи
 * (`/grant` + `/revoke`, `POST /api/permissions`, обработчик
 * `GRANT_PERMISSION`) отбивают неизвестный тип ДО записи. Строку с именем
 * инлайнового инструмента в таблицу не положить вообще — ни через команду, ни
 * через Mini App, ни миграцией (сиды кладут только типы из `ACTION_TYPES`).
 * `/perms` печатает то, что в таблице лежит, а лежать там такому нечему.
 *
 * ПОЭТОМУ ЗДЕСЬ НЕТ ПРАВКИ КОДА. Первая версия этого круга добавила в
 * `permissions.ts` отдельный сторож-предикат, а в четыре входа — отказы со
 * ссылкой на него. Замер (он же первый тест ниже) показал, что сторож
 * недостижим: его аргумент типизирован `ActionType`, пересечение с
 * `INLINE_TOOL_NAMES` пусто, и ни одна ветка отказа не исполнилась бы никогда.
 * Сторож, закрывающий невозможное, — то же враньё, только в коде: он заявляет
 * защиту, которой не даёт, и следующий читатель поверит ему, а не замеру.
 * Правка откачена, осталось измерение.
 *
 * ЧТО ЭТОТ ФАЙЛ СТЕРЕЖЁТ. Ровно инвариант, на котором держится вывод: как
 * только пространства имён пересекутся — кто-то внесёт `QUERY_DB` в
 * `ACTION_TYPES` или назовёт новый инлайновый инструмент именем действия, —
 * первый тест покраснеет, и разговор про мёртвую строку придётся вести заново,
 * уже имея под рукой настоящий случай. До тех пор его нет.
 *
 * Не путать с `inline-tools-role-check.test.ts`: там про действующую преграду
 * инлайнового пути (`ROLE_EXPOSED_TOOLS` / `CALLER_RESTRICTED`), здесь — про
 * то, что таблица `permissions` к этому пути не относится вовсе.
 */
import { test, expect, describe } from "bun:test";
import { ACTION_TYPES, isToolExposedToRole, type ActionType } from "../lib/permissions.ts";
import { INLINE_TOOL_NAMES } from "../lib/constants.ts";
import { CHARACTERS } from "../characters/index.ts";
import { cmdGrant, cmdRevoke } from "../lib/commands.ts";
import { validateGrantPermissionPayload } from "../lib/dispatch/permissions.ts";
import { db } from "../lib/db.ts";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/** Представитель класса: самый опасный из инлайновых — произвольный SELECT. */
const INLINE_SAMPLE = "QUERY_DB";

describe("инлайновые инструменты и типы действий — непересекающиеся множества", () => {
  test("образец на месте: список не переименовали под тестом", () => {
    expect(INLINE_TOOL_NAMES.has(INLINE_SAMPLE)).toBe(true);
    expect(INLINE_TOOL_NAMES.size).toBeGreaterThan(0);
    expect(ACTION_TYPES.length).toBeGreaterThan(0);
  });

  test("пересечение пусто — на этом держится весь разбор в шапке", () => {
    const both = ACTION_TYPES.filter((a) => INLINE_TOOL_NAMES.has(a));
    // Список, а не счётчик: покраснев, тест обязан назвать виновника.
    expect(both).toEqual([]);
  });
});

describe("замер: почему инлайновый путь нельзя просто завести в гейт", () => {
  test("ни одна выданная пара роль↔инлайновый инструмент не имеет строки в таблице", () => {
    const rows = new Set(
      (
        db.prepare("SELECT agent_key, action_type FROM permissions").all() as Array<{
          agent_key: string;
          action_type: string;
        }>
      ).map((r) => `${r.agent_key}.${r.action_type}`),
    );
    const covered: string[] = [];
    let pairs = 0;
    for (const c of CHARACTERS) {
      for (const t of INLINE_TOOL_NAMES) {
        if (!isToolExposedToRole(t, c.key)) continue;
        pairs++;
        if (rows.has(`${c.key}.${t}`)) covered.push(`${c.key}.${t}`);
      }
    }
    // Без этой строки утверждение ниже было бы пустым: ноль пар — ноль строк.
    expect(pairs).toBeGreaterThan(0);
    // Отсюда и вывод: включить проверку таблицы на инлайновом пути — значит
    // закрыть весь читающий инструментарий разом. Не «оптимизация», а отказ.
    expect(covered).toEqual([]);
  });

  test("таблица засеяна только типами действий", () => {
    const seeded = (
      db.prepare("SELECT DISTINCT action_type FROM permissions").all() as Array<{
        action_type: string;
      }>
    ).map((r) => r.action_type);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.filter((a) => !ACTION_TYPES.includes(a as ActionType))).toEqual([]);
  });
});

describe("все входы записи отбивают имя инлайнового инструмента", () => {
  test("/grant отказывает и ничего не пишет", () => {
    const out = cmdGrant({ args: ["backend", INLINE_SAMPLE, "auto"], changedBy: "tg:1" });
    expect(out).toContain(`Неизвестный action: ${INLINE_SAMPLE}`);
    expect(out).not.toContain("права обновлены");
    expect(
      db
        .prepare("SELECT 1 FROM permissions WHERE agent_key = ? AND action_type = ?")
        .get("backend", INLINE_SAMPLE),
    ).toBeNull();
  });

  test("/revoke отказывает и ничего не пишет", () => {
    const out = cmdRevoke({ args: ["backend", INLINE_SAMPLE], changedBy: "tg:1" });
    expect(out).toContain(`Неизвестный action: ${INLINE_SAMPLE}`);
    expect(out).not.toContain("права обновлены");
    expect(
      db
        .prepare("SELECT 1 FROM permissions WHERE agent_key = ? AND action_type = ?")
        .get("backend", INLINE_SAMPLE),
    ).toBeNull();
  });

  test("GRANT_PERMISSION отбивает полезную нагрузку", () => {
    const err = validateGrantPermissionPayload({
      target_agent_key: "backend",
      action_type: INLINE_SAMPLE,
      allowed: true,
      requires_approval: false,
    } as never);
    expect(err).toContain(INLINE_SAMPLE);
    expect(err).toContain("unknown action_type");
  });

  test("Mini App проверяет тип ДО setPermission, а не после", () => {
    // Текстом: маршрут — ветка HTTP-сервера, поднимать её целиком ради порядка
    // двух строк дороже, чем он стоит. Ловится ровно тот регресс, о котором
    // речь: проверка уехала за запись.
    const s = src("lib/miniapp-server.ts");
    const check = s.indexOf("unknown actionType");
    // Первая запись ПОСЛЕ проверки: уедет проверка за запись — поиск от неё
    // запись не найдёт. Регэксп, а не подстрока, — чтобы файл не читался
    // T-751 как пишущий в permissions.
    const write = s.slice(check).search(/setPermission\(/);
    expect(check).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(0);
  });
});
