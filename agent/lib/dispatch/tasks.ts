/**
 * Task lifecycle handlers (create/assign/status/review/comment).
 * Extracted from action-dispatch.ts for T-112 modularization.
 *
 * NOTE: DELEGATE_TO_ROLE and SPLIT_TASK intentionally remain in
 * action-dispatch.ts — they are coupled to the dispatch closure
 * (respondAs/handoffDeps/delegationChain + recursive dispatchAction),
 * which is outside the scope of this mechanical extraction.
 */
import {
  createTask,
  assignTask,
  updateTaskStatus,
  getTask,
  isDiagTaskInput,
  DIAG_ASSIGNEE,
  OPEN_TASK_STATUSES,
  type Task,
} from "../tasks.ts";
import type { PayloadByType } from "../action-payload.ts";
import { pinnedChatId } from "./helpers.ts";
import { log } from "../log.ts";
import { CHARACTERS } from "../../characters/index.ts";

export type TaskHandlerContext = {
  agentKey: string;
  chatId: number;
};

export type TaskHandlerResult =
  | { ok: true; result: any; taskId?: string }
  | { ok: false; error: string };

/**
 * Задача с доски чата-источника — или ничего.
 *
 * Аудит 2026-08-10: мутаторы адресуют задачу по id и шли в БД по нему одному.
 * Чат — граница арендатора (то же самое знают /tasks, SPLIT_TASK и
 * pinnedChatId), но ровно те действия, которые принимают taskId, её не
 * проверяли: агент из чата A переставлял статус и исполнителя на доске чата B.
 *
 * Чужая задача отдаётся как отсутствующая, и текст ошибки тот же: иначе
 * перебор id даёт оракул существования по чужим доскам. Разница видна только в
 * логе — на стороне, куда модель не дотягивается.
 */
function ownTask(
  taskId: string,
  ctx: TaskHandlerContext,
  action: string,
): Task | null {
  const t = getTask(taskId);
  if (!t) return null;
  if (t.chat_id !== ctx.chatId) {
    log.warn(`[security] ${action}: задача с доски другого чата — отказ`, {
      task_id: taskId,
      task_chat: t.chat_id,
      originating: ctx.chatId,
      agent: ctx.agentKey,
    });
    return null;
  }
  return t;
}


/**
 * Канонический ключ роли — или null, если такой роли нет.
 *
 * Аудит 2026-08-12: `assigned_to` — это адрес, а не подпись: очередь роли
 * выбирается точным равенством (`listTasksByAssignee`). Ключ никто не сверял, а
 * enum в tools-schema — подсказка модели, не проверка. «Backend», «бэкенд»,
 * «devops» ложились в БД как есть, задача не совпадала ни с одной очередью и не
 * была видна НИКОМУ, при этом действие возвращало ok:true. Задача не падала —
 * она исчезала.
 *
 * Регистр и пробелы правим молча: намерение однозначно, а отказ там только
 * ломает делегирование. Всё остальное — отказ со списком (см. assigneeError).
 */
const ROLE_BY_NORM = new Map<string, string>(
  CHARACTERS.map((c) => [c.key.toLowerCase(), c.key]),
);

export function canonicalAssignee(raw: string): string | null {
  return ROLE_BY_NORM.get(raw.trim().toLowerCase()) ?? null;
}

function assigneeError(raw: string): string {
  return `unknown assignee: ${raw}. Допустимо: ${[...ROLE_BY_NORM.values()].join(", ")}`;
}

export function handleCreateTask(
  payload: PayloadByType["CREATE_TASK"],
  ctx: TaskHandlerContext,
): TaskHandlerResult {
  // Схема инструмента CREATE_TASK сегодня chatId не объявляет, и build-payload
  // подставляет ctx.chatId — но хендлер вызывается ещё и из аппрувов и Mini
  // App, а payload там приходит из БД. Пиннинг убирает вопрос «а этот путь
  // точно не даёт положить задачу на чужую доску» целиком.
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "CREATE_TASK");
  // Родитель обязан быть на той же доске. Иначе дерево разрывается между
  // чатами: ребёнок ложится в СВОЙ чат, а rollupParent потом пересчитывает по
  // нему статус задачи чужого — и, если та уже закрыта, ещё и переоткрывает её.
  if (payload.parentId) {
    const parent = ownTask(payload.parentId, ctx, "CREATE_TASK");
    if (!parent) {
      return { ok: false, error: `parent task not found: ${payload.parentId}` };
    }
    // Аудит 2026-08-20: createTask переоткрывает ЛЮБОГО терминального родителя
    // голым UPDATE'ом (`tasks.ts`, «Появление нового ребёнка — прямое
    // доказательство, что набор был неполон»). Для done/failed это осознанно:
    // план собирают по одной подзадаче, и первый закрывшийся ребёнок штампует
    // родителя раньше времени. Но `cancelled` ставит человек — это решение
    // «не делаем», а не промежуточный итог rollup'а. Отменённый родитель
    // уезжал в running, следующий rollup закрывал его как done, и отмена
    // владельца отменялась входом модели, без единого аппрува.
    //
    // Режем на границе модели, а не в createTask: та же функция обслуживает
    // аппрувы и Mini App, где переоткрытие — законный ручной сценарий.
    if (parent.status === "cancelled") {
      log.warn("[security] CREATE_TASK: подзадача под отменённым родителем — отказ", {
        task_id: payload.parentId,
        agent: ctx.agentKey,
      });
      return {
        ok: false,
        error: `parent task is cancelled: ${payload.parentId}. Отменённую задачу не переоткрывают подзадачей — создай новую задачу или попроси владельца снять отмену.`,
      };
    }
  }
  let assignedTo: string | null = null;
  if (payload.assignedTo) {
    assignedTo = canonicalAssignee(payload.assignedTo);
    if (!assignedTo) return { ok: false, error: assigneeError(payload.assignedTo) };
  }
  const task = createTask({
    chatId,
    createdBy: payload.createdBy ?? ctx.agentKey,
    title: payload.title,
    description: payload.description ?? null,
    assignedTo,
    priority: payload.priority ?? 0,
    parentId: payload.parentId ?? null,
    inputPayload: payload.inputPayload,
  });
  return {
    ok: true,
    taskId: task.id,
    result: {
      taskId: task.id,
      status: task.status,
      title: task.title,
    },
  };
}

export function handleAssignTask(
  payload: PayloadByType["ASSIGN_TASK"],
  ctx: TaskHandlerContext,
): TaskHandlerResult {
  const current = ownTask(payload.taskId, ctx, "ASSIGN_TASK");
  if (!current) {
    return { ok: false, error: `task not found: ${payload.taskId}` };
  }
  // Худший исход здесь — «переназначили» и потеряли: прежний исполнитель уже
  // затёрт, а новый не существует. Проверяем ДО записи.
  const assignedTo = canonicalAssignee(payload.assignedTo ?? "");
  if (!assignedTo) {
    return { ok: false, error: assigneeError(String(payload.assignedTo ?? "")) };
  }
  // Аудит 2026-09-10: сами инварианты стоят в `assignTask` (докблок там же) —
  // это последний рубеж у самой записи. Здесь — тот же отказ на своём слое.
  //
  // Уточнение того же аудита, вечером: первая редакция этого комментария
  // обосновывала вынос тем, что исключение из `lib/tasks.ts` приходит к модели
  // как `dispatch/audit failed: …`. Это неверно. `dispatchAction` ловит всё
  // сам (action-dispatch.ts:1013) и возвращает обычный `{ok:false, error}`;
  // префикс `dispatch/audit failed:` ставится ровно в одном месте
  // (action-dispatch.ts:1877) и только когда бросает сам `dispatchAndAudit`,
  // то есть на записи строки аудита. По ФОРМЕ ответа отказ от броска не
  // отличить.
  //
  // Вынос от этого не перестаёт быть правильным, но причины у него другие, и
  // их стоит назвать честно: (1) текст. Инвариант у записи написан для того,
  // кто читает код, а сюда нужен ответ модели — с именем роли и указанием,
  // что делать. (2) Лог. Отказ по правилу оставляет `[security]`-строку с
  // ролью, задачей и запрошенным исполнителем; исключение из библиотеки —
  // только стек. (3) Слой. Правило — работа диспетчера, ровно как проверка
  // авторства у отмены ниже; инварианту у записи остаётся роль последнего
  // рубежа, до которого в норме не доходит.
  if (isDiagTaskInput(current.input) && assignedTo !== DIAG_ASSIGNEE) {
    log.warn("[security] ASSIGN_TASK: увод задачи самопочинки — отказ", {
      task_id: current.id,
      agent: ctx.agentKey,
      requested: assignedTo,
    });
    return {
      ok: false,
      error:
        `cannot reassign task ${current.id}: это задача самодиагностики, ` +
        `её забирает по адресу ${DIAG_ASSIGNEE} (иначе ретрая упавшего действия ` +
        `не будет). Нужна своя работа — заведи задачу через CREATE_TASK.`,
    };
  }
  if (!OPEN_TASK_STATUSES.includes(current.status)) {
    return {
      ok: false,
      error:
        `cannot reassign task ${current.id}: статус ${current.status} терминальный, ` +
        `работа закончена. Нужна новая работа по тому же поводу — CREATE_TASK.`,
    };
  }
  const task = assignTask(payload.taskId, assignedTo);
  return {
    ok: true,
    taskId: task.id,
    result: { taskId: task.id, status: task.status },
  };
}

/**
 * Статус diag-задачи двигает поллер самопочинки, а не роли с доски.
 *
 * Аудит 2026-09-10. Соседний запрет в ASSIGN_TASK держит задачу самопочинки
 * У aieng; эта проверка держит её В ТОМ СТАТУСЕ, в котором её ищут. Обе
 * половины нужны вместе, потому что оба поставщика работы смотрят на статус
 * в упор: `listPendingDiagTasks` берёт строго `status='pending'`
 * (self-diag.ts:492), подборщик осиротевших — строго `status='running'`
 * (self-diag.ts:397), а `processDiagTask` пишет терминал сам, каждым UPDATE'ом
 * с `AND status='running'` (:430, :442, :461, :476).
 *
 * Что ломалось. Пока задача в `running` (поллер поставил его ДО вызова
 * модели), любая роль с той же доски могла увести её в сторону: REQUEST_REVIEW
 * → `awaiting_review`, UPDATE_TASK_STATUS → `done`. После этого её не видит
 * никто: поллер ждёт `pending`, подборщик — `running`, а `gcStaleTasks`
 * `awaiting_review` не трогает НАМЕРЕННО (это ожидание человека, tasks.ts:70).
 * Единственный разрешённый ретрай упавшего действия сгорал, не состоявшись,
 * и следа об этом не оставалось нигде — ровно тот исход, который аудит
 * 2026-08-21 закрыл для убитого процесса, только дверь другая и открыть её
 * может любая роль в чате.
 *
 * Границу проводим по действующему, а не по статусу: aieng — единственный, у
 * кого своя работа с этой задачей есть. Остаток размена назван честно: aieng
 * своей же ранней записью статуса может обесценить текст, который поллер
 * собирался положить в `error`; задачу это не роняет (терминал остаётся
 * терминалом), а закрывать роли доступ к собственной задаче ради этого
 * дороже, чем оставить.
 */
function diagStatusGuard(
  current: { id: string; input: unknown },
  ctx: TaskHandlerContext,
  action: string,
): TaskHandlerResult | null {
  if (!isDiagTaskInput(current.input)) return null;
  if (ctx.agentKey === DIAG_ASSIGNEE) return null;
  log.warn(`[security] ${action}: смена статуса задачи самопочинки — отказ`, {
    task_id: current.id,
    agent: ctx.agentKey,
  });
  return {
    ok: false,
    error:
      `cannot change status of task ${current.id}: это задача самодиагностики, ` +
      `её статусом управляет поллер самопочинки (иначе ретрая упавшего действия ` +
      `не будет). Своя работа — заведи задачу через CREATE_TASK.`,
  };
}

export function handleUpdateTaskStatus(
  payload: PayloadByType["UPDATE_TASK_STATUS"],
  ctx: TaskHandlerContext,
): TaskHandlerResult {
  const current = ownTask(payload.taskId, ctx, "UPDATE_TASK_STATUS");
  if (!current) {
    return { ok: false, error: `task not found: ${payload.taskId}` };
  }
  // Аудит 2026-08-28: отмена необратима, и до сих пор её мог поставить кто
  // угодно с доски чата. `cancelled` терминален (TASK_TRANSITIONS.cancelled
  // пуст), а единственный путь наружу — CREATE_TASK{parentId} — моделям
  // закрыт с 2026-08-20. То есть одна роль стирала работу другой без возврата,
  // и это ровно та доктрина, которую тот аудит уже записал рядом: «cancelled
  // ставит человек — это решение „не делаем“». Охранялся вход обратно, вход
  // внутрь оставался открытым.
  //
  // Совсем запрещать нельзя: из `pending` отмена — единственный способ
  // закрыть задачу, и создателю нужно убирать собственные лишние. Поэтому
  // граница — авторство, а не назначение: `created_by` пишет диспетчер
  // (`build-payload.ts`, `createdBy: ctx.agentKey`), модель это поле не
  // трогает, значит на него можно опираться.
  if (payload.status === "cancelled" && current.created_by !== ctx.agentKey) {
    log.warn("[security] UPDATE_TASK_STATUS: отмена чужой задачи — отказ", {
      task_id: current.id,
      created_by: current.created_by,
      agent: ctx.agentKey,
    });
    return {
      ok: false,
      error:
        `cannot cancel task ${current.id}: заведена не тобой (${current.created_by}), ` +
        `а отмена необратима. Если работа не выходит — переведи в running и затем в ` +
        `failed с причиной в error; если задача лишняя — скажи об этом её автору.`,
    };
  }
  const diagErr = diagStatusGuard(current, ctx, "UPDATE_TASK_STATUS");
  if (diagErr) return diagErr;
  const patch: { output?: unknown; error?: string | null } = {};
  if (payload.output !== undefined) patch.output = payload.output;
  if (payload.error !== undefined) patch.error = payload.error;
  const task = updateTaskStatus(payload.taskId, payload.status, patch);
  return {
    ok: true,
    taskId: task.id,
    result: { taskId: task.id, status: task.status },
  };
}

export function handleRequestReview(
  payload: PayloadByType["REQUEST_REVIEW"],
  ctx: TaskHandlerContext,
): TaskHandlerResult {
  const current = ownTask(payload.taskId, ctx, "REQUEST_REVIEW");
  if (!current) {
    return { ok: false, error: `task not found: ${payload.taskId}` };
  }
  const diagErr = diagStatusGuard(current, ctx, "REQUEST_REVIEW");
  if (diagErr) return diagErr;
  const task = updateTaskStatus(payload.taskId, "awaiting_review");
  return {
    ok: true,
    taskId: task.id,
    result: { taskId: task.id, status: task.status },
  };
}

export function handleCommentTask(
  payload: PayloadByType["COMMENT_TASK"],
  ctx: TaskHandlerContext,
): TaskHandlerResult {
  // Только запись в audit; здесь убедимся, что задача существует, лежит на
  // нашей доске (иначе след уходит в историю чужой) и подтянем chat_id.
  const t = ownTask(payload.taskId, ctx, "COMMENT_TASK");
  if (!t) return { ok: false, error: `task not found: ${payload.taskId}` };
  return { ok: true, taskId: t.id, result: { taskId: t.id } };
}
