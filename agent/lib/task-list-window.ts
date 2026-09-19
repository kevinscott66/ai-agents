/**
 * Окно списка задач для `GET /api/tasks` (AUD-030).
 *
 * Раньше выборка жила прямо в ручке miniapp-server.ts, между разбором
 * query-строки и redaction: три ветки SQL, флаг `truncated` и `nextOffset`.
 * Контракт окна (страницы через `nextOffset` покрывают выборку без дыр и
 * повторов, `truncated` честен на ровно полной странице) проверялся только
 * через HTTP или по тексту ручки. Здесь он отдельно от транспорта: ручка
 * валидирует запрос и прячет контент, модуль отвечает за окно, контракт
 * закреплён в tests/aud-030-task-list-window-contract.test.ts.
 */
import { db } from "./db.ts";
import { getTask, listTasksByAssignee, listTasksByChat, type Task, type TaskStatus } from "./tasks.ts";

export const TASK_LIST_DEFAULT_LIMIT = 50;
/** Потолок окна: `?limit=` больше этого до СУБД не доезжает. */
export const TASK_LIST_MAX_LIMIT = 200;

export interface TaskListQuery {
  /** Канонический ключ исполнителя (canonicalAssignee) или null — без фильтра. */
  assignee: string | null;
  chatId?: number;
  statuses?: TaskStatus[];
  limit: number;
  offset: number;
}

export interface TaskListWindow {
  tasks: Task[];
  truncated: boolean;
  /** Готовый `offset` следующей страницы; null — страниц больше нет. */
  nextOffset: number | null;
}

export function listTaskWindow(q: TaskListQuery): TaskListWindow {
  const { limit, offset, chatId, statuses } = q;
  // Аудит 2026-08-28: выдача резалась молча. Ответ на сто задач из ста и
  // ответ на сто задач из трёхсот выглядели одинаково — код 200, массив
  // ровно по лимиту, ни поля, ни «показать ещё». Соседняя ручка
  // `/api/wiki/list` эту же ситуацию давно подписывает флагом `truncated` —
  // делаем так же: спрашиваем на строку больше лимита и по ней узнаём, есть
  // ли что-то за краем окна.
  const probe = limit + 1;
  let tasks: Task[];
  let truncated = false;
  if (q.assignee) {
    // Аудит 2026-08-28: `chat_id` сюда не доезжал вовсе — ветка assignee
    // выигрывала и молча теряла сужение области, отвечая 200 с задачами
    // роли из всех чатов сразу.
    const rows = listTasksByAssignee(q.assignee, statuses, probe, chatId, offset);
    truncated = rows.length > limit;
    // Очередь роли отсортирована `priority DESC`: лишняя строка последняя.
    tasks = truncated ? rows.slice(0, limit) : rows;
  } else if (chatId !== undefined) {
    const rows = listTasksByChat(chatId, statuses, probe, offset);
    truncated = rows.length > limit;
    // А здесь порядок ВОЗРАСТАЮЩИЙ, хотя `limit` берёт N свежайших (F1
    // того же аудита). Лишняя строка в такой выборке — самая старая, то
    // есть первая: `slice(0, limit)` выбросил бы самую свежую задачу,
    // ровно ту, ради которой доску и открывают.
    tasks = truncated ? rows.slice(rows.length - limit) : rows;
  } else {
    // Без chat_id и assignee — прямой скан. Аудит 2026-08-20: статус здесь
    // не применялся вовсе. Две других ветки принимают `statuses`, а эта
    // молча возвращала всю доску — то есть ?status=pending без chat_id
    // работал как запрос вообще без фильтра, отвечая 200.
    //
    // Это не гипотетика: `load()` в miniapp/src/pages/Dashboard.tsx зовёт
    // ровно `api.tasks({ status: "pending", limit: 200 })` — без chat_id. Список
    // «в очереди» на главной показывал задачи в любом статусе, включая
    // done и cancelled.
    const where = statuses?.length
      ? ` WHERE status IN (${statuses.map(() => "?").join(",")})`
      : "";
    const rows = db
      .prepare(
        // Без тай-брейка произвольной становится не только выдача, но и
        // флаг truncated: лишняя строка probe берётся с плавающей границы.
        `SELECT id FROM tasks${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...(statuses ?? []), probe, offset) as { id: string }[];
    truncated = rows.length > limit;
    // Режем по id, а не после getTask: лишняя строка тут самая старая по
    // `created_at DESC`, то есть последняя, и тянуть её целиком незачем.
    tasks = rows.slice(0, limit).map((r) => getTask(r.id)).filter((t): t is Task => Boolean(t));
  }
  // AUD-012: `offset` сдвигает окно во всех трёх ветках; `nextOffset` —
  // готовое значение для следующей страницы.
  return { tasks, truncated, nextOffset: truncated ? offset + limit : null };
}
