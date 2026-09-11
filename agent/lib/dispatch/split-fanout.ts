/**
 * Как фан-аут SPLIT_TASK сводит исходы делегирований к «дети» и «ошибки».
 *
 * Аудит 2026-09-11, круг 30. Цикл фан-аута считал так:
 *
 *     if (r.kind === "ok") { if (r.taskId) childIds.push(r.taskId); }
 *     else { errors.push(`${role}: ${gateRefusalText(r)}`); }
 *
 * Исход «ok, но `taskId` нет» не попадал НИ В ОДИН из двух счётчиков. А он
 * возможен и означает не отказ: `DELEGATE_TO_ROLE` ловит исключение
 * `createTask` («parent depth cap», занятая база на фоне VACUUM), пишет
 * `[delegate] failed to create task row` и продолжает — ход уже сделан,
 * объявление ушло в чат, ответ модели оплачен, нет только строки на доске.
 *
 * Цена молчания: `childIds` короче `roles`, `errors` пуст, и вызывающий брал
 * текст-заглушку «all delegations failed». `reconcileExpectedChildren` при
 * `actual > 0` кладёт его в `input.delegationError`, а `rollupParent` по этому
 * маркеру форсит родителю `failed`. Сплит на две роли, где обе отработали и
 * лишь у одной не записалась строка, закрывался как «все делегирования
 * провалились» — и ложь каскадилась вверх по предкам.
 *
 * Заодно про саму заглушку: в эту ветку заходят при ЛЮБОМ расхождении, в том
 * числе частичном, а при полном провале `errors` непуст и до заглушки дело не
 * доходит. Утверждать «все провалились» она права не имеет.
 *
 * Решения вынесены сюда, потому что проверять их в диспетчере нечем: чтобы
 * `createTask` упал ровно у одной роли, нужен мок модуля, а мок модуля в общем
 * процессе `bun test` протекает в соседние файлы (тот же довод записан в
 * tests/handoff-budget-per-turn.test.ts). Здесь же обе функции чистые.
 */

/** Исход одного делегирования в терминах, которые важны фан-ауту. */
export type FanoutOutcome = {
  role: string;
  /** id строки задачи, если она создалась. */
  taskId?: string;
  /** Текст отказа гейта/воронки. Есть только у неуспешных исходов. */
  refusal?: string;
};

/**
 * Сегмент для исхода «делегирование прошло, строки задачи нет».
 *
 * Намеренно без фраз из `DELEGATION_REFUSALS` (lib/diagnostic.ts): это
 * поломка, а не отказ по правилам, и `isByDesignRefusal` обязан вернуть по
 * нему false — иначе диагностика на потерянную строку не заведётся.
 */
export const MISSING_ROW_SEGMENT = "delegated but task row missing";

export function foldFanoutOutcomes(outcomes: readonly FanoutOutcome[]): {
  childIds: string[];
  errors: string[];
} {
  const childIds: string[] = [];
  const errors: string[] = [];
  for (const o of outcomes) {
    if (o.refusal !== undefined) {
      errors.push(`${o.role}: ${o.refusal}`);
    } else if (o.taskId) {
      childIds.push(o.taskId);
    } else {
      errors.push(`${o.role}: ${MISSING_ROW_SEGMENT}`);
    }
  }
  return { childIds, errors };
}

/**
 * Текст на случай, когда расхождение есть, а объяснить его нечем.
 *
 * Истинен и при частичном расхождении, и при полном: он не утверждает про
 * исход делегирований ничего, кроме того, что известно — сколько ролей дало
 * строку задачи из скольких.
 */
export function delegationShortfallText(childCount: number, roleCount: number): string {
  return `delegation outcome unaccounted for: ${childCount}/${roleCount} ролей дали строку задачи`;
}
