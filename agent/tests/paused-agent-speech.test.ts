/**
 * Аудит 2026-08-09: пауза не затыкала главное — обычную речь.
 *
 * `isAgentPaused` до этого читался ровно из одного места — evaluateGate
 * (lib/permissions.ts). Гейт стоит на пути ДЕЙСТВИЙ, а текстовый ответ агента
 * уходит мимо него (ctx.reply / sendChunked в orchestrator/message-handler.ts,
 * respondAs в lib/handoff.ts). То есть поставленный на паузу агент продолжал
 * разговаривать в чате — именно тем и занимаясь, ради чего паузу нажимают.
 *
 * Здесь проверяется воронка handoff: через respondAs агент на паузе выходил в
 * чат чужими руками (@-упоминание, любой прямой вызов). Проверяем не только
 * возвращённый null, но и то, что до отправки typing дело не дошло — иначе
 * тест зелёный и тогда, когда пауза просто утонула в catch внутри respondAs.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { respondAs } from "../lib/handoff.ts";
import type { HandoffDeps } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";

const CHAT = "-100778";
const TARGET = "design";
const CALLER = "orchestrator";

function setPaused(agentKey: string, paused: 0 | 1) {
  db.prepare(
    `INSERT INTO agent_states(agent_key, paused, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       paused = excluded.paused,
       updated_at = excluded.updated_at`,
  ).run(agentKey, paused, Date.now());
}

/** Бот-заглушка: единственное, что нам нужно наблюдать, — дошло ли до typing. */
function fakeBot(key: string) {
  const sendChatAction = mock(async () => {});
  const bot = {
    def: { key, name: key, envToken: "", system: "" },
    bot: { telegram: { sendChatAction } },
    username: `${key}_bot`,
    id: 100,
  } as unknown as RunningBot;
  return { bot, sendChatAction };
}

const deps = (): HandoffDeps => ({
  anthropic: {} as never,
  model: "test-model",
  historyLimit: 5,
  bots: [],
});

afterEach(() => {
  db.prepare("DELETE FROM agent_states WHERE agent_key = ?").run(TARGET);
});

describe("пауза — агент молчит и когда его зовут через handoff", () => {
  test("цель на паузе: respondAs отдаёт skipped с причиной и не начинает ход", async () => {
    setPaused(TARGET, 1);
    const { bot, sendChatAction } = fakeBot(TARGET);

    const outcome = await respondAs(
      {
        target: bot,
        chatId: CHAT,
        triggerText: "@design сделай баннер",
        triggerAgentKey: CALLER,
        depth: 0,
        visited: new Set([CALLER]),
      },
      deps(),
    );

    // «Пропущено», а не «упало»: до правки 2026-08-13 оба исхода приходили
    // одним и тем же null, и различить их выше по стеку было нечем.
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("ожидался skipped");
    expect(outcome.reason).toContain("paused");
    // Ключевая проверка: до фикса сюда доходило — агент на паузе показывал
    // «печатает…» и шёл в модель. Один лишь статус ничего не доказывает.
    expect(sendChatAction).not.toHaveBeenCalled();
  });

  test("после снятия паузы ход начинается как обычно", async () => {
    setPaused(TARGET, 0);
    const { bot, sendChatAction } = fakeBot(TARGET);

    // Ход развалится дальше (anthropic — заглушка), нас интересует только то,
    // что воронка его пропустила: пауза не должна резать снятую с паузы роль.
    await respondAs(
      {
        target: bot,
        chatId: CHAT,
        triggerText: "@design сделай баннер",
        triggerAgentKey: CALLER,
        depth: 0,
        visited: new Set([CALLER]),
      },
      deps(),
    ).catch(() => null);

    expect(sendChatAction).toHaveBeenCalled();
  });

  test("пауза одной роли не задевает соседнюю", async () => {
    setPaused(TARGET, 1);
    const { bot, sendChatAction } = fakeBot("frontend");

    await respondAs(
      {
        target: bot,
        chatId: CHAT,
        triggerText: "@frontend поправь вёрстку",
        triggerAgentKey: CALLER,
        depth: 0,
        visited: new Set([CALLER]),
      },
      deps(),
    ).catch(() => null);

    expect(sendChatAction).toHaveBeenCalled();
  });
});

describe("пауза — основной вход речи в message-handler", () => {
  // Хендлер апдейта поднять в тесте нечем (telegraf ctx + живые боты), поэтому
  // проверяем форму источника — тот же приём, что в turn-error-visible.test.ts.
  // Важна не только сама проверка, но и её место: если она уедет ниже
  // shouldProcessTrigger или rate-limit, агент на паузе снова начнёт тратить
  // токены и чужие счётчики, просто не показывая результат.
  const SRC = readFileSync(
    new URL("../orchestrator/message-handler.ts", import.meta.url),
    "utf8",
  );

  test("речь остановленного агента обрывается до хода", () => {
    // agentStopReason — это paused ИЛИ disabled: выключенный агент тоже молчит.
    expect(SRC).toMatch(/const stopReason = agentStopReason\(def\.key\);/);
    expect(SRC).toMatch(/if \(stopReason\) \{/);
  });

  test("проверка стоит раньше анти-дупа и rate-limit", () => {
    const paused = SRC.indexOf("const stopReason = agentStopReason(def.key)");
    const antiDup = SRC.indexOf("shouldProcessTrigger(chatId");
    const rateLimit = SRC.indexOf("checkAndConsumeIngestLimit(chatId");
    expect(paused).toBeGreaterThan(0);
    expect(antiDup).toBeGreaterThan(paused);
    expect(rateLimit).toBeGreaterThan(paused);
  });
});
