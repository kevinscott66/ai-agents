/**
 * Аудит 2026-08-20: LIST_RECENT_MESSAGES молча отдавал пустой список на входе,
 * который он не понял.
 *
 * `kinds` приходит из payload модели без валидатора (в action-dispatch.ts это
 * прямой каст, не buildPayload). Нераспознанные значения попадали в ветку
 * `AND 0`, то есть SQL, который заведомо не вернёт ни строки, и наружу уезжало
 * `ok:true, count:0`. Для модели это неотличимо от «сервисных сообщений в чате
 * нет» — а инструмент существует ровно затем, чтобы найти message_id системных
 * сообщений перед DELETE_MESSAGE. Опечатка вида `kinds:['system']` (описание
 * инструмента само называет их «системные») превращалась в уверенный вывод, что
 * удалять нечего.
 *
 * Тот же класс — нечисловой `since`: `1e999` парсится JSON'ом в Infinity, и
 * `ts >= Infinity` тоже даёт тихий ноль.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";

const CHAT = 991177;

function seed(text: string, ts: number) {
  db.prepare(
    `INSERT INTO messages(chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, transport)
     VALUES (?, 'test', 0, 'u1', 'tester', ?, ?, 'bot_api')`,
  ).run(CHAT, text, ts);
}
function clear() {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT);
}

async function list(payload: Record<string, unknown>) {
  return dispatchAction(
    "LIST_RECENT_MESSAGES",
    { chat_id: CHAT, ...payload } as never,
    { agentKey: "orchestrator", chatId: CHAT, userbot: null },
  );
}

interface ListRecentResult {
  messages: Array<{ id: number; text_preview: string }>;
  count: number;
}

describe("LIST_RECENT_MESSAGES: непонятый вход — отказ, а не пустая выдача", () => {
  beforeEach(() => {
    clear();
    const base = Date.now() - 100_000;
    seed("[service] user joined", base + 1);
    seed("[service] pinned a message", base + 2);
    seed("обычное сообщение", base + 3);
  });
  afterEach(clear);

  test("сервисные сообщения в чате ЕСТЬ — иначе тесты ниже ничего не значат", async () => {
    const res = await list({ kinds: ["service"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.result as ListRecentResult).count).toBe(2);
  });

  for (const bad of [["system"], ["services"], ["SERVICE"], ["любые"], [""]]) {
    test(`kinds:${JSON.stringify(bad)} — ошибка, а не count:0`, async () => {
      const res = await list({ kinds: bad });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain("kinds");
      // Текст обязан назвать допустимые значения: модель на этом и исправится.
      expect(res.error).toContain("service");
      expect(res.error).toContain("text");
      expect(res.error).toContain("all");
    });
  }

  test("частично распознанный список тоже отказ — иначе половина запроса теряется молча", async () => {
    const res = await list({ kinds: ["service", "sistem"] });
    expect(res.ok).toBe(false);
  });

  test("нераспознанное значение попадает в текст ошибки", async () => {
    const res = await list({ kinds: ["sistem"] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("sistem");
  });

  test("не-строки в kinds тоже отбиваются, а не приводятся к строке", async () => {
    const res = await list({ kinds: [42] });
    expect(res.ok).toBe(false);
  });

  for (const kinds of [["service"], ["text"], ["all"], ["service", "text"], ["all", "text"]]) {
    test(`kinds:${JSON.stringify(kinds)} по-прежнему работает`, async () => {
      const res = await list({ kinds });
      expect(res.ok).toBe(true);
    });
  }

  test("kinds отсутствует — дефолт ['service'], без ошибки", async () => {
    const res = await list({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.result as ListRecentResult).count).toBe(2);
  });

  test("kinds:[] — тоже дефолт, пустой массив это не «ничего не подходит»", async () => {
    const res = await list({ kinds: [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.result as ListRecentResult).count).toBe(2);
  });

  test("since:Infinity — отказ, а не тихий ноль строк", async () => {
    // JSON.parse('{"since":1e999}') даёт именно Infinity, так что вход достижим.
    expect(JSON.parse('{"since":1e999}').since).toBe(Infinity);
    const res = await list({ kinds: ["all"], since: Infinity });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("since");
  });

  test("since:NaN — отказ", async () => {
    const res = await list({ kinds: ["all"], since: NaN });
    expect(res.ok).toBe(false);
  });

  test("нормальный since продолжает фильтровать", async () => {
    const res = await list({ kinds: ["all"], since: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.result as ListRecentResult).count).toBe(3);
  });

  test("since отсутствует — без ограничения", async () => {
    const res = await list({ kinds: ["all"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.result as ListRecentResult).count).toBe(3);
  });
});
