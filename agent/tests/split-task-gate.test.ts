/**
 * SPLIT_TASK не должен быть вторым входом в делегирование мимо гейта
 * (аудит 2026-08-12).
 *
 * Ветка SPLIT_TASK в action-dispatch.ts фанилась по ролям вызовом
 * `dispatchAction("DELEGATE_TO_ROLE", …)` — то есть сырого исполнителя.
 * Всё, что делает делегирование легальным, лежит слоем выше, в
 * gateOrDispatch: checkPerChatRateLimit / checkPerBotPerChatRateLimit /
 * checkRateLimit, payloadForcesApproval, evaluateGate и строка в
 * agent_actions. Ни одна из этих проверок для детей не выполнялась.
 *
 * Ни SPLIT_TASK, ни DELEGATE_TO_ROLE не входят в ROLE_EXPOSED_TOOLS, то есть
 * оба открыты каждой роли. Значит владелец, отобравший у роли право
 * делегировать (allowed=0) или потребовавший на него одобрения
 * (requires_approval=1), не отбирал ничего: та же роль вызывала SPLIT_TASK и
 * получала N делегирований — N объявлений «→ роль: задача» в чат и N полных
 * оплаченных LLM-ходов — без единого запроса на одобрение, без учёта в
 * рейт-лимитах и без единой строки в аудите. По журналу видно один SPLIT_TASK
 * и ноль делегирований.
 *
 * single-gate-invariant.test.ts эту дыру не ловит: он структурный, по местам
 * вызова evaluateGate, и целиком вносит action-dispatch.ts в белый список.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { dispatchAndAudit } from "../lib/action-dispatch.ts";
import { setPermission } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const TEST_CHAT = 999_806_121;

type ActionRow = { action_type: string; status: string };

function actionsInChat(): ActionRow[] {
  return db
    .prepare(
      `SELECT action_type, status FROM agent_actions WHERE chat_id = ? ORDER BY created_at`,
    )
    .all(TEST_CHAT) as ActionRow[];
}

function cleanup(): void {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(TEST_CHAT);
}

// Через общий хелпер, а не `getPermission` + обратная запись: DELEGATE_TO_ROLE
// не входит в шесть действий, засеянных миграцией 007, — то есть строки у
// qa могло не быть вовсе. `getPermission` на пустом месте отдаёт
// `{allowed:false}`, и обратная запись СОЗДАВАЛА бы явный запрет там, где был
// дефолт. `savePermissions` снимает наличие строки отдельно. T-751.
let restorePerms: () => void;

beforeEach(() => {
  restorePerms = savePermissions([["qa", "DELEGATE_TO_ROLE"]]);
  cleanup();
});

afterEach(() => {
  restorePerms();
  cleanup();
});

describe("SPLIT_TASK: дети проходят тот же гейт, что и прямое делегирование", () => {
  test("отобранное право DELEGATE_TO_ROLE отбирает и фан-аут сплита", async () => {
    setPermission("qa", "DELEGATE_TO_ROLE", {
      allowed: false,
      requires_approval: false,
    });

    const res = await dispatchAndAudit(
      "SPLIT_TASK",
      { title: "разложить на роли", roles: ["backend"] } as never,
      { agentKey: "qa", chatId: TEST_CHAT },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;

    // Ключевой признак: хендлер DELEGATE_TO_ROLE вообще не должен был
    // запуститься. Его собственная ранняя ошибка ("no resolveAgent in dispatch
    // ctx" — в тестовом ctx нет resolveAgent) означает, что управление до него
    // дошло, то есть гейт обошли.
    expect(res.error).not.toMatch(/no resolveAgent/);
  });

  test("каждое дочернее делегирование оставляет строку в agent_actions", async () => {
    setPermission("qa", "DELEGATE_TO_ROLE", {
      allowed: false,
      requires_approval: false,
    });

    await dispatchAndAudit(
      "SPLIT_TASK",
      { title: "две роли", roles: ["backend", "design"] } as never,
      { agentKey: "qa", chatId: TEST_CHAT },
    );

    // Раньше в журнале была ровно одна строка — сам SPLIT_TASK. Делегирования
    // исполнялись как будто их не было.
    const delegations = actionsInChat().filter(
      (r) => r.action_type === "DELEGATE_TO_ROLE",
    );
    expect(delegations.length).toBe(2);
    for (const d of delegations) expect(d.status).toBe("forbidden");
  });

  test("requires_approval на делегировании не обходится через сплит", async () => {
    setPermission("qa", "DELEGATE_TO_ROLE", {
      allowed: true,
      requires_approval: true,
    });

    await dispatchAndAudit(
      "SPLIT_TASK",
      { title: "через одобрение", roles: ["backend"] } as never,
      { agentKey: "qa", chatId: TEST_CHAT },
    );

    const rows = actionsInChat().filter(
      (r) => r.action_type === "DELEGATE_TO_ROLE",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("pending_approval");

    const approvals = db
      .prepare(
        `SELECT action_type FROM approvals WHERE chat_id = ? AND status = 'pending'`,
      )
      .all(TEST_CHAT) as { action_type: string }[];
    expect(approvals.map((a) => a.action_type)).toEqual(["DELEGATE_TO_ROLE"]);
  });
});
