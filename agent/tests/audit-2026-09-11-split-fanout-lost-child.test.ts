/**
 * Аудит 2026-09-11, круг 30: фан-аут SPLIT_TASK терял исход «делегирование
 * прошло, строки задачи нет» — и объявлял по этому поводу, что провалились все.
 *
 * Цикл клал в `childIds` только при `r.taskId`, а в `errors` — только при
 * `r.kind !== "ok"`. Исход `ok` без `taskId` не попадал никуда. Возникает он не
 * от отказа: `DELEGATE_TO_ROLE` ловит исключение `createTask`, пишет строку в
 * лог и продолжает — ход сделан, объявление в чате, ответ модели оплачен, нет
 * только строки на доске.
 *
 * Дальше `childIds.length !== roles.length` при пустом `errors` давало
 * текст-заглушку «all delegations failed», `reconcileExpectedChildren` при
 * `actual > 0` клал его в `input.delegationError`, а `rollupParent` по этому
 * маркеру штамповал родителю `failed`. Сплит, где обе роли отработали,
 * закрывался как полный провал, и ложь ехала вверх по предкам.
 *
 * Проверяется решение, а не диспетчер: чтобы `createTask` упал ровно у одной
 * роли, нужен мок модуля, а мок модуля в общем процессе `bun test` протекает в
 * соседние файлы (тот же довод — в tests/handoff-budget-per-turn.test.ts).
 * Поэтому решение вынесено в чистые функции, и они здесь и меряются.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  foldFanoutOutcomes,
  delegationShortfallText,
  MISSING_ROW_SEGMENT,
} from "../lib/dispatch/split-fanout.ts";
import { isByDesignRefusal, joinDelegationErrors } from "../lib/diagnostic.ts";

describe("исход без строки задачи не теряется", () => {
  test("одна роль сдала, у второй строка не записалась", () => {
    const { childIds, errors } = foldFanoutOutcomes([
      { role: "smm", taskId: "t-1" },
      { role: "qa" }, // ok, но createTask бросил
    ]);

    expect(childIds).toEqual(["t-1"]);
    // До правки здесь был пустой массив, и вызывающий брал заглушку
    // «all delegations failed» — про роль, которая работу сдала.
    expect(errors).toEqual([`qa: ${MISSING_ROW_SEGMENT}`]);
  });

  test("потерянная строка — поломка, а не отказ по правилам", () => {
    const { errors } = foldFanoutOutcomes([{ role: "qa" }]);
    // Иначе диагностика на потерянного ребёнка не заведётся: отказы по
    // правилам её намеренно не поднимают.
    expect(isByDesignRefusal(joinDelegationErrors(errors))).toBe(false);
  });

  test("отказ гейта по-прежнему попадает в errors с ролью", () => {
    const { childIds, errors } = foldFanoutOutcomes([
      { role: "smm", refusal: "forbidden: нет права" },
    ]);
    expect(childIds).toEqual([]);
    expect(errors).toEqual(["smm: forbidden: нет права"]);
  });

  test("полный успех не даёт ни одной ошибки", () => {
    const { childIds, errors } = foldFanoutOutcomes([
      { role: "smm", taskId: "t-1" },
      { role: "qa", taskId: "t-2" },
    ]);
    expect(childIds).toEqual(["t-1", "t-2"]);
    expect(errors).toEqual([]);
  });

  test("отказ важнее отсутствующей строки: сегмент один, не два", () => {
    // У отказанного исхода taskId нет по построению — двойной учёт сделал бы
    // из одного отказа две записи и сбил бы вердикт isByDesignRefusal.
    const { errors } = foldFanoutOutcomes([{ role: "smm", refusal: "delegation cycle" }]);
    expect(errors).toHaveLength(1);
    expect(isByDesignRefusal(joinDelegationErrors(errors))).toBe(true);
  });
});

describe("заглушка не утверждает того, чего не знает", () => {
  test("текст называет счёт, а не исход делегирований", () => {
    const t = delegationShortfallText(1, 2);
    expect(t).toContain("1/2");
    expect(t).not.toContain("all delegations failed");
  });

  test("прежний литерал из диспетчера убран", () => {
    // Он употреблялся ровно там, где не имел на это права: ветку открывает
    // ЛЮБОЕ расхождение, включая частичное.
    const src = readFileSync(new URL("../lib/action-dispatch.ts", import.meta.url), "utf8");
    expect(src).not.toContain('"all delegations failed"');
  });
});
