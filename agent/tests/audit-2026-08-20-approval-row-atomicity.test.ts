/**
 * Аудит 2026-08-20: строка действия и строка заявки писались двумя коммитами.
 *
 * На ветке `gate.decision === "approval"` в `action-dispatch.ts` сначала шёл
 * `logAction({status: "pending_approval"})`, а следом — отдельной операцией —
 * `createApproval(...)`. Между ними процесс может быть убит (рестарт при
 * деплое, OOM), а INSERT в `approvals` — упасть сам по себе.
 *
 * Остаётся действие в статусе `pending_approval`, к которому не привязана ни
 * одна заявка. Подобрать его некому: `expireStaleApprovals` работает по
 * таблице `approvals` и такой строки не видит, `gcStaleTasks` трогает только
 * `tasks`, а санитайзера по `agent_actions.status='pending_approval'` в
 * `db-maint.ts` нет вовсе. Действие висит «на одобрении» вечно: в Mini App и в
 * диагностике оно показано как ждущее решения, а решить его невозможно —
 * решать нечего.
 *
 * Что атомарность здесь считалась важной, видно по соседнему блоку: T-314
 * специально резервирует бакеты «SYNCHRONOUSLY (no await between)». Про эту
 * пару не сказано ничего, то есть это пропуск, а не принятый компромисс.
 *
 * Инвариант: строк `pending_approval` без заявки не бывает — ни при успехе,
 * ни при сорванной записи заявки.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  gateOrDispatch,
  __setApprovalTransactionFaultForTests,
} from "../lib/action-dispatch.ts";
import { setPermission } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const TEST_CHAT = 999_806_220;
const AGENT = "qa";

function cleanup(): void {
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(TEST_CHAT);
}

/** Действия «на одобрении», под которыми нет заявки. */
function orphanedPending(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_actions a
        WHERE a.chat_id = ? AND a.status = 'pending_approval'
          AND NOT EXISTS (SELECT 1 FROM approvals p WHERE p.action_id = a.id)`,
    )
    .get(TEST_CHAT) as { n: number };
  return row.n;
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

describe("действие и заявка пишутся атомарно", () => {
  test("успешный путь: заявка есть у каждой pending-строки", async () => {
    const res = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "нужно одобрение" } as never,
      { agentKey: AGENT, chatId: TEST_CHAT },
    );

    expect(res.kind).toBe("pending_approval");
    expect(orphanedPending()).toBe(0);
  });

  test("сорванная запись заявки не оставляет вечно висящего действия", async () => {
    // Детерминированная замена SQLITE_FULL / SQLITE_BUSY / убитого процесса:
    // роняем середину единицы работы — после строки действия, до строки
    // заявки. Сбой берётся из штатного шва, а не из подмены `db.prepare`:
    // текст INSERT'а — деталь реализации, а инвариант проверяется здесь не он.
    __setApprovalTransactionFaultForTests(() => {
      throw new Error("database or disk is full");
    });

    let res: Awaited<ReturnType<typeof gateOrDispatch>>;
    try {
      res = await gateOrDispatch(
        "SEND_MESSAGE",
        { text: "заявка не запишется" } as never,
        { agentKey: AGENT, chatId: TEST_CHAT },
      );
    } finally {
      __setApprovalTransactionFaultForTests(null);
    }

    // До фикса: logAction уже закоммичен → 1 осиротевшая строка навсегда.
    // Теперь обе записи откатываются вместе, а вызывающий получает отказ —
    // не исключение наружу: ход агента продолжается, просто без заявки.
    expect({ kind: res.kind, orphans: orphanedPending() }).toEqual({
      kind: "error",
      orphans: 0,
    });
  });
});
