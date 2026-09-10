/**
 * Data-layer для tasks (этап 3, C2).
 *
 * Хранит задачи в SQLite, поддерживает иерархию parent/child (depth ≤ 5)
 * и FSM-переходы статусов. JSON-поля (input/output) сериализуются в TEXT.
 *
 * Здесь только чистый CRUD + валидация переходов. Аудит — lib/audit.ts, гейт
 * разрешений — lib/permissions.ts (зовётся из lib/action-dispatch.ts).
 *
 * Важное про границу чата: эти функции её НЕ проверяют — chatId и taskId
 * принимаются как есть. Пиннинг чата и проверка «задача моя» живут в
 * lib/dispatch/tasks.ts, и вызывать CRUD напрямую можно только там, где чат
 * уже проверен. Обёртка, которая делала это «удобнее» (lib/actions.ts),
 * удалена аудитом 2026-08-12 именно потому, что проверок не делала —
 * см. tests/no-dead-task-facade.test.ts.
 */
import { TASK_TRANSITIONS, type TaskStatus } from "./task-fsm.ts";
import { getErrorMessage } from "./errors.ts";
import { db } from "./db.ts";
import { log } from "./log.ts";

export type { TaskStatus };

export interface Task {
  id: string;
  parent_id: string | null;
  depth: number;
  chat_id: number;
  created_by: string;
  assigned_to: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  deadline: number | null;
  input: unknown | null;
  output: unknown | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface TaskRow {
  id: string;
  parent_id: string | null;
  depth: number;
  chat_id: number;
  created_by: string;
  assigned_to: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  deadline: number | null;
  input: string | null;
  output: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const MAX_DEPTH = 5;

// Таблица переходов переехала в lib/task-fsm.ts — её же читает Mini App,
// который до аудита 2026-08-14 держал собственную разошедшуюся копию.
const FSM = TASK_TRANSITIONS;

/** Тот же FSM, наружу только для чтения — чтобы «терминальность» не переписывали. */
export const TASK_FSM: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = FSM;

/**
 * Незакрытые статусы — те, из которых FSM ещё куда-то ведёт.
 *
 * Аудит 2026-08-12: «открытая задача» жила литеральным списком по месту
 * использования, и в `tasks_open` (miniapp-metrics.ts) список был неполный —
 * awaiting_review не считался. Задача, припаркованная на ревью, при этом
 * висит бессрочно: gcStaleTasks её намеренно не трогает (это ожидание
 * человека, а не зависшая работа), а второго механизма, который бы её закрыл,
 * нет. Счётчик — единственное, что о ней сообщает; он и обязан её видеть.
 * Выводим из FSM, чтобы новый статус нельзя было забыть добавить в счётчики.
 */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = (
  Object.keys(FSM) as TaskStatus[]
).filter((s) => FSM[s].length > 0);

function parseJSON(v: string | null): unknown | null {
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Задача-«роль» из очереди рантайма (`SPAWN_ROLE`).
 *
 * Аудит 2026-09-10. Такая задача — не узел плана, а вторая половина строки
 * `role_runtime_queue`: id у них общий (role-runtime.ts:230-285 вставляет обе
 * в одной транзакции), а статусом её двигает только воркер, и каждый его
 * UPDATE обусловлен `AND status='running'` / `AND state='running'`
 * (role-runtime.ts:343-395, :552, :578). Признак `_spawn_role` в `input`
 * ставит он же; по нему её нашла и миграция, заводившая очередь задним числом
 * (migrations.ts:999). Отличать её от обычной задачи нужно ровно затем, чтобы
 * логика набора детей не переписывала итог чужого прогона — см. `createTask`.
 */
export function isSpawnRoleTaskInput(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { _spawn_role?: unknown })._spawn_role === true
  );
}

function isSpawnRoleTask(task: Task): boolean {
  return isSpawnRoleTaskInput(task.input);
}

function rowToTask(row: TaskRow): Task {
  return {
    ...row,
    input: parseJSON(row.input),
    output: parseJSON(row.output),
  };
}

export interface CreateTaskInput {
  chatId: number | string;
  createdBy: string;
  assignedTo?: string | null;
  title: string;
  description?: string | null;
  parentId?: string | null;
  priority?: number;
  deadline?: number | null;
  inputPayload?: unknown;
}

export function createTask(input: CreateTaskInput): Task {
  let depth = 0;
  let reopenChain: Task[] = [];
  let directParent: Task | null = null;
  if (input.parentId) {
    const parent = getTask(input.parentId);
    if (!parent) throw new Error(`parent task not found: ${input.parentId}`);
    directParent = parent;
    depth = parent.depth + 1;
    // Аудит 2026-08-10: родитель без объявленного числа детей закрывается по
    // первому же завершившемуся ребёнку — rollupParent видит набор из одной
    // строки и считает его полным (expectedChildren ставит только SPLIT_TASK).
    // Само по себе это разумный дефолт и он покрыт тестами; ломается он на
    // плане, который собирают по одной подзадаче: CREATE_TASK("Релиз") →
    // CREATE_TASK("бэкенд", parent) → бэкенд done → «Релиз 2.0» done, а
    // фронтенд и qa ещё не созданы. Дальше они создаются под уже терминальным
    // родителем, и rollupParent для них выходит на первой строке навсегда —
    // то есть итоговый статус так и остаётся ложным.
    //
    // Появление нового ребёнка — прямое доказательство, что набор был неполон.
    // Переоткрываем родителя, чтобы следующий rollup пересчитал его по всему
    // набору. Промежуточный «done» между детьми остаётся, но конечный статус
    // становится честным, а возможность автозакрытия сохраняется.
    //
    // Аудит 2026-08-20: переоткрывался ТОЛЬКО прямой родитель, а rollupParent
    // на терминальном узле выходит первой строкой — то есть исправленный
    // статус родителя уже никогда не поднимался к деду. Путь штатный
    // (MAX_DEPTH = 5): «Релиз» → «Бэкенд» → «api»; api done ⇒ по неизвестному
    // набору закрывается «Бэкенд», каскадом — «Релиз». Поздние «миграции»
    // переоткрывали «Бэкенд», их провал доводил его до failed, а каскад к
    // «Релизу» упирался в ранний return: провалившийся релиз навсегда
    // числился done.
    //
    // Доказательство неполноты набора распространяется на всю цепочку: статус
    // деда выведен из статуса родителя, который мы только что признали
    // преждевременным. Переоткрываем всех терминальных предков подряд —
    // следующий rollup пересчитает каждого по его полному набору.
    //
    // Аудит 2026-09-10: `_spawn_role` не переоткрываем — ни прямого родителя,
    // ни предка. Обоснование переоткрытия — «новый ребёнок опровергает вывод
    // КОДА о полноте набора»; у задачи-роли статус выведен не из набора детей
    // вообще, а из прогона: его пишет воркер (role-runtime.ts:552, :578) и
    // пишет в паре со строкой `role_runtime_queue`. Дети у неё есть только
    // потому, что модель внутри роли имеет право на CREATE_TASK{parentId} —
    // это её работа, а не её план.
    //
    // Что ломалось. Роль отработала: `tasks.status='done'`,
    // `role_runtime_queue.state='done'`. Модель создаёт под ней ещё одну
    // подзадачу — и эта ветка переводит задачу в `running`, гася `error`.
    // Очередь остаётся `done`: `claimNextRoleTask` берёт только `queued`, а
    // все UPDATE'ы воркера обусловлены `state='running'`, так что второго
    // прогона не будет никогда. Две таблицы про один прогон расходятся
    // навсегда. У провалившейся роли к этому добавляется потеря причины:
    // `error=NULL` затирает текст падения, который в очереди уже не лежит.
    // А дальше rollupParent досчитывает роль по её детям — то есть итог
    // прогона задним числом определяет посторонняя подзадача, и упавшая роль
    // выезжает `done`.
    //
    // Прямой родитель здесь, в отличие от `cancelled`, тоже под запретом:
    // снятие отмены человеком — законный сценарий, а «переоткрыть завершённый
    // прогон» смысла не имеет, повторный запуск роли — это новый SPAWN_ROLE.
    // Останавливаться на такой задаче безопасно по той же причине, что и на
    // отменённой: rollupParent на терминальном узле выходит первой строкой,
    // так что каскад вверх она и так глушит.
    if (FSM[parent.status].length === 0 && !isSpawnRoleTask(parent)) {
      reopenChain = [parent];
      let anc = parent.parent_id ? getTask(parent.parent_id) : null;
      // Ограничение на длину — против битой цепочки parent_id: depth в
      // таблице может врать, а бесконечный цикл здесь подвесил бы диспетчер.
      //
      // Аудит 2026-08-27: `cancelled` останавливает подъём. Обоснование
      // переоткрытия — «новый ребёнок опровергает вывод кода о полноте
      // набора»; `done`/`failed` предок и получил РОВНО таким выводом
      // (rollupParent). `cancelled` выводом не бывает: rollupParent его не
      // ставит, в него ведут только кнопки Mini App (task-fsm.ts:41,43) —
      // это решение человека, и появление внука его не опровергает.
      // Аудит 2026-08-21 закрыл ту же дыру на прямом родителе, но со стороны
      // входов модели; цепочку предков, добавленную днём раньше, это не
      // покрыло: замер показывал «дед cancelled → running (error=NULL) →
      // done» на штатном пути «Релиз → Бэкенд → api, потом миграции».
      // Отменённый человеком релиз выезжал на доску выполненным, следа
      // отмены не оставалось нигде.
      //
      // Прямой родитель сюда не попадает намеренно: снятие отмены человеком
      // через Mini App/аппрув законно и запинено отдельным тестом
      // (audit-2026-08-20-create-task-cancelled-parent.test.ts). Каскад вверх
      // отменённый предок и так глушит — rollupParent на терминале выходит
      // первой строкой, — так что останавливаться на нём безопасно.
      while (
        anc &&
        FSM[anc.status].length === 0 &&
        anc.status !== "cancelled" &&
        !isSpawnRoleTask(anc) &&
        reopenChain.length <= MAX_DEPTH
      ) {
        reopenChain.push(anc);
        anc = anc.parent_id ? getTask(anc.parent_id) : null;
      }
      if (anc?.status === "cancelled") {
        log.warn("[tasks] предок отменён человеком — подъём остановлен", {
          cancelled_ancestor: anc.id,
          reopened: reopenChain.map((t) => t.id),
        });
      } else if (anc && isSpawnRoleTask(anc)) {
        log.warn("[tasks] предок — завершённый прогон роли, подъём остановлен", {
          spawn_role_ancestor: anc.id,
          reopened: reopenChain.map((t) => t.id),
        });
      }
    } else if (FSM[parent.status].length === 0) {
      log.warn("[tasks] родитель — завершённый прогон роли, переоткрытия нет", {
        spawn_role_parent: parent.id,
        parent_status: parent.status,
      });
    }
  }
  if (depth > MAX_DEPTH) {
    throw new Error(`task depth ${depth} exceeds max ${MAX_DEPTH}`);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const chatId =
    typeof input.chatId === "string" ? Number(input.chatId) : input.chatId;

  // Аудит 2026-08-20: INSERT ребёнка и переоткрытие предков шли ТРЕМЯ разными
  // автокоммитами. Обрыв между ними (рестарт agent-team при деплое, kill)
  // оставлял ребёнка под уже терминальным родителем — а триггер переоткрытия
  // живёт только внутри createTask, то есть больше не сработает никогда: ветка
  // тихо выпадает из подсчёта rollup'а. Обрыв на последнем шаге давал второй
  // исход: родитель running, но `delegationError` в input остался, и на финише
  // детей rollupParent форсит failed при всех детях done — дословно тот случай,
  // который комментарий ниже объявляет починенным.
  //
  // Соседняя forceTerminalStatus обернула свою многошаговую запись по этой же
  // причине (аудит 2026-08-14); bun:sqlite вкладывает транзакции через
  // SAVEPOINT, так что вызов изнутри чужой транзакции безопасен.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks(
        id, parent_id, depth, chat_id, created_by, assigned_to,
        title, description, status, priority, deadline,
        input, output, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      id,
      input.parentId ?? null,
      depth,
      chatId,
      input.createdBy,
      input.assignedTo ?? null,
      input.title,
      input.description ?? null,
      input.priority ?? 0,
      input.deadline ?? null,
      input.inputPayload === undefined ? null : JSON.stringify(input.inputPayload),
      now,
      now,
    );

    // Терминал → running пишется голым UPDATE'ом: из терминального статуса FSM
    // не выпускает никого, а running — тот самый хаб, из которого достижим
    // любой исход последующего rollup. error гасим: он описывал прошлый,
    // преждевременный вывод о наборе.
    for (const anc of reopenChain) {
      db.prepare(
        `UPDATE tasks SET status='running', error=NULL, updated_at=? WHERE id=?`,
      ).run(now, anc.id);
    }
    if (directParent) {
      // Вместе с error снимаем и `delegationError` — иначе переоткрытие не
      // работает вовсе.
      //
      // Аудит 2026-08-13. При autonomy=manual каждое дочернее делегирование
      // внутри SPLIT_TASK уходит в апрув и строки таска не создаёт: детей ноль,
      // reconcileExpectedChildren пишет `delegationError` в input родителя и
      // закрывает его как failed. Владелец потом аппрувит все делегирования, они
      // отрабатывают, дети появляются — родитель переоткрывается этой самой
      // веткой, но маркер остаётся, потому что живёт он в `input`, а гасили тут
      // только колонку `error`. На финише детей rollupParent снова читает его
      // через undeliveredDelegation и форсит `failed` — при всех детях `done`.
      // Успешно выполненный сплит навсегда числился проваленным, и никакой
      // последующий успех этого уже не исправлял.
      //
      // Аудит 2026-08-29: снятие маркера стояло ВНУТРИ ветки переоткрытия, то
      // есть срабатывало только когда родитель уже терминален. А маркер пишется
      // и на живом родителе: `reconcileExpectedChildren` кладёт его в ветке
      // `actual > 0` (tasks.ts:577), где `rollupParent` выходит на
      // незавершённых детях и родитель остаётся `running`. Достаточно, чтобы
      // владелец успел аппрувить отставшую роль ДО того, как доработают
      // остальные: сплит backend+frontend+qa, из них manual только qa; qa
      // возвращает `pending_approval:<id>` и строки не создаёт; аппрув приходит
      // раньше финиша двух других — `createTask` видит нетерминального
      // родителя, `reopenChain` пуст, маркер остаётся. Дальше все трое `done`,
      // а rollupParent форсит `failed` (tasks.ts:664) и каскадит эту ложь на
      // всех предков. Прежний регрессионный тест
      // (task-lifecycle-audit-2026-08-13.test.ts:139) покрывал только обратный
      // порядок — аппрув после финиша, — где родитель уже терминален.
      //
      // Появление ребёнка — то же доказательство, что и для самого reopen:
      // делегирование всё-таки доставлено, прошлый вывод о наборе был
      // преждевременным. Что при частичном апруве (одобрили одно из трёх)
      // родитель теперь может выйти `done` — это документированное поведение
      // «неизвестного набора» из rollupParent, а не регресс: `expectedChildren`
      // к этому моменту уже переписан и счётчик всё равно молчит.
      //
      // Сверять роль нового ребёнка с ролями, названными в маркере, заманчиво,
      // но нельзя: `joinDelegationErrors` при обрезке выбрасывает сегменты
      // целиком, заменяя их счётчиком (diagnostic.ts:165), — на сплите от шести
      // ролей роль отставшего в тексте может отсутствовать. Промах такой сверки
      // возвращал бы ровно исходную ошибку: вечный ложный `failed` с каскадом.
      // Из двух неточностей выбираем ту, что теряет сигнал, а не ту, что
      // выдумывает провал.
      //
      // Снимаем только у ПРЯМОГО родителя: у предков выше `delegationError`
      // описывает их собственные невыданные делегирования, к появлению этого
      // ребёнка отношения не имеющие, — гасить его тут было бы подлогом.
      const inp = directParent.input;
      if (inp && typeof inp === "object" && "delegationError" in inp) {
        const next = { ...(inp as Record<string, unknown>) };
        delete next.delegationError;
        db.prepare(`UPDATE tasks SET input=?, updated_at=? WHERE id=?`).run(
          JSON.stringify(next),
          now,
          directParent.id,
        );
      }
    }
  })();

  for (const anc of reopenChain) {
    log.info("tasks: предок переоткрыт — набор детей оказался неполным", {
      parent_id: anc.id,
      was: anc.status,
      new_child: id,
      // Прямой родитель или предок выше: в цепочке ниже первого элемента
      // статус был выведен из чужого преждевременного вывода, а не из
      // собственного набора.
      direct: anc.id === reopenChain[0]!.id,
    });
  }

  const task = getTask(id);
  if (!task) throw new Error("failed to create task");
  return task;
}

export function getTask(id: string): Task | null {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined;
  return row ? rowToTask(row) : null;
}

/**
 * Сменить исполнителя задачи.
 *
 * Аудит 2026-09-10: единственная пишущая функция этого файла без единой
 * проверки — голый UPDATE по id, без FSM, без CAS и без докблока, тогда как у
 * соседнего `updateTaskStatus` есть и таблица переходов, и CAS по статусу
 * (аудит 2026-08-29), а у отмены — ещё и проверка авторства (аудит
 * 2026-08-28). Действие при этом засеяно ВСЕМ 12 ролям как `allowed=1,
 * requires_approval=0` (migrations.ts), в `CALLER_RESTRICTED` его нет, и
 * единственный барьер в хендлере — граница чата и каноничность ключа роли.
 *
 * Закрываются две дыры, обе — «переназначили, и работа исчезла молча»:
 *
 * 1. `assigned_to` у диагностической задачи — это не подпись, а АДРЕС
 *    ИСПОЛНЕНИЯ. Петля самопочинки C15 (action-dispatch.ts) создаёт задачу
 *    строго с `assignedTo: "aieng"` и `_diag: true`, а поллер выбирает работу
 *    запросом `WHERE assigned_to = 'aieng' AND status = 'pending' AND input
 *    LIKE '%"_diag":true%'` (self-diag.ts). Любая роль, дёрнув `ASSIGN_TASK
 *    {taskId, assignedTo: "smm"}`, получала `ok: true` — и задача навсегда
 *    выпадала из выборки поллера: ретрая упавшего действия не будет никогда, а
 *    в очереди smm окажется задача, чей `input` — машинный payload чужого
 *    вызова. Ошибку не увидит никто: наверху ok, в логах ничего.
 * 2. Терминальные статусы. `done`/`failed`/`cancelled` переписывались на
 *    другого исполнителя задним числом — история задачи становилась чужой.
 *    В очередь такая задача не вернётся (`listTasksByAssignee` зовут с
 *    открытыми статусами), то есть это порча атрибуции, а не воскрешение
 *    работы, — но именно её и читают в разборе «кто это сделал».
 *
 * CAS по статусу — из тех же соображений, что и в `updateTaskStatus`: между
 * чтением и записью статус успевает сменить кто угодно из пишущих в ту же БД,
 * и проигравший обязан узнать об этом, а не записать поверх.
 */
export function assignTask(id: string, assignedTo: string): Task {
  const t = getTask(id);
  if (!t) throw new Error(`task not found: ${id}`);
  if (!OPEN_TASK_STATUSES.includes(t.status)) {
    throw new Error(
      `cannot reassign task in terminal status: ${t.status} (task ${id})`,
    );
  }
  if (isDiagTaskInput(t.input) && assignedTo !== DIAG_ASSIGNEE) {
    throw new Error(
      `diagnostic task is addressed to ${DIAG_ASSIGNEE} and cannot be reassigned (task ${id})`,
    );
  }
  const now = Date.now();
  const res = db
    .prepare(
      `UPDATE tasks SET assigned_to = ?, updated_at = ? WHERE id = ? AND status = ?`,
    )
    .run(assignedTo, now, id, t.status);
  if (res.changes !== 1) {
    const actual = getTask(id);
    throw new Error(
      `task status changed under assignment: ${actual?.status ?? "<задача исчезла>"} (task ${id})`,
    );
  }
  const updated = getTask(id);
  if (!updated) throw new Error("failed to assign task");
  return updated;
}

/**
 * Кому адресована задача самопочинки. Строка одна и та же в трёх местах —
 * здесь, в C15-петле (`action-dispatch.ts`) и в запросе поллера
 * (`self-diag.ts`); импортировать её оттуда нельзя, не заводя цикл, поэтому
 * связь держится этим комментарием и тестом
 * `tests/audit-2026-09-10-assign-task-guards.test.ts`.
 */
export const DIAG_ASSIGNEE = "aieng";

/** Тот же признак, по которому поллер самодиагностики выбирает работу. */
export function isDiagTaskInput(input: unknown): boolean {
  return (
    !!input &&
    typeof input === "object" &&
    (input as { _diag?: unknown })._diag === true
  );
}

export interface UpdateStatusPatch {
  output?: unknown;
  error?: string | null;
}

export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  patch?: UpdateStatusPatch,
): Task {
  const t = getTask(id);
  if (!t) throw new Error(`task not found: ${id}`);
  const allowed = FSM[t.status];
  if (!allowed || !allowed.includes(status)) {
    throw new Error(
      `invalid status transition: ${t.status} → ${status} (task ${id})`,
    );
  }
  const now = Date.now();
  // Если поле не передано — не затираем существующее.
  const sets: string[] = ["status = ?", "updated_at = ?"];
  const vals: unknown[] = [status, now];
  if (patch && patch.output !== undefined) {
    sets.push("output = ?");
    vals.push(JSON.stringify(patch.output));
  }
  if (patch && patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  vals.push(id);
  // Аудит 2026-08-29: FSM проверялся по статусу, прочитанному ОДНИМ оператором
  // раньше, а UPDATE искал строку только по id. Между чтением и записью статус
  // успевает сменить кто угодно из пишущих в ту же БД мимо этой функции —
  // подметание брошенных аренд в role-runtime, восстановление self-diag,
  // соседний диспетчер, — и запись накладывалась поверх, совершая переход,
  // который FSM бы не пропустил, да ещё и отвечая вызывающему успехом.
  //
  // Тот же приём, что в `approvals.ts` (`WHERE id = ? AND status = 'pending'`):
  // условие перехода живёт в самом UPDATE, и проигравший узнаёт об этом. Текст
  // ошибки — прежний, чтобы вызывающие, которые ловят `invalid status
  // transition`, продолжали ловить.
  vals.push(t.status);

  const res = db
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
    .run(...vals as never[]);
  if (res.changes !== 1) {
    const actual = getTask(id);
    throw new Error(
      `invalid status transition: ${actual?.status ?? "<задача исчезла>"} → ${status} (task ${id})`,
    );
  }
  const updated = getTask(id);
  if (!updated) throw new Error("failed to update task status");

  // C29: roll up parent status when a child reaches a terminal state.
  // `cancelled` is terminal too (rollupParent treats it as such): if the LAST
  // child to settle does so via cancellation, the parent must still
  // re-evaluate, otherwise it stays stuck in pending/running forever.
  if (
    updated.parent_id &&
    (status === "done" || status === "failed" || status === "cancelled")
  ) {
    try {
      rollupParent(updated.parent_id);
    } catch (e) {
      log.error("[tasks] rollupParent error", {
        error: getErrorMessage(e),
      });
    }
  }
  return updated;
}

/**
 * Сколько детей родитель обещал завести (`input.expectedChildren`), или null,
 * если он ничего не обещал — тогда полным считается любой непустой набор,
 * как было до T-730a.
 */
function expectedChildCount(parent: Task): number | null {
  const inp = parent.input;
  if (!inp || typeof inp !== "object") return null;
  const n = (inp as { expectedChildren?: unknown }).expectedChildren;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Текст о делегированиях, которые не создали строку в БД, — или null.
 *
 * Живёт в input родителя, а не в переменной: сверка происходит сразу после
 * сплита, когда дети ещё работают, а решение о статусе родителя принимается
 * много позже, при финише последнего ребёнка. К тому моменту от стека вызова
 * SPLIT_TASK не остаётся ничего.
 */
function undeliveredDelegation(parent: Task): string | null {
  const inp = parent.input;
  if (!inp || typeof inp !== "object") return null;
  const e = (inp as { delegationError?: unknown }).delegationError;
  return typeof e === "string" && e.trim() !== "" ? e : null;
}

/**
 * Кратчайший путь по таблице переходов FSM: список промежуточных статусов,
 * которыми `from` можно довести до `to`, или null, если пути нет. Пустой
 * массив — «уже там». Нужен `forceTerminalStatus` ниже: голый UPDATE обязан
 * оставить в истории задачи те же переходы, что оставил бы обычный путь.
 *
 * Аудит 2026-08-28: над этой функцией лежали ЧУЖИЕ докблоки — от
 * `reconcileExpectedChildren` и `forceTerminalStatus`, обе объявлены ниже.
 * Прочитанные как описание fsmPath, они врут полностью, а сама fsmPath
 * оставалась без единой строки объяснения.
 */
function fsmPath(from: TaskStatus, to: TaskStatus): TaskStatus[] | null {
  if (from === to) return [];
  const prev = new Map<TaskStatus, TaskStatus>();
  const seen = new Set<TaskStatus>([from]);
  const queue: TaskStatus[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of FSM[cur]) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === to) {
        const path: TaskStatus[] = [];
        for (let s: TaskStatus = to; s !== from; s = prev.get(s)!) path.unshift(s);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** Внутренний сигнал «CAS не сошёлся» — наружу из `forceTerminalStatus` не выходит. */
class StaleTaskStatus extends Error {
  constructor(readonly expected: TaskStatus) {
    super(`task status changed under reconciler (expected ${expected})`);
  }
}

/**
 * Проставить терминальный статус в обход FSM — но не в обход его смысла.
 *
 * Оба места, где статус пишется голым UPDATE'ом (rollupParent по набору детей
 * и нулевая ветка reconcileExpectedChildren), знают о задаче больше таблицы
 * переходов: согласованность детей там уже проверена. Но `pending → failed`
 * FSM запрещает не из педантизма — история задачи читается по этим переходам,
 * и запись, которой в FSM нет, ломает любого читателя. rollupParent мостил
 * pending → running → target, а ветка «ни одного ребёнка не создалось» — нет,
 * и родитель сплита, у которого провалились все делегирования, прыгал прямо
 * pending → failed. Мост теперь один на оба вызова.
 *
 * Аудит 2026-08-10: мост был зашит в `running` с обоснованием «running достижим
 * из каждого нетерминального статуса». Проверена не та половина: важно не то,
 * что в промежуточный статус можно войти, а то, что из него можно выйти в
 * target. FSM.running = [done, failed, awaiting_review, awaiting_approval] —
 * cancelled там нет, так что родитель, у которого все дети отменены, уходил из
 * running и awaiting_review ровно тем переходом, от которого мост защищает.
 * Для done/failed мост работал, поэтому дыра и не всплывала. Теперь путь
 * ищется по самой таблице, а не выбирается заранее.
 */
function forceTerminalStatus(
  task: Task,
  target: TaskStatus,
  error?: string | null,
): void {
  // Уже терминальный: перезаписать один терминал другим FSM не позволяет
  // никому, и «мы проверили детей» тут не аргумент. Оба вызывающих отсекают
  // такую задачу раньше — это страховка, а не рабочая ветка.
  if (FSM[task.status].length === 0) return;
  const now = Date.now();
  // Все шаги пути, кроме последнего: последний — сама запись терминала ниже,
  // вместе с error. Пути нет только если target недостижим из текущего статуса
  // вообще; тогда писать нечего, кроме самого target — как и раньше.
  const bridge = (fsmPath(task.status, target) ?? []).slice(0, -1);

  const vals: unknown[] = [target, now];
  let sql = `UPDATE tasks SET status=?, updated_at=?`;
  if (error != null) {
    sql += `, error=?`;
    vals.push(error);
  }
  // `AND status=?` — CAS, см. комментарий у транзакции ниже. Ожидаемое
  // значение подставляется на вызове: для первого шага это снимок вызывающего,
  // дальше — предыдущий шаг моста.
  sql += ` WHERE id=? AND status=?`;
  vals.push(task.id);

  // Аудит 2026-08-14: мост писался по одному UPDATE на шаг, каждый в своём
  // автокоммите. Промежуточный статус — не состояние задачи, а след того, как
  // мы к терминалу шли: любой сбой между шагами (исключение, kill процесса,
  // рестарт systemd) оставлял задачу ДОЛГОВЕЧНО в `running` — статусе, из
  // которого её уже никто не заберёт, потому что исполнителя нет. Через сутки
  // такую задачу подбирал `gcStaleTasks` и переписывал в `failed` с
  // `error='gc_stale'`, а rollup поднимал провал к родителю. То есть отмена
  // сплита, у которого все дети отменены, задним числом превращалась в
  // «упало по таймауту» — с неверной причиной в истории и у родителя.
  // Замер: с подменённым db.prepare, бросающим на записи терминала, статус
  // после вызова — `running` (было) против исходного `awaiting_review` (стало).
  //
  // Мост и терминал — одна запись, а не последовательность: наружу видно либо
  // старый статус, либо конечный. bun:sqlite вкладывает транзакции через
  // SAVEPOINT, так что вызов изнутри чужой транзакции безопасен.
  //
  // Аудит 2026-09-10: шаги писались голым `WHERE id=?`, то есть каждый UPDATE
  // верил снимку `task`, прочитанному вызывающим ДО транзакции. Оба
  // вызывающих — реконсиляторы (rollupParent по финишу ребёнка и failTask),
  // они читают задачу, считают детей и только потом пишут; между чтением и
  // записью статус успевает измениться — параллельным финишем второго ребёнка,
  // отменой из Mini App, воркером. Мост при этом проходил ПО СТАРОМУ пути:
  // задачу, уже ушедшую в `cancelled` рукой человека, следующий вызов молча
  // проводил `cancelled → running → done`, потому что путь считался от
  // устаревшего `task.status`, а WHERE не спорил. Транзакция от аудита
  // 2026-08-14 защищает от обрыва между шагами, но не от гонки: она делает
  // запись атомарной, а не обусловленной.
  //
  // Теперь каждый шаг проверяет то значение, которое сам же и ожидает увидеть:
  // первый — снимок вызывающего, каждый следующий — результат предыдущего.
  // Не совпало — вся запись откатывается (мост и терминал по-прежнему одна
  // запись) и не повторяется: победил чужой переход, и наш вывод о детях
  // построен на устаревшем чтении. Обоим вызывающим это ровно то, что нужно —
  // они best-effort, бросать наверх нечего, поэтому наружу уходит WARN, а не
  // исключение.
  try {
    db.transaction(() => {
      let expected: TaskStatus = task.status;
      for (const step of bridge) {
        const res = db
          .prepare(
            `UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status=?`,
          )
          .run(step, now, task.id, expected);
        if (res.changes !== 1) throw new StaleTaskStatus(expected);
        expected = step;
      }
      const res = db.prepare(sql).run(...([...vals, expected] as never[]));
      if (res.changes !== 1) throw new StaleTaskStatus(expected);
    })();
  } catch (e) {
    if (!(e instanceof StaleTaskStatus)) throw e;
    log.warn("[tasks] статус изменился под реконсилятором — запись отменена", {
      task_id: task.id,
      expected: e.expected,
      actual: getTask(task.id)?.status ?? null,
      target,
    });
  }
}

/**
 * Пометить задачу проваленной из ЛЮБОГО статуса — не в обход FSM, а по нему.
 *
 * Аудит 2026-08-21: `updateTaskStatus(id, "failed")` работает только из
 * `running`. Из `pending` он бросает — и правильно делает, история задачи
 * читается по переходам. Но у вызывающих есть законная нужда «что бы ни
 * случилось, задача не должна остаться висеть», и удовлетворяли её вручную:
 *
 *   try { updateTaskStatus(id, "running"); } catch (e) { log.debug(...); }
 *   updateTaskStatus(id, "failed", { error: ... });
 *
 * Такая страховка не может сработать ни разу: если в `running` не пустили, то
 * в `failed` тем более. Четыре копии этого в `lib/self-diag.ts` плюс пятое
 * место — обработчик падения поллера, — который звал `failed` прямо из
 * `pending`. Задача оставалась `pending`, а выборка поллера берёт именно
 * `pending`: она поднималась снова каждые 30 секунд, бесконечно.
 *
 * Мост здесь уже был — `forceTerminalStatus` ищет путь по самой таблице
 * переходов и пишет все шаги одной транзакцией. Не хватало публичного входа
 * и двух вещей вокруг него: терминальный статус — это no-op (перезаписать
 * отмену владельца словом «провалилась» было бы ложью), а у задачи с
 * родителем провал надо докатить наверх, как это делает `updateTaskStatus`.
 *
 * Возвращает статус, в котором задача осталась, — вызывающему это единственный
 * способ отличить «пометили» от «уже было решено без нас».
 */
export function failTask(id: string, error: string): TaskStatus {
  const t = getTask(id);
  if (!t) throw new Error(`task not found: ${id}`);
  if (FSM[t.status].length === 0) return t.status;
  forceTerminalStatus(t, "failed", error);
  if (t.parent_id) {
    try {
      rollupParent(t.parent_id);
    } catch (e) {
      log.error("[tasks] rollupParent error", { error: getErrorMessage(e) });
    }
  }
  return "failed";
}

/**
 * Зафиксировать фактическое число детей у родителя-сплита и пересчитать его
 * статус. Нужно, когда часть делегирований не создала строку (отказ по циклу,
 * упавший createTask): иначе счётчик `expectedChildren` никогда не сойдётся и
 * родитель провисит в pending до gc_stale — ровно тот мусор, от которого
 * уходили в T-730.
 *
 * `actual === 0` — отдельная ветка, и это не педантизм: сам по себе пересчёт
 * её не закрывает. `expectedChildCount` отдаёт null при n ≤ 0 (ноль означает
 * «родитель ничего не обещал»), а `rollupParent` выходит на пустом наборе
 * детей — так что при полном провале делегирования обе защиты промахиваются
 * мимо друг друга и родитель висит pending те же 24 часа до gc_stale. Раз
 * детей нет, катить наверх нечего: закрываем родителя напрямую.
 */
export function reconcileExpectedChildren(
  parentId: string,
  actual: number,
  opts?: { error?: string },
): void {
  const parent = getTask(parentId);
  if (!parent) return;
  // Аудит 2026-09-11: та же граница, что в `rollupParent` ниже. Нулевая ветка
  // здесь тоже штампует терминал (`forceTerminalStatus(parent, "failed")`), а
  // прогон роли статусом двигает только воркер — в паре со строкой очереди.
  if (isSpawnRoleTask(parent)) {
    log.warn("[tasks] reconcileExpectedChildren: родитель — прогон роли, пропуск", {
      task_id: parent.id,
      status: parent.status,
    });
    return;
  }
  const inp =
    parent.input && typeof parent.input === "object"
      ? { ...(parent.input as Record<string, unknown>) }
      : {};
  inp.expectedChildren = actual;
  // Аудит 2026-08-10: opts.error читался только в ветке actual === 0. При
  // частичном сплите (3 роли, 2 взялись) обещание молча переписывалось с 3 на
  // 2, и набор сходился — а несостоявшегося ребёнка нет в БД, значит и
  // «провалившегося ребёнка» rollup не видит. Родитель выходил done с
  // error = NULL: доска показывала сплит выполненным целиком.
  if (actual > 0 && opts?.error) {
    inp.delegationError = opts.error;
  }
  db.prepare(`UPDATE tasks SET input = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(inp),
    Date.now(),
    parentId,
  );
  if (actual > 0) {
    rollupParent(parentId);
    return;
  }
  // Ни одного ребёнка не создалось. Не трогаем уже терминального родителя.
  if (
    parent.status === "done" ||
    parent.status === "failed" ||
    parent.status === "cancelled"
  ) {
    return;
  }
  forceTerminalStatus(
    parent,
    "failed",
    opts?.error ?? "no child tasks were created",
  );
  if (parent.parent_id) {
    try {
      rollupParent(parent.parent_id);
    } catch (e) {
      // Аудит 2026-08-20: было `log.debug`, а в проде уровень — `info`
      // (log.ts:91), то есть сбой не печатался вовсе и функция возвращала
      // успех. Дед остаётся pending/running без единого признака, через сутки
      // его подбирает gcStaleTasks и переписывает в failed с `error=gc_stale`:
      // успешно завершённое дерево получает ложную причину провала. Соседний
      // catch на том же классе ошибки (updateTaskStatus) пишет error.
      log.error("tasks: reconcile cascade failed", {
        e: String(e),
        parent_id: parent.parent_id,
      });
    }
  }
}

/**
 * C29: if the parent task is still pending/running and all its children have
 * terminal status, transition it: done if all children done, failed if any
 * child failed (first child error wins).
 */
export function rollupParent(parentId: string): void {
  const parent = getTask(parentId);
  if (!parent) return;
  if (parent.status === "done" || parent.status === "failed" || parent.status === "cancelled") {
    return;
  }
  // Аудит 2026-09-11: вторая дверь к тому же расхождению, что закрыл круг
  // 2026-09-10 со стороны переоткрытия. Там запретили поднимать ЗАВЕРШЁННЫЙ
  // прогон роли обратно в running; здесь — закрывать ЖИВОЙ по чужим детям.
  //
  // Статус задачи-роли — не вывод из набора детей, а половина строки
  // `role_runtime_queue`: обе таблицы двигает воркер и двигает вместе. Дети у
  // неё появляются потому, что модель внутри роли вправе звать
  // CREATE_TASK{parentId} — это её работа, а не её план, и полнота такого
  // набора ничего про прогон не говорит.
  //
  // Что ломалось, без всякого злоумышленника: роль claim'нута (`tasks.status
  // = 'running'`, `queue.state = 'running'`), любая роль с доски заводит под
  // ней подзадачу и закрывает её. Набор «полон» (expectedChildren роль не
  // ставила), и `forceTerminalStatus` штампует прогон `done`. Очередь
  // остаётся `running`, а `heartbeatRoleTask` обусловлен `tasks.status =
  // 'running'` (role-runtime.ts) — он не находит строки, воркер получает
  // `leaseLost` и бросает «role task lease lost before completion», минуя
  // `failRoleTask`. Оплаченный прогон выброшен, доска показывает «done».
  if (isSpawnRoleTask(parent)) {
    log.warn("[tasks] rollupParent: родитель — прогон роли, статус не трогаем", {
      task_id: parent.id,
      status: parent.status,
    });
    return;
  }
  const children = db
    .prepare(`SELECT id, status, error FROM tasks WHERE parent_id = ?`)
    .all(parentId) as Array<{ id: string; status: TaskStatus; error: string | null }>;
  if (children.length === 0) return;
  // Родитель может быть ещё «в наборе»: SPLIT_TASK создаёт детей строго
  // последовательно (await на каждом делегировании), поэтому первый же
  // закрывшийся ребёнок видит набор из одной строки, считает его полным и
  // штампует родителя терминальным статусом — а остальные дети к тому моменту
  // не существуют. До T-730 делегированный ребёнок вообще не закрывался, и
  // этот путь был мёртв; после — родитель сплита получал статус первого
  // ребёнка (3 роли, 2 провалились → «done»). Отсюда явный счётчик.
  //
  // Аудит 2026-08-10: счётчик закрывает ровно одного производителя детей из
  // двух. Его ставит только SPLIT_TASK (action-dispatch.ts:870); CREATE_TASK
  // принимает parentTaskId и не обещает ничего, так что при «expected === null»
  // первый же закрывшийся ребёнок считает набор полным. Закрывать этот путь
  // здесь нельзя — по неизвестному набору автозакрытие как раз и является
  // документированным поведением (см. c29-redistribution, tasks-rollup-cancel),
  // и запрет на него отнял бы работающую возможность ради одного сценария.
  // Поэтому чинится вторая половина: поздний ребёнок переоткрывает уже
  // закрытого родителя — см. reopenParentForLateChild в createTask.
  const expected = expectedChildCount(parent);
  if (expected !== null && children.length < expected) return;
  const allTerminal = children.every(
    (c) => c.status === "done" || c.status === "failed" || c.status === "cancelled",
  );
  if (!allTerminal) return;
  const firstFailed = children.find((c) => c.status === "failed");
  const anyDone = children.some((c) => c.status === "done");
  // Часть делегирований могла не создать строку вовсе (роль на паузе, отказ по
  // циклу): такого ребёнка нет ни в наборе, ни среди провалившихся, и без
  // отметки на родителе сплит из трёх ролей, две из которых отработали,
  // выходил «done» — притом что треть работы не выдана никому и не будет.
  const undelivered = undeliveredDelegation(parent);
  const target: TaskStatus = firstFailed || undelivered
    ? "failed"
    : anyDone
      ? "done"
      : "cancelled";
  // Терминал ставится в обход FSM (согласованность детей уже проверена), но с
  // мостом через running, чтобы в истории не оставалось перехода, которого в
  // таблице нет. Мост и запись — в forceTerminalStatus, общем с нулевой веткой
  // reconcileExpectedChildren.
  forceTerminalStatus(
    parent,
    target,
    firstFailed
      ? (firstFailed.error ?? "child task failed")
      : (undelivered ?? null),
  );

  // Cascade upward if grandparent exists.
  if (parent.parent_id) {
    try {
      rollupParent(parent.parent_id);
    } catch (e) {
      // См. reconcileExpectedChildren выше: тот же сбой, тот же исход
      // (gc_stale задним числом), тот же уровень.
      log.error("tasks: rollupParent cascade failed", {
        e: String(e),
        parent_id: parent.parent_id,
      });
    }
  }
}

/**
 * `limit` не косметика. Таблица tasks не архивируется (db-maint трогает только
 * agent_actions/audit_logs/messages, DELETE FROM tasks нет нигде), то есть
 * растёт всю жизнь деплоя. HTTP-ручка GET /api/tasks?assignee=X отдаёт
 * не больше 200 строк, но раньше резала их в JS уже ПОСЛЕ того, как весь
 * результат оказывался в памяти и каждая строка проходила через JSON.parse
 * колонок input/output. Bun.serve однопоточный и делит поток с SQLite, так
 * что цикл таких запросов подвешивал весь процесс. Порядок строк не меняется:
 * LIMIT приписан после ORDER BY, то есть даёт ровно тот же top-N, что
 * прежний slice(0, limit).
 *
 * По умолчанию лимита нет — у commands.ts фильтрация идёт после выборки,
 * и обрезка там поменяла бы вывод команды /tasks.
 *
 * Порядок `priority DESC, created_at ASC` — это очередь работы, а не доска:
 * сверху то, что делать первым. Поэтому здесь top-N и есть правильный top-N,
 * и усечение НЕ трогается (в отличие от listTasksByChat ниже — там та же
 * запись означала прямо противоположное).
 *
 * `chatId` — аудит 2026-08-28. Ветка `assignee` в GET /api/tasks выигрывала
 * у `chat_id` и молча выбрасывала его: `?assignee=qa&chat_id=-100` отдавал
 * задачи роли из ВСЕХ чатов с кодом 200, то есть сужение области выглядело
 * применённым. commands.ts то же самое доделывал руками
 * (`.filter(t => t.chat_id === args.chatId)`) — фильтр переехал в SQL, чтобы
 * второй копии не было и чтобы `limit` считался уже после сужения, а не до.
 */
export function listTasksByAssignee(
  agentKey: string,
  statuses?: TaskStatus[],
  limit?: number,
  chatId?: number | string,
): Task[] {
  let sql = `SELECT * FROM tasks WHERE assigned_to = ?`;
  const args: unknown[] = [agentKey];
  if (statuses && statuses.length) {
    sql += ` AND status IN (${statuses.map(() => "?").join(",")})`;
    args.push(...statuses);
  }
  if (chatId !== undefined && chatId !== null) {
    sql += ` AND chat_id = ?`;
    args.push(typeof chatId === "string" ? Number(chatId) : chatId);
  }
  // Тай-брейк по rowid — тот же приём и та же причина, что в listTasksByChat
  // ниже: `priority DESC, created_at ASC` ключ неполный, а SPLIT_TASK кладёт
  // подзадачи пачкой в одну миллисекунду с одним приоритетом. Без него на
  // границе LIMIT решает планировщик, и два одинаковых запроса возвращают
  // разные наборы. rowid — порядок вставки, то есть ровно то, что и так
  // отдавалось на практике. EXPLAIN QUERY PLAN не меняется: здесь и до этого
  // стоял `USE TEMP B-TREE FOR ORDER BY`, так что цена нулевая.
  sql += ` ORDER BY priority DESC, created_at ASC, rowid ASC`;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    sql += ` LIMIT ?`;
    args.push(Math.floor(limit));
  }
  const rows = db.prepare(sql).all(...args as never[]) as TaskRow[];
  return rows.map(rowToTask);
}

/**
 * Задачи чата, в хронологическом порядке (старые сверху).
 *
 * Про сам `limit` — см. комментарий к listTasksByAssignee. Но обрезался он
 * здесь не с того конца, и это аудит 2026-08-28.
 *
 * Порядок у чата — `created_at ASC`, то есть LIMIT брал N САМЫХ СТАРЫХ задач.
 * У listTasksByAssignee это правильно (там очередь работы, сверху — что делать
 * первым), а доска чата так не читается: в чате на 300 задач
 * `GET /api/tasks?chat_id=X&limit=50` показывал первые пятьдесят за всю жизнь
 * чата — почти сплошь done и cancelled, — а всё сегодняшнее оставалось за
 * кадром. Ответ при этом 200 и полный, отличить его от «задач всего пятьдесят»
 * нельзя. Соседняя ветка того же обработчика (без chat_id) уже брала
 * `ORDER BY created_at DESC LIMIT ?`, то есть свежие: одна ручка отвечала
 * двумя разными способами в зависимости от наличия фильтра.
 *
 * Чинится так: у СУБД берём N свежайших (`created_at DESC LIMIT ?`), наружу
 * отдаём их в прежнем возрастающем порядке. Показ не меняется — меняется
 * только то, КАКИЕ N строк в него попадают. Вызов без `limit` (commands.ts,
 * /tasks) идёт по той же ветке, что и раньше, байт в байт.
 *
 * Разворот делается в JS, а не подзапросом: `SELECT * FROM (…)` не пробрасывает
 * наружу `rowid`, а без него внешний ORDER BY снова остаётся без тай-брейка.
 * Строк тут не больше `limit` (ручка режет его на 200), так что цена разворота
 * — ноль, и это дешевле, чем тащить служебную колонку через rowToTask в JSON
 * ответа.
 *
 * `rowid` в тай-брейке — потому что задачи, созданные в одну миллисекунду
 * (SPLIT_TASK кладёт подзадачи пачкой), иначе распределяются между страницами
 * как повезёт планировщику; rowid — это порядок вставки, то есть ровно то, что
 * и так возвращалось на практике.
 */
export function listTasksByChat(
  chatId: number | string,
  statuses?: TaskStatus[],
  limit?: number,
): Task[] {
  const cid = typeof chatId === "string" ? Number(chatId) : chatId;
  let where = `chat_id = ?`;
  const args: unknown[] = [cid];
  if (statuses && statuses.length) {
    where += ` AND status IN (${statuses.map(() => "?").join(",")})`;
    args.push(...statuses);
  }
  const capped =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0;
  const sql = capped
    ? `SELECT * FROM tasks WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`
    : `SELECT * FROM tasks WHERE ${where} ORDER BY created_at ASC, rowid ASC`;
  if (capped) args.push(Math.floor(limit as number));
  const rows = db.prepare(sql).all(...args as never[]) as TaskRow[];
  if (capped) rows.reverse();
  return rows.map(rowToTask);
}
