/**
 * Аудит 2026-08-28: LIST_RECENT_MESSAGES тащил из БД вдвое больше строк ради
 * дедупликации, которой не бывает.
 *
 * Запрос брал `LIMIT limit * 2` («Fetch more to account for deduplication»), а
 * дальше цикл выкидывал повторы по `tg_message_id`. Придумано это в T-544, до
 * миграции 030 — а она создала `CREATE UNIQUE INDEX idx_messages_dedup ON
 * messages(chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL`.
 *
 * Запрос фильтрует по одному `chat_id`, значит внутри его выдачи ненулевые
 * `tg_message_id` уникальны структурно: цикл не мог пропустить ни строки ни
 * разу. Строки с NULL он и так не трогал. То есть половина вытащенного из
 * SQLite гарантированно выбрасывалась, а код рядом утверждал обратное —
 * читатель видел «дубли бывают» там, где БД их не допускает.
 *
 * Проверено на живой БД (read-only): индекс на месте, дублей ноль.
 *
 * Тесты ниже держат ровно ту предпосылку, на которой стоит упрощение: если
 * индекс когда-нибудь снимут, это должно упасть здесь, а не тихо разъехаться
 * в выдаче инструмента.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";

const CHAT = 779001;

const SRC = readFileSync(new URL("../lib/dispatch/misc.ts", import.meta.url), "utf-8");
/** Тот же файл без строк-комментариев — см. пояснение в тесте ниже. */
const CODE = SRC.split("\n")
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

function seed(text: string, ts: number, tgId: number | null) {
  db.prepare(
    `INSERT INTO messages(chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, transport, tg_message_id)
     VALUES (?, 'test', 0, 'u1', 'tester', ?, ?, 'bot_api', ?)`,
  ).run(CHAT, text, ts, tgId);
}

function clear() {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT);
}

beforeEach(clear);
afterEach(clear);

async function list(limit: number) {
  const res = await dispatchAction(
    "LIST_RECENT_MESSAGES",
    { chat_id: CHAT, kinds: ["all"], limit },
    { agentKey: "orchestrator", chatId: CHAT, userbot: null },
  );
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("dispatch failed");
  return res.result as { messages: Array<{ id: number; ts: number }>; count: number };
}

describe("предпосылки: дубль по tg_message_id невозможен на уровне БД", () => {
  test("уникальный частичный индекс есть в схеме", () => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_messages_dedup'`)
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toContain("UNIQUE");
    expect(row!.sql.replace(/\s+/g, " ")).toContain("ON messages(chat_id, tg_message_id)");
    expect(row!.sql).toContain("WHERE tg_message_id IS NOT NULL");
  });

  test("вторая строка с тем же (chat_id, tg_message_id) отвергается", () => {
    seed("первое", 1000, 4242);
    expect(() => seed("второе", 2000, 4242)).toThrow();
  });

  test("NULL дублировать можно — но их цикл и не трогал", () => {
    seed("а", 1000, null);
    seed("б", 2000, null);
    expect(
      (db.prepare(`SELECT COUNT(*) c FROM messages WHERE chat_id = ?`).get(CHAT) as { c: number }).c,
    ).toBe(2);
  });
});

describe("выдача не изменилась", () => {
  test("возвращается ровно limit строк, свежие первыми", async () => {
    for (let i = 1; i <= 10; i++) seed(`m${i}`, 1000 + i, 100 + i);
    const r = await list(4);
    expect(r.count).toBe(4);
    expect(r.messages.map((m) => m.ts)).toEqual([1010, 1009, 1008, 1007]);
  });

  test("строк меньше лимита — отдаются все", async () => {
    seed("а", 1000, 1);
    seed("б", 1001, null);
    const r = await list(50);
    expect(r.count).toBe(2);
  });

  test("пустой чат — пустая выдача, а не ошибка", async () => {
    const r = await list(10);
    expect(r.count).toBe(0);
  });
});

describe("из БД не тащится вдвое больше нужного", () => {
  test("LIMIT биндится самим limit, без удвоения", () => {
    // Только код: обе строки цитируются в комментарии, который объясняет, что
    // именно убрали (source-guard на собственном тексте иначе всегда красный).
    expect(CODE).not.toContain("limit * 2");
    expect(CODE).not.toContain("Fetch more to account");
    expect(CODE).toContain(".all(String(chatId), since, limit) as MsgRow[]");
  });

  test("ручной дедуп по tg_message_id убран вместе с ним", () => {
    expect(CODE).not.toContain("seenTgIds");
    expect(CODE).not.toContain("dedupedRows");
  });
});
