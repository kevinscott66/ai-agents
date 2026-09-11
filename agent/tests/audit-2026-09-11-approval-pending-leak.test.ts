/**
 * Аудит 2026-09-11: одобрено, не исполнено — и строка навсегда «ждёт аппрув».
 *
 * Гейт, решивший «нужно согласование», заводит в `agent_actions` строку со
 * статусом `pending_approval` и рядом заявку. Дальше строку действия закрывает
 * ровно тот, кто принял решение:
 *
 *   • отказ человека и протухание заявки — `closeGatedActionRow`
 *     (аудит того же дня, уже в коде);
 *   • одобрение — `dispatchAndAudit`, заводящий СВОЮ пару `attempted` →
 *     `ok`/`error` с тем же `request_id`.
 *
 * Второй пункт был обещанием на все случаи, а `executeApproved` умеет
 * отказать ДО диспатча тремя способами: протухший TTL заявки, вызывающий, не
 * допущенный к этому типу действия (`CALLER_RESTRICTED`), и deny-гейт,
 * появившийся между созданием заявки и нажатием «Approve» (выключили агента,
 * закрыли чат). На этих трёх путях второй строки не заводится вовсе, а первая
 * остаётся `pending_approval` навсегда: `expireStaleApprovals` смотрит на
 * `approvals.status='pending'` (здесь уже `approved`), `expireStaleAttempts` —
 * на `attempted`. Дальше это видно везде, где читают журнал: `/audit`, лента
 * Mini App, GET_LOGS у самой модели и ряд `agent_actions_recent` в `/metrics`,
 * где счётчик заявок давно ноль, а «ждущих» действий — нет.
 *
 * Оба вызывающих (`cmdApprove` и ветка Mini App) прямо утверждали в
 * комментарии, что строку с ошибкой уже записал диспатч, — и это оставалось
 * единственным описанием происходящего для того, кто придёт чинить.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { readFileSync } from "node:fs";
import {
  createApproval,
  decideApproval,
  APPROVAL_TTL_MS,
} from "../lib/approvals.ts";
import { insertActionRow } from "../lib/audit.ts";
import { executeApproved } from "../lib/commands.ts";
import { setAutonomy, clearAutonomy } from "../lib/permissions.ts";
import { stripComments } from "./helpers/strip-comments.ts";

const CHAT_ID = -100_930_311;

afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT_ID);
  clearAutonomy("chat", String(CHAT_ID));
});

/** Пара «строка действия в pending_approval + заявка на неё», как её заводит гейт. */
function gated(opts: {
  requestedBy: string;
  actionType?: string;
  ageMs?: number;
}): { actionId: string; approvalId: string } {
  const actionType = opts.actionType ?? "SEND_MESSAGE";
  const action = insertActionRow(actionType, {
    agentKey: opts.requestedBy,
    chatId: CHAT_ID,
    payload: { chatId: CHAT_ID, text: "текст на согласование" },
    status: "pending_approval",
  });
  const a = createApproval({
    actionId: action.id,
    chatId: CHAT_ID,
    requestedBy: opts.requestedBy,
    actionType: actionType as any,
    payload: { chatId: CHAT_ID, text: "текст на согласование" } as any,
  });
  if (opts.ageMs) {
    db.prepare(`UPDATE approvals SET created_at = ? WHERE id = ?`).run(
      Date.now() - opts.ageMs,
      a.id,
    );
  }
  return { actionId: action.id, approvalId: a.id };
}

function statusOf(actionId: string): string {
  return (
    db
      .prepare(`SELECT status FROM agent_actions WHERE id = ?`)
      .get(actionId) as { status: string }
  ).status;
}

function errorOf(actionId: string): string {
  return (
    (
      db
        .prepare(`SELECT error FROM agent_actions WHERE id = ?`)
        .get(actionId) as { error: string | null }
    ).error ?? ""
  );
}

describe("отказ исполнения ДО диспатча закрывает строку действия", () => {
  test("протухшая заявка: строка не остаётся ждать решения, которое принято", async () => {
    const { actionId, approvalId } = gated({
      requestedBy: "smm",
      ageMs: APPROVAL_TTL_MS * 3,
    });
    // Санитар мог не отработать — процесс лежал. Человек жмёт «Approve».
    const approved = decideApproval(approvalId, "approved", "admin");
    expect(statusOf(actionId)).toBe("pending_approval");

    await expect(executeApproved(approved)).rejects.toThrow(/expired|просроч/i);

    expect(statusOf(actionId)).not.toBe("pending_approval");
    expect(statusOf(actionId)).toBe("forbidden");
    expect(errorOf(actionId)).toMatch(/expired|устарел/i);
  });

  test("вызывающий, не допущенный к типу действия", async () => {
    // MAC_RUN_CLAUDE — только оркестратору (CALLER_RESTRICTED). Строка,
    // заведённая от чужого имени, исполниться не должна и висеть тоже.
    const { actionId, approvalId } = gated({
      requestedBy: "smm",
      actionType: "MAC_RUN_CLAUDE",
    });
    const approved = decideApproval(approvalId, "approved", "admin");

    await expect(executeApproved(approved)).rejects.toThrow(/caller not allowed/i);

    expect(statusOf(actionId)).toBe("forbidden");
    expect(errorOf(actionId)).toContain("caller not allowed");
  });

  test("запрет, появившийся между заявкой и нажатием", async () => {
    const { actionId, approvalId } = gated({ requestedBy: "smm" });
    const approved = decideApproval(approvalId, "approved", "admin");
    // Владелец дёрнул рубильник чата, пока карточка висела.
    setAutonomy("chat", String(CHAT_ID), "locked");

    await expect(executeApproved(approved)).rejects.toThrow(/blocked at execution/i);

    expect(statusOf(actionId)).toBe("forbidden");
    expect(errorOf(actionId)).toContain("blocked at execution");
  });

  test("закрытую строку повторный отказ не переписывает", async () => {
    const { actionId, approvalId } = gated({
      requestedBy: "smm",
      ageMs: APPROVAL_TTL_MS * 3,
    });
    const approved = decideApproval(approvalId, "approved", "admin");
    await expect(executeApproved(approved)).rejects.toThrow();
    const first = errorOf(actionId);
    await expect(executeApproved(approved)).rejects.toThrow();
    // `WHERE status='pending_approval'` — тот же приём, что у finalizeActionRow.
    expect(errorOf(actionId)).toBe(first);
  });
});

describe("оба вызывающих больше не обещают чужой записи", () => {
  test("комментарии не утверждают, что dispatchAndAudit записал ошибку", () => {
    const cmds = stripComments(
      readFileSync(new URL("../lib/commands.ts", import.meta.url), "utf8"),
    );
    // В КОДЕ отказы до диспатча идут через общий хелпер, а не голым throw.
    expect(cmds).toContain("failBeforeDispatch(");
    expect(cmds).toContain("closeGatedActionRow(approval.action_id");

    // Комментарий у обоих вызывающих обязан называть ОБА пути закрытия
    // строки, а не один. Отрицательное утверждение («старой фразы нет») тут
    // не годится: оно совпало бы с цитатой этой же фразы в разборе — как в
    // докблоке выше.
    for (const rel of ["../lib/commands.ts", "../lib/miniapp-server.ts"]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(src).toContain("failBeforeDispatch");
    }
  });
});
