/**
 * CODE_TASK: агент ставит задачу на код, Mac пишет код и открывает PR
 * (самоулучшение, пункт 9). Формат задачи и границы правки — lib/code-task.ts,
 * исполнение — mac-daemon/code-task.ts.
 *
 * Сюда действие попадает уже одобренным: CODE_TASK стоит в
 * ALWAYS_APPROVE_ACTIONS, карточка показывает весь текст задачи. Хендлер
 * отвечает сразу («задача запущена»), а кадр `code_task` уходит на Mac в фоне.
 * Итог — отложенной проверкой (lib/followups.ts), как у починки селекторов:
 * через минуту после ответа Mac сервер будит агента с задачей «сообщи владельцу
 * ссылку на PR».
 *
 * Границы.
 *  - Только оркестратор, только по просьбе владельца (MINIAPP_ADMIN_USER_IDS)
 *    в его личке, не делегированием — как у USERBOT_SEND_DM и CLOUDFLARE_DNS.
 *  - Одна задача одновременно и не больше CODE_TASK_MAX_PER_DAY за сутки:
 *    зацикленный агент упрётся в потолок, а не наплодит PR.
 *  - Строка 'running' старше CODE_TASK_STALE_MS — сервер перезапускали посреди
 *    задачи, ответа Mac уже никто не ждёт: она становится 'failed'.
 */
import { db } from "./db.ts";
import { log } from "./log.ts";
import { getErrorMessage } from "./errors.ts";
import { DAY_MS, MINUTE_MS } from "./time-constants.ts";
import { parseUserIdList } from "./allowlist.ts";
import { createFollowup } from "./followups.ts";
import { sendCodeTaskToMac } from "./mac-bridge.ts";
import { parseCodeTask, parseCodeTaskOutcome, type CodeTask, type CodeTaskOutcome } from "./code-task.ts";
import type { PayloadByType } from "./action-payload.ts";
import type { HandlerResult } from "./dispatch/helpers.ts";

export const CODE_TASK_MAX_PER_DAY = 5;
export const CODE_TASK_STALE_MS = 70 * MINUTE_MS;

export type CodeTaskStatus = "running" | "done" | "failed" | "no_change";

export interface CodeTaskRow {
  id: string;
  title: string;
  chat_id: number;
  user_id: string;
  status: CodeTaskStatus;
  branch: string | null;
  pr_url: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

type SendCodeTask = (task: CodeTask, userId: string, chatId: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

let sendCodeTask: SendCodeTask = sendCodeTaskToMac;
/** Для тестов: подменить отправку кадра на Mac. */
export function _setSendCodeTaskForTests(fn: SendCodeTask | null): void {
  sendCodeTask = fn ?? sendCodeTaskToMac;
}

export function getCodeTask(id: string): CodeTaskRow | null {
  return (db.prepare(`SELECT * FROM code_tasks WHERE id = ?`).get(id) as CodeTaskRow | null) ?? null;
}

function expireStale(now: number): void {
  db.prepare(`UPDATE code_tasks SET status = 'failed', error = 'stale', finished_at = ? WHERE status = 'running' AND created_at < ?`).run(
    now,
    now - CODE_TASK_STALE_MS,
  );
}

/** Почему сейчас нельзя; null — можно. */
export function codeTaskLimit(now: number): string | null {
  expireStale(now);
  const running = db.prepare(`SELECT title FROM code_tasks WHERE status = 'running' LIMIT 1`).get() as { title: string } | null;
  if (running) return `задача «${running.title}» ещё идёт на Mac — её итог придёт сам, новую поставь после`;
  const today = (db.prepare(`SELECT COUNT(*) AS n FROM code_tasks WHERE created_at >= ?`).get(now - DAY_MS) as { n: number }).n;
  if (today >= CODE_TASK_MAX_PER_DAY) return `за сутки уже ${today} задач на код (максимум ${CODE_TASK_MAX_PER_DAY}) — скажи владельцу и жди завтра`;
  return null;
}

/** Задача для отложенной проверки: что сказать владельцу. Без свободного текста с Mac. */
export function codeTaskFollowupTask(title: string, outcome: CodeTaskOutcome | null): string {
  const what = `задача на код «${title.slice(0, 80)}»`;
  if (!outcome) return `Сообщи владельцу: ${what} не дала ответа Mac. Повторять не надо — спроси владельца.`;
  if (outcome.ok) {
    const tc = outcome.typecheck_ok === false ? " Проверка типов нашла ошибки — смотри CI." : "";
    return `Сообщи владельцу: ${what} готова, PR ${outcome.pr_url} ждёт его ревью и мержа.${tc} Сам не мержи.`;
  }
  if (outcome.code === "code_task_no_change") {
    return `Сообщи владельцу: ${what} ничего не поменяла — исполнитель не нашёл, что править, или задача неясна. Предложи уточнить формулировку.`;
  }
  if (outcome.code === "code_task_forbidden_paths") {
    return `Сообщи владельцу: ${what} задела файлы, которые исполнителю менять нельзя (${(outcome.changed ?? []).join(", ").slice(0, 60)}); PR не открыт. Такую правку владелец делает сам.`;
  }
  return `Сообщи владельцу: ${what} не удалась (${outcome.code}). Повторять не надо — спроси владельца.`;
}

function finish(row: CodeTaskRow, outcome: CodeTaskOutcome | null, error: string | null): void {
  const status: CodeTaskStatus = outcome?.ok ? "done" : outcome?.code === "code_task_no_change" ? "no_change" : "failed";
  db.prepare(`UPDATE code_tasks SET status = ?, branch = ?, pr_url = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'`).run(
    status,
    outcome?.branch ?? null,
    outcome?.ok ? outcome.pr_url : null,
    outcome && !outcome.ok ? outcome.code : error,
    Date.now(),
    row.id,
  );
  const made = createFollowup({
    chatId: row.chat_id,
    userId: row.user_id,
    agentKey: "orchestrator",
    task: codeTaskFollowupTask(row.title, outcome),
    inMin: 1,
  });
  if (!made.ok) log.warn("[code-task] итог не поставлен в проверку", { id: row.id, error: made.error });
}

export async function runCodeTaskInBackground(row: CodeTaskRow, task: CodeTask): Promise<void> {
  try {
    const res = await sendCodeTask(task, row.user_id, row.chat_id);
    const outcome = parseCodeTaskOutcome(res.stdout);
    finish(row, outcome, outcome ? null : "bad_outcome");
  } catch (e) {
    const msg = getErrorMessage(e).slice(0, 200);
    log.warn("[code-task] задача не дошла до итога", { id: row.id, error: msg });
    finish(row, null, msg);
  }
}

/**
 * Хендлер одобренного CODE_TASK. Гейт уже взял подтверждение; здесь то, что
 * гейт по payload не видит: кто просил и откуда, и потолки.
 */
export async function handleCodeTask(
  payload: PayloadByType["CODE_TASK"],
  ctx: { agentKey: string; chatId: number },
  now = Date.now(),
): Promise<HandlerResult> {
  if (ctx.agentKey !== "orchestrator") {
    return { ok: false, error: `forbidden: CODE_TASK is restricted to orchestrator (caller: ${ctx.agentKey})` };
  }
  const userId = payload._userId;
  const owners = parseUserIdList(process.env.MINIAPP_ADMIN_USER_IDS);
  if (payload._delegated === true || !userId || !owners.includes(Number(userId)) || String(ctx.chatId) !== userId) {
    return { ok: false, error: "forbidden: задачи на код — только по просьбе владельца в его личном чате" };
  }
  const task = parseCodeTask({ title: payload.title, goal: payload.goal });
  if (!task) return { ok: false, error: "invalid CODE_TASK payload" };
  const limit = codeTaskLimit(now);
  if (limit) return { ok: false, error: limit };
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO code_tasks (id, title, goal, chat_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`).run(
    id,
    task.title,
    task.goal,
    ctx.chatId,
    userId,
    now,
  );
  void runCodeTaskInBackground(getCodeTask(id)!, task);
  return {
    ok: true,
    result: {
      started: true,
      id,
      note: "задача запущена на Mac, займёт до 50 минут; итог придёт сам — сервер разбудит тебя. Скажи владельцу одной фразой, что задача ушла, и не повторяй вызов. Мерж PR — за владельцем.",
    },
  };
}
