/**
 * Аудит 2026-08-14: `approvals` росла бесконечно — единственная таблица со
 * временем жизни «навсегда». Замер до правки (200 решённых заявок
 * PUBLISH_TO_CHANNEL возрастом 400 суток, прогон archiveOldRows + gcMessages +
 * expireStaleApprovals): было 200 → стало 200, 852 КБ, самой старой строке 400
 * дней. Здесь фиксируются оба свойства правки: старое решённое уезжает в архив,
 * незакрытое не уезжает никогда.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createApproval, getApproval } from "../lib/approvals.ts";
import {
  archiveOldRows,
  expireStaleApprovals,
  APPROVALS_SPEC,
  dbStats,
} from "../lib/db-maint.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** Заявка заданного возраста и статуса. */
function seed(opts: { ageDays: number; status: string; payload?: unknown }): string {
  const a = createApproval({
    actionId: `act-${crypto.randomUUID()}`,
    chatId: -100123,
    requestedBy: "smm",
    actionType: "PUBLISH_TO_CHANNEL",
    payload: opts.payload ?? { text: "пост", channel: "@delabs" },
  });
  const decided = opts.status === "pending";
  db.prepare(
    `UPDATE approvals SET created_at=?, status=?, decided_at=?, decided_by=? WHERE id=?`,
  ).run(
    NOW - opts.ageDays * DAY,
    opts.status,
    decided ? null : NOW - opts.ageDays * DAY,
    decided ? null : "owner",
    a.id,
  );
  return a.id;
}

const count = (t: string): number =>
  (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

beforeEach(() => {
  db.prepare(`DELETE FROM approvals`).run();
  db.prepare(`DELETE FROM approvals_archive`).run();
});

describe("архивация approvals", () => {
  test("решённые старше отсечки уезжают в архив и исчезают из живой таблицы", () => {
    const ids = [
      seed({ ageDays: 90, status: "approved" }),
      seed({ ageDays: 45, status: "rejected" }),
      seed({ ageDays: 31, status: "expired" }),
      seed({ ageDays: 60, status: "failed" }),
    ];

    const res = archiveOldRows({ olderThanDays: 30, now: NOW });

    expect(res.approvals).toBe(4);
    expect(count("approvals")).toBe(0);
    expect(count("approvals_archive")).toBe(4);
    for (const id of ids) {
      const row = db
        .prepare(`SELECT id, archived_at FROM approvals_archive WHERE id=?`)
        .get(id) as { id: string; archived_at: number } | undefined;
      expect(row?.id).toBe(id);
      expect(row?.archived_at).toBe(NOW);
    }
  });

  test("payload переносится целиком, а не теряется по дороге", () => {
    const body = "x".repeat(3000);
    const id = seed({ ageDays: 90, status: "approved", payload: { text: body } });

    archiveOldRows({ olderThanDays: 30, now: NOW });

    const row = db
      .prepare(
        `SELECT payload, action_id, requested_by FROM approvals_archive WHERE id=?`,
      )
      .get(id) as { payload: string; action_id: string; requested_by: string };
    expect(JSON.parse(row.payload).text).toBe(body);
    expect(row.requested_by).toBe("smm");
    expect(row.action_id.startsWith("act-")).toBe(true);
  });

  test("незакрытая заявка не уезжает никогда, даже возрастом в год", () => {
    const pending = seed({ ageDays: 365, status: "pending" });

    const res = archiveOldRows({ olderThanDays: 30, now: NOW });

    expect(res.approvals).toBe(0);
    expect(count("approvals")).toBe(1);
    expect(count("approvals_archive")).toBe(0);
    expect(getApproval(pending)?.status).toBe("pending");
  });

  test("свежие решённые остаются в живой таблице", () => {
    seed({ ageDays: 1, status: "approved" });
    seed({ ageDays: 29, status: "rejected" });

    const res = archiveOldRows({ olderThanDays: 30, now: NOW });

    expect(res.approvals).toBe(0);
    expect(count("approvals")).toBe(2);
  });

  test("просроченная заявка сначала закрывается санитаром, потом архивируется", () => {
    seed({ ageDays: 90, status: "pending" });

    // Сутки TTL: строка становится 'expired', но остаётся на месте.
    expireStaleApprovals({ now: NOW, ttlMs: DAY });
    expect(count("approvals")).toBe(1);
    expect(
      (db.prepare(`SELECT status FROM approvals`).get() as { status: string }).status,
    ).toBe("expired");

    // И только следующий архивный прогон её убирает.
    expect(archiveOldRows({ olderThanDays: 30, now: NOW }).approvals).toBe(1);
    expect(count("approvals")).toBe(0);
    expect(count("approvals_archive")).toBe(1);
  });

  test("повторный прогон идемпотентен: ни дублей, ни падения на PRIMARY KEY", () => {
    seed({ ageDays: 90, status: "approved" });

    expect(archiveOldRows({ olderThanDays: 30, now: NOW }).approvals).toBe(1);
    expect(archiveOldRows({ olderThanDays: 30, now: NOW }).approvals).toBe(0);
    expect(count("approvals_archive")).toBe(1);
  });

  test("замер из находки: 200 старых заявок больше не переживают обслуживание", () => {
    for (let i = 0; i < 200; i++) {
      seed({ ageDays: 400, status: "approved", payload: { text: "x".repeat(3000) } });
    }
    expect(count("approvals")).toBe(200);

    archiveOldRows({ olderThanDays: 30, now: NOW });

    expect(count("approvals")).toBe(0);
    expect(count("approvals_archive")).toBe(200);
  });
});

describe("форма правки", () => {
  test("спека архива объявляет все колонки источника, кроме archived_at", () => {
    const cols = (db.prepare(`PRAGMA table_info(approvals)`).all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect([...APPROVALS_SPEC.columns].sort()).toEqual(cols);

    const archiveCols = (
      db.prepare(`PRAGMA table_info(approvals_archive)`).all() as { name: string }[]
    )
      .map((c) => c.name)
      .sort();
    expect(archiveCols).toEqual([...cols, "archived_at"].sort());
  });

  test("отбор по состоянию — часть условия, иначе удалится не то, что скопировано", () => {
    // Регрессия на случай, если extraWhere уберут из DELETE или из COUNT:
    // тогда pending-строка либо удалится без копии, либо счётчик разъедется.
    seed({ ageDays: 90, status: "pending" });
    seed({ ageDays: 90, status: "approved" });

    const res = archiveOldRows({ olderThanDays: 30, now: NOW });

    expect(res.approvals).toBe(1);
    expect(count("approvals")).toBe(1);
    expect(count("approvals_archive")).toBe(1);
    expect(APPROVALS_SPEC.extraWhere).toBeTruthy();
  });

  test("архив виден на экране «БД», иначе размер файла необъясним", () => {
    seed({ ageDays: 90, status: "approved" });
    archiveOldRows({ olderThanDays: 30, now: NOW });

    const stat = dbStats().find((s) => s.table === "approvals_archive");
    expect(stat).toBeDefined();
    expect(stat?.rows).toBe(1);
  });
});
