/**
 * T-701 — CREATE_DIAGNOSTIC_TASK as a first-class action.
 *
 * Задумано было так: диагностические задачи ставились только неявно, на
 * catch-пути диспетчера (`createDiagnosticTask`, diagnostic.ts), а этот
 * хендлер должен был дать агенту попросить разбор явно — с маршрутизацией на
 * роль и `suggested_fix`.
 *
 * Аудит 2026-08-28: до хендлера не доходит никто. Тула у действия нет (оно в
 * DISPATCH_ONLY_ACTIONS, и это пинится prompt-tool-parity), а неявный путь
 * зовёт библиотечный `createDiagnosticTask()` НАПРЯМУЮ, мимо диспетчера. То
 * есть ветка `case "CREATE_DIAGNOSTIC_TASK"` в проде не исполняется ни разу —
 * вместе с отказом по чужому чату ниже.
 *
 * Ни тип действия, ни сид разрешения не сняты: это шов T-701, и решение —
 * выдать модели тул или снести — за владельцем. Инвариант держит тест
 * `audit-2026-08-28-diagnostic-action-unreachable`: он упадёт и если ветку
 * начнут диспатчить, и если движок перестанет звать библиотеку напрямую.
 *
 * Gate (wired in permissions.ts): allowed for all roles, requires_approval=0 —
 * creating a task is not an external side-effect. NOT in ALWAYS_APPROVE_ACTIONS
 * nor CALLER_RESTRICTED.
 *
 * Recursion / cascade safety mirrors `shouldSkipSelfDiag` (lib/diagnostic.ts):
 *   - never diagnose a diagnostic action or a CREATE_TASK (loop guard);
 *   - skip when the failed action was approval-gated (belongs in approvals);
 *   - skip transient errors — rate-limit (retried by anthropic-client /
 *     dispatcher) и network (ретраит C15 / оркестратор); решение принимается
 *     по категории `categorizeAggregateError`, как на неявном пути.
 * Плюс два рубежа против шторма (аудит 2026-08-09): дедуп по
 * (failed_action_id, error_category) и почасовой троттл T-705 по title. Здесь
 * они нужнее, чем на неявном пути: failed_action_id приходит от модели.
 * Skips return ok:true with a `skipped_reason` so the caller can audit them
 * without treating them as hard failures.
 */
import { getAction } from "../audit.ts";
import { getPermission, type ActionType } from "../permissions.ts";
import {
  categorizeAggregateError,
  findExistingDiagnostic,
  pickResponsibleRole,
  shouldSkipSelfDiag,
} from "../diagnostic.ts";
import { isDiagTaskThrottled } from "../fix-chain.ts";
import { createTask } from "../tasks.ts";
import { log } from "../log.ts";
import { CHARACTERS } from "../../characters/index.ts";
import type { CreateDiagnosticTaskPayload } from "../action-payload.ts";

const VALID_AGENT_KEYS: Set<string> = new Set(CHARACTERS.map((c) => c.key));

export interface DiagnosticActionContext {
  agentKey: string;
  chatId: number;
}

export type DiagnosticSkipReason =
  | "recursion_guard"
  | "skipped_approval_gated"
  | "skipped_rate_limited"
  | "skipped_network"
  | "no_role"
  | "duplicate"
  | "throttled";

export interface CreateDiagnosticTaskActionResult {
  ok: true;
  result: {
    task_id: string | null;
    assigned_to: string | null;
    error_category: string;
    skipped_reason?: DiagnosticSkipReason;
  };
}

export interface CreateDiagnosticTaskActionFailure {
  ok: false;
  error: string;
}

/**
 * Validate the payload. Returns a string error message, or null if valid.
 */
export function validateCreateDiagnosticTaskPayload(
  p: CreateDiagnosticTaskPayload,
): string | null {
  if (typeof p?.failed_action_id !== "string" || !p.failed_action_id) {
    return "failed_action_id is required";
  }
  if (typeof p?.hypothesis !== "string" || p.hypothesis.trim().length < 10) {
    return "hypothesis must be at least 10 characters";
  }
  if (p.target_agent_key !== undefined && p.target_agent_key !== null) {
    if (
      typeof p.target_agent_key !== "string" ||
      !VALID_AGENT_KEYS.has(p.target_agent_key)
    ) {
      return `unknown target_agent_key: ${p.target_agent_key}`;
    }
  }
  if (p.suggested_fix !== undefined && p.suggested_fix !== null) {
    if (
      typeof p.suggested_fix !== "object" ||
      typeof p.suggested_fix.action !== "string" ||
      !p.suggested_fix.action
    ) {
      return "suggested_fix.action must be a non-empty string";
    }
    if (
      typeof p.suggested_fix.payload !== "object" ||
      p.suggested_fix.payload === null
    ) {
      return "suggested_fix.payload must be an object";
    }
  }
  return null;
}

/**
 * Apply a CREATE_DIAGNOSTIC_TASK action. Runs after the gate has allowed it
 * (allowed for all roles, no approval). Looks up the failed action, applies
 * the cascade-safety filters, then creates a routed diagnostic task.
 */
export function handleCreateDiagnosticTask(
  payload: CreateDiagnosticTaskPayload,
  ctx: DiagnosticActionContext,
): CreateDiagnosticTaskActionResult | CreateDiagnosticTaskActionFailure {
  const err = validateCreateDiagnosticTaskPayload(payload);
  if (err) return { ok: false, error: err };

  // Аудит 2026-08-11: проверялось только «строка существует». `getAction`
  // читает agent_actions по одному id, без условия по чату — при том что
  // колонка есть, а соседний listActions фильтрует по ней с T-725. Чат —
  // граница арендатора (pinnedChatId, ownTask, /tasks), и аудит из неё
  // выпадал: id приходит от модели, так что чужой провал утекал текстом
  // ошибки на нашу доску, а его task_id уходил в parentId ниже — то есть в
  // запись по ЧУЖОЙ доске. Чужое (и непроверяемое, chat_id IS NULL) действие
  // отдаём как несуществующее и теми же словами: разный ответ на «нет такого»
  // и «есть, но не твоё» — это оракул существования по чужим чатам.
  const failed = getAction(payload.failed_action_id);
  if (!failed || failed.chat_id !== ctx.chatId) {
    if (failed) {
      log.warn("[security] CREATE_DIAGNOSTIC_TASK: провал с чужого чата — отказ", {
        failed_action_id: payload.failed_action_id,
        action_chat: failed.chat_id,
        originating: ctx.chatId,
        agent: ctx.agentKey,
      });
    }
    return {
      ok: false,
      error: `failed_action_id not found: ${payload.failed_action_id}`,
    };
  }

  const failedActionType = failed.action_type;
  const failedError = failed.error ?? "(no error recorded)";

  // Loop guard: never create a diagnostic about a diagnostic action, плюс общее
  // с неявным путём решение shouldSkipSelfDiag. Раньше здесь стоял литерал
  // "CREATE_TASK" и комментарий «mirrors», что зеркальности не гарантировало;
  // решение зависит не только от типа действия, но и от текста ошибки, поэтому
  // передаём его — иначе модель обошла бы правило, попросив диагностику вручную.
  if (
    failedActionType === "CREATE_DIAGNOSTIC_TASK" ||
    shouldSkipSelfDiag(failedActionType, failed.error)
  ) {
    return {
      ok: true,
      result: {
        task_id: null,
        assigned_to: null,
        error_category: "unknown",
        skipped_reason: "recursion_guard",
      },
    };
  }

  // Mirror self-diag filter: approval-gated original actions belong in the
  // approvals queue, not an auto-retry diagnostic.
  const perm = getPermission(failed.agent_key, failedActionType as ActionType);
  if (perm.requires_approval) {
    return {
      ok: true,
      result: {
        task_id: null,
        assigned_to: null,
        error_category: "permission_denied",
        skipped_reason: "skipped_approval_gated",
      },
    };
  }

  // Транзиентные ошибки не идут на доску — зеркало неявного пути
  // (diagnostic.ts, createDiagnosticTask: deferred_rate_limited /
  // deferred_network / no_role).
  //
  // Аудит 2026-08-21. Здесь стоял собственный регэксп `/429|rate.?limit/i`,
  // который УЖЕ, чем классификатор: «Too Many Requests: retry after 30»,
  // «quota exceeded», «rate exceeded» — это `rate_limited` по
  // `categorizeError` и не rate-limit по фильтру. А сетевых ошибок фильтр не
  // знал вовсе. Второй промах складывался с первым: `pickResponsibleRole`
  // документирован как «null = задачу создавать НЕ надо», и этот null гасился
  // через `?? "orchestrator"` — сигнал «не создавать» превращался в «создать и
  // повесить на оркестратора». Итог: моргнувшая сеть = задача
  // `[diagnostic] network: …` на доске владельца; троттл T-705 по title поток
  // ограничивал, но не отменял (разные типы упавшего действия — разные title).
  //
  // Решение по классу ошибки, а не по маршруту: явный `target_agent_key` его
  // не отменяет — «кому расследовать» не делает сбой провайдера постоянным.
  //
  // Условие — ровно `!responsible`, без дублирующего перечисления категорий:
  // null отдают именно `rate_limited` и `network`, а вторая проверка тех же
  // двух имён ничего не ловит (проверено мутацией: подмена любой из них
  // оставляет тесты зелёными) и лишь заводит второй источник правды рядом с
  // `pickResponsibleRole`. Категории ниже нужны только чтобы назвать причину.
  const category = categorizeAggregateError(failedError);
  const responsible = pickResponsibleRole(category);
  if (!responsible) {
    return {
      ok: true,
      result: {
        task_id: null,
        assigned_to: null,
        error_category: category,
        skipped_reason:
          category === "rate_limited"
            ? "skipped_rate_limited"
            : category === "network"
              ? "skipped_network"
              : "no_role",
      },
    };
  }

  const assignedTo = payload.target_agent_key ?? responsible;
  const title = `[diagnostic] ${category}: ${failedActionType}`;

  // Аудит 2026-08-09: у явного пути не было ни дедупа, ни троттла.
  //
  // Неявный путь (createDiagnosticTask) дедупит по (failed_action_id,
  // error_category) — но failed_action_id там свежий crypto.randomUUID() из
  // logAction, так что ключ не может совпасть никогда. Здесь наоборот:
  // failed_action_id приходит ОТ МОДЕЛИ и повторяется сколько угодно раз.
  // Дедуп жил там, где он невозможен, и отсутствовал там, где он и нужен:
  // агент, попросивший разобраться с одним и тем же провалом трижды, получал
  // три задачи на доске и три чужих запуска.
  const existing = findExistingDiagnostic(payload.failed_action_id, category);
  if (existing) {
    return {
      ok: true,
      result: {
        task_id: existing.id,
        assigned_to: null,
        error_category: category,
        skipped_reason: "duplicate",
      },
    };
  }

  // Второй рубеж — тот же анти-шторм T-705, что у C15-петли: дедуп ловит
  // повтор по одному действию, троттл — поток разных действий одного класса.
  if (isDiagTaskThrottled(title, Date.now(), null)) {
    return {
      ok: true,
      result: {
        task_id: null,
        assigned_to: null,
        error_category: category,
        skipped_reason: "throttled",
      },
    };
  }

  // Диагностика — НЕ подзадача того, что упало.
  //
  // Аудит 2026-08-13. Здесь стояло `parentId = failed.task_id`, и это ломало
  // ровно тот таск, ради которого расследование и заводят. Действие упало →
  // его таск T закрылся как `failed` с текстом ошибки. Владелец просит
  // «разберись, почему упало» → createTask видит терминального родителя,
  // отрабатывает reopenParentForLateChild (tasks.ts) и голым UPDATE'ом ставит
  // T в `running`, **стирая error**. Настоящая причина провала исчезает
  // безвозвратно. Дальше диагностика завершается, rollupParent пересчитывает T
  // по единственному ребёнку (у не-SPLIT родителя `expectedChildren` — null,
  // значит набор из одной строки считается полным) — и проваленный таск
  // показывается на доске выполненным. Если же диагностику никто не взял, T
  // через сутки закрывает gcStaleTasks с `error='gc_stale'` вместо настоящей
  // причины.
  //
  // Родительство здесь и не нужно: связь с исходной задачей уже записана в
  // `inputPayload.failed_action_id` (и в `agent_actions.task_id`), а иерархия
  // означала бы, что итог T зависит от итога расследования — то есть успешный
  // разбор «чинил» бы статус того, что на самом деле не сделано.
  //
  // Неявный путь (`diagnostic.ts` из `dispatchAndAudit`) этой беды не знал:
  // он передаёт `parentTaskId`, которого не задаёт ни один вызывающий.
  const task = createTask({
    chatId: ctx.chatId,
    createdBy: ctx.agentKey,
    assignedTo,
    parentId: null,
    title,
    description: payload.hypothesis,
    inputPayload: {
      type: "diagnostic",
      failed_action_id: payload.failed_action_id,
      error_category: category,
      hypothesis: payload.hypothesis,
      original_error: failedError,
      suggested_fix: payload.suggested_fix ?? null,
      explicit: true,
    },
    priority: 2,
  });

  return {
    ok: true,
    result: { task_id: task.id, assigned_to: assignedTo, error_category: category },
  };
}
