/**
 * Аудит 2026-08-28: хвостовой пробел в команде становился аргументом.
 *
 * Разбор был один на все десять admin-команд: `text.split(/\s+/).slice(1)`.
 * Двойные пробелы внутри строки такой сплит съедает (`\s+` жадный), а вот
 * хвостовой — нет: `"/audit ".split(/\s+/)` даёт `["/audit", ""]`, и пустая
 * строка уезжает в аргументы как настоящее значение.
 *
 * Дальше расходятся два поведения. Команды, проверяющие аргумент на
 * истинность (`/perms`, `/tasks`, `/autonomy`, `/discussion`, `/approve`),
 * пустую строку не замечают. А две — замечают:
 *
 *   /audit·                    → «Неизвестный agent: .»
 *   /grant qa SET_REACTION·    → «Неизвестный mode: .»
 *
 * Обе отвечают отказом на команду, которую человек набрал правильно, и
 * называют причиной пустоту, которой он не вводил. Хвостовой пробел ставят
 * мобильные клавиатуры сами, так что путь этот не экзотический.
 *
 * Чиним у источника, а не в двух хендлерах: аргументов, которых человек не
 * писал, быть не должно ни у кого, включая команды, добавленные завтра.
 */
import { describe, test, expect } from "bun:test";
import { parseCommandArgs } from "../lib/admin-commands.ts";
import { cmdAudit, cmdGrant, cmdPerms } from "../lib/commands.ts";

describe("parseCommandArgs", () => {
  test("хвостовой пробел не даёт аргумента", () => {
    expect(parseCommandArgs("/audit ")).toEqual([]);
  });

  test("хвостовой перевод строки — тоже", () => {
    expect(parseCommandArgs("/audit\n")).toEqual([]);
  });

  test("пустой аргумент не появляется в хвосте списка", () => {
    expect(parseCommandArgs("/grant qa SET_REACTION ")).toEqual(["qa", "SET_REACTION"]);
  });

  test("настоящие аргументы не теряются", () => {
    expect(parseCommandArgs("/audit qa 50")).toEqual(["qa", "50"]);
    expect(parseCommandArgs("/grant  qa   SET_REACTION  approval")).toEqual([
      "qa",
      "SET_REACTION",
      "approval",
    ]);
  });

  test("команда без аргументов и пустой текст дают пустой список", () => {
    expect(parseCommandArgs("/audit")).toEqual([]);
    expect(parseCommandArgs("")).toEqual([]);
  });

  test("команда с @-суффиксом разбирается так же", () => {
    expect(parseCommandArgs("/audit@dlb_lead_bot qa")).toEqual(["qa"]);
  });
});

describe("симптомы, из-за которых это чинилось", () => {
  test("/audit с хвостовым пробелом отдаёт записи, а не «Неизвестный agent»", () => {
    const out = cmdAudit({ args: parseCommandArgs("/audit ") });
    expect(out).not.toContain("Неизвестный agent");
  });

  test("/grant с хвостовым пробелом не жалуется на пустой mode", () => {
    const out = cmdGrant({
      args: parseCommandArgs("/grant qa SET_REACTION "),
      changedBy: "test",
    });
    expect(out).not.toContain("Неизвестный mode");
  });

  test("настоящая опечатка по-прежнему отвергается", () => {
    // Правка не должна была превратиться в «глотаем всё непонятое»: это ровно
    // то поведение, от которого уходил аудит 2026-08-09 в cmdAudit.
    expect(cmdAudit({ args: parseCommandArgs("/audit designer") })).toContain(
      "Неизвестный agent",
    );
    expect(
      cmdGrant({ args: parseCommandArgs("/grant qa SET_REACTION maybe"), changedBy: "test" }),
    ).toContain("Неизвестный mode");
    expect(cmdPerms({ args: parseCommandArgs("/perms designer") })).toContain(
      "Неизвестный agent",
    );
  });
});
