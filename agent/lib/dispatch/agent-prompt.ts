/**
 * T-702 — UPDATE_AGENT_PROMPT handlers.
 *
 * Two-phase lifecycle:
 *
 *  1. PRE-APPROVAL (insertPendingAgentPrompt) — called from gateOrDispatch
 *     AFTER validation, BEFORE approval-row creation. Inserts a new row in
 *     agent_prompts with version = max(version)+1 and applied_at = NULL.
 *     This is the versioned audit trail of every prompt PROPOSAL,
 *     regardless of approval outcome.
 *
 *  2. POST-APPROVAL (handleUpdateAgentPromptApproved) — called from
 *     dispatchAction's switch-case (which runs from cmdApprove's
 *     executeApproved). Sets applied_at = now() on the matching
 *     agent_prompts row. Actual hot-swap of running agent prompt is OUT OF
 *     SCOPE for this PR — T-705 wires that into characters/* runtime.
 *
 * On REJECT (handleUpdateAgentPromptRejected) — called from cmdReject.
 * Stamps rejected_at on the agent_prompts row (миграция 048) and writes an
 * audit_logs entry for human-readable trail. Аудит 2026-08-27: раньше строка
 * оставалась с applied_at = NULL «в качестве маркера» — тем же самым, каким
 * помечена ожидающая решения версия. Одобрение шло по этому маркеру и
 * стамповало отклонённую версию как применённую.
 */
import { db } from "../db.ts";
import type { Database } from "bun:sqlite";
import { log } from "../log.ts";
import { insertActionRow, emitActionEvents } from "../audit.ts";
import { CHARACTERS } from "../../characters/index.ts";
import type { UpdateAgentPromptPayload } from "../action-payload.ts";

const VALID_AGENT_KEYS: Set<string> = new Set(CHARACTERS.map((c) => c.key));

export const MIN_PROMPT_LEN = 50;
export const MAX_PROMPT_LEN = 8000;
export const MIN_REASON_LEN = 20;

export interface UpdateAgentPromptResult {
  ok: true;
  result: {
    target_agent_key: string;
    version: number;
    prompt_row_id: number;
    applied_at: number | null;
    reason: string;
  };
}

export interface UpdateAgentPromptFailure {
  ok: false;
  error: string;
}

/**
 * Validate UPDATE_AGENT_PROMPT payload. Returns error string or null.
 */
export function validateUpdateAgentPromptPayload(
  p: UpdateAgentPromptPayload,
): string | null {
  if (typeof p?.target_agent_key !== "string" || !p.target_agent_key) {
    return "target_agent_key is required";
  }
  if (!VALID_AGENT_KEYS.has(p.target_agent_key)) {
    return `unknown target_agent_key: ${p.target_agent_key}`;
  }
  if (typeof p.new_prompt !== "string") {
    return "new_prompt must be a string";
  }
  const promptLen = p.new_prompt.length;
  if (promptLen < MIN_PROMPT_LEN) {
    return `new_prompt too short: ${promptLen} < ${MIN_PROMPT_LEN}`;
  }
  if (promptLen > MAX_PROMPT_LEN) {
    return `new_prompt too long: ${promptLen} > ${MAX_PROMPT_LEN}`;
  }
  if (typeof p.reason !== "string" || p.reason.trim().length < MIN_REASON_LEN) {
    return `reason must be at least ${MIN_REASON_LEN} characters (operator accountability)`;
  }
  return null;
}

interface VersionRow {
  v: number | null;
}

/**
 * Insert a new agent_prompts row with version = max(version)+1 and
 * applied_at = NULL. Returns { id, version }. Called from gateOrDispatch
 * inside the same transaction as the approval row (so even rejected
 * proposals are recorded), and from the fallback branch of the approve
 * handler.
 *
 * `approvalId` — заявка, которая эту версию решает (миграция 050). Передаётся
 * всегда, когда известна: по ней строку закрывают истечение TTL и провал
 * исполнения, у которых на руках нет ни текста промпта, ни причины. У ветки
 * «строки не нашлось, вставляем применённой» заявки нет по построению —
 * там NULL.
 */
export function insertPendingAgentPrompt(
  payload: UpdateAgentPromptPayload,
  editedBy: string,
  database: Database = db,
  approvalId: string | null = null,
): { id: number; version: number } {
  const now = Date.now();
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS v FROM agent_prompts WHERE agent_key = ?`,
    )
    .get(payload.target_agent_key) as VersionRow;
  const nextVersion = (row?.v ?? 0) + 1;
  const ins = database
    .prepare(
      `INSERT INTO agent_prompts(
        agent_key, version, prompt, edited_by, edited_at, applied_at, reason,
        approval_id
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      payload.target_agent_key,
      nextVersion,
      payload.new_prompt,
      editedBy,
      now,
      payload.reason,
      approvalId,
    );
  return { id: Number(ins.lastInsertRowid), version: nextVersion };
}

/**
 * Закрыть строку версии, заявку по которой решили НЕ применением: истёк TTL
 * (`expireStaleApprovals`) или исполнение упало уже после одобрения
 * (`markApprovalFailed`).
 *
 * Аудит 2026-09-10: оба пути меняли статус заявки и на строку версии не
 * смотрели, а строка с `applied_at IS NULL AND rejected_at IS NULL` — это ровно
 * тот маркер, по которому одобрение ищет, что применять (докблок
 * `handleUpdateAgentPromptApproved`). Мёртвая версия оставалась кандидатом
 * навсегда, и следующее одобрение того же текста стамповало её вместо новой:
 * тот же развал, что чинил аудит 2026-08-27 со стороны отказа.
 *
 * Отбор строго по `approval_id` и без запасного варианта по содержимому:
 * догадываться, какую из одинаковых версий закрыть, здесь нельзя — ошибка
 * закрыла бы ЖИВОЕ предложение, ждущее решения владельца. У строк старше
 * миграции 050 approval_id пуст, их этот проход просто не трогает: они и так
 * относятся к заявкам, решённым до появления колонки.
 *
 * Отдельная колонка `closed_at`, а НЕ `rejected_at` (миграция 051): протухшая
 * заявка — не отказ. Докстрока `ApprovalStatus` (approvals.ts) говорит это
 * прямым текстом про `expired`, и цена подделки не косметическая: `rejected_at`
 * заведена затем, чтобы роль, читающая `GET_PROMPT_HISTORY`, не переспрашивала
 * то, в чём ей уже отказали. Протухшую заявку, показанную как «rejected», роль
 * прочтёт как решение владельца и НЕ переспросит — хотя владелец не сказал
 * ничего и переспросить как раз нужно.
 */
export function closeAgentPromptProposals(
  approvalIds: string[],
  now: number = Date.now(),
  database: Database = db,
): number {
  if (approvalIds.length === 0) return 0;
  const upd = database.prepare(
    `UPDATE agent_prompts SET closed_at = ?
     WHERE approval_id = ? AND applied_at IS NULL AND rejected_at IS NULL
       AND closed_at IS NULL`,
  );
  let closed = 0;
  const tx = database.transaction(() => {
    for (const id of approvalIds) closed += Number(upd.run(now, id).changes);
  });
  tx();
  if (closed > 0) {
    log.info("[agent-prompt] версии закрыты вместе с заявками", { closed });
  }
  return closed;
}

/**
 * Called from dispatchAction's UPDATE_AGENT_PROMPT case (runs only after
 * cmdApprove). Finds the matching pending agent_prompts row (by
 * agent_key + prompt + reason, applied_at IS NULL, latest version) and
 * sets applied_at. Fallback: if no pending row found (shouldn't happen in
 * normal flow), insert one and mark it applied immediately.
 *
 * Note: hot-swap of the running character prompt is T-705's job — this
 * handler only marks the data row + writes audit_log.
 */
export function handleUpdateAgentPromptApproved(
  payload: UpdateAgentPromptPayload,
  ctx: { agentKey: string; chatId: number; approvalId?: string },
): UpdateAgentPromptResult | UpdateAgentPromptFailure {
  const err = validateUpdateAgentPromptPayload(payload);
  if (err) return { ok: false, error: err };

  // Аудит 2026-08-20: сопоставление идёт по содержимому (agent_key + prompt +
  // reason), потому что одобрение не приносит сюда id строки. Значит два
  // одинаковых предложения — типичный повтор после «зависшей» первой заявки —
  // неразличимы, и порядок решает ORDER BY.
  //
  // Было DESC: владелец одобрял СТАРШУЮ заявку (v5), а applied_at ставился
  // младшей (v6); следующее одобрение стамповало v5. Версионный след
  // переворачивался относительно фактических решений. Тексты идентичны, так
  // что содержимое не теряется, но журнал врал о порядке.
  //
  // ASC совпадает с тем, как заявки решают на самом деле: очередь показывает
  // старшую первой, её и одобряют первой.
  //
  // Аудит 2026-08-27: `rejected_at IS NULL` — вторая половина того же условия.
  // Раньше отказ строку не трогал, то есть отклонённая версия оставалась
  // неотличима от ожидающей. Владелец отклонял v5, автор переспрашивал тем же
  // текстом, владелец одобрял v6 — а applied_at по ASC вставал на v5, на
  // ОТКЛОНЁННУЮ. Одобренная v6 при этом числилась «не применена никогда»
  // (воспроизведено на чистой БД: v1 applied, v2 NULL).
  // Аудит 2026-09-10: точная связь, если она есть. `approval_id` пишется в
  // строку при постановке в очередь, а `closeAgentPromptProposals` по нему уже
  // закрывает строки протухших заявок — то есть ключ был, им просто не
  // пользовались на применении. Всё, чего не хватало, — довезти id сюда:
  // теперь его ставит `executeApproved`, единственный исполнитель одобренного
  // (DispatchCtx.approvalId).
  //
  // Что это чинит поверх ASC-порядка ниже. Порядок — компромисс: он совпадает
  // с тем, КАК заявки решают (очередь показывает старшую первой), но угадывает
  // намерение владельца, а не читает его. Стоит владельцу решить очередь не по
  // порядку — из Mini App это одно нажатие — и applied_at снова встаёт не на
  // ту версию, а тексты одинаковы, так что заметить нечем. По id угадывать
  // нечего: одобрена ровно эта строка.
  //
  // Сопоставление по содержимому остаётся запасным путём и удалено быть не
  // может: `approval_id` у строк, заведённых до миграции, пуст, и у любого
  // будущего вызывающего, который id не довезёт, поведение должно остаться
  // прежним, а не «не нашли — вставим новую версию».
  const byApproval = ctx.approvalId
    ? (db
        .prepare(
          `SELECT id, version FROM agent_prompts
           WHERE approval_id = ? AND applied_at IS NULL AND rejected_at IS NULL
             AND closed_at IS NULL
           LIMIT 1`,
        )
        .get(ctx.approvalId) as { id: number; version: number } | undefined)
    : undefined;

  const pending =
    byApproval ??
    (db
      .prepare(
        `SELECT id, version FROM agent_prompts
         WHERE agent_key = ? AND applied_at IS NULL AND rejected_at IS NULL
           AND closed_at IS NULL
           AND prompt = ? AND reason = ?
         ORDER BY version ASC LIMIT 1`,
      )
      .get(
        payload.target_agent_key,
        payload.new_prompt,
        payload.reason,
      ) as { id: number; version: number } | undefined);

  // `!` — присваиваются внутри транзакции ниже, обе ветки её `if` пишут обе.
  let rowId!: number;
  let version!: number;
  const now = Date.now();
  // Аудит 2026-08-29: отметка «применено» и строка аудита о применении уходили
  // разными автокоммитами, а запасная ветка вдобавок делала INSERT и UPDATE
  // двумя. Обрыв между ними оставлял в `agent_prompts` строку с applied_at =
  // NULL — неотличимую от живого предложения, ждущего решения владельца:
  // следующее одобрение того же текста нашло бы её выборкой выше и
  // проштамповало повторно. Собираем всё в одну durability-единицу; событие в
  // шину шлём после коммита (см. докблок `insertActionRow`).
  const applied = db.transaction(() => {
    if (pending) {
      rowId = pending.id;
      version = pending.version;
      // Условие `applied_at IS NULL` повторено в UPDATE намеренно: выборка выше
      // и запись — два разных обращения к БД, и без повтора второе одобрение той
      // же заявки перештамповало бы уже применённую строку новым временем.
      // Между ними нет await, так что промах здесь означал бы что-то, чего мы не
      // понимаем, — тогда лучше след в логе, чем молчаливая перезапись.
      const upd = db
        .prepare(
          `UPDATE agent_prompts SET applied_at = ?
           WHERE id = ? AND applied_at IS NULL AND rejected_at IS NULL
             AND closed_at IS NULL`,
        )
        .run(now, rowId);
      if (Number(upd.changes) === 0) {
        log.warn("[agent-prompt] pending-строка исчезла между выборкой и записью", {
          rowId,
          version,
          targetAgent: payload.target_agent_key,
        });
      }
    } else {
      const inserted = insertPendingAgentPrompt(payload, ctx.agentKey);
      rowId = inserted.id;
      version = inserted.version;
      db.prepare(`UPDATE agent_prompts SET applied_at = ? WHERE id = ?`).run(
        now,
        rowId,
      );
    }

    // Dedicated audit row capturing the applied event (the canonical
    // agent_actions row is written by dispatchAndAudit).
    return insertActionRow("UPDATE_AGENT_PROMPT", {
      agentKey: ctx.agentKey,
      chatId: ctx.chatId,
      payload: {
        target_agent_key: payload.target_agent_key,
        version,
        prompt_row_id: rowId,
        reason: payload.reason,
        _applied: true,
      },
      status: "ok",
    });
    // Аудит 2026-09-10: транзакция была DEFERRED, а её запасная ветка
    // открывается ЧТЕНИЕМ — `SELECT COALESCE(MAX(version), 0)` внутри
    // `insertPendingAgentPrompt` — и только потом пишет. В WAL это ровно тот
    // случай, из-за которого SQLite отдаёт SQLITE_BUSY_SNAPSHOT: снимок для
    // чтения взят до того, как кто-то другой закоммитил, и повышение до записи
    // невозможно. `busy_timeout` такое НЕ пережидает — он повторяет ожидание
    // блокировки, а не устаревший снимок, — то есть отказ приходит вызывающему
    // сразу, уже ПОСЛЕ того, как человек нажал «одобрить».
    //
    // BEGIN IMMEDIATE берёт запись сразу: конкурент ждёт по busy_timeout, как
    // и на всех остальных путях (`withApprovalTransaction` в approvals.ts
    // делает то же самое).
  }).immediate();
  emitActionEvents(applied);

  return {
    ok: true,
    result: {
      target_agent_key: payload.target_agent_key,
      version,
      prompt_row_id: rowId,
      applied_at: now,
      reason: payload.reason,
    },
  };
}

/**
 * Called from cmdReject when the action is UPDATE_AGENT_PROMPT. Leaves
 * agent_prompts.applied_at = NULL (the marker that this version was never
 * applied) and writes an audit_logs row for human-readable trail.
 */
export function handleUpdateAgentPromptRejected(args: {
  payload: UpdateAgentPromptPayload;
  decidedBy: string;
  /**
   * Кто просил правку (`approvals.requested_by`).
   *
   * Аудит 2026-08-21: в записи были чей промпт, кто отказал и почему — и не
   * было заказчика. Найти его было не по чему: id самого approval'а в строке
   * тоже отсутствовал, а approval'ы уезжают в архив по расписанию. При этом
   * промпт роли `perm` велит читать audit_logs при разборе денаев: роль
   * приходила разбираться и на вопрос «кто» ответить не могла.
   */
  requestedBy: string;
  /** id approval'а — ключ, по которому запись можно связать с решением. */
  approvalId: string;
  /**
   * Чат САМОГО approval'а, а не тот, где нажали «отклонить». Единственный
   * читатель журнала фильтрует по chat_id (miniapp-server.ts, /api/audit-logs),
   * поэтому запись должна лежать в чате, к которому относится решение.
   */
  chatId: number;
  reason?: string;
}): void {
  const id = crypto.randomUUID();
  const now = Date.now();

  // Аудит 2026-08-27: отказ не оставлял следа В САМОЙ строке версии — она
  // оставалась с applied_at = NULL, то есть неотличимой от ожидающей решения.
  // Строка в audit_logs этого не закрывает: одобрение ищет версию в
  // agent_prompts и в журнал не смотрит, а `GET_PROMPT_HISTORY` читает ту же
  // таблицу и печатал `applied: false` и для отказа, и для «ещё не решено».
  //
  // Отбор тот же, что у одобрения (по содержимому, ASC): id approval'а не
  // несёт ссылки на строку версии, а очередь решают со старшей.
  const pending = db
    .prepare(
      `SELECT id, version FROM agent_prompts
       WHERE agent_key = ? AND applied_at IS NULL AND rejected_at IS NULL
         AND closed_at IS NULL
         AND prompt = ? AND reason = ?
       ORDER BY version ASC LIMIT 1`,
    )
    .get(
      args.payload.target_agent_key,
      args.payload.new_prompt,
      args.payload.reason,
    ) as { id: number; version: number } | undefined;
  // Аудит 2026-08-29: отметка отказа в строке версии и запись решения в
  // журнал — две половины одного решения, а уходили двумя автокоммитами.
  // Обрыв между ними давал ровно тот развал, который эта же функция чинила
  // 2026-08-27, только с другой стороны: версия помечена отклонённой, а «кто
  // отказал и почему» не записано нигде, и роль `perm`, которой промпт велит
  // разбирать денаи по audit_logs, снова не может ответить на «кто».
  const tx = db.transaction(() => {
    if (pending) {
      db.prepare(
        `UPDATE agent_prompts SET rejected_at = ?
         WHERE id = ? AND applied_at IS NULL AND rejected_at IS NULL
           AND closed_at IS NULL`,
      ).run(now, pending.id);
    } else {
      // Не молчим: строку версии кладут ДО создания approval'а
      // (insertPendingAgentPrompt из gateOrDispatch), так что её отсутствие
      // здесь означает что-то, чего мы не понимаем. Сам отказ это не отменяет —
      // решение человека записывается ниже в любом случае.
      log.warn("[agent-prompt] отказ: строка версии не найдена", {
        targetAgent: args.payload.target_agent_key,
        approvalId: args.approvalId,
    });
  }

  db.prepare(
    `INSERT INTO audit_logs(id, agent_key, chat_id, event_type, payload, created_at)
     VALUES (?, ?, ?, 'UPDATE_AGENT_PROMPT_REJECTED', ?, ?)`,
  ).run(
    id,
    args.payload.target_agent_key,
    args.chatId,
    JSON.stringify({
      target_agent_key: args.payload.target_agent_key,
      reason: args.payload.reason,
      requested_by: args.requestedBy,
      approval_id: args.approvalId,
      decided_by: args.decidedBy,
      reject_reason: args.reason ?? null,
    }),
    now,
  );
  });
  tx();
}

/**
 * Единая точка «что сделать после отказа» — вызывается из ЛЮБОГО пути отказа.
 *
 * Аудит 2026-08-08: было два бага сразу. Telegram-путь (cmdReject) звал
 * handleUpdateAgentPromptRejected в `try { } catch {}` без единой строчки лога:
 * если запись аудита падала, отказ system-prompt'а не оставлял следа НИГДЕ, и
 * узнать об этом было неоткуда. А путь Mini App (POST /api/approvals/:id/decide)
 * не звал её вовсе — отказ через веб просто не писался в audit_logs. Правки
 * system prompt'ов — самое чувствительное, что есть в репо; «кто отказал и
 * почему» должно оставаться в обоих случаях.
 *
 * Проверка типа действия внутри, а не у вызывающего: иначе третий путь отказа
 * снова забудет `if`. Ошибка аудита не роняет сам отказ (решение человека уже
 * записано), но громко логируется.
 */
export function auditRejectedApproval(args: {
  actionType: string;
  payload: unknown;
  decidedBy: string;
  /**
   * Заказчик и id approval'а — обязательные (аудит 2026-08-21).
   *
   * У модуля уже есть правило «проверять внутри, а не у вызывающего, иначе
   * третий путь отказа снова забудет» (аудит 2026-08-08). Обязательный
   * параметр доводит то же правило до компилятора: оба существующих пути
   * держат в руках полную строку approval'а, и третий её тоже будет держать.
   */
  requestedBy: string;
  approvalId: string;
  /** Чат approval'а (см. handleUpdateAgentPromptRejected). */
  chatId: number;
  reason?: string;
}): void {
  if (args.actionType !== "UPDATE_AGENT_PROMPT") return;
  try {
    handleUpdateAgentPromptRejected({
      payload: (args.payload ?? {}) as UpdateAgentPromptPayload,
      decidedBy: args.decidedBy,
      requestedBy: args.requestedBy,
      approvalId: args.approvalId,
      chatId: args.chatId,
      reason: args.reason,
    });
  } catch (e) {
    log.error("[agent-prompt] отказ не записан в audit_logs", {
      decidedBy: args.decidedBy,
      requestedBy: args.requestedBy,
      approvalId: args.approvalId,
      chatId: args.chatId,
      error: String((e as Error)?.message ?? e),
    });
  }
}
