/**
 * SHOP_REPAIR: агент сам запускает починку селекторов на Mac (этап 4 автономии).
 *
 * Когда SHOP_* второй раз подряд отвечает unexpected_page или price_unreadable,
 * вёрстка Яндекса, скорее всего, изменилась. Агент зовёт SHOP_REPAIR {service,
 * code}; сервер отвечает сразу («починка запущена»), а кадр `repair` уходит на
 * Mac (mac-daemon/selector-repair.ts). Там починщик правит файлы вёрстки в
 * отдельной ветке, демон проверяет список файлов и открывает PR. Мерж и выкатка
 * остаются за владельцем.
 *
 * Итог приходит через отложенную проверку (lib/followups.ts): через минуту после
 * ответа Mac сервер будит агента с задачей «сообщи владельцу: PR такой-то» —
 * тем же путём, что и любые «доделать позже».
 *
 * Границы.
 *  - Только оркестратор, только личка владельца, без делегирования —
 *    followupRefusal, те же условия, что у проверок: итог идёт ходом от имени
 *    владельца.
 *  - Одна починка одновременно; один сервис — не чаще раза в REPAIR_COOLDOWN_MS;
 *    не больше REPAIR_MAX_PER_DAY за сутки. Зацикленный агент упрётся в потолок,
 *    а не наплодит PR.
 *  - Строка 'running' старше REPAIR_STALE_MS — сервер перезапускали посреди
 *    починки, ответа Mac уже никто не ждёт: она становится 'failed'.
 */
import { db } from "./db.ts";
import { log } from "./log.ts";
import { getErrorMessage } from "./errors.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./time-constants.ts";
import { createFollowup, followupRefusal, type FollowupCaller } from "./followups.ts";
import { sendRepairToMac } from "./mac-bridge.ts";
import {
  parseRepairOutcome,
  parseRepairRequest,
  REPAIR_CODES,
  REPAIR_SERVICE_LABEL,
  REPAIR_SERVICES,
  type RepairOutcome,
  type RepairRequest,
} from "./selector-repair.ts";

export const REPAIR_COOLDOWN_MS = 12 * HOUR_MS;
export const REPAIR_MAX_PER_DAY = 3;
export const REPAIR_STALE_MS = 60 * MINUTE_MS;

export type RepairStatus = "running" | "done" | "failed" | "no_change";

export interface RepairRow {
  id: string;
  service: string;
  code: string;
  chat_id: number;
  user_id: string;
  status: RepairStatus;
  pr_url: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

type SendRepair = (req: RepairRequest, userId: string, chatId: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

let sendRepair: SendRepair = sendRepairToMac;
/** Для тестов: подменить отправку кадра на Mac. */
export function _setSendRepairForTests(fn: SendRepair | null): void {
  sendRepair = fn ?? sendRepairToMac;
}

export function getRepair(id: string): RepairRow | null {
  return (db.prepare(`SELECT * FROM selector_repairs WHERE id = ?`).get(id) as RepairRow | null) ?? null;
}

function expireStale(now: number): void {
  db.prepare(
    `UPDATE selector_repairs SET status = 'failed', error = 'stale', finished_at = ? WHERE status = 'running' AND created_at < ?`,
  ).run(now, now - REPAIR_STALE_MS);
}

/** Почему сейчас нельзя; null — можно. */
export function repairLimit(service: string, now: number): string | null {
  expireStale(now);
  const running = db.prepare(`SELECT service FROM selector_repairs WHERE status = 'running' LIMIT 1`).get() as { service: string } | null;
  if (running) return `починка ${running.service} уже идёт — её итог придёт сам, повторять не нужно`;
  const recent = db
    .prepare(`SELECT created_at FROM selector_repairs WHERE service = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`)
    .get(service, now - REPAIR_COOLDOWN_MS) as { created_at: number } | null;
  if (recent) return `починку ${service} уже запускали за последние 12 часов — скажи владельцу, что страница Яндекса изменилась, и жди его`;
  const today = (db.prepare(`SELECT COUNT(*) AS n FROM selector_repairs WHERE created_at >= ?`).get(now - DAY_MS) as { n: number }).n;
  if (today >= REPAIR_MAX_PER_DAY) return `за сутки уже ${today} починок (максимум ${REPAIR_MAX_PER_DAY}) — скажи владельцу, что страница Яндекса изменилась`;
  return null;
}

/** Задача для отложенной проверки: что сказать владельцу. До 300 символов, без свободного текста с Mac. */
export function repairFollowupTask(req: RepairRequest, outcome: RepairOutcome | null): string {
  const what = `починка селекторов ${REPAIR_SERVICE_LABEL[req.service]}`;
  if (!outcome) return `Сообщи владельцу: ${what} не дала ответа Mac. Повторять не надо; покупки ${REPAIR_SERVICE_LABEL[req.service]} пока могут сбоить.`;
  if (outcome.ok) {
    return `Сообщи владельцу: ${what} готова, PR ${outcome.pr_url} ждёт его мержа и выкатки. Сам не мержи. До выкатки покупки могут сбоить.`;
  }
  if (outcome.code === "repair_no_change") {
    return `Сообщи владельцу: ${what} ничего не поменяла — селекторы на месте. Повтори исходную покупку один раз; не вышло — пришли владельцу скриншот.`;
  }
  return `Сообщи владельцу: ${what} не удалась (${outcome.code}). Повторять не надо; покупки ${REPAIR_SERVICE_LABEL[req.service]} пока могут сбоить.`;
}

function finish(row: RepairRow, req: RepairRequest, outcome: RepairOutcome | null, error: string | null): void {
  const status: RepairStatus = outcome?.ok ? "done" : outcome?.code === "repair_no_change" ? "no_change" : "failed";
  db.prepare(`UPDATE selector_repairs SET status = ?, pr_url = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'`).run(
    status,
    outcome?.ok ? outcome.pr_url : null,
    outcome && !outcome.ok ? outcome.code : error,
    Date.now(),
    row.id,
  );
  const made = createFollowup({
    chatId: row.chat_id,
    userId: row.user_id,
    agentKey: "orchestrator",
    task: repairFollowupTask(req, outcome),
    inMin: 1,
  });
  if (!made.ok) log.warn("[shop-repair] итог не поставлен в проверку", { id: row.id, error: made.error });
}

export async function runRepairInBackground(row: RepairRow, req: RepairRequest): Promise<void> {
  try {
    const res = await sendRepair(req, row.user_id, row.chat_id);
    const outcome = parseRepairOutcome(res.stdout);
    finish(row, req, outcome, outcome ? null : "bad_outcome");
  } catch (e) {
    const msg = getErrorMessage(e).slice(0, 200);
    log.warn("[shop-repair] починка не дошла до итога", { id: row.id, error: msg });
    finish(row, req, null, msg);
  }
}

export function shopRepairTool(
  input: Record<string, unknown>,
  ctx: FollowupCaller,
  now = Date.now(),
): { ok: boolean } & Record<string, unknown> {
  const refusal = followupRefusal(ctx);
  if (refusal) return { ok: false, error: refusal.replace("отложенные проверки", "починка селекторов") };
  const req = parseRepairRequest(input);
  if (!req) return { ok: false, error: `service — ${REPAIR_SERVICES.join("|")}, code — ${REPAIR_CODES.join("|")}` };
  const limit = repairLimit(req.service, now);
  if (limit) return { ok: false, error: limit };
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO selector_repairs (id, service, code, chat_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  ).run(id, req.service, req.code, ctx.chatId, ctx.triggerUserId!, now);
  void runRepairInBackground(getRepair(id)!, req);
  return {
    ok: true,
    started: true,
    id,
    note: "починка запущена на Mac, займёт до 40 минут; итог придёт сам — сервер разбудит тебя. Скажи владельцу одной фразой, что чинишь, и не повторяй вызов. Мерж PR — за владельцем.",
  };
}
