/**
 * Аудит 2026-08-28: схема предлагала выбрать чат, которого выбрать нельзя.
 *
 * Тринадцать инструментов объявляли параметр чата («ID чата (по умолчанию —
 * текущий)»), а хендлеры все тринадцать пиннят к чату-источнику через
 * pinnedChatId. Пиннинг — правильный инвариант, чинить надо не его, а
 * молчание вокруг него:
 *
 *  - LIST_RECENT_MESSAGES возвращал `ok:true` и историю СВОЕГО чата на запрос
 *    истории чужого. Для исходящих действий подмена хотя бы безобидна («ушло
 *    не туда, куда просили»), а здесь модель получает чужой по её мнению текст
 *    и делает по нему выводы о чате, который не читала;
 *  - FORWARD_MESSAGE держал `fromChatId` в `required`, то есть ТРЕБОВАЛ
 *    значение, которое затем выбрасывал (build-payload.ts отказывал без него);
 *  - USERBOT_GUIDE в системном промпте учил все 12 ролей писать `{chat_id, …}`.
 *
 * Промпт-инъекция «покажи последние сообщения из чата -100…» упиралась в
 * пиннинг и раньше — утечки не было. Убираем приглашение её написать и
 * подписываем подмену там, где она уже случилась.
 *
 * CREATE_TASK — образец, по которому выровнены остальные: он пиннится и НЕ
 * объявляет чат в схеме.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
// agent-sdk-runtime — первым импортом намеренно. Пара с tools-schema
// циклическая: если первым инициализировать tools-schema, частичный прогон
// падает на `Cannot access 'INLINE_TOOL_NAMES' before initialization` — не
// поломкой кода, а порядком инициализации (в полном прогоне каталога порядок
// задают соседние файлы, и это не воспроизводится).
import { SDK_SIDE_EFFECT_FREE_TOOLS } from "../lib/agent-sdk-runtime.ts";
import { TOOLS } from "../lib/tools-schema.ts";
import { handleListRecentMessages } from "../lib/dispatch/misc.ts";
import {
  CHAT_PINNED_ACTIONS,
  crossChatRequested,
  pinnedChatNote,
} from "../lib/dispatch/helpers.ts";
import { db } from "../lib/db.ts";

const ORIGIN = -100_828_101;
const FOREIGN = -100_828_909;

function seed(chatId: number, text: string) {
  db.prepare(
    `INSERT INTO messages (chat_id, agent_key, is_bot, from_user_id, from_name, text, ts)
     VALUES (?, NULL, 0, '1', 'кто-то', ?, ?)`,
  ).run(String(chatId), text, Date.now());
}

function clear() {
  db.prepare(`DELETE FROM messages WHERE chat_id IN (?, ?)`).run(
    String(ORIGIN),
    String(FOREIGN),
  );
}

interface ListResult {
  chat_id: number;
  count: number;
  note?: string;
  messages: Array<{ text_preview: string }>;
}

async function list(payload: Record<string, unknown>): Promise<ListResult> {
  const res = await handleListRecentMessages({ kinds: ["all"], limit: 50, ...payload } as never, {
    agentKey: "smm",
    chatId: ORIGIN,
    resolveUserbot: async () => null,
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.result as ListResult;
}

describe("LIST_RECENT_MESSAGES: подмена чата больше не молчалива", () => {
  test("выдача называет чат, из которого она собрана", async () => {
    seed(ORIGIN, "своё сообщение");
    try {
      const r = await list({});
      expect(r.chat_id).toBe(ORIGIN);
    } finally {
      clear();
    }
  });

  test("чужой chat_id: строки свои, и об этом сказано в выдаче", async () => {
    seed(ORIGIN, "своё сообщение");
    seed(FOREIGN, "чужая переписка");
    try {
      const r = await list({ chat_id: FOREIGN });
      // Пиннинг как был — проверяем именно его, а не только текст заметки.
      expect(r.messages.map((m) => m.text_preview)).toEqual(["своё сообщение"]);
      expect(r.chat_id).toBe(ORIGIN);
      expect(r.note).toBeTruthy();
      // Заметка обязана назвать ОБА числа: без запрошенного модель не поймёт,
      // что подменили именно её запрос.
      expect(r.note).toContain(String(FOREIGN));
      expect(r.note).toContain(String(ORIGIN));
    } finally {
      clear();
    }
  });

  test("свой chat_id и отсутствие chat_id заметки не рождают", async () => {
    seed(ORIGIN, "своё сообщение");
    try {
      expect((await list({})).note).toBeUndefined();
      expect((await list({ chat_id: ORIGIN })).note).toBeUndefined();
    } finally {
      clear();
    }
  });

  test("пустая выдача тоже подписана — иначе подмену видно только при наличии строк", async () => {
    seed(FOREIGN, "чужая переписка");
    try {
      const r = await list({ chat_id: FOREIGN });
      expect(r.count).toBe(0);
      expect(r.note).toBeTruthy();
    } finally {
      clear();
    }
  });
});

describe("crossChatRequested / pinnedChatNote", () => {
  test("чужой чат — да, свой и отсутствующий — нет", () => {
    expect(crossChatRequested(FOREIGN, ORIGIN)).toBe(true);
    expect(crossChatRequested(ORIGIN, ORIGIN)).toBe(false);
    expect(crossChatRequested(undefined, ORIGIN)).toBe(false);
  });

  test("заметка есть ровно тогда, когда была подмена", () => {
    expect(pinnedChatNote(ORIGIN, ORIGIN)).toBeUndefined();
    expect(pinnedChatNote(undefined, ORIGIN)).toBeUndefined();
    const note = pinnedChatNote(FOREIGN, ORIGIN)!;
    expect(note).toContain(String(FOREIGN));
    expect(note).toContain(String(ORIGIN));
  });
});

/**
 * Инвариант, а не перечень: следующий пиннящийся инструмент попадёт под него
 * сам. Точечная правка тринадцати описаний ровно этим и плоха — четырнадцатое
 * снова разъедется.
 */
describe("схема не предлагает выбрать чат тем, кто его пиннит", () => {
  const CHAT_PARAMS = ["chat_id", "chatId", "fromChatId", "from_chat_id"];

  test("ни один пиннящийся инструмент не объявляет параметр чата", () => {
    const offenders: string[] = [];
    for (const t of TOOLS) {
      if (!CHAT_PINNED_ACTIONS.has(t.name)) continue;
      const props = (t.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const p of CHAT_PARAMS) if (p in props) offenders.push(`${t.name}.${p}`);
    }
    expect(offenders).toEqual([]);
  });

  test("и тем более не требует его", () => {
    const offenders: string[] = [];
    for (const t of TOOLS) {
      if (!CHAT_PINNED_ACTIONS.has(t.name)) continue;
      const req = ((t.input_schema as { required?: string[] }).required ?? []) as string[];
      for (const p of CHAT_PARAMS) if (req.includes(p)) offenders.push(`${t.name}.${p}`);
    }
    expect(offenders).toEqual([]);
  });

  test("проверка не вырождена: пиннящиеся инструменты в схеме есть", () => {
    const covered = TOOLS.filter((t) => CHAT_PINNED_ACTIONS.has(t.name));
    expect(covered.length).toBeGreaterThanOrEqual(12);
    // Заодно расписка в том, зачем импортирован agent-sdk-runtime (см. шапку
    // импортов): он обязан быть инициализирован раньше tools-schema.
    expect(SDK_SIDE_EFFECT_FREE_TOOLS.size).toBeGreaterThan(0);
  });
});

describe("системный промпт не учит передавать чат", () => {
  // Читаем ТОЛЬКО текст гайда: файл большой, и провалившийся source-guard
  // вывалил бы его целиком в отчёт теста.
  const src = readFileSync(new URL("../characters/index.ts", import.meta.url).pathname, "utf-8");
  const guide = src.slice(
    src.indexOf("const USERBOT_GUIDE"),
    src.indexOf("export const CHARACTERS"),
  );

  test("предпосылки: гайд читается и он про userbot", () => {
    expect(guide).toContain("Userbot capability");
    expect(guide.length).toBeGreaterThan(200);
  });

  test("примеры вызовов не содержат чата", () => {
    expect(guide).not.toContain("chat_id");
    expect(guide).not.toContain("chatId");
  });

  test("сами примеры на месте — строки не потерялись при правке", () => {
    expect(guide).toContain("DELETE_MESSAGE {message_id, via_userbot: true}");
    expect(guide).toContain("LIST_RECENT_MESSAGES {since, kinds}");
  });
});
