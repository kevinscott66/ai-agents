/**
 * Аудит 2026-08-28: watchdog мерил не то, что обещает его шапка.
 *
 * Шапка `lib/watchdog.ts` говорит «каждый бот должен периодически получать
 * Telegram-апдейты», но отметка `markSeen` стояла ровно в двух хендлерах —
 * `bot.on("message")` и `bot.on("voice")`. Всё, что до них не доходит, для
 * watchdog'а не существовало.
 *
 * Главный такой путь — админ-команды: `registerAdminCommands` вешает
 * `bot.command(...)` ДО регистрации message-handler'а, и telegraf дальше в
 * `bot.on("message")` апдейт не пускает (это описано в `lib/admin-commands.ts`
 * прямым текстом). Совпадение адресов делает дефект точечным: админ-команды
 * регистрируются только на `orchestrator`, и `orchestrator` — единственный ключ
 * в дефолтном `chatAlertKeys`. Слепое пятно ровно на том боте, который
 * единственный алертит в чат.
 *
 * Отказ: оператор 4+ часа работает через `/tasks`, `/approvals`, `/approve` и
 * не пишет обычных реплик → бот отвечает на каждую команду, а на очередном тике
 * уходит «бот orchestrator молчит 245 мин, проверь токен/поллинг», и дальше
 * ежечасно (SUPPRESS_MS), при `WATCHDOG_TG_ALERTS=true` — в каждый чат из
 * allowlist.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  markSeen,
  registerSeenProbe,
  startWatchdog,
  _resetWatchdogState,
} from "../lib/watchdog.ts";
import type { RunningBot } from "../lib/types.ts";

/** Фейк telegraf-бота: копит middleware и умеет прогнать через них апдейт. */
function fakeBot() {
  const chain: ((ctx: unknown, next: () => Promise<void>) => Promise<void>)[] = [];
  return {
    use(mw: (ctx: unknown, next: () => Promise<void>) => Promise<void>) {
      chain.push(mw);
      return this;
    },
    /** Прогоняет апдейт по цепочке; `handled` — дошло ли до конечного хендлера. */
    async dispatch(ctx: unknown = {}): Promise<{ handled: boolean }> {
      let handled = false;
      const run = async (i: number): Promise<void> => {
        if (i >= chain.length) {
          handled = true;
          return;
        }
        await chain[i](ctx, () => run(i + 1));
      };
      await run(0);
      return { handled };
    },
    depth: () => chain.length,
  };
}

const runningBot = (key: string): RunningBot =>
  ({ def: { key }, username: `${key}_bot`, id: 1, bot: {} } as unknown as RunningBot);

beforeEach(() => _resetWatchdogState());
afterEach(() => _resetWatchdogState());

describe("проба на входе бота", () => {
  const PAST = () => Date.now() - 10_000;
  const wait = () => new Promise((r) => setTimeout(r, 150));

  test("апдейт-команда двигает счётчик", async () => {
    // Бот «молчит» 10 секунд...
    markSeen("orchestrator", PAST());
    const bot = fakeBot();
    registerSeenProbe(bot, "orchestrator");
    // ...и получает ровно тот апдейт, который в проде перехватывает
    // bot.command и дальше в bot.on("message") не пускает.
    await bot.dispatch({ update_id: 1, message: { text: "/tasks" } });

    const alerts: string[] = [];
    const wd = startWatchdog({
      bots: [runningBot("orchestrator")],
      alert: async (m) => void alerts.push(m),
      intervalMs: 30,
      silenceMs: 5000,
    });
    await wait();
    wd.stop();
    expect(alerts).toEqual([]);
  });

  test("контроль: без пробы тот же апдейт счётчик не двигает", async () => {
    markSeen("orchestrator", PAST());
    const alerts: string[] = [];
    const wd = startWatchdog({
      bots: [runningBot("orchestrator")],
      alert: async (m) => void alerts.push(m),
      intervalMs: 30,
      silenceMs: 5000,
    });
    await wait();
    wd.stop();
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]).toContain("orchestrator");
    expect(alerts[0]).toContain("молчит");
  });

  test("проба пропускает апдейт дальше по цепочке", async () => {
    const bot = fakeBot();
    registerSeenProbe(bot, "qa");
    const res = await bot.dispatch({ update_id: 2 });
    expect(res.handled).toBe(true);
  });

  test("проба — ровно одна middleware", () => {
    const bot = fakeBot();
    registerSeenProbe(bot, "qa");
    expect(bot.depth()).toBe(1);
  });

  test("отмечается ровно переданный ключ, не соседний", async () => {
    markSeen("design", PAST());
    markSeen("qa", PAST());
    const bot = fakeBot();
    registerSeenProbe(bot, "design");
    await bot.dispatch();

    const alerts: string[] = [];
    const wd = startWatchdog({
      bots: [runningBot("design"), runningBot("qa")],
      alert: async (m) => void alerts.push(m),
      intervalMs: 30,
      silenceMs: 5000,
      chatAlertKeys: new Set(["design", "qa"]),
    });
    await wait();
    wd.stop();
    const keys = alerts.map((a) => a.match(/бот (\w+)/)?.[1]);
    expect(keys).not.toContain("design");
    expect(keys).toContain("qa");
  });
});

describe("проводка", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const TEAM = read("../orchestrator-team.ts");
  const MH = read("../orchestrator/message-handler.ts");
  const VH = read("../orchestrator/voice-handler.ts");

  test("проба зарегистрирована в buildBot", () => {
    expect(TEAM).toContain("registerSeenProbe(bot, def.key);");
  });

  test("проба идёт раньше админ-команд и хендлеров", () => {
    const probe = TEAM.indexOf("registerSeenProbe(bot, def.key);");
    expect(probe).toBeGreaterThan(-1);
    for (const later of [
      "registerAdminCommands(",
      "registerVoiceHandler(",
      "registerMessageHandler(",
    ]) {
      expect(TEAM.indexOf(later)).toBeGreaterThan(probe);
    }
  });

  test("точечных отметок в хендлерах не осталось", () => {
    // Иначе один апдейт двигал бы счётчик дважды, а слепое пятно на командах
    // выглядело бы починенным только частично.
    expect(MH).not.toContain("markSeen");
    expect(VH).not.toContain("markSeen");
  });
});
