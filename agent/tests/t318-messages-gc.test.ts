/**
 * T-318: messages retention/GC tests.
 *
 * - parseMessagesRetentionDays: default 90, fail-closed on garbage.
 * - gcMessages: deletes only rows older than retention.
 * - retention=0 → no-op.
 * - Idempotent re-run.
 * - Archive row mirrors source with archived_at set.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  gcMessages,
  parseMessagesRetentionDays,
  DEFAULT_MESSAGES_RETENTION_DAYS,
} from "../lib/db-maint.ts";

const TEST_CHAT = "-1009003318";

function cleanup(): void {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM messages_archive WHERE chat_id = ?`).run(TEST_CHAT);
}

function insertMessage(ts: number, text = "hello"): number {
  const r = db
    .prepare(
      `INSERT INTO messages (chat_id, agent_key, is_bot, from_user_id, from_name, text, ts)
       VALUES (?, NULL, 0, '42', 'alice', ?, ?)`,
    )
    .run(TEST_CHAT, text, ts);
  return Number(r.lastInsertRowid);
}

function hasColumn(table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .some((entry) => entry.name === column);
}

/**
 * Сколько строк ЧУЖИХ чатов попадёт под тот же порог.
 *
 * `gcMessages` чистит таблицу `messages` целиком — ни chat_id, ни автора он не
 * различает, и это правильно: ретеншен общий. Но тогда «удалено ровно 1» —
 * утверждение про весь прогон, а не про наши строки: любой соседний файл,
 * оставивший сообщение старше 90 дней, делает счётчик больше. Считаем чужих по
 * тому же самому порогу и вычитаем. T-751.
 */
function foreignOlderThan(cutoff: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE chat_id != ? AND ts < ?`,
      )
      .get(TEST_CHAT, cutoff) as { n: number }
  ).n;
}

beforeEach(cleanup);
afterEach(cleanup);

describe("T-318 messages-gc", () => {
  test("parseMessagesRetentionDays default is 90", () => {
    expect(DEFAULT_MESSAGES_RETENTION_DAYS).toBe(90);
    expect(parseMessagesRetentionDays(undefined)).toBe(90);
    expect(parseMessagesRetentionDays("")).toBe(90);
  });

  test("parseMessagesRetentionDays accepts valid integer", () => {
    expect(parseMessagesRetentionDays("30")).toBe(30);
    // Ноль проходит насквозь намеренно: это ручка «выключить GC совсем»
    // (см. докстринг gcMessages), а не опечатка и не «взять дефолт».
    // Докстринг parseMessagesRetentionDays обещал обратное до 2026-08-21.
    expect(parseMessagesRetentionDays("0")).toBe(0);
  });

  test("parseMessagesRetentionDays fails closed on garbage to default", () => {
    expect(parseMessagesRetentionDays("garbage")).toBe(90);
    expect(parseMessagesRetentionDays("12.5")).toBe(90);
    expect(parseMessagesRetentionDays("-5")).toBe(90);
    expect(parseMessagesRetentionDays("NaN")).toBe(90);
    expect(parseMessagesRetentionDays("1e9999")).toBe(90); // Infinity
  });

  test("parseMessagesRetentionDays uses env var when present", () => {
    const prev = process.env.MESSAGES_RETENTION_DAYS;
    try {
      process.env.MESSAGES_RETENTION_DAYS = "7";
      expect(parseMessagesRetentionDays()).toBe(7);
      process.env.MESSAGES_RETENTION_DAYS = "totally-not-a-number";
      expect(parseMessagesRetentionDays()).toBe(90);
    } finally {
      if (prev === undefined) delete process.env.MESSAGES_RETENTION_DAYS;
      else process.env.MESSAGES_RETENTION_DAYS = prev;
    }
  });

  test("gcMessages with retention=0 is a no-op even if rows exist", () => {
    const now = Date.now();
    insertMessage(now - 365 * 24 * 60 * 60 * 1000, "ancient");
    const res = gcMessages({ retentionDays: 0, now });
    expect(res).toEqual({ deleted: 0, archived: 0, retention_days: 0 });
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`)
      .get(TEST_CHAT) as { n: number };
    expect(remaining.n).toBe(1);
  });

  test("gcMessages deletes only rows older than retention; archives them", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // gcMessages чистит ВСЮ таблицу, а не только наш chat_id: cleanup() здесь
    // не изолирует. Любая чужая строка старше отсечки — а тесты пишут реальную
    // data/memory.db — попадёт в тот же прогон, и абсолютная единица развалится
    // (в CI 2026-08-14 так и вышло: deleted=2). Считаем дельту от того, что уже
    // лежало старым, — проверка «удалили ровно свою одну» от этого не слабеет.
    const oldId = insertMessage(now - 100 * day, "old-row");
    const freshId = insertMessage(now - 10 * day, "fresh-row");

    const foreign = foreignOlderThan(now - 90 * day);
    const res = gcMessages({ retentionDays: 90, now });
    expect(res.retention_days).toBe(90);
    expect(res.deleted - foreign).toBe(1);
    expect(res.archived - foreign).toBe(1);

    // Old gone from source.
    const oldStill = db
      .prepare(`SELECT id FROM messages WHERE id = ?`)
      .get(oldId);
    expect(oldStill == null).toBe(true);
    // Fresh still there.
    const freshStill = db
      .prepare(`SELECT id FROM messages WHERE id = ?`)
      .get(freshId);
    expect(freshStill).toBeTruthy();
    // Old in archive with archived_at.
    const archived = db
      .prepare(
        `SELECT id, text, archived_at FROM messages_archive WHERE id = ?`,
      )
      .get(oldId) as
      | { id: number; text: string; archived_at: number }
      | undefined;
    expect(archived).toBeTruthy();
    expect(archived!.text).toBe("old-row");
    expect(archived!.archived_at).toBe(now);
  });

  test("gcMessages is idempotent on re-run", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    insertMessage(now - 100 * day, "old-1");
    insertMessage(now - 95 * day, "old-2");
    insertMessage(now - 5 * day, "fresh");

    const foreign = foreignOlderThan(now - 90 * day);
    const first = gcMessages({ retentionDays: 90, now });
    expect(first.deleted - foreign).toBe(2);

    const second = gcMessages({ retentionDays: 90, now });
    expect(second.deleted).toBe(0);
    expect(second.archived).toBe(0);

    // Archive still has the 2 rows (INSERT OR IGNORE prevents duplicates).
    const archCount = db
      .prepare(`SELECT COUNT(*) AS n FROM messages_archive WHERE chat_id = ?`)
      .get(TEST_CHAT) as { n: number };
    expect(archCount.n).toBe(2);

    // Source has only the fresh row.
    const srcCount = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`)
      .get(TEST_CHAT) as { n: number };
    expect(srcCount.n).toBe(1);
  });

  test("gcMessages fails closed when messages.kind is missing from archive", () => {
    const sourceHadKind = hasColumn("messages", "kind");
    if (!sourceHadKind) db.exec(`ALTER TABLE messages ADD COLUMN kind TEXT`);
    /*
     * Миграция 045 добавила `kind` в архив, то есть прод-дрейф снят и сам
     * собой этот случай больше не наступает. Тест остаётся: fail-closed
     * должен срабатывать на ЛЮБОЙ такой рассинхрон, а не только на этой
     * колонке, — поэтому дрейф здесь воспроизводится руками.
     */
    db.exec(`ALTER TABLE messages_archive DROP COLUMN kind`);

    try {
      // Reproduce the production drift: source has kind, archive does not.
      expect(hasColumn("messages_archive", "kind")).toBe(false);
      const now = Date.now();
      const oldId = insertMessage(now - 100 * 24 * 60 * 60 * 1000, "with-kind");
      db.prepare(`UPDATE messages SET kind = ? WHERE id = ?`).run("human", oldId);

      expect(() => gcMessages({ retentionDays: 90, now })).toThrow(
        /archive schema incompatible.*kind/,
      );
      expect(
        db.prepare(`SELECT id, kind FROM messages WHERE id = ?`).get(oldId),
      ).toEqual({ id: oldId, kind: "human" });
      expect(
        db.prepare(`SELECT id FROM messages_archive WHERE id = ?`).get(oldId),
      ).toBeNull();
    } finally {
      cleanup();
      db.exec(`ALTER TABLE messages_archive ADD COLUMN kind TEXT`);
      if (!sourceHadKind) db.exec(`ALTER TABLE messages DROP COLUMN kind`);
    }
  });

  test("после 045 архивация переносит kind, а не падает на нём", () => {
    // Прод-схема: kind есть в источнике. До 045 это был ежедневный отказ.
    const sourceHadKind = hasColumn("messages", "kind");
    if (!sourceHadKind) db.exec(`ALTER TABLE messages ADD COLUMN kind TEXT`);
    try {
      expect(hasColumn("messages_archive", "kind")).toBe(true);
      const now = Date.now();
      const oldId = insertMessage(now - 100 * 24 * 60 * 60 * 1000, "kept-kind");
      db.prepare(`UPDATE messages SET kind = ? WHERE id = ?`).run("human", oldId);

      gcMessages({ retentionDays: 90, now });

      expect(
        db.prepare(`SELECT id FROM messages WHERE id = ?`).get(oldId),
      ).toBeNull();
      expect(
        db.prepare(`SELECT id, kind FROM messages_archive WHERE id = ?`).get(oldId),
      ).toEqual({ id: oldId, kind: "human" });
    } finally {
      cleanup();
      if (!sourceHadKind) db.exec(`ALTER TABLE messages DROP COLUMN kind`);
    }
  });

  test("gcMessages uses env-driven default when no opts passed", () => {
    const prev = process.env.MESSAGES_RETENTION_DAYS;
    try {
      process.env.MESSAGES_RETENTION_DAYS = "30";
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      insertMessage(now - 60 * day, "older-than-30");
      insertMessage(now - 10 * day, "younger-than-30");
      const foreign = foreignOlderThan(now - 30 * day);
      const res = gcMessages({ now });
      expect(res.retention_days).toBe(30);
      expect(res.deleted - foreign).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.MESSAGES_RETENTION_DAYS;
      else process.env.MESSAGES_RETENTION_DAYS = prev;
    }
  });
});
