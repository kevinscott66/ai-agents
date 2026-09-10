/**
 * Аудит 2026-09-11: решение по заявке не доходило до строки ДЕЙСТВИЯ.
 *
 * Гейт на ветке `gate.decision === "approval"` пишет `agent_actions` со
 * статусом `pending_approval` — и снимал его никто. Два единственных UPDATE по
 * этой таблице (`finalizeActionRow` в audit.ts, `expireStaleAttempts` в
 * db-maint.ts) сужены до `attempted`; отказ и протухание меняли только таблицу
 * `approvals`.
 *
 * Отсюда сценарий буднего дня, без всякого краша: smm просит
 * PUBLISH_TO_CHANNEL, владелец жмёт «Reject» — и строка действия НАВСЕГДА
 * читается «ждёт аппрув». В `/audit`, в ленте Mini App (`labels.ts:50`) и в
 * GET_LOGS, который читает сама модель: роль, переспросившая журнал «одобрили
 * мою публикацию?», видит ожидание вместо состоявшегося отказа, а человек —
 * очередь, которой в `/approvals` уже нет. То же с истечением TTL: санитар
 * переводит заявку в `expired`, действие остаётся ждущим.
 *
 * Докблок `action-dispatch.ts` (аудит 2026-08-20) описывает только вариант с
 * крашем МЕЖДУ двумя коммитами и прямо говорит, что санитайзера по
 * `pending_approval` нет вовсе, — то есть здесь не зафиксированный компромисс,
 * а пропуск.
 *
 * Одобрение сюда намеренно не входит: `executeApproved` идёт через
 * `dispatchAndAudit`, а тот заводит СВОЮ пару строк `attempted` → `ok`/`error`
 * с тем же `request_id`. Закрывать здесь ещё и её значило бы посчитать одно
 * действие дважды в одном статусе (см. докблок `closeGatedActionRow`).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import { closeGatedActionRow } from "../lib/audit.ts";
import { cmdReject } from "../lib/commands.ts";
import { expireStaleApprovals } from "../lib/db-maint.ts";
import { setPermission } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const TEST_CHAT = 999_809_110;
const AGENT = "qa";
const DECIDER = "tg:987654321 (@owner)";

function cleanup(): void {
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM approvals WHERE requested_by = ?`).run(AGENT);
}

/** Строка действия и её заявка, поставленные настоящим гейтом. */
async function queueOne(text: string): Promise<{ actionId: string; approvalId: string }> {
  const res = await gateOrDispatch(
    "SEND_MESSAGE",
    { text } as never,
    { agentKey: AGENT, chatId: TEST_CHAT },
  );
  if (res.kind !== "pending_approval") {
    throw new Error(`ожидали pending_approval, получили ${res.kind}`);
  }
  // Оба id возвращает сам гейт. Выбирать «последнюю pending» запросом нельзя:
  // два вызова подряд попадают в одну миллисекунду, и `ORDER BY created_at`
  // между ними не различает.
  return { actionId: res.actionId, approvalId: res.approvalId };
}

function actionRow(id: string): { status: string; error: string | null } {
  return db
    .prepare(`SELECT status, error FROM agent_actions WHERE id = ?`)
    .get(id) as { status: string; error: string | null };
}

let restorePerms: () => void;

beforeEach(() => {
  restorePerms = savePermissions([[AGENT, "SEND_MESSAGE"]]);
  cleanup();
  setPermission(AGENT, "SEND_MESSAGE", {
    allowed: true,
    requires_approval: true,
  });
});

afterEach(() => {
  restorePerms();
  cleanup();
});

describe("решение по заявке закрывает строку действия", () => {
  test("отказ снимает «ждёт аппрув»", async () => {
    const { actionId, approvalId } = await queueOne("уйдёт ли это наружу");
    expect(actionRow(actionId).status).toBe("pending_approval");

    const reply = cmdReject({
      approvalId,
      decidedBy: DECIDER,
      chatId: TEST_CHAT,
      reason: "не сейчас",
    });
    expect(reply).toContain("Rejected");

    const after = actionRow(actionId);
    expect(after.status).toBe("forbidden");
    // Строка отвечает на вопрос «почему наружу не ушло».
    expect(after.error).toContain("отклонено");
    expect(after.error).toContain("не сейчас");
  });

  test("отказ без причины тоже закрывает строку", async () => {
    const { actionId, approvalId } = await queueOne("без причины");
    cmdReject({ approvalId, decidedBy: DECIDER, chatId: TEST_CHAT });
    expect(actionRow(actionId).status).toBe("forbidden");
  });

  test("истечение TTL закрывает строку так же", async () => {
    const { actionId, approvalId } = await queueOne("протухнет");
    // Заявке — сутки с лишним: санитар ходит по `created_at`.
    const long = Date.now() - 30 * 60 * 60 * 1000;
    db.prepare(`UPDATE approvals SET created_at = ? WHERE id = ?`).run(long, approvalId);

    const res = expireStaleApprovals({ ttlMs: 24 * 60 * 60 * 1000 });
    expect(res.expired).toBeGreaterThanOrEqual(1);

    const after = actionRow(actionId);
    expect(after.status).toBe("forbidden");
    expect(after.error).toContain("просрочена");
  });

  test("ждущих строк после обоих путей не остаётся", async () => {
    const a = await queueOne("отказ");
    const b = await queueOne("протухание");
    cmdReject({ approvalId: a.approvalId, decidedBy: DECIDER, chatId: TEST_CHAT });
    db.prepare(`UPDATE approvals SET created_at = ? WHERE id = ?`).run(
      Date.now() - 30 * 60 * 60 * 1000,
      b.approvalId,
    );
    expireStaleApprovals({ ttlMs: 24 * 60 * 60 * 1000 });

    const stuck = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_actions
          WHERE chat_id = ? AND status = 'pending_approval'`,
      )
      .get(TEST_CHAT) as { n: number };
    expect(stuck.n).toBe(0);
  });

  test("уже закрытую строку второй раз не переписать", async () => {
    const { actionId, approvalId } = await queueOne("однократность");
    cmdReject({
      approvalId,
      decidedBy: DECIDER,
      chatId: TEST_CHAT,
      reason: "первое решение",
    });
    // `WHERE status='pending_approval'` — тот же приём, что у finalizeActionRow:
    // терминальную строку не перепишет ни повторное решение, ни санитар.
    expect(closeGatedActionRow(actionId, "второе решение")).toBe(false);
    expect(actionRow(actionId).error).toContain("первое решение");
  });

  test("строку в другом статусе не трогает вовсе", () => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO agent_actions(id, agent_key, chat_id, action_type, status, created_at)
       VALUES (?, ?, ?, 'SEND_MESSAGE', 'ok', ?)`,
    ).run(id, AGENT, TEST_CHAT, Date.now());
    expect(closeGatedActionRow(id, "мимо")).toBe(false);
    expect(actionRow(id).status).toBe("ok");
  });
});
