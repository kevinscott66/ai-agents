/**
 * Аудит 2026-09-11, круг 30: экранирование значений меток в /metrics было
 * неполным — слэш и кавычка, но не перевод строки.
 *
 * Это не «инъекция, которую кто-то сегодня проведёт»: обе метки закрыты
 * сверху (`version` из package.json, `status` — литералы `ActionStatus`).
 * Проверяется здесь другое — что инвариант формата принадлежит рендеру, а не
 * держится на дисциплине вызывающих: рендер не должен уметь выдать строку,
 * которую Prometheus прочтёт как ДВА ряда, каким бы ни было значение.
 */
import { describe, test, expect } from "bun:test";
import { _escapeLabelValue } from "../lib/miniapp-metrics.ts";

describe("значение метки не может разорвать строку экспозиции", () => {
  test("перевод строки уезжает escape-последовательностью, а не переносом", () => {
    // До правки здесь возвращалось значение с настоящим \n внутри.
    expect(_escapeLabelValue("ok\nagent_fake_total 99")).toBe(
      "ok\\nagent_fake_total 99",
    );
    expect(_escapeLabelValue("ok\nx")).not.toContain("\n");
  });

  test("кавычка и слэш по-прежнему экранируются", () => {
    expect(_escapeLabelValue('a"b')).toBe('a\\"b');
    expect(_escapeLabelValue("a\\b")).toBe("a\\\\b");
  });

  test("порядок замен: слэш не экранируется дважды", () => {
    // Если бы `\` шёл не первым, результат \n превратился бы в \\n, то есть
    // в литеральные «слэш + n» — не тот символ, что был во входе.
    expect(_escapeLabelValue("\\n")).toBe("\\\\n");
    expect(_escapeLabelValue("\\")).toBe("\\\\");
  });

  test("обычное значение не трогается", () => {
    expect(_escapeLabelValue("pending_approval")).toBe("pending_approval");
    expect(_escapeLabelValue("")).toBe("");
  });

  test("готовая строка ряда остаётся одной строкой", () => {
    // Сборка ровно как в renderMetricLine — это и есть то свойство, ради
    // которого экранирование существует.
    const line = `agent_actions_recent{status="${_escapeLabelValue("ok\nagent_bogus 1")}"} 5`;
    expect(line.split("\n")).toHaveLength(1);
  });
});
