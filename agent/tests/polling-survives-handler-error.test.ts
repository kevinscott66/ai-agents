/**
 * Аудит 2026-08-13: брошенный хендлер останавливал поллинг, а перезапуск стирал
 * очередь. Три части одной цепочки, каждая проверяется отдельно.
 *
 * 1. bot.catch не был зарегистрирован → дефолтный handleError telegraf
 *    (telegraf.js:84-91) ставит process.exitCode = 1 и ПЕРЕБРАСЫВАЕТ ошибку;
 *    reject уезжает в Promise.all внутри Polling.loop и роняет launch().
 * 2. launchWithRestart перезапускал с dropPendingUpdates: true — всё, что
 *    пользователи написали за время простоя, Telegram выбрасывал молча.
 * 3. Ответы admin-команд уходили голым reply() без разбиения: /audit 100 и
 *    /approvals переваливают 4096 символов, а это 400 от Telegram, то есть
 *    ровно тот throw из пункта 1.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { buildErrorGuard, GUARD_REPLY } from "../lib/bot-error-guard.ts";
import { launchWithRestart, type LaunchableBot } from "../lib/launch-restart.ts";
import { splitForTelegram, TELEGRAM_MESSAGE_HARD_LIMIT } from "../lib/telegram-chunking.ts";
import { registerAdminCommands } from "../lib/admin-commands.ts";
import { logAction } from "../lib/audit.ts";
import { db } from "../lib/db.ts";

const ALLOWED = ["-100777"];
const TEST_CHAT = -1_000_813;

function fakeCtx(chatId: number | undefined, reply?: () => Promise<any>) {
  const sent: string[] = [];
  return {
    sent,
    ctx: {
      chat: chatId === undefined ? undefined : { id: chatId },
      update: { update_id: 42 },
      reply: async (t: string) => {
        if (reply) return reply();
        sent.push(t);
        return { message_id: 1 };
      },
    } as never,
  };
}

describe("bot.catch не даёт хендлеру уронить поллинг", () => {
  test("ошибка хендлера не пробрасывается наружу", async () => {
    // Главное свойство: guard возвращает управление, а не бросает. Если бы он
    // бросил — telegraf зовёт его из своего catch, и reject уехал бы в
    // Promise.all ровно как без guard'а вовсе.
    const { ctx } = fakeCtx(-100777);
    const guard = buildErrorGuard("orchestrator", ALLOWED);
    await guard(new Error("хендлер упал"), ctx);
  });

  test("в разрешённом чате пользователь получает извинение", async () => {
    const { ctx, sent } = fakeCtx(-100777);
    await buildErrorGuard("orchestrator", ALLOWED)(new Error("бум"), ctx);
    expect(sent).toEqual([GUARD_REPLY]);
  });

  test("вне allowlist бот молчит", async () => {
    // Обещание «бот не разговаривает вне разрешённых чатов» важнее, чем
    // сообщить об ошибке тому, кто затащил бота к себе: ответ отсюда был бы
    // подсказкой, что бот жив и у него есть админ-поверхность.
    const { ctx, sent } = fakeCtx(-100999);
    await buildErrorGuard("orchestrator", ALLOWED)(new Error("бум"), ctx);
    expect(sent).toEqual([]);
  });

  test("апдейт без чата не роняет guard", async () => {
    const { ctx, sent } = fakeCtx(undefined);
    await buildErrorGuard("orchestrator", ALLOWED)(new Error("бум"), ctx);
    expect(sent).toEqual([]);
  });

  test("падение самого извинения тоже гасится", async () => {
    // Сбой мог быть в Telegram — тогда reply падает следом. Бросить отсюда
    // значит вернуть ровно ту цепочку, которую guard и убирает.
    const { ctx } = fakeCtx(-100777, async () => {
      throw new Error("429 too many requests");
    });
    await buildErrorGuard("orchestrator", ALLOWED)(new Error("бум"), ctx);
  });
});

describe("перезапуск не стирает очередь", () => {
  function spyBot(behaviour: (n: number) => Promise<unknown>): {
    bot: LaunchableBot;
    calls: boolean[];
  } {
    const calls: boolean[] = [];
    let n = 0;
    return {
      calls,
      bot: {
        def: { key: "orchestrator" },
        bot: {
          launch: (opts) => {
            calls.push(opts.dropPendingUpdates);
            n += 1;
            return behaviour(n);
          },
        },
      },
    };
  }

  const noSleep = async () => {};

  test("dropPendingUpdates только на холодном старте", async () => {
    // Было `dropPendingUpdates: true` внутри while(true): [true, true, true].
    const { bot, calls } = spyBot(async () => undefined);
    await launchWithRestart(bot, { maxRestarts: 2, sleep: noSleep });
    expect(calls).toEqual([true, false, false]);
  });

  test("падение launch тоже не даёт права сбросить очередь", async () => {
    // Именно этот путь и был больным: хендлер бросил → launch отклонён →
    // перезапуск → очередь простоя выброшена.
    const { bot, calls } = spyBot(async (n) => {
      if (n === 1) throw new Error("polling died");
      return undefined;
    });
    await launchWithRestart(bot, { maxRestarts: 2, sleep: noSleep });
    expect(calls).toEqual([true, false, false]);
  });

  test("ждём между попытками, удваивая паузу", async () => {
    const waits: number[] = [];
    const { bot } = spyBot(async () => undefined);
    await launchWithRestart(bot, {
      maxRestarts: 2,
      delayMs: 3000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    // Пауза перед каждым перезапуском, но не после последнего. Раньше здесь
    // стояло [3000, 3000]: пауза не росла никогда, и вечный отказ (401/409/429)
    // стоил трёх секунд на итерацию до конца времён. Аудит 2026-08-28 добавил
    // удвоение до потолка — разбор в
    // tests/audit-2026-08-28-launch-restart-backoff.test.ts.
    expect(waits).toEqual([3000, 6000]);
  });
});

describe("guard и цикл перезапуска действительно подключены", () => {
  // Проверка структурная осознанно: buildBot зовёт bot.telegram.getMe(), то есть
  // сеть и живой токен, а main() запускает 12 ботов и вечный цикл. Модули выше
  // проверены поведенчески; здесь остаётся ровно один вопрос — вызваны ли они.
  const SRC = readFileSync(
    new URL("../orchestrator-team.ts", import.meta.url),
    "utf8",
  );

  test("registerErrorGuard стоит до регистрации хендлеров", () => {
    const guard = SRC.indexOf("registerErrorGuard(bot,");
    expect(guard).toBeGreaterThan(-1);
    // Иначе апдейт, пришедший между регистрациями, остался бы без catch.
    for (const h of [
      "registerAdminCommands(",
      "registerVoiceHandler(",
      "registerMessageHandler(",
    ]) {
      expect(SRC.indexOf(h)).toBeGreaterThan(guard);
    }
  });

  test("локальный цикл перезапуска заменён общим", () => {
    // Локальная копия внутри main() и была тем местом, где dropPendingUpdates
    // стоял внутри while(true).
    // Аудит 2026-08-20: из того же модуля приехал stopAllSafely, поэтому
    // импорт больше не одиночный — инвариант тут в источнике, а не в списке.
    expect(SRC).toMatch(
      /import \{[^}]*\blaunchWithRestart\b[^}]*\} from "\.\/lib\/launch-restart\.ts"/,
    );
    // Ни одного собственного launch: единственный владелец опции —
    // launch-restart.ts. (Слово dropPendingUpdates в комментарии рядом — не
    // вызов, поэтому ищем именно вызов.)
    expect(SRC).not.toMatch(/\.launch\(/);
    expect(SRC).toMatch(/for \(const b of bots\) void launchWithRestart\(b\)/);
  });
});

describe("admin-команда отвечает частями, а не одним 400", () => {
  const ADMIN_ID = 4242;
  const ENV_KEY = "TELEGRAM_ADMIN_USER_IDS";

  /** Телеграф-подобный объект: нам нужен ровно `command(name, handler)`. */
  function fakeTelegraf() {
    const handlers = new Map<string, (ctx: any) => Promise<void>>();
    return {
      handlers,
      bot: { command: (n: string, h: any) => handlers.set(n, h) } as never,
    };
  }

  test("/audit на 100 записей уходит несколькими сообщениями", async () => {
    const before = process.env[ENV_KEY];
    process.env[ENV_KEY] = String(ADMIN_ID);
    try {
      for (let i = 0; i < 100; i++) {
        logAction({
          agentKey: "orchestrator",
          chatId: TEST_CHAT,
          // Самый длинный тип действия: с ним сотня строк даёт ~5.8k символов,
          // то есть ровно тот случай, на котором голый reply() ловит 400.
          actionType: "CREATE_DIAGNOSTIC_TASK",
          status: "ok",
        });
      }
      const { handlers, bot } = fakeTelegraf();
      registerAdminCommands(bot, {} as never, [String(TEST_CHAT)]);
      const sent: string[] = [];
      await handlers.get("audit")!({
        chat: { id: TEST_CHAT },
        from: { id: ADMIN_ID },
        message: { text: "/audit orchestrator 100" },
        reply: async (t: string) => {
          sent.push(t);
          return { message_id: sent.length };
        },
      });
      // Голый reply() отправил бы это одним сообщением — и получил бы 400 от
      // Telegram, то есть throw из хендлера.
      expect(sent.length).toBeGreaterThan(1);
      for (const part of sent) {
        expect(part.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_HARD_LIMIT);
      }
      expect(sent.join("")).toContain("orchestrator CREATE_DIAGNOSTIC_TASK ok");
    } finally {
      db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(
        String(TEST_CHAT),
      );
      if (before === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = before;
    }
  });
});

describe("длинный ответ admin-команды не роняет хендлер", () => {
  test("выдача /audit на 100 строк режется под лимит Telegram", () => {
    // Ровно та форма, что строит cmdAudit: `[ts] agent action status`.
    const reply = Array.from(
      { length: 100 },
      (_, i) =>
        `[2026-08-13 12:${String(i % 60).padStart(2, "0")}] orchestrator CREATE_DIAGNOSTIC_TASK ok`,
    ).join("\n");
    expect(reply.length).toBeGreaterThan(TELEGRAM_MESSAGE_HARD_LIMIT);
    const parts = splitForTelegram(reply);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      // Запас под префикс «(i/N)», который добавляет sendChunked.
      expect(p.length + 8).toBeLessThanOrEqual(TELEGRAM_MESSAGE_HARD_LIMIT);
    }
    // Ничего не потеряли по дороге — иначе «починка» была бы обрезкой.
    expect(parts.join("\n").split("\n")).toHaveLength(100);
  });
});
