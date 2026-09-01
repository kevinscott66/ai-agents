/**
 * Аудит 2026-08-09: LIST_RECENT_MESSAGES применял `limit` до отбора по kinds.
 *
 * Порядок был «взять limit*2 строк → обрезать до limit → отфильтровать по
 * виду», то есть фильтр мог только уменьшить выдачу. В живом чате свежий хвост
 * — это обычная переписка, а kinds по умолчанию ['service']: модель просила 20
 * строк, получала ноль и делала вывод, что сервисных сообщений нет. При этом
 * они лежали в уже вытащенных из БД, но отброшенных строках.
 *
 * Схема инструмента обещает «сколько строк вернуть», значит limit обязан
 * считать ПОДХОДЯЩИЕ строки.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";

const CHAT = 778899;

interface RecentMessage {
  id: number;
  ts: number;
  text_preview: string;
}
interface ListRecentResult {
  messages: RecentMessage[];
  count: number;
}

function seed(text: string, ts: number) {
  db.prepare(
    `INSERT INTO messages(chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, transport)
     VALUES (?, 'test', 0, 'u1', 'tester', ?, ?, 'bot_api')`,
  ).run(CHAT, text, ts);
}

function clear() {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT);
}

type Kind = "service" | "text" | "all";

async function list(kinds: Kind[], limit: number): Promise<ListRecentResult> {
  const res = await dispatchAction(
    "LIST_RECENT_MESSAGES",
    { chat_id: CHAT, kinds, limit },
    { agentKey: "orchestrator", chatId: CHAT, userbot: null },
  );
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("dispatch failed");
  return res.result as ListRecentResult;
}

describe("LIST_RECENT_MESSAGES: limit считает подходящие строки, а не сырые", () => {
  beforeEach(clear);
  afterEach(clear);

  test("свежая болтовня не вытесняет сервисные сообщения из выдачи", async () => {
    const base = Date.now() - 1_000_000;
    // Сначала 10 сервисных (старые), потом 100 обычных (свежие) — ровно та
    // раскладка, при которой старый порядок возвращал пустой список.
    for (let i = 0; i < 10; i++) seed(`[service] событие ${i}`, base + i);
    for (let i = 0; i < 100; i++) seed(`болтовня ${i}`, base + 1000 + i);

    const out = await list(["service"], 5);
    expect(out.messages).toHaveLength(5);
    expect(out.count).toBe(5);
    for (const m of out.messages) {
      expect(m.text_preview.startsWith("[service]")).toBe(true);
    }
  });

  test("симметрично: сервисный шум не вытесняет обычные сообщения", async () => {
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 10; i++) seed(`болтовня ${i}`, base + i);
    for (let i = 0; i < 100; i++) seed(`[service] событие ${i}`, base + 1000 + i);

    const out = await list(["text"], 5);
    expect(out.messages).toHaveLength(5);
    for (const m of out.messages) {
      expect(m.text_preview.startsWith("[service]")).toBe(false);
    }
  });

  test("возвращаются самые свежие из подходящих, а не самые старые", async () => {
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 20; i++) seed(`[service] событие ${i}`, base + i);
    for (let i = 0; i < 50; i++) seed(`болтовня ${i}`, base + 1000 + i);

    const out = await list(["service"], 3);
    const texts = out.messages.map((m) => m.text_preview);
    expect(texts).toEqual([
      "[service] событие 19",
      "[service] событие 18",
      "[service] событие 17",
    ]);
  });

  test("kinds:['all'] отдаёт оба вида и упирается ровно в limit", async () => {
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 10; i++) seed(`[service] событие ${i}`, base + i);
    for (let i = 0; i < 10; i++) seed(`болтовня ${i}`, base + 100 + i);

    const out = await list(["all"], 15);
    expect(out.messages).toHaveLength(15);
  });

  test("подходящих меньше, чем limit — отдаём сколько есть", async () => {
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 2; i++) seed(`[service] событие ${i}`, base + i);
    for (let i = 0; i < 50; i++) seed(`болтовня ${i}`, base + 100 + i);

    const out = await list(["service"], 10);
    expect(out.messages).toHaveLength(2);
  });
});
