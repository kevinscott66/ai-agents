/**
 * Аудит 2026-08-28: счётчик заявок в дайджесте упирался в 1000.
 *
 * `buildDigest` печатал `pending: N`, где N — длина
 * `listPendingApprovals(undefined, 1000)`. То есть тысяча полных строк с JOIN
 * тянулась из БД ради `.length` и минимума по `created_at`, а сам счётчик
 * замирал на 1000 ровно тогда, когда очередь становится проблемой: в отчёте
 * владельцу «pending: 1000» и на тысяче заявок, и на пяти тысячах. Именно по
 * этой строке принимается решение разгребать очередь.
 *
 * Заявки в тестовой БД общие для всего прогона, поэтому считаем дельту от
 * фактического состояния, а не абсолют.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { buildDigest } from "../lib/digest.ts";
import {
  createApproval,
  listPendingApprovals,
  oldestPendingApprovalAt,
} from "../lib/approvals.ts";
import { db } from "../lib/db.ts";

const CHAT_ID = -100_900_930;
const EMPTY_CHAT = -100_900_931;
const SEEDED = 1002;

function pendingNow(): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`).get() as {
    n: number;
  };
  return r.n;
}

function seed(n: number): void {
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      createApproval({
        actionId: `act-cap-${i}`,
        chatId: CHAT_ID,
        requestedBy: `role${i % 12}`,
        actionType: "PUBLISH_TO_CHANNEL",
        payload: { text: `заявка ${i}` },
      });
    }
  })();
}

const clean = () => {
  db.prepare(`DELETE FROM approvals WHERE chat_id IN (?, ?)`).run(CHAT_ID, EMPTY_CHAT);
};
beforeEach(clean);
afterEach(clean);

describe("предпосылки", () => {
  test("прежнее выражение отдавало ровно потолок, а не размер очереди", () => {
    const before = pendingNow();
    seed(SEEDED);
    expect(pendingNow()).toBe(before + SEEDED);
    // Ровно эта величина и печаталась как `pending:`.
    expect(listPendingApprovals(undefined, 1000).length).toBe(1000);
  });
});

describe("buildDigest: Approvals", () => {
  test("счётчик показывает всю очередь, а не первую тысячу", () => {
    const before = pendingNow();
    seed(SEEDED);
    const text = buildDigest({ now: new Date() });
    expect(text).toContain(`pending: ${before + SEEDED}`);
  });

  test("возраст считается по самой старой заявке очереди", () => {
    seed(3);
    const row = db
      .prepare(`SELECT MIN(created_at) AS at FROM approvals WHERE status = 'pending'`)
      .get() as { at: number };
    // Делаем нашу заявку самой старой в БД, чтобы возраст не зависел от чужих.
    const oldest = row.at - 3 * 3600_000;
    db.prepare(`UPDATE approvals SET created_at = ? WHERE chat_id = ? LIMIT 1`).run(
      oldest,
      CHAT_ID,
    );
    const text = buildDigest({ now: new Date(oldest + 3 * 3600_000) });
    expect(text).toContain("oldest: 3h");
  });
});

describe("oldestPendingApprovalAt", () => {
  test("пустая очередь — null, а не 0", () => {
    expect(oldestPendingApprovalAt(EMPTY_CHAT)).toBeNull();
  });

  test("отдаёт минимум created_at по своему срезу", () => {
    seed(3);
    const rows = db
      .prepare(`SELECT created_at AS at FROM approvals WHERE chat_id = ?`)
      .all(CHAT_ID) as { at: number }[];
    const min = Math.min(...rows.map((r) => r.at));
    expect(oldestPendingApprovalAt(CHAT_ID)).toBe(min);
  });

  test("решённые заявки в расчёт не идут", () => {
    seed(2);
    db.prepare(`UPDATE approvals SET status = 'approved' WHERE chat_id = ?`).run(CHAT_ID);
    expect(oldestPendingApprovalAt(CHAT_ID)).toBeNull();
  });
});
