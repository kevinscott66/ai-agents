/**
 * Единственная таблица переходов статусов задачи — и словарь самих статусов.
 *
 * Аудит 2026-08-14: таблица жила в двух местах. Сервер (`lib/tasks.ts`)
 * валидировал переходы по своему `FSM`, Mini App рисовал кнопки по своему
 * `NEXT_STATUS` (`miniapp/src/pages/Tasks.tsx`), и копии УЖЕ разошлись:
 *
 *   сервер: pending → running | cancelled | awaiting_approval
 *   Mini App: pending → running | cancelled
 *   сервер: running → done | failed | awaiting_review | awaiting_approval
 *   Mini App: running → done | failed | awaiting_review
 *
 * То есть перевод задачи в «ждёт аппрува» разрешён на сервере, но кнопки для
 * него в интерфейсе не существует ни в списке, ни в карточке. Расхождение
 * молчаливое в обе стороны: лишний переход в копии Mini App дал бы кнопку,
 * которую сервер отвергает — пользователь жмёт и получает ошибку.
 *
 * Файл намеренно без зависимостей: его импортирует и серверный код (bun), и
 * бандл Mini App (vite). Ничего кроме типа и таблицы сюда класть нельзя —
 * иначе в браузерный бандл поедет SQLite.
 */

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "awaiting_review"
  | "done"
  | "failed"
  | "cancelled";

/**
 * Из какого статуса куда можно. Пустой массив = терминальный статус.
 *
 * Не читать напрямую — читать через `nextStatuses` ниже. Аудит 2026-09-11:
 * таблица перестала быть полным ответом на вопрос «куда можно». Сервер завёл
 * второй запрет — прогон временной роли статуса не меняет вовсе, — и он снова
 * оказался известен только серверу. Mini App строил кнопки по таблице, то есть
 * рисовал переходы, которые `updateTaskStatus` отклоняет: та же болезнь, от
 * которой этот файл и заведён, просто на этаж выше.
 */
export const TASK_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  pending: ["running", "cancelled", "awaiting_approval"],
  running: ["done", "failed", "awaiting_review", "awaiting_approval"],
  awaiting_approval: ["running", "cancelled"],
  // Аудит 2026-08-20: `failed` добавлен — у ревью не было исхода
  // «посмотрели и не приняли». Оставались только «вернуть в работу» и
  // «принять», поэтому ревьюер в Mini App мог закрыть негодную работу
  // единственным способом — соврав `done`, а UPDATE_TASK_STATUS{failed}
  // по задаче на ревью отвечал `invalid status transition`. Отмены здесь
  // по-прежнему нет намеренно: `cancelled` — про работу, которая не
  // начиналась, а до ревью она уже сделана.
  awaiting_review: ["running", "done", "failed"],
  done: [],
  failed: [],
  cancelled: [],
};

/** Пустой список переходов: одна константа на все запреты. */
const NO_TRANSITIONS: readonly TaskStatus[] = Object.freeze([]);

/**
 * Задача-«роль» из очереди рантайма (`SPAWN_ROLE`): вторая половина строки
 * `role_runtime_queue`, id у них общий. Статусом её двигает только воркер,
 * каждым своим UPDATE'ом с `AND status='running'`; признак `_spawn_role` в
 * `input` ставит он же.
 *
 * Предикат живёт здесь, а не в lib/tasks.ts, по той же причине, по которой
 * здесь живёт таблица: его обязаны знать обе стороны, а lib/tasks.ts тянет
 * SQLite и в браузерный бандл не поедет. Он чистый — смотрит только на форму
 * `input`. lib/tasks.ts его реэкспортирует, чтобы не переписывать импорты.
 */
export function isSpawnRoleTaskInput(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { _spawn_role?: unknown })._spawn_role === true
  );
}

/**
 * Куда можно из ТЕКУЩЕГО СОСТОЯНИЯ ЗАДАЧИ — единственный ответ на этот вопрос.
 *
 * Отличие от `TASK_TRANSITIONS` в аргументе: таблица знает только про статус,
 * а запрет бывает и по самой задаче. Сервер валидирует запись этим, Mini App
 * этим же решает, какие кнопки показать — и вот теперь расходиться им нечем.
 *
 * Незнакомый статус (пришёл из БД старше миграции) — пустой список, а не
 * исключение: вызывающие здесь рисуют кнопки и валидируют, им нужен ответ.
 */
export function nextStatuses(task: {
  status: TaskStatus;
  input?: unknown;
}): readonly TaskStatus[] {
  if (isSpawnRoleTaskInput(task.input)) return NO_TRANSITIONS;
  return TASK_TRANSITIONS[task.status] ?? NO_TRANSITIONS;
}
