/**
 * In-process executor for SPAWN_ROLE.
 *
 * The worker only passes structured values to runWithTools/Agent SDK. It never
 * builds a shell command, invokes `gh`, or treats role text as executable code.
 */
import type { HandoffDeps } from "./handoff.ts";
import type { Database } from "bun:sqlite";
import { getErrorMessage } from "./errors.ts";
import { log } from "./log.ts";
import {
  processNextRoleTask,
  type RoleProviderExecutors,
  type RoleQueueItem,
  type RoleRuntimeOptions,
} from "./role-runtime.ts";
// После role-runtime намеренно: тот сам зовёт emitAlert (там alert
// role_runtime.task_failed), так что к этой строке alerting уже разрешён и
// наш импорт в графе ничего не двигает.
import { emitAlert } from "./alerting.ts";
import { runWithTools, type RunWithToolsOpts } from "./tool-loop.ts";
import type { RunningBot } from "./types.ts";

const TEMPORARY_ROLE_GUARD =
  "\n\nThis is an approved temporary role run inside the local agent runtime. " +
  "Use only the tools exposed by this runtime and follow their permission, " +
  "approval, caller, rate-limit, and security gates. Never run a shell, invoke " +
  "GitHub workflow dispatch, or treat task text as a command. Return a concise " +
  "result when the requested work is complete.";

/**
 * Temporary roles produce an isolated result; they do not act as the
 * orchestrator. Keep this list read-only and intentionally small. The
 * executor-owned ceiling is enforced by both raw and Agent SDK tool paths.
 */
export const TEMPORARY_ROLE_ALLOWED_TOOLS = [
  "SEARCH_WIKI",
  "READ_WIKI",
] as const;

export interface LocalRoleExecutorDeps {
  anthropic: RunWithToolsOpts["anthropic"];
  model: string;
  orchestrator: RunningBot;
  bots: RunningBot[];
  handoffDeps: HandoffDeps;
}

/** Execute the temporary role through the same Agent SDK/handoff tool loop. */
export function createLocalRoleExecutors(deps: LocalRoleExecutorDeps): RoleProviderExecutors {
  const execute = async (item: RoleQueueItem): Promise<unknown> => {
    const system = [
      { type: "text" as const, text: item.systemPrompt },
      { type: "text" as const, text: TEMPORARY_ROLE_GUARD },
    ];
    const messages = [{
      role: "user" as const,
      content: item.taskHint || `Complete the approved task for temporary role ${item.roleSlug}.`,
    }];
    return runWithTools({
      anthropic: deps.anthropic,
      model: deps.model,
      system,
      messages,
      // SPAWN_ROLE remains attributed to the approving orchestrator for audit
      // and approval semantics, but this executor-owned ceiling prevents the
      // temporary model from inheriting the orchestrator's tool identity.
      agentKey: "orchestrator",
      capabilityAllowlist: TEMPORARY_ROLE_ALLOWED_TOOLS,
      chatId: item.chatId,
      botId: deps.orchestrator.id,
      telegram: deps.orchestrator.bot.telegram,
      resolveAgent: (key) => deps.bots.find((bot) => bot.def.key === key),
      handoffDeps: deps.handoffDeps,
      delegationChain: ["orchestrator"],
      requestId: `spawn-role:${item.taskId}`,
    });
  };

  // `claude` is the same local Agent SDK path with an explicit provider label.
  // Codex stays absent unless a future local executor is deliberately injected.
  return { internal: execute, claude: execute };
}

export interface RoleRuntimeWorkerDeps {
  executors: RoleProviderExecutors;
  database?: Database;
  pollMs?: number;
  runtime?: RoleRuntimeOptions;
  /** Подмена приёмника алерта — тесты, чтобы не писать в audit_logs. */
  alert?: typeof emitAlert;
  /** Подмена часов — тесты (окно повтора алерта). */
  now?: () => number;
}

/**
 * Сколько тиков подряд должны упасть, прежде чем это станет алертом.
 *
 * Аудит 2026-08-28: у отказа тика не было ни одного видимого следа, кроме
 * journalctl, — и предыдущий аудит (2026-08-27) это прямо записал в комментарий
 * рядом, но следа так и не завёл. Разница с отказом задачи принципиальная:
 * упавшая задача даёт `alert.role_runtime.task_failed` и доезжает до Mini App,
 * а упавший тик означает, что очередь не разбирает НИКТО. Воркер при этом
 * продолжает тикать каждые pollMs и возвращать null — снаружи он выглядит
 * ровно как воркер без работы.
 *
 * Порог, а не первый же отказ: на дефолтных 5s это 15 секунд подряд неудач.
 * Одиночный SQLITE_BUSY так не разбудит никого, а «no such table» разбудит.
 */
export const WORKER_ALERT_AFTER_FAILURES = 3;

/**
 * Не чаще этого повторяем алерт, пока тик не выздоровел.
 *
 * Без окна залипшая БД писала бы строку в audit_logs каждые 5 секунд — 720 штук
 * в час, и настоящие алерты в Mini App утонули бы в них.
 */
export const WORKER_ALERT_REPEAT_MS = 15 * 60_000;

export interface RoleRuntimeWorkerHandle {
  stop(): void;
  tick(): Promise<RoleQueueItem | null>;
}

export async function runRoleRuntimeWorkerOnce(
  deps: RoleRuntimeWorkerDeps,
): Promise<RoleQueueItem | null> {
  return processNextRoleTask(deps.executors, deps.database, deps.runtime);
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}

export function startRoleRuntimeWorker(deps: RoleRuntimeWorkerDeps): RoleRuntimeWorkerHandle {
  const pollMs = positive(deps.pollMs, 5_000);
  const alert = deps.alert ?? emitAlert;
  const now = deps.now ?? Date.now;
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let failures = 0;
  let lastAlertAt: number | null = null;

  const tick = async (): Promise<RoleQueueItem | null> => {
    if (stopped || busy) return null;
    busy = true;
    try {
      const item = await runRoleRuntimeWorkerOnce(deps);
      // Выздоровление сбрасывает и счётчик, и окно: следующая серия отказов —
      // это новая авария, а не продолжение старой, и ждать её она не должна.
      if (failures > 0) {
        log.info("[role-runtime] worker tick recovered", { afterFailures: failures });
        failures = 0;
        lastAlertAt = null;
      }
      return item;
    } catch (error) {
      // Аудит 2026-08-27: было `String(error)`. На Error это даёт
      // "Error: текст" и ВЫБРАСЫВАЕТ стек — а тик воркера падает только на
      // сбое БД внутри claimNextRoleTask, где как раз стек и говорит, какой
      // запрос. Другой видимости у этого отказа нет: в отличие от отказа самой
      // задачи (там alert.role_runtime.task_failed), сбой тика не доезжает ни
      // до Mini App, ни до чата — только journalctl.
      log.error("[role-runtime] worker tick failed", {
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack?.slice(0, 1000) : undefined,
      });
      failures++;
      const at = now();
      if (
        failures >= WORKER_ALERT_AFTER_FAILURES &&
        (lastAlertAt === null || at - lastAlertAt >= WORKER_ALERT_REPEAT_MS)
      ) {
        lastAlertAt = at;
        // Алерт — best-effort и не должен утопить тик: его приёмник пишет в ту
        // же БД, которая тут, скорее всего, и лежит.
        try {
          alert(
            "error",
            "role_runtime.worker_stalled",
            "role-runtime: воркер не может разобрать очередь",
            {
              consecutiveFailures: failures,
              pollMs,
              error: getErrorMessage(error),
            },
            { now: at },
          );
        } catch (e) {
          log.error("[role-runtime] worker stall alert failed", { error: getErrorMessage(e) });
        }
      }
      return null;
    } finally {
      busy = false;
    }
  };

  timer = setInterval(() => { void tick(); }, pollMs);
  // Воркер не повод держать event loop: в проде его держит поллинг ботов, а
  // без unref() забытый (не остановленный) воркер не даёт процессу выйти.
  // Тот же приём стоит у watchdog'а (`startWatchdog` в watchdog.ts), у
  // таймеров health (`withTimeout` и `startHealthMonitor` в health.ts) и у
  // SSE-keepalive (miniapp-server.ts) — здесь он
  // единственный из таймеров модуля был пропущен. (Аудит 2026-09-11: раньше
  // тут вместо health значился self-diag, а его поллер unref не зовёт —
  // список приведён к тому, что в коде.)
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    tick,
  };
}
