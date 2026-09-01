/**
 * Аудит 2026-08-20: `/approvals` молча обрезает список на двадцати.
 *
 * `listPendingApprovals` отдаёт `ORDER BY created_at ASC LIMIT 20`, а
 * cmdApprovals печатает ровно то, что пришло, — без единого признака, что
 * показано не всё. Потолок очереди — 10 нерешённых заявок НА РОЛЬ
 * (maxPendingApprovals), ролей двенадцать: в одном чате штатно копится до 120.
 *
 * Докблок самого потолка это следствие уже называет: «Сотня заявок одной роли
 * вытесняет из выдачи всех остальных на сутки — до срабатывания TTL». Правая
 * половина — сам потолок — сделана, левая нет: человек, глядя на ровно двадцать
 * строк, не может отличить «это вся очередь» от «это первая шестая её часть».
 * Невидимая заявка не будет решена и тихо истечёт по TTL.
 *
 * Инвариант: если показано не всё — в выдаче есть строка о том, сколько
 * заявок осталось за кадром.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cmdApprovals } from "../lib/commands.ts";
import { createApproval } from "../lib/approvals.ts";
import { db } from "../lib/db.ts";

const CHAT_ID = -100_900_920;
const OTHER_CHAT = -100_900_921;

function seed(n: number, chatId = CHAT_ID): void {
  for (let i = 0; i < n; i++) {
    createApproval({
      actionId: `act-trunc-${chatId}-${i}-${Math.random()}`,
      chatId,
      requestedBy: `role${i % 12}`,
      actionType: "PUBLISH_TO_CHANNEL",
      payload: { text: `пост номер ${i}` },
    });
  }
}

const clean = () => {
  db.prepare(`DELETE FROM approvals WHERE chat_id IN (?, ?)`).run(CHAT_ID, OTHER_CHAT);
};
beforeEach(clean);
afterEach(clean);

describe("cmdApprovals: видно, что список неполон", () => {
  test("при 25 заявках сказано, сколько осталось за кадром", () => {
    seed(25);
    const out = cmdApprovals({ chatId: CHAT_ID, args: [] });
    const shown = out.split("\n").filter((l) => l.includes("PUBLISH_TO_CHANNEL"));
    expect(shown.length).toBe(20);
    expect(out).toContain("ещё 5");
  });

  test("при 20 ровно — никакого хвоста", () => {
    seed(20);
    const out = cmdApprovals({ chatId: CHAT_ID, args: [] });
    expect(out.split("\n").filter((l) => l.includes("PUBLISH_TO_CHANNEL")).length)
      .toBe(20);
    expect(out).not.toContain("ещё");
  });

  test("счёт остатка чат-локальный: соседний чат его не раздувает", () => {
    seed(21);
    seed(30, OTHER_CHAT);
    const out = cmdApprovals({ chatId: CHAT_ID, args: [] });
    expect(out).toContain("ещё 1");
  });

  test("решённые заявки в остаток не попадают", () => {
    seed(25);
    // Половину «решили» — они уже не pending и в очереди не висят.
    db.prepare(
      `UPDATE approvals SET status = 'approved' WHERE chat_id = ? AND id IN (
         SELECT id FROM approvals WHERE chat_id = ? ORDER BY created_at DESC LIMIT 5
       )`,
    ).run(CHAT_ID, CHAT_ID);
    const out = cmdApprovals({ chatId: CHAT_ID, args: [] });
    expect(out).not.toContain("ещё");
  });

  test("пустая очередь — прежний ответ", () => {
    expect(cmdApprovals({ chatId: CHAT_ID, args: [] })).toBe("нет ожидающих approvals");
  });
});
