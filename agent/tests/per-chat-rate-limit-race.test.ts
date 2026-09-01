/**
 * Аудит 2026-08-09: гонка check-then-act в чат-лимитах.
 *
 * T-314 закрыл её для агентских бакетов и оставил абзац-предупреждение прямо
 * над своим кодом. Чат-бакеты (T-315 per-chat и T-240 per-bot-per-chat) при
 * этом остались в исходном виде: проверка в начале gateOrDispatch, коммит —
 * ПОСЛЕ `await dispatchAndAudit`. Telegraf разбирает пачку из getUpdates через
 * Promise.all, так что параллельные ходы — обычный режим, а не экзотика.
 *
 * Почему это важнее, чем кажется: агентский лимит чат не защищает. У двенадцати
 * ролей двенадцать своих корзин, и «не больше N сообщений в минуту в этот чат»
 * держится ровно на per-chat. Именно он и не держался под нагрузкой.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { gateOrDispatch } from "../lib/action-dispatch.ts";
import {
  checkAndConsumeChatRateLimits,
  refundChatRateLimits,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_913;
const ENV_KEY = "RATE_LIMIT_PER_CHAT_PER_MIN";
const PER_CHAT_MAX = 3;
const AGENTS = [
  "orchestrator", "pm", "product", "backend", "frontend", "tgdev",
  "aieng", "qa", "smm", "copy", "design", "perm",
];

let savedGlobal = saveAutonomy();
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = String(PER_CHAT_MAX);
  _resetRateLimits();
  cleanupChat(CHAT);
  for (const a of AGENTS) cleanupChat(CHAT, a);
  savedGlobal = saveAutonomy();
  setAutonomy("global", "*", "auto");
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(CHAT);
  for (const a of AGENTS) cleanupChat(CHAT, a);
});

function fakeTg() {
  return {
    callApi: mock(() => Promise.resolve(true)),
    sendMessage: mock(async () => {
      // Задержка не обязательна для воспроизведения (хватает и микротаска), но
      // делает окно между check и commit явным.
      await Promise.resolve();
      await Promise.resolve();
      return { message_id: 1 };
    }),
    deleteMessage: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    pinChatMessage: mock(() => Promise.resolve(true)),
    forwardMessage: mock(() => Promise.resolve({ message_id: 1 })),
    sendPoll: mock(() => Promise.resolve({ message_id: 1 })),
    sendPhoto: mock(() => Promise.resolve({ message_id: 77 })),
  };
}

describe("per-chat лимит держится при параллельных ходах", () => {
  test("12 ролей одновременно шлют в один чат — проходит не больше лимита", async () => {
    const tg = fakeTg();
    const results = await Promise.all(
      AGENTS.map((agentKey, i) =>
        gateOrDispatch(
          "SEND_MESSAGE",
          { text: `hi ${i}` },
          { agentKey, chatId: CHAT, telegram: tg as never },
        ),
      ),
    );
    const ok = results.filter((r) => r.kind === "ok").length;
    // До фикса проходили все двенадцать: каждый видел пустую корзину на входе,
    // а коммит случался уже после отправки. Агентские лимиты тут не при чём —
    // у каждой роли своя корзина, и ни одна не переполнена.
    expect(ok).toBe(PER_CHAT_MAX);
    expect(tg.sendMessage).toHaveBeenCalledTimes(PER_CHAT_MAX);
    for (const r of results.filter((x) => x.kind !== "ok")) {
      expect(r.kind).toBe("rate_limited");
    }
  });

  test("один агент, параллельная пачка — тот же лимит", async () => {
    const tg = fakeTg();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        gateOrDispatch(
          "SEND_MESSAGE",
          { text: `hi ${i}` },
          { agentKey: "pm", chatId: CHAT, telegram: tg as never },
        ),
      ),
    );
    expect(results.filter((r) => r.kind === "ok").length).toBe(PER_CHAT_MAX);
  });

  test("соседний чат не задет", async () => {
    const tg = fakeTg();
    const other = CHAT - 1;
    try {
      await Promise.all([
        ...AGENTS.map((agentKey) =>
          gateOrDispatch(
            "SEND_MESSAGE",
            { text: "x" },
            { agentKey, chatId: CHAT, telegram: tg as never },
          ),
        ),
        gateOrDispatch(
          "SEND_MESSAGE",
          { text: "y" },
          { agentKey: "pm", chatId: other, telegram: tg as never },
        ),
      ]).then((rs) => {
        expect(rs[rs.length - 1]!.kind).toBe("ok");
      });
    } finally {
      cleanupChat(other);
      cleanupChat(other, "pm");
    }
  });

  test("после провала отправки слот чата возвращается", async () => {
    const tg = fakeTg();
    tg.sendMessage = mock(async () => {
      throw new Error("bot was kicked from the group chat");
    });
    for (let i = 0; i < 5; i++) {
      await gateOrDispatch(
        "SEND_MESSAGE",
        { text: `boom ${i}` },
        { agentKey: "pm", chatId: CHAT, telegram: tg as never },
      );
    }
    // Пять провалов подряд не должны съесть лимит чата: рефанд у чат-бакетов
    // такой же, как у агентских (кроме NO_REFUND_ACTIONS).
    const ok = fakeTg();
    const r = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "теперь получилось" },
      { agentKey: "pm", chatId: CHAT, telegram: ok as never },
    );
    expect(r.kind).toBe("ok");
  });
});

describe("резервация чат-бакетов как примитив", () => {
  test("N параллельных резерваций — ровно лимит побеждает", async () => {
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.resolve().then(() =>
          checkAndConsumeChatRateLimits(undefined, CHAT, "SEND_MESSAGE", now),
        ),
      ),
    );
    expect(results.filter((r) => r.ok).length).toBe(PER_CHAT_MAX);
  });

  test("бакет бота — отдельное измерение поверх чата", () => {
    const now = Date.now();
    // Один бот выбирает свою корзину; общая корзина чата тоже расходуется.
    for (let i = 0; i < PER_CHAT_MAX; i++) {
      expect(checkAndConsumeChatRateLimits(7, CHAT, "SEND_MESSAGE", now).ok).toBe(
        true,
      );
    }
    const denied = checkAndConsumeChatRateLimits(8, CHAT, "SEND_MESSAGE", now);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("per chat");
  });

  test("проигравший бот-бакет не съедает слот чата", () => {
    const now = Date.now();
    // Забиваем корзину конкретного бота, оставляя место в корзине чата.
    process.env[ENV_KEY] = "10";
    for (let i = 0; i < 10; i++) {
      checkAndConsumeChatRateLimits(9, CHAT, "SEND_MESSAGE", now);
    }
    process.env[ENV_KEY] = String(PER_CHAT_MAX);
    // Теперь у бота 9 корзина переполнена; отказ не должен списать слот чата
    // — иначе один залипший бот выключает чат для остальных.
    const before = checkAndConsumeChatRateLimits(9, CHAT, "SEND_MESSAGE", now);
    expect(before.ok).toBe(false);
  });

  test("рефанд возвращает ровно один слот", () => {
    const now = Date.now();
    for (let i = 0; i < PER_CHAT_MAX; i++) {
      expect(
        checkAndConsumeChatRateLimits(undefined, CHAT, "SEND_MESSAGE", now).ok,
      ).toBe(true);
    }
    expect(
      checkAndConsumeChatRateLimits(undefined, CHAT, "SEND_MESSAGE", now).ok,
    ).toBe(false);
    refundChatRateLimits(undefined, CHAT, "SEND_MESSAGE", now);
    expect(
      checkAndConsumeChatRateLimits(undefined, CHAT, "SEND_MESSAGE", now).ok,
    ).toBe(true);
    expect(
      checkAndConsumeChatRateLimits(undefined, CHAT, "SEND_MESSAGE", now).ok,
    ).toBe(false);
  });

  test("GENERATE_IMAGE слот чата не возвращается — как и агентский", () => {
    const now = Date.now();
    expect(
      checkAndConsumeChatRateLimits(undefined, CHAT, "GENERATE_IMAGE", now).ok,
    ).toBe(true);
    refundChatRateLimits(undefined, CHAT, "GENERATE_IMAGE", now);
    // Деньги OpenAI уже потрачены внутри dispatch'а — рефанд превратил бы
    // цикл падающих отправок в неограниченный счёт (см. NO_REFUND_ACTIONS).
    for (let i = 0; i < PER_CHAT_MAX - 1; i++) {
      checkAndConsumeChatRateLimits(undefined, CHAT, "GENERATE_IMAGE", now);
    }
    expect(
      checkAndConsumeChatRateLimits(undefined, CHAT, "GENERATE_IMAGE", now).ok,
    ).toBe(false);
  });

  test("без chatId резервация ничего не занимает", () => {
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      expect(
        checkAndConsumeChatRateLimits(1, undefined, "SEND_MESSAGE", now).ok,
      ).toBe(true);
    }
  });
});
