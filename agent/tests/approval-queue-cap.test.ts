/**
 * Аудит 2026-08-14: постановка действия в очередь одобрения не стоила агенту
 * ничего. `gateOrDispatch` возвращается на ветке `approval` раньше, чем
 * резервирует слот rate-limit'а (проверка наверху ничего не тратит), а слот
 * списывается только в `executeApproved` — то есть после нажатия человека,
 * которого может не быть.
 *
 * Замер до правки: 60 подряд гейтованных действий одной роли — 60 заявок в
 * очереди, `listPendingApprovals()` (двадцать САМЫХ СТАРЫХ) отдаёт только их,
 * заявка другой роли в выдачу не попадает вовсе.
 */
import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { db } from "../lib/db.ts";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import {
  listPendingApprovals,
  countPendingApprovals,
  maxPendingApprovals,
  MAX_PENDING_APPROVALS,
} from "../lib/approvals.ts";
import { setPermission } from "../lib/permissions.ts";

const CHAT = -100777;
const ctx = (agentKey: string) => ({ agentKey, chatId: CHAT, botId: "bot-test" });

/** Действие, гейтованное на одобрение для конкретной роли. */
function gateOn(agentKey: string): void {
  setPermission(agentKey, "EDIT_MESSAGE", { allowed: true, requires_approval: true });
}

async function queue(agentKey: string, text: string) {
  return await gateOrDispatch(
    "EDIT_MESSAGE",
    { chatId: CHAT, messageId: 1, text } as never,
    ctx(agentKey) as never,
  );
}

const savedEnv = process.env.MAX_PENDING_APPROVALS;

/**
 * Таблица permissions между тестами НЕ сбрасывается (_setup.ts чистит только
 * лимиты и autonomy_modes), а удаление строки — не сброс: getPermission на
 * отсутствующей строке возвращает `{allowed:false}`, то есть другое поведение.
 * Поэтому снимок и восстановление, а не DELETE.
 */
type PermRow = { allowed: number; requires_approval: number };
const savedPerms = new Map<string, PermRow | null>();

beforeEach(() => {
  db.prepare(`DELETE FROM approvals`).run();
  for (const key of ["smm", "copy"]) {
    if (!savedPerms.has(key)) {
      savedPerms.set(
        key,
        (db
          .prepare(
            `SELECT allowed, requires_approval FROM permissions
              WHERE agent_key=? AND action_type='EDIT_MESSAGE'`,
          )
          .get(key) as PermRow | undefined) ?? null,
      );
    }
    gateOn(key);
  }
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MAX_PENDING_APPROVALS;
  else process.env.MAX_PENDING_APPROVALS = savedEnv;
});

afterAll(() => {
  for (const [key, row] of savedPerms) {
    if (row) {
      db.prepare(
        `UPDATE permissions SET allowed=?, requires_approval=?
          WHERE agent_key=? AND action_type='EDIT_MESSAGE'`,
      ).run(row.allowed, row.requires_approval, key);
    } else {
      db.prepare(
        `DELETE FROM permissions WHERE agent_key=? AND action_type='EDIT_MESSAGE'`,
      ).run(key);
    }
  }
});

describe("предел очереди одобрений", () => {
  test("до предела заявки создаются как обычно", async () => {
    process.env.MAX_PENDING_APPROVALS = "5";
    for (let i = 0; i < 5; i++) {
      const res = await queue("smm", `правка ${i}`);
      expect(res.kind).toBe("pending_approval");
    }
    expect(countPendingApprovals("smm")).toBe(5);
  });

  test("на пределе следующая заявка отбивается с внятной причиной", async () => {
    process.env.MAX_PENDING_APPROVALS = "5";
    for (let i = 0; i < 5; i++) await queue("smm", `правка ${i}`);

    const res = await queue("smm", "лишняя");

    expect(res.kind).toBe("error");
    expect((res as { error: string }).error).toContain("очередь одобрений переполнена");
    expect((res as { error: string }).error).toContain("smm");
    // Отказ записан в аудит: у ответа есть actionId.
    expect((res as { actionId?: string }).actionId).toBeTruthy();
    // И, главное, лишняя заявка в очередь не попала.
    expect(countPendingApprovals("smm")).toBe(5);
  });

  test("предел на роль, а не на таблицу: соседняя роль не заперта", async () => {
    process.env.MAX_PENDING_APPROVALS = "3";
    for (let i = 0; i < 3; i++) await queue("smm", `правка ${i}`);
    expect((await queue("smm", "лишняя")).kind).toBe("error");

    const other = await queue("copy", "правка copy");

    expect(other.kind).toBe("pending_approval");
    expect(countPendingApprovals("copy")).toBe(1);
  });

  test("замер из находки: заявка второй роли видна в выдаче, а не вытеснена", async () => {
    process.env.MAX_PENDING_APPROVALS = "10";
    for (let i = 0; i < 60; i++) await queue("smm", `спам ${i}`);
    await queue("copy", "важная правка");

    // listPendingApprovals — двадцать самых старых. До правки все двадцать
    // были бы от smm.
    const visible = listPendingApprovals(CHAT);
    expect(visible.length).toBeLessThanOrEqual(20);
    expect(visible.some((a) => a.requested_by === "copy")).toBe(true);
    expect(countPendingApprovals("smm")).toBe(10);
  });

  test("решённые заявки освобождают место — предел про очередь, а не про историю", async () => {
    process.env.MAX_PENDING_APPROVALS = "3";
    for (let i = 0; i < 3; i++) await queue("smm", `правка ${i}`);
    expect((await queue("smm", "лишняя")).kind).toBe("error");

    db.prepare(
      `UPDATE approvals SET status='approved', decided_by='owner', decided_at=?
        WHERE id = (SELECT id FROM approvals WHERE requested_by='smm' AND status='pending'
                    ORDER BY created_at ASC LIMIT 1)`,
    ).run(Date.now());

    expect((await queue("smm", "после решения")).kind).toBe("pending_approval");
  });

  test("счётчик считает только pending и только свою роль", async () => {
    process.env.MAX_PENDING_APPROVALS = "10";
    await queue("smm", "одна");
    await queue("copy", "две");
    db.prepare(`UPDATE approvals SET status='rejected' WHERE requested_by='copy'`).run();

    expect(countPendingApprovals("smm")).toBe(1);
    expect(countPendingApprovals("copy")).toBe(0);
  });
});

describe("форма правки", () => {
  test("предел по умолчанию — 10, кривой env не обнуляет очередь", () => {
    delete process.env.MAX_PENDING_APPROVALS;
    expect(maxPendingApprovals()).toBe(MAX_PENDING_APPROVALS);
    for (const bad of ["0", "-5", "abc", ""]) {
      process.env.MAX_PENDING_APPROVALS = bad;
      expect(maxPendingApprovals()).toBe(MAX_PENDING_APPROVALS);
    }
  });

  test("env читается при обращении, а не на импорте", () => {
    process.env.MAX_PENDING_APPROVALS = "42";
    expect(maxPendingApprovals()).toBe(42);
    process.env.MAX_PENDING_APPROVALS = "7";
    expect(maxPendingApprovals()).toBe(7);
  });
});
