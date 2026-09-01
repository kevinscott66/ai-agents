/**
 * C15: self-diagnostic retry loop.
 *
 * When dispatchAndAudit() logs a tool error it also creates a "diagnostic task"
 * assigned to aieng (see lib/action-dispatch.ts). This module polls those
 * pending diag-tasks, asks aieng (Claude) for a corrected payload, and retries
 * the original action ONCE.
 *
 * Guardrails:
 *  - hard cap: each original action gets at most 1 self-diag retry
 *    (tracked via inputPayload._retry_count on the diag task; the retry
 *     dispatch carries _retry_count=1 so any failure won't spawn another
 *     diag-task — see action-dispatch.ts).
 *  - approval-gated actions are skipped (those belong in the approvals queue).
 *  - rate-limited actions are skipped (anthropic-client retries those itself).
 *  - aieng response must be valid JSON; on parse failure → task = failed.
 *  - aieng call capped at max_tokens = 1024.
 */
import { getErrorMessage } from "./errors.ts";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db.ts";
import { runTextViaAgentSdk } from "./agent-sdk-runtime.ts";
import {
  createTask,
  failTask,
  updateTaskStatus,
  type Task,
} from "./tasks.ts";
import { dispatchAndAudit } from "./action-dispatch.ts";
import {
  checkAndConsumeRateLimit,
  checkAndConsumeChatRateLimits,
  refundRateLimit,
  refundChatRateLimits,
} from "./rate-limits.ts";
import {
  evaluateGate,
  payloadForcesApproval,
  type ActionType,
  ACTION_TYPES,
} from "./permissions.ts";
import { callAnthropic } from "./anthropic-client.ts";
import type { DispatchCtx } from "./action-dispatch.ts";
import type { PayloadFor } from "./action-payload.ts";
import { getFixChain, appendFixChain } from "./fix-chain.ts";
import { log } from "./log.ts";

/**
 * Потолок ожидания одного ответа aieng.
 *
 * Вызов ниже — это спавн дочернего `claude` (или, в compat-ветке, сетевой
 * запрос). Ни у того, ни у другого нет собственного дедлайна, а тик поллера
 * держит флаг `running` ровно столько, сколько длится await. Один повисший
 * subprocess останавливал весь self-heal бессрочно и без единой строки в лог:
 * следующий тик выходил по `if (running) return`.
 *
 * Пять минут — с запасом: запрос одношаговый (`maxTurns: 1`,
 * `max_tokens: 1024`), нормальный ответ приходит за секунды.
 */
export const SELF_DIAG_LLM_TIMEOUT_MS = 5 * 60_000;

/** Отказ по дедлайну — отдельный класс, чтобы его было видно в тесте и в логе. */
export class SelfDiagTimeoutError extends Error {
  constructor(ms: number) {
    super(`aieng call timed out after ${ms}ms`);
    this.name = "SelfDiagTimeoutError";
  }
}

/**
 * Гонка промиса с таймером.
 *
 * Отменить сам вызов нечем: `runTextViaAgentSdk` не принимает AbortSignal, а
 * трогать его сигнатуру — это чужой файл. Поэтому дедлайн здесь освобождает
 * ВЫЗЫВАЮЩЕГО, а не убивает subprocess: поллер идёт дальше, задача получает
 * терминальный статус. Осиротевший процесс переживёт нас, но он больше никого
 * не блокирует.
 *
 * Проигравший промис остаётся подписанным на `Promise.race`, так что его
 * поздний reject считается обработанным и не всплывает как unhandledRejection.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SelfDiagTimeoutError(ms)), ms);
    // Таймер не должен продлевать жизнь процессу: он живёт дольше, чем ждёт
    // вызывающий, только если промис уже победил — а тогда его снимет finally.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

const ACTION_TYPE_SET = new Set<string>(ACTION_TYPES);

/**
 * Поля payload, которые несут ПОЛНОМОЧИЕ, а не данные: их проставляет доверенный
 * вызывающий, и модель не вправе их сочинять. Пока такое поле одно, но имя у
 * списка есть, чтобы следующему было куда лечь: `_userId` дошёл сюда именно
 * потому, что закрывали его в одном месте (инструментальный путь), а входов в
 * диспатч два.
 */
export const MODEL_FORBIDDEN_PAYLOAD_FIELDS = ["_userId"] as const;

/**
 * Гейт ровно в той форме, в какой его считает gateOrDispatch, — включая
 * forceApproval для действий от лица владельца (via_userbot). Вызывается
 * evaluateGate напрямую, а не gateOrDispatch: тот на «approval» ЗАВЕДЁТ строку
 * апрува, а self-diag-ретраю место не в очереди на подтверждение, а в failed.
 *
 * Аудит 2026-08-08: условие forceApproval было здесь копией выражения из
 * gateOrDispatch. Две копии одного инварианта расходятся молча — теперь обе
 * стороны зовут payloadForcesApproval.
 */
function gateFor(
  agentKey: string,
  actionType: ActionType,
  chatId: number | null,
  payload: Record<string, unknown> | undefined,
) {
  const forcedReason = payloadForcesApproval(actionType, payload);
  return evaluateGate({
    agentKey,
    actionType,
    chatId: chatId ?? undefined,
    forceApproval: forcedReason !== null,
    forceApprovalReason: forcedReason ?? undefined,
  });
}

export interface DiagInput {
  actionType: ActionType;
  payload: Record<string, unknown>;
  error: string;
  _diag: true;
  _retry_count: number;
}

export interface AiengFixResponse {
  action?: ActionType;
  payload?: Record<string, unknown>;
  reason?: string;
  giveup?: boolean;
}

/**
 * Поля, которые на санкционированном пути ставит доверенный код, а не модель.
 *
 * Аудит 2026-08-14: ретрай — единственная точка диспатча, минующая
 * `buildPayload`. Тулзовый путь собирает payload из ctx (`tools-schema.ts` →
 * `buildPayload`), путь апрувов переигрывает уже собранный. Здесь же в
 * `dispatchAndAudit` уходит объект, который целиком написала модель, а её
 * промпт содержит текст упавшего действия дословно. Три предыдущих аудита
 * закрыли гейт, личность исполнителя и лимиты — форму payload не закрыл никто.
 *
 * Что именно ломалось:
 *  - `createdBy` — `dispatch/tasks.ts:110` читает `payload.createdBy ??
 *    ctx.agentKey`, а `buildPayload` для CREATE_TASK жёстко ставит
 *    `createdBy: ctx.agentKey` и модели этого поля не отдаёт. Значит здесь
 *    модель назначала автора задачи. Дальше — отмывание полномочий: поллер
 *    берёт авторитет из `task.created_by` (см. gateFor ниже), и задача,
 *    подписанная «orchestrator», исполняется с правами оркестратора, включая
 *    CALLER_RESTRICTED-действия вроде MAC_RUN_CLAUDE.
 *  - `inputPayload` — `buildPayload` его не эмитит вовсе; его пишет только
 *    доверенный код при создании диаг-задачи. Модель, положив туда
 *    `{"_diag":true,…}`, сама конструирует задачу, которую подберёт
 *    `listPendingDiagTasks` (LIKE '%"_diag":true%').
 *  - `_userId` — allow-list Mac-моста (`isUserAllowed` в `dispatch/mac.ts`).
 *    На тулзовом пути он форсированно берётся из триггера
 *    (`ctx.triggerUserId` в `tools-schema.ts`), здесь его называла модель.
 *  - `_diag` — маркер, по которому action-dispatch решает, спавнить ли диаг.
 *
 * Вырезаем до гейта, чтобы проверяли и исполняли ровно один и тот же объект.
 */
export const TRUSTED_ONLY_PAYLOAD_FIELDS = [
  "createdBy",
  "inputPayload",
  "_userId",
  "_diag",
] as const;

/** Убрать из payload поля доверенного слоя. Возвращает и список вырезанных. */
export function stripTrustedOnlyFields(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  dropped: string[];
} {
  const forbidden = TRUSTED_ONLY_PAYLOAD_FIELDS as readonly string[];
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (forbidden.includes(k)) dropped.push(k);
    else out[k] = v;
  }
  return { payload: out, dropped };
}

/** Parse aieng JSON response. Returns null on any failure. */
export function parseAiengResponse(text: string): AiengFixResponse | null {
  // Try to extract first JSON object from the text.
  const trimmed = text.trim();
  let candidate = trimmed;
  // Strip ```json ... ``` fences if present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidate = fence[1].trim();
  // Best-effort: find first { ... last }.
  if (!candidate.startsWith("{")) {
    const i = candidate.indexOf("{");
    const j = candidate.lastIndexOf("}");
    if (i >= 0 && j > i) candidate = candidate.slice(i, j + 1);
  }
  try {
    const obj = JSON.parse(candidate) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const r = obj as AiengFixResponse;
    if (r.giveup === true) return { giveup: true, reason: r.reason };
    if (!r.action || !ACTION_TYPE_SET.has(String(r.action))) return null;
    if (!r.payload || typeof r.payload !== "object") return null;
    return { action: r.action, payload: r.payload, reason: r.reason };
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are aieng — the AI/LLM engineer self-diagnostic subagent.
A tool action just FAILED. Inspect the failed action and error message, then
propose EITHER a corrected payload to retry the action, OR a different action,
OR give up.

Return STRICT JSON only, one of:
  {"action": "<ACTION_TYPE>", "payload": { ... }, "reason": "<short>"}
  {"giveup": true, "reason": "<short>"}

Rules:
- No prose outside JSON. No markdown fences.
- Use the same ACTION_TYPE as the failure unless a different action is clearly
  the right fix.
- Do NOT include the _diag or _retry_count fields in your proposed payload.
- If the error indicates a permission/approval/rate-limit issue, give up.
- If the error looks like a transient network glitch, propose the SAME payload
  unchanged to retry.
- Be terse in "reason" (one sentence).`;

export interface SelfDiagDeps {
  /**
   * Only needed when callAnthropicImpl is set (backward-compat test seam).
   * Production path uses runTextViaAgentSdk (subscription, not API key).
   */
  anthropic?: Anthropic | null;
  /** Only needed for callAnthropicImpl compat. */
  model?: string;
  /**
   * Builds the DispatchCtx for the retry. We need the telegram instance,
   * resolver and handoff deps from the orchestrator process.
   *
   * `agentKey` — роль, ЧЬИ полномочия проверял гейт; вернуть null, если её бот
   * сейчас не поднят (исполнять от чужого имени нельзя — см. комментарий у
   * вызова).
   */
  buildDispatchCtx: (args: {
    chatId: number;
    actionType: ActionType;
    agentKey: string;
  }) => DispatchCtx | null;
  /**
   * Production LLM call seam. Defaults to runTextViaAgentSdk (Claude subscription
   * path, uses CLAUDE_CODE_OAUTH_TOKEN — NOT ANTHROPIC_API_KEY). Provide this in
   * tests to avoid spawning a real Claude subprocess.
   */
  runTextImpl?: (system: string, prompt: string) => Promise<string>;
  /**
   * Backward-compat test seam: raw Anthropic API call. Superseded by runTextImpl.
   * Kept so existing tests that inject callAnthropicImpl continue to work.
   */
  callAnthropicImpl?: typeof callAnthropic;
  /**
   * Потолок ожидания ответа aieng, мс. По умолчанию
   * `SELF_DIAG_LLM_TIMEOUT_MS`. Отдельным полем — чтобы тест мог поставить
   * десятки миллисекунд и не ждать реальный дедлайн.
   */
  llmTimeoutMs?: number;
}

export interface SelfDiagPollerOpts {
  intervalMs?: number;
  /** Test seam: override deps. */
  deps: SelfDiagDeps;
}

export interface SelfDiagPollerHandle {
  stop: () => void;
  /** Test seam: run one tick synchronously. */
  tick: () => Promise<void>;
}

/**
 * Потолок, после которого diag-задача в `running` считается брошенной.
 *
 * Аудит 2026-08-21. `processDiagTask` переводит задачу в `running` ДО вызова
 * aieng (:404), а `listPendingDiagTasks` выбирает строго `status='pending'`.
 * Пока процесс жив, дыры нет: тик сериализован флагом `running`, и каждый
 * выход из `processDiagTask` пишет терминальный статус. Но kill процесса или
 * рестарт systemd ровно в этом окне оставляет задачу в `running` НАВСЕГДА:
 * поллер её больше не видит, единственный разрешённый ретрай сгорает, не
 * состоявшись, а через сутки `gcStaleTasks` (db-maint.ts) штампует
 * `failed / error='gc_stale'` — то есть в истории остаётся «зависла по
 * таймауту» вместо «прервана рестартом». Замер до фикса: два тика подряд по
 * задаче в `running` — ноль вызовов aieng, статус не меняется.
 *
 * Тот же класс, что и мост статусов в tasks.ts:400-415, но там окно
 * схлопывается транзакцией, а здесь между `running` и терминалом стоит вызов
 * модели — атомарным его не сделать. Значит нужен подбор осиротевших.
 *
 * 15 минут — с запасом от любого честного тика: сам вызов одношаговый, а
 * второго процесса, который мог бы держать задачу дольше, у прод-юнита нет.
 */
export const SELF_DIAG_STRANDED_MS = 15 * 60_000;

export interface RecoverStrandedOpts {
  /** Test seam: порог «сколько висеть, чтобы считаться брошенной», мс. */
  strandedMs?: number;
  /** Test seam: подмена «сейчас». */
  now?: number;
}

export interface RecoverStrandedResult {
  /** Вернулись в pending — будут подобраны этим же тиком. */
  requeued: string[];
  /** Исчерпали одну попытку восстановления — закрыты честной причиной. */
  failed: string[];
}

/**
 * Аудит 2026-08-29: подбор брошенных не отличал «умерла ДО отправки действия»
 * от «умерла ПОСЛЕ».
 *
 * Между `updateTaskStatus(task.id, "running")` и терминальной записью нет ни
 * одной долговечной отметки, а посередине стоит `dispatchAndAudit`. Задача,
 * пережившая рестарт юнита или выкатку `deploy.sh` внутри длинного вызова
 * (`GENERATE_IMAGE`, порезанный на куски `SEND_DOCUMENT`), возвращалась в
 * `pending` — и тем же тиком подбиралась заново: `tick()` зовёт
 * `listPendingDiagTasks` сразу после подбора. Побочный эффект повторялся:
 * второй пост в канал, второй документ, вторая платная картинка.
 *
 * Отметку ставим ровно перед отправкой. Дальше подбор такую задачу не
 * воскрешает, а закрывает честной причиной: узнать, долетело действие или нет,
 * неоткуда, а повтор побочного эффекта хуже несостоявшегося ретрая. Ретрай и
 * так разрешён ровно один.
 *
 * `_diag: true` переписываем явно: обе выборки — и подбора, и поллера — ищут
 * строку `"_diag":true` в JSON, и потерять её при перезаписи нельзя.
 */
export function markDiagDispatched(taskId: string, actionType: string): void {
  const row = db.prepare(`SELECT input FROM tasks WHERE id=?`).get(taskId) as
    | { input: string | null }
    | undefined;
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row?.input ?? "{}") as unknown;
    if (parsed && typeof parsed === "object") {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    // Нечитаемый input — отметка важнее сохранности мусора.
  }
  input._diag = true;
  input._diag_dispatched = actionType;
  db.prepare(`UPDATE tasks SET input=?, updated_at=? WHERE id=?`).run(
    JSON.stringify(input),
    Date.now(),
    taskId,
  );
}

/**
 * Возвращает брошенные diag-задачи из `running` обратно в `pending`.
 *
 * Счётчик `_diag_restarts` в input — страховка от петли: если задача сама и
 * убивает процесс (OOM на большом payload), второй подбор её не воскресит, а
 * закроет с причиной, которая так и написана. Один подбор — ровно столько,
 * сколько нужно, чтобы состоялся единственный разрешённый ретрай.
 *
 * `running` → `pending` FSM не разрешает (`running` — хаб к терминалам), и
 * штатному коду это правильно запрещать. Здесь санитар, как и `gcStaleTasks`:
 * пишем голым UPDATE'ом и объясняем это тут, а не расширяем FSM.
 */
export function recoverStrandedDiagTasks(
  opts: RecoverStrandedOpts = {},
): RecoverStrandedResult {
  const strandedMs = opts.strandedMs ?? SELF_DIAG_STRANDED_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - strandedMs;

  const rows = db
    .prepare(
      `SELECT id, input FROM tasks
       WHERE assigned_to = 'aieng' AND status = 'running'
         AND input LIKE '%"_diag":true%'
         AND updated_at < ?
       ORDER BY updated_at ASC
       LIMIT 20`,
    )
    .all(cutoff) as Array<{ id: string; input: string | null }>;

  const out: RecoverStrandedResult = { requeued: [], failed: [] };
  for (const row of rows) {
    let input: Record<string, unknown> = {};
    let parseFailed = false;
    try {
      const parsed = JSON.parse(row.input ?? "{}") as unknown;
      if (parsed && typeof parsed === "object") {
        input = parsed as Record<string, unknown>;
      } else {
        parseFailed = true;
      }
    } catch {
      parseFailed = true;
    }

    // Аудит 2026-08-29: раньше нечитаемый input оставляли как `{}` и всё равно
    // возвращали в pending — а запись затирала JSON целиком на
    // `{"_diag_restarts":1}`. Без `"_diag":true` строка не попадала уже ни в
    // одну выборку: ни в подбор, ни в поллер. Комментарий обещал, что «закроет
    // её второй проход по счётчику» — именно этого произойти и не могло, и
    // задача висела в pending до `gcStaleTasks`, который через сутки называл
    // её `gc_stale`. Исполнить её всё равно нельзя: processDiagTask читает из
    // того же input и actionType, и payload.
    if (parseFailed) {
      db.prepare(
        `UPDATE tasks SET status='failed', error=?, updated_at=? WHERE id=? AND status='running'`,
      ).run("self-diag: нечитаемый input задачи", now, row.id);
      out.failed.push(row.id);
      log.warn("[self-diag] нечитаемый input — задача закрыта", {
        task_id: row.id,
      });
      continue;
    }

    // Действие уже ушло в dispatchAndAudit — повторять его нельзя.
    if (input._diag_dispatched !== undefined) {
      db.prepare(
        `UPDATE tasks SET status='failed', error=?, updated_at=? WHERE id=? AND status='running'`,
      ).run(
        `self-diag: процесс умер после отправки ${String(input._diag_dispatched).slice(0, 40)} — повтор побочного эффекта не делаем`,
        now,
        row.id,
      );
      out.failed.push(row.id);
      log.warn("[self-diag] действие уже было отправлено — задачу не подбираем", {
        task_id: row.id,
        dispatched: input._diag_dispatched,
      });
      continue;
    }

    const restarts =
      typeof input._diag_restarts === "number" ? input._diag_restarts : 0;

    if (restarts >= 1) {
      db.prepare(
        `UPDATE tasks SET status='failed', error=?, updated_at=? WHERE id=? AND status='running'`,
      ).run(
        "self-diag: задача дважды осталась в running после перезапуска",
        now,
        row.id,
      );
      out.failed.push(row.id);
      log.warn("[self-diag] брошенная задача не подбирается второй раз", {
        task_id: row.id,
      });
      continue;
    }

    input._diag_restarts = restarts + 1;
    db.prepare(
      `UPDATE tasks SET status='pending', input=?, updated_at=? WHERE id=? AND status='running'`,
    ).run(JSON.stringify(input), now, row.id);
    out.requeued.push(row.id);
    log.warn(
      "[self-diag] задача осталась в running после перезапуска — вернули в pending",
      { task_id: row.id },
    );
  }
  return out;
}

function listPendingDiagTasks(limit = 5): Task[] {
  // Match aieng-assigned, pending tasks whose JSON input contains "_diag":true.
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE assigned_to = 'aieng' AND status = 'pending'
         AND input LIKE '%"_diag":true%'
       ORDER BY priority DESC, created_at ASC, rowid ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string;
      parent_id: string | null;
      depth: number;
      chat_id: number;
      created_by: string;
      assigned_to: string | null;
      title: string;
      description: string | null;
      status: import("./tasks.ts").TaskStatus;
      priority: number;
      deadline: number | null;
      input: string | null;
      output: string | null;
      error: string | null;
      created_at: number;
      updated_at: number;
    }>;
  return rows.map((row) => ({
    ...row,
    input: row.input ? safeParse(row.input) : null,
    output: row.output ? safeParse(row.output) : null,
  }));
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Разделение payload'а на «что делать» и «от чьего имени и на какой глубине».
 *
 * Соглашение по всему проекту: ключ с `_`-префиксом — контекст, который
 * подставляет вызывающий, а не участник диалога. `_userId`, `_depth`,
 * `_delegation_chain`, `_parent_*`, `_rerouted`, `_retry_count`, `_fix_chain`,
 * `_diag*`. Ни одно из них не описывает задачу — все описывают полномочия и
 * границы. Модель не должна их касаться; см. развёрнутый разбор у места
 * применения в `processDiagTask`.
 *
 * Пара функций, а не одна с флагом: на месте вызова видно оба слагаемых и то,
 * в каком порядке они накладываются.
 */
function withoutContextFields(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!payload || typeof payload !== "object") return out;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (!k.startsWith("_")) out[k] = v;
  }
  return out;
}

function contextFieldsOf(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!payload || typeof payload !== "object") return out;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (k.startsWith("_")) out[k] = v;
  }
  return out;
}

/**
 * Process a single diag task. Exported for tests.
 */
export async function processDiagTask(
  task: Task,
  deps: SelfDiagDeps,
): Promise<void> {
  const input = task.input as Partial<DiagInput> | null;
  if (!input || !input.actionType || !input.payload) {
    failTask(task.id, "diag task missing actionType/payload");
    return;
  }
  const actionType = input.actionType as ActionType;
  const failedPayload = input.payload as Record<string, unknown>;
  const failedError = input.error ?? task.error ?? "(no error recorded)";
  const retryCount =
    typeof input._retry_count === "number" ? input._retry_count : 0;

  // Already retried — skip and mark failed (cap = 1).
  if (retryCount >= 1) {
    failTask(task.id, "self-diag cap reached (retry_count >= 1)");
    return;
  }

  // Skip anything the gate doesn't outright allow: такие действия принадлежат
  // очереди апрувов, а не этому циклу.
  //
  // Аудит 2026-08-04: здесь стоял `getPermission(task.created_by, actionType)
  // .requires_approval`, и это было мимо по трём осям сразу. (1) Роль: права
  // считались для ИСХОДНОЙ роли, а исполняет ретрай `aieng` — у него своя
  // строка в permissions, а часто её нет вовсе. (2) Источник истины:
  // ALWAYS_APPROVE_ACTIONS живёт в КОДЕ гейта, а не в таблице, и миграция 038
  // сеет PUBLISH_TO_CHANNEL как requires_approval=0 — то есть проверка
  // пропускала публикацию в канал, для которой апрув обязателен. (2) Слои:
  // disabled-агент, CALLER_RESTRICTED, allowed=false и autonomy=locked не
  // проверялись вообще, потому что dispatchAndAudit гейт не зовёт.
  //
  // Считаем гейт для task.created_by — роли, чьи полномочия ретрай наследует
  // (createdBy: ctx.agentKey при заведении diag-таска). Для незнакомой строки
  // (например «miniapp:<uid>» у таска, заведённого через Mini App) permissions
  // строки не имеет, и гейт закрывается — так и надо.
  const preGate = gateFor(task.created_by, actionType, task.chat_id, failedPayload);
  if (preGate.decision !== "allow") {
    failTask(
      task.id,
      `skipped: gate says ${preGate.decision} (${preGate.reason ?? "no reason"}) — not eligible for self-diag retry`,
    );
    return;
  }

  // Skip rate-limit errors: anthropic-client / dispatcher will retry on its own.
  if (/429|rate.?limit/i.test(String(failedError))) {
    failTask(task.id, "skipped: rate-limit error (not eligible for self-diag retry)");
    return;
  }

  // Move to running.
  try {
    updateTaskStatus(task.id, "running");
  } catch (e) {
    log.error(`[self-diag] cannot move task ${task.id} to running`, { error: (e as Error)?.message });
    return;
  }

  // Build the aieng prompt.
  const userPrompt = `Action ${actionType} failed.

Error: ${failedError}

Original payload (JSON):
${JSON.stringify(failedPayload, null, 2)}

Propose either {"action","payload","reason"} or {"giveup":true,"reason":""}.
Return JSON only.`;

  const askAieng = async (): Promise<string> => {
    if (deps.runTextImpl) {
      // Preferred test seam — also used by any explicit override.
      return await deps.runTextImpl(SYSTEM_PROMPT, userPrompt);
    }
    if (deps.callAnthropicImpl) {
      // Backward-compat test seam: raw Anthropic API call.
      // deps.anthropic / model are guaranteed set when callAnthropicImpl is set.
      const resp = await deps.callAnthropicImpl(
        {
          model: deps.model ?? "claude-sonnet-4-6",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        },
        deps.anthropic!,
        "aieng",
      );
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    }
    // Production: subscription path (CLAUDE_CODE_OAUTH_TOKEN), NOT API key.
    // T-734: self-heal was calling callAnthropic (ANTHROPIC_API_KEY) which has
    // an empty credit balance on VPS — fixed by routing through Agent SDK.
    return await runTextViaAgentSdk({
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      agentKey: "aieng",
      maxTurns: 1,
    });
  };

  let respText: string;
  try {
    // Дедлайн общий для всех трёх веток, а не только для продовой: тестовый сим
    // с тем же успехом может не вернуться, а поведение поллера должно быть одно.
    respText = await withDeadline(
      askAieng(),
      deps.llmTimeoutMs ?? SELF_DIAG_LLM_TIMEOUT_MS,
    );
  } catch (e) {
    updateTaskStatus(task.id, "failed", {
      error: `aieng call failed: ${getErrorMessage(e)}`,
    });
    return;
  }

  const parsed = parseAiengResponse(respText);
  if (!parsed) {
    updateTaskStatus(task.id, "failed", {
      error: `aieng response not parseable as JSON: ${respText.slice(0, 200)}`,
    });
    return;
  }

  if (parsed.giveup) {
    updateTaskStatus(task.id, "done", {
      output: { giveup: true, reason: parsed.reason ?? "" },
    });
    return;
  }

  // Retry the action with the fixed payload. Carry _retry_count=1 so any
  // failure here will NOT spawn a fresh diag-task (see action-dispatch.ts).
  const retryAction = parsed.action as ActionType;
  // T-705b: carry forward the fix chain so a downstream failure can detect
  // the loop. Append a label noting that aieng proposed a retry.
  const parentChain = getFixChain(input);
  const retryChain = appendFixChain(
    parentChain,
    `retry:${retryAction}:${String(parsed.reason ?? "fix").slice(0, 40)}`,
  );
  // Аудит 2026-08-13, два фикса одного рубежа. Поля с `_`-префиксом — НЕ данные
  // модели: это метаданные доверия и защиты от циклов, которые штатный путь
  // подставляет из контекста сам — `_userId` (его и только его проверяет
  // whitelist MAC_USER_IDS, `dispatch/mac.ts`; подставляется в
  // `tools-schema.ts` из `ctx.triggerUserId`), `_depth` и `_delegation_chain`
  // (анти-луп T-705), `_parent_*`, `_rerouted`, `_diag*`.
  //
  // А здесь payload брался из ответа модели целиком. То есть модель НАЗНАЧАЛА
  // сама себе личность и глубину: упавший payload печатается ей же на 30 строк
  // выше вместе с `_userId` владельца, так что подставить валидный id — не
  // угадывание, а копия; `_depth: 0` в ответе обнуляет счётчик анти-лупа.
  //
  // Содержательную часть берём от модели, `_`-контекст — из упавшего payload:
  // он пришёл из реального действия и свой гейт уже проходил. Исключение —
  // MODEL_FORBIDDEN_PAYLOAD_FIELDS: `_userId` не восстанавливается ниоткуда.
  // Системный промпт разрешает модели предложить ДРУГОЕ действие ("OR a
  // different action"), поэтому перенос личности с упавшего SEND_MESSAGE на
  // предложенный MAC_RUN_CLAUDE — это ровно тот пропуск на машину владельца,
  // который здесь и закрывается. У автономного ретрая человека за спиной нет
  // по определению, и `isUserAllowed(undefined)` — правильный на это ответ.
  const restoredContext = contextFieldsOf(failedPayload);
  const modelContext = contextFieldsOf(parsed.payload);
  for (const field of MODEL_FORBIDDEN_PAYLOAD_FIELDS) {
    if (field in modelContext) {
      log.warn("[self-diag] модель сочинила поле полномочий — вычищено", {
        task_id: task.id,
        retry_action: retryAction,
        field,
      });
    }
    delete restoredContext[field];
  }
  // Четвёртый рубеж того же места, из #438: не весь доверенный слой носит
  // `_`-префикс. `createdBy` назначает автора задачи, `inputPayload` подменяет
  // вход — оба ставит доверенный код, и оба модель писала бы сама. Режем ДО
  // гейта: проверять и исполнять надо один и тот же объект.
  const content = stripTrustedOnlyFields(withoutContextFields(parsed.payload));
  if (content.dropped.length > 0) {
    log.warn("[self-diag] модель прислала поля доверенного слоя — вырезаны", {
      task_id: task.id,
      retry_action: retryAction,
      dropped: content.dropped,
    });
  }
  const retryPayload = {
    ...content.payload,
    ...restoredContext,
    _retry_count: 1,
    _fix_chain: retryChain,
  } as Record<string, unknown>;
  // Второй рубеж, и он же главный: до сюда проверено ЛИШЬ упавшее действие, а
  // диспатчится то, которое выбрала модель — системный промпт прямо разрешает
  // ей предложить другое ("OR a different action"). Без этой проверки любой
  // сбой любого негейтованного действия превращался в канал «модель называет
  // действие → оно исполняется без гейта», включая PUBLISH_TO_CHANNEL.
  // dispatchAndAudit гейт не зовёт по устройству, так что звать его обязан
  // вызывающий. Гейт идёт до сборки контекста: он ничего оттуда не берёт, а
  // его вердикт — более точный диагноз, чем «бота нет».
  const gate = gateFor(task.created_by, retryAction, task.chat_id, retryPayload);
  if (gate.decision !== "allow") {
    log.warn("[self-diag] предложенное действие не прошло гейт", {
      task_id: task.id,
      failed_action: actionType,
      retry_action: retryAction,
      authority: task.created_by,
      decision: gate.decision,
      reason: gate.reason,
    });
    updateTaskStatus(task.id, "failed", {
      error: `retry blocked by gate: ${gate.decision} (${gate.reason ?? "no reason"})`,
    });
    return;
  }

  // Аудит 2026-08-08: гейт выше спрашивал про полномочия `task.created_by`, а
  // контекст исполнения был жёстко зашит на aieng — то есть авторизовали одну
  // личность, а действовала другая. Расходилось всё сразу: бот-отправитель
  // (в чат пишет aieng вместо роли), ведро rate-limit (лимит роли не тратится,
  // тратится чужой), атрибуция в audit_logs и agent_actions (след ведёт к
  // aieng, хотя решение принималось за роль). Исполняем тем, кого проверили.
  const ctx = deps.buildDispatchCtx({
    chatId: task.chat_id,
    actionType: retryAction,
    agentKey: task.created_by,
  });
  if (!ctx) {
    // Бота этой роли сейчас нет. Подменять исполнителя на aieng — ровно тот
    // баг, что чинится выше, поэтому ретрай не делаем вовсе.
    log.warn("[self-diag] роль-заказчик не поднята — ретрай пропущен", {
      task_id: task.id,
      authority: task.created_by,
      retry_action: retryAction,
    });
    updateTaskStatus(task.id, "failed", {
      error: `retry skipped: bot for '${task.created_by}' is not running`,
    });
    return;
  }

  // Аудит 2026-08-09: третий рубеж — лимиты. dispatchAndAudit не содержит ни
  // строчки про rate-limit: их держит gateOrDispatch, а этот путь его минует
  // сознательно (гейт уже позван выше вручную). Итог: ретрай GENERATE_IMAGE
  // стоил очередные $0.04 и не касался ни одного ведра — ровно то, что
  // NO_REFUND_ACTIONS чинил с другой стороны. Единственной границей оставался
  // isDiagTaskThrottled (5 задач в час), то есть до 5 бесплатных картинок в
  // час мимо лимита «6/час на агента, 30/час суммарно».
  const reserveChat = checkAndConsumeChatRateLimits(
    ctx.botId,
    ctx.chatId,
    retryAction,
  );
  const reserve = reserveChat.ok
    ? checkAndConsumeRateLimit(ctx.agentKey, retryAction)
    : reserveChat;
  if (!reserve.ok) {
    if (reserveChat.ok) {
      refundChatRateLimits(
        ctx.botId,
        ctx.chatId,
        retryAction,
        Date.now(),
        reserveChat.reservedAt,
      );
    }
    log.info("[self-diag] ретрай упёрся в rate-limit", {
      task_id: task.id,
      retry_action: retryAction,
      agent: ctx.agentKey,
      reason: reserve.reason,
    });
    updateTaskStatus(task.id, "failed", {
      error: `retry rate limited: ${reserve.reason ?? "rate limited"}`,
    });
    return;
  }

  // Долговечная отметка «действие ушло» — до самой отправки. Всё, что между
  // ней и терминальной записью, для подбора брошенных означает «повторять
  // нельзя»; см. markDiagDispatched.
  markDiagDispatched(task.id, retryAction);

  let retryRes;
  try {
    retryRes = await dispatchAndAudit(
      retryAction,
      retryPayload as PayloadFor<typeof retryAction>,
      ctx,
    );
  } catch (e) {
    // Аудит 2026-08-29: снимаем отметки собственных резерваций (см.
    // refundBucket) — ретрай ходит через LLM и легко переживает окно.
    refundRateLimit(ctx.agentKey, retryAction, Date.now(), reserve.reservedAt);
    refundChatRateLimits(
      ctx.botId,
      ctx.chatId,
      retryAction,
      Date.now(),
      reserveChat.reservedAt,
    );
    updateTaskStatus(task.id, "failed", {
      error: `retry threw: ${getErrorMessage(e)}`,
    });
    return;
  }
  if (!retryRes.ok && !retryRes.sideEffect) {
    // Тот же размен, что в gateOrDispatch: слот возвращается, кроме действий
    // из NO_REFUND_ACTIONS, где деньги списаны внутри dispatch'а.
    //
    // Аудит 2026-08-29: «тот же размен» было неправдой — здесь рефанд стоял
    // безусловно. На прямом пути (`action-dispatch.ts`, аудит 2026-08-21)
    // и через очередь одобрений (`commands.ts`, аудит 2026-08-28) провал,
    // уже оставивший след снаружи, не рефандится. Частичная доставка
    // (`sendChunked` бросает после k из N частей) приходит сюда обычным
    // `!ok` с `sideEffect: true`, и рефанд возвращал все три ведра за ход,
    // положивший в чат k сообщений — то есть счётчик флуда откатывался
    // ровно в тот момент, когда он и должен тормозить.
    refundRateLimit(ctx.agentKey, retryAction, Date.now(), reserve.reservedAt);
    refundChatRateLimits(
      ctx.botId,
      ctx.chatId,
      retryAction,
      Date.now(),
      reserveChat.reservedAt,
    );
  }

  if (retryRes.ok) {
    updateTaskStatus(task.id, "done", {
      output: {
        retried: true,
        action: retryAction,
        reason: parsed.reason ?? "",
        actionId: retryRes.actionId,
      },
    });
    log.info(
      `[self-diag] task ${task.id} → retry OK (${retryAction})`,
    );
  } else {
    updateTaskStatus(task.id, "failed", {
      error: `retry failed: ${retryRes.error}`,
    });
    log.info(
      `[self-diag] task ${task.id} → retry FAILED (${retryAction}): ${retryRes.error}`,
    );
  }
}

export function startSelfDiagPoller(
  opts: SelfDiagPollerOpts,
): SelfDiagPollerHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      // Сначала подбираем осиротевших: они не в `pending`, и без этого шага
      // выборка ниже их не увидит никогда (см. SELF_DIAG_STRANDED_MS).
      try {
        recoverStrandedDiagTasks();
      } catch (e) {
        log.warn("[self-diag] подбор брошенных задач не удался", {
          error: getErrorMessage(e),
        });
      }
      const tasks = listPendingDiagTasks(5);
      for (const t of tasks) {
        if (stopped) break;
        try {
          await processDiagTask(t, opts.deps);
        } catch (e) {
          log.error(`[self-diag] processDiagTask(${t.id}) crashed`, { error: (e as Error)?.message });
          try {
            // Задача здесь может быть в любом статусе: крах мог случиться и до
            // перехода в running. Прямой `failed` из pending FSM запрещает, и
            // задача оставалась pending — а выборка поллера берёт именно
            // pending, то есть она поднималась снова каждый тик, бесконечно.
            // failTask мостит путь по таблице переходов и молчит на уже
            // терминальной задаче (гонка с отменой владельцем).
            failTask(t.id, `poller crashed: ${getErrorMessage(e)}`);
          } catch (e2) {
            log.warn("self-diag: failed to mark task failed after poller crash", {
              e: String(e2),
              task_id: t.id,
            });
          }
        }
      }
    } finally {
      running = false;
    }
  }

  const handle = setInterval(() => {
    // Не `void tick()`: у tick есть finally, но нет catch, а первый же вызов в
    // нём — синхронное обращение к БД (listPendingDiagTasks). Заблокированная
    // или сломанная БД превращала тик в НЕОБРАБОТАННЫЙ reject, и он уходил в
    // глобальный process.on("unhandledRejection") из telegraf-patch — то есть
    // в лог падала строка `[unhandledRejection]` без модуля и без стека, по
    // которой не понять, что именно сломалось. Ловим здесь и логируем с
    // именем — ровно как health.ts.
    tick().catch((e) =>
      log.error("[self-diag] tick err", { error: getErrorMessage(e) }),
    );
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
    tick,
  };
}
