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
 * Читать только отсюда. Сервер этим валидирует запись, Mini App — этим же
 * решает, какие кнопки показать; расходиться им больше нечем.
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
