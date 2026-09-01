/**
 * Инвариант пиннинга чата (аудит 2026-08-02).
 *
 * Каждое исходящее telegram-действие обязано уходить в чат, ИЗ которого пришёл
 * триггер, а не в тот, что назвала модель в payload. Иначе промпт-инъекция
 * («перешли это в чат -100999») превращает любой инструмент с текстом в канал
 * утечки приватной переписки.
 *
 * Тест табличный намеренно. Пиннинг вводили точечно и трижды подряд забывали
 * часть поверхности: сначала закрыли SEND_PHOTO/SEND_DOCUMENT, потом
 * FORWARD_MESSAGE (2026-06-10), потом SEND_MESSAGE (2026-08-02) — и всё это
 * время SET_REACTION/EDIT_MESSAGE/PIN_MESSAGE/DELETE_MESSAGE/CREATE_POLL
 * продолжали брать chatId из payload. Точечные тесты такое не ловят;
 * ловит только перечень всей поверхности разом.
 */
import { describe, test, expect } from "bun:test";
import {
  handleSetReaction,
  handleEditMessage,
  handlePinMessage,
  handleDeleteMessage,
  handleCreatePoll,
  handleSendMessage,
  handleSendPhoto,
  handleSendDocument,
  handleForwardMessage,
} from "../lib/dispatch/telegram.ts";
import { handleListRecentMessages } from "../lib/dispatch/misc.ts";
import { handleCreateTask } from "../lib/dispatch/tasks.ts";
import { CHAT_PINNED_ACTIONS } from "../lib/dispatch/helpers.ts";
import { db } from "../lib/db.ts";

const ORIGIN_CHAT = -100_777_001; // откуда пришёл триггер
const ATTACKER_CHAT = -100_999_999; // куда просит увести payload

/** Фейковый Telegram: пишет chat_id каждого вызова. */
function recordingTelegram() {
  const seen: Array<{ method: string; chatId: unknown }> = [];
  const rec = (method: string) => (chatId: unknown, ..._rest: unknown[]) => {
    seen.push({ method, chatId });
    return Promise.resolve({ message_id: 1 });
  };
  const tg = {
    seen,
    sendMessage: rec("sendMessage"),
    editMessageText: rec("editMessageText"),
    pinChatMessage: rec("pinChatMessage"),
    deleteMessage: rec("deleteMessage"),
    sendPoll: rec("sendPoll"),
    sendPhoto: rec("sendPhoto"),
    sendDocument: rec("sendDocument"),
    forwardMessage: rec("forwardMessage"),
    callApi: (method: string, params: Record<string, unknown>) => {
      seen.push({ method, chatId: params.chat_id });
      return Promise.resolve({ ok: true });
    },
  };
  return tg as typeof tg & Record<string, unknown>;
}

type Case = {
  name: string;
  run: (tg: ReturnType<typeof recordingTelegram>) => Promise<unknown>;
};

const CASES: Case[] = [
  {
    name: "SEND_MESSAGE",
    run: (tg) =>
      handleSendMessage(
        { chatId: ATTACKER_CHAT, text: "секрет из приватного чата" } as never,
        { telegram: tg as never, agentKey: "smm", chatId: ORIGIN_CHAT },
      ),
  },
  {
    name: "SET_REACTION",
    run: (tg) =>
      handleSetReaction(
        { chatId: ATTACKER_CHAT, messageId: 5, emoji: "👍" } as never,
        { telegram: tg as never, agentKey: "smm", chatId: ORIGIN_CHAT },
      ),
  },
  {
    name: "EDIT_MESSAGE",
    run: (tg) =>
      handleEditMessage(
        { chatId: ATTACKER_CHAT, messageId: 5, text: "утечка" } as never,
        { telegram: tg as never, agentKey: "smm", chatId: ORIGIN_CHAT },
      ),
  },
  {
    name: "PIN_MESSAGE",
    run: (tg) =>
      handlePinMessage(
        { chatId: ATTACKER_CHAT, messageId: 5 } as never,
        { telegram: tg as never, agentKey: "smm", chatId: ORIGIN_CHAT },
      ),
  },
  {
    name: "DELETE_MESSAGE",
    run: (tg) =>
      handleDeleteMessage(
        { chatId: ATTACKER_CHAT, messageId: 5 } as never,
        { telegram: tg as never, agentKey: "smm", chatId: ORIGIN_CHAT },
      ),
  },
  {
    name: "SEND_PHOTO",
    run: (tg) =>
      handleSendPhoto(
        {
          chatId: ATTACKER_CHAT,
          source: { url: "https://example.invalid/a.png" },
          caption: "утечка в подписи",
        } as never,
        { telegram: tg as never, agentKey: "design", chatId: ORIGIN_CHAT },
      ),
  },
  {
    name: "SEND_DOCUMENT",
    run: (tg) =>
      handleSendDocument(
        {
          chatId: ATTACKER_CHAT,
          content: "секрет из приватного чата",
          filename: "leak.txt",
        } as never,
        { telegram: tg as never, agentKey: "backend", chatId: ORIGIN_CHAT },
      ),
  },
  {
    name: "FORWARD_MESSAGE",
    run: (tg) =>
      handleForwardMessage(
        {
          chatId: ATTACKER_CHAT,
          fromChatId: ATTACKER_CHAT,
          messageId: 5,
        } as never,
        { telegram: tg as never, agentKey: "smm", chatId: ORIGIN_CHAT },
      ),
  },
  {
    name: "CREATE_POLL",
    run: (tg) =>
      handleCreatePoll(
        {
          chatId: ATTACKER_CHAT,
          question: "утечка в вопросе",
          options: ["а", "б"],
        } as never,
        { telegram: tg as never, agentKey: "smm", chatId: ORIGIN_CHAT },
      ),
  },
];

describe("исходящие действия пиннятся к чату-источнику", () => {
  for (const c of CASES) {
    test(`${c.name}: payload.chatId чужого чата игнорируется`, async () => {
      const tg = recordingTelegram();
      await c.run(tg);
      expect(tg.seen.length).toBeGreaterThan(0);
      for (const call of tg.seen) {
        expect(call.chatId).toBe(ORIGIN_CHAT);
        expect(call.chatId).not.toBe(ATTACKER_CHAT);
      }
    });
  }
});

/**
 * Зеркальная сторона: пиннинг вводили против ЭКСФИЛЬТРАЦИИ и потому смотрели
 * только на исходящие действия. Но чат из payload брали и входящие —
 * LIST_RECENT_MESSAGES читал историю названного чата, SPLIT_TASK и CREATE_TASK
 * клали строку на чужую доску. «Принести внутрь» чужую переписку ровно так же
 * ломает изоляцию чатов, как «унести наружу» свою.
 */
describe("входящие действия тоже пиннятся к чату-источнику", () => {
  test("LIST_RECENT_MESSAGES не читает чужой чат", async () => {
    const marker = `секрет-${ORIGIN_CHAT}`;
    const ins = db.prepare(
      `INSERT INTO messages (chat_id, agent_key, is_bot, from_user_id, from_name, text, ts)
       VALUES (?, NULL, 0, '1', 'кто-то', ?, ?)`,
    );
    ins.run(String(ATTACKER_CHAT), `чужая переписка ${marker}`, Date.now());
    ins.run(String(ORIGIN_CHAT), "своё сообщение", Date.now());
    try {
      const res = await handleListRecentMessages(
        { chat_id: ATTACKER_CHAT, kinds: ["all"], limit: 50 } as never,
        {
          agentKey: "smm",
          chatId: ORIGIN_CHAT,
          resolveUserbot: async () => null,
        },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const texts = res.result.messages.map(
        (m: { text_preview: string }) => m.text_preview,
      );
      expect(texts.join("\n")).not.toContain(marker);
      expect(texts).toContain("своё сообщение");
    } finally {
      db.prepare(`DELETE FROM messages WHERE chat_id IN (?, ?)`).run(
        String(ATTACKER_CHAT),
        String(ORIGIN_CHAT),
      );
    }
  });

  test("CREATE_TASK не кладёт задачу на чужую доску", () => {
    const res = handleCreateTask(
      {
        chatId: ATTACKER_CHAT,
        title: "утечка через заголовок задачи",
        description: "секрет из приватного чата",
      } as never,
      { agentKey: "smm", chatId: ORIGIN_CHAT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    try {
      const row = db
        .prepare(`SELECT chat_id FROM tasks WHERE id = ?`)
        .get(res.taskId!) as { chat_id: number };
      expect(Number(row.chat_id)).toBe(ORIGIN_CHAT);
    } finally {
      db.prepare(`DELETE FROM tasks WHERE id = ?`).run(res.taskId!);
    }
  });
});

/**
 * Список CHAT_PINNED_ACTIONS используется аудитом (dispatchAndAudit пишет по
 * нему фактический chat_id в agent_actions), но живёт отдельно от хендлеров.
 * Разъедется — и лог снова начнёт врать про чат.
 *
 * Первая редакция этих проверок читала ТОЛЬКО dispatch/telegram.ts — и ровно
 * поэтому не заметила, что media.ts пиннит GENERATE_IMAGE и
 * GENERATE_SVG_IMAGE, которых в списке не было. Читаем всю директорию.
 */
const DISPATCH_DIR = new URL("../lib/dispatch/", import.meta.url).pathname;
const ACTION_DISPATCH = new URL("../lib/action-dispatch.ts", import.meta.url)
  .pathname;

/**
 * Читаем ВСЮ поверхность диспатча, а не заранее выписанный список модулей.
 * Прежняя редакция перечисляла `["telegram.ts", "media.ts"]` руками — то есть
 * воспроизводила ровно тот класс ошибки, от которого защищает: новый модуль с
 * исходящим хендлером в перечень бы не попал и проверку прошёл невидимкой.
 * Заодно берём action-dispatch.ts: часть хендлеров (SPLIT_TASK,
 * CREATE_TEAM_CHANNEL) так и осталась инлайновым switch'ем и в lib/dispatch не
 * переехала.
 */
async function readDispatchSources(): Promise<Record<string, string>> {
  const names = [...(await Array.fromAsync(
    new Bun.Glob("*.ts").scan({ cwd: DISPATCH_DIR }),
  ))].sort();
  const out: Record<string, string> = {};
  for (const n of names) {
    out[`dispatch/${n}`] = await Bun.file(`${DISPATCH_DIR}${n}`).text();
  }
  out["action-dispatch.ts"] = await Bun.file(ACTION_DISPATCH).text();
  return out;
}

/** Строки кода без комментариев — чтобы объяснения не считались за код. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

describe("CHAT_PINNED_ACTIONS не разъехался с хендлерами", () => {
  test("список равен множеству вызовов pinnedChatId во всём lib/dispatch", async () => {
    const sources = await readDispatchSources();
    const called = new Set<string>();
    for (const src of Object.values(sources)) {
      // [^;] вместо [^)]: вызов, разложенный на несколько строк (с висячей
      // запятой перед скобкой), прежним шаблоном не распознавался, и тест
      // падал на чисто косметическом изменении. Чинить такое стали бы
      // удалением записи из списка — то есть возвращая враньё в аудит.
      for (const m of codeOnly(src).matchAll(
        /pinnedChatId\([^;]*?["']([A-Z_]+)(?:\.[a-z]+)?["']/g,
      )) {
        called.add(m[1]!);
      }
    }
    expect(called.size).toBeGreaterThan(0);
    expect([...called].sort()).toEqual([...CHAT_PINNED_ACTIONS].sort());
  });

  test("чат нигде не берётся из payload мимо pinnedChatId", async () => {
    // Прежняя формулировка была «каждый хендлер в OUTBOUND_MODULES обязан
    // звать pinnedChatId» и держалась на двух руками выписанных именах файлов
    // и на `split("export async function ")` — синхронный `export function
    // handleX` она не видела вовсе (а SCHEDULE_POST именно такой).
    //
    // Формулируем инвариант напрямую: адресат НЕ приходит из payload. Тогда
    // проверка не зависит ни от списка модулей, ни от того, зовёт ли хендлер
    // помощник — mac.ts, например, шлёт в ctx.chatId вообще без pinnedChatId,
    // и это правильно.
    const sources = await readDispatchSources();
    const leaks: string[] = [];
    for (const [mod, raw] of Object.entries(sources)) {
      // Маскируем оба помощника: pinnedChatId возвращает ctx.chatId, а
      // pinnedChatNote — строку заметки. Ни один не отдаёт чат из payload
      // наружу, поэтому чтение внутри их аргументов адресатом не является;
      // всё остальное — является.
      const src = codeOnly(raw).replace(
        /pinnedChat(?:Id|Note)\([^;]*?\)/g,
        "«pinned»",
      );
      for (const m of src.matchAll(/\bp(?:ayload)?\.chat(?:_id|Id)\b/g)) {
        const line = src.slice(0, m.index).split("\n").length;
        leaks.push(`${mod}:${line} ${m[0]}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("резолвера «чат из payload» не осталось нигде", async () => {
    // Прежняя редакция допускала ровно одно употребление — выбор chat_id для
    // строки аудита у НЕпиннутых действий. Аудит 2026-08-28: там он и врал,
    // потому что чат из payload не описывает ничего ни у одного хендлера.
    // Теперь аудит берёт ctx.chatId всегда, а сам помощник удалён; проверка
    // больше не делает исключений, включая модуль, где он объявлялся.
    const sources = await readDispatchSources();
    for (const [mod, raw] of Object.entries(sources)) {
      const calls = [...codeOnly(raw).matchAll(/resolveChatId\(/g)].length;
      expect(`${mod}:${calls}`).toBe(`${mod}:0`);
    }
  });

  test("каждое действие, получающее chatId из инпута модели, пиннится", async () => {
    // Вход, а не выход. buildPayload читает chatId ИЗ СЫРОГО ИНПУТА МОДЕЛИ
    // (`i.chatId`) и раскладывает его по payload'ам — в том числе тем, чьи
    // схемы инструментов поле вообще не объявляют (CREATE_TASK, SPLIT_TASK).
    // Значит вопрос «а модель точно не может назвать чужой чат» решается не
    // схемой, а этим списком.
    const src = codeOnly(
      await Bun.file(`${DISPATCH_DIR}build-payload.ts`).text(),
    );
    const receives: string[] = [];
    let current: string | null = null;
    for (const line of src.split("\n")) {
      const c = line.match(/case "([A-Z_]+)":/);
      if (c) current = c[1]!;
      if (/^\s*chat_?[iI]d,\s*$/.test(line) && current) receives.push(current);
    }
    expect(receives.length).toBeGreaterThan(0);
    const unpinned = receives.filter((a) => !CHAT_PINNED_ACTIONS.has(a)).sort();
    expect(unpinned).toEqual([]);
  });
});
