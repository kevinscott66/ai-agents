/**
 * Аудит 2026-08-28: канал уезжал с половиной команды без права постить, и об
 * этом никто не говорил вслух.
 *
 * `handleCreateTeamChannel` строил `note` ровно из одного сигнала —
 * `unresolved.length`. А сигналов о частичной неудаче три, и два оставались
 * молчаливыми:
 *
 *  - `result.failed` — бот резолвнулся в @username, но Telegram отказал в
 *    правах админа (`getInputEntity`/`EditAdmin` бросили: бот не запущен
 *    владельцем, приватность, что угодно). Постить в канал он не сможет.
 *  - `result.floodWaitSeconds` — цикл приглашений оборван на середине по
 *    требованию сервера (userbot.ts останавливается на первом FLOOD_WAIT,
 *    аудит 2026-08-13). Остаток команды в канал не приглашён вовсе.
 *
 * Оба уезжали в ответ сырыми полями `result`, и ровно про это уже написан
 * вывод соседнего аудита 2026-08-27 в этой же функции: сырого списка мало,
 * поэтому `unresolved` и получил note со словами «не выдавай состав канала за
 * полный». `failed` — тот же класс с той же ценой, только пришёл он не от нас,
 * а от Telegram; `floodWaitSeconds` вдобавок пишется в `log.error`, которого
 * модель не видит никогда.
 *
 * Цена та же и несимметричная: канал неидемпотентен (`maxFloodRetries: 0`,
 * «создание канала необратимо, повтор плодит второй»), дорезолвить админа
 * задним числом действием нельзя. Значит единственный шанс сказать человеку,
 * что состав неполный, — этот самый ответ.
 *
 * Инвариант: `ok:true` у создания канала означает «канал есть», а не «состав
 * полный». Любая часть состава, не доехавшая до прав админа, названа в note.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { handleCreateTeamChannel } from "../lib/dispatch/channel.ts";
import { _resetFloodCooldowns } from "../lib/userbot-flood.ts";
import { db } from "../lib/db.ts";

const CHAT = -558001;

beforeEach(() => {
  // Тест с floodWaitSeconds взводит кулдаун на agentKey, и bun гоняет каталог
  // одним процессом: без сброса следующий вызов упрётся в гвард на входе и
  // вернёт ok:false — не по той причине, которую проверяем.
  _resetFloodCooldowns();
});

afterEach(() => {
  _resetFloodCooldowns();
  db.prepare(`DELETE FROM team_channels WHERE created_by_chat = ?`).run(CHAT);
});

interface Outcome {
  added?: string[];
  failed?: string[];
  floodWaitSeconds?: number;
}

/** Контекст с полностью резолвимыми ролями и предсказуемым исходом userbot'а. */
function ctx(outcome: Outcome, known?: Record<string, string>) {
  const resolve = known ?? {};
  return {
    agentKey: "orchestrator",
    chatId: CHAT,
    resolveAgent: (role: string) =>
      known
        ? resolve[role]
          ? ({ username: resolve[role] } as never)
          : undefined
        : ({ username: `@${role}_bot` } as never),
    resolveUserbot: async () =>
      ({
        isNoop: false,
        createTeamChannel: async (title: string, _about: string, usernames: string[]) => ({
          channelId: -1004242,
          title,
          added: outcome.added ?? usernames,
          failed: outcome.failed ?? [],
          ...(outcome.floodWaitSeconds !== undefined
            ? { floodWaitSeconds: outcome.floodWaitSeconds }
            : {}),
        }),
      }) as never,
  } as never;
}

async function create(outcome: Outcome, known?: Record<string, string>) {
  const r = await handleCreateTeamChannel(
    { title: "Канал", roles: ["smm", "backend"] } as never,
    ctx(outcome, known),
  );
  return r as { ok: boolean; result?: Record<string, unknown>; error?: string };
}

describe("предпосылки", () => {
  test("соседний сигнал в этой же функции уже говорится вслух", async () => {
    // Доктрина, которой не хватало failed/floodWaitSeconds: аудит 2026-08-27.
    const r = await create({}, { smm: "@smm_bot", orchestrator: "@orc_bot" });
    expect(r.ok).toBe(true);
    expect(String(r.result?.note)).toContain("backend");
  });

  test("частичная неудача не превращается в отказ — канал-то создан", async () => {
    // Отказ здесь был бы хуже молчания: модель попробует ещё раз и заведёт
    // второй канал, а первый останется висеть в аккаунте владельца.
    const r = await create({ added: ["smm_bot"], failed: ["backend_bot"] });
    expect(r.ok).toBe(true);
    expect(r.result?.channelId).toBe(-1004242);
  });
});

describe("отказ Telegram в правах админа назван вслух", () => {
  test("note называет бота, которому отказали", async () => {
    const r = await create({ added: ["smm_bot"], failed: ["backend_bot"] });
    expect(String(r.result?.note)).toContain("backend_bot");
  });

  test("note говорит, чем это кончится, а не только что случилось", async () => {
    const r = await create({ added: ["smm_bot"], failed: ["backend_bot"] });
    const note = String(r.result?.note);
    expect(note).toContain("постить");
    expect(note).toContain("не выдавай состав канала за полный");
  });

  test("сырой список из ответа никуда не делся", async () => {
    const r = await create({ added: ["smm_bot"], failed: ["backend_bot"] });
    expect(r.result?.failed).toEqual(["backend_bot"]);
  });
});

describe("оборванный на середине цикл приглашений назван вслух", () => {
  test("note называет паузу и то, что состав неполон", async () => {
    const r = await create({
      added: ["smm_bot"],
      failed: ["backend_bot", "orchestrator_bot"],
      floodWaitSeconds: 30,
    });
    const note = String(r.result?.note);
    expect(note).toContain("30");
    expect(note).toContain("backend_bot");
  });

  test("пауза без единого отказа всё равно названа", async () => {
    // Теоретический край: сервер попросил паузу на последнем боте, отказов нет.
    const r = await create({ added: ["smm_bot", "backend_bot"], floodWaitSeconds: 12 });
    expect(String(r.result?.note)).toContain("12");
  });
});

describe("несколько бед сразу — в одном note, а не вместо друг друга", () => {
  test("нерезолвнутая роль и отказ Telegram названы оба", async () => {
    const r = await create(
      { added: ["smm_bot"], failed: ["orc_bot"] },
      { smm: "@smm_bot", orchestrator: "@orc_bot" },
    );
    const note = String(r.result?.note);
    expect(note).toContain("backend"); // не резолвится вовсе
    expect(note).toContain("orc_bot"); // резолвится, но прав не получил
    expect(r.result?.unresolved).toEqual(["backend"]);
  });
});

describe("чистый успех не обрастает предупреждениями", () => {
  test("все на месте — ни note, ни unresolved", async () => {
    const r = await create({});
    expect(r.ok).toBe(true);
    expect(r.result?.note).toBeUndefined();
    expect(r.result?.unresolved).toBeUndefined();
  });

  test("отсутствующее поле failed не выдумывает предупреждение", async () => {
    // Хендл-заглушки в тестах возвращают ответ без `failed`; лишний note на
    // ровном месте — тот же обман, только в другую сторону.
    const r = await create({ failed: undefined });
    expect(r.result?.note).toBeUndefined();
  });
});
