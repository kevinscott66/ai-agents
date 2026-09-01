/**
 * Аудит 2026-08-28: перезапуск поллинга долбился с постоянным шагом в 3 секунды.
 *
 * `launchWithRestart` ждал ровно `RESTART_DELAY_MS` перед каждой попыткой и не
 * различал сетевой сбой (пройдёт сам за секунды) и отказ, который сам не
 * пройдёт: отозванный токен (401), чужой инстанс на getUpdates (409),
 * упёршийся лимит (429). Telegraf на таких отклоняет launch немедленно, то
 * есть итерация стоит ~0 мс: получается ровно 20 попыток в минуту на бота, в
 * проде их двенадцать — ~4 запроса в секунду в Bot API и ~28 800 одинаковых
 * строк лога на бота в сутки. По 429 это ещё и продлевало сам лимит: модуль
 * `telegram-retry.ts` умеет читать `retry_after`, но цикл перезапуска его не
 * спрашивал.
 *
 * Теперь пауза удваивается до потолка, `retry_after` уважается, а удавшийся
 * прогон начинает счёт заново — иначе один обрыв через сутки работы ждал бы
 * минуту вместо трёх секунд.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  launchWithRestart,
  nextRestartDelayMs,
  MAX_RESTART_DELAY_MS,
  HEALTHY_RUN_MS,
  MAX_RETRY_AFTER_WAIT_MS,
  RESTART_DELAY_MS,
  type LaunchableBot,
} from "../lib/launch-restart.ts";
import { parseRetryAfterSeconds } from "../lib/telegram-retry.ts";

/**
 * Бот, у которого каждая попытка «живёт» заданное число миллисекунд по
 * подменённым часам, а потом завершается заданным образом.
 */
function fakeBot(steps: Array<{ livesMs?: number; rejectWith?: unknown }>): {
  bot: LaunchableBot;
  now: () => number;
} {
  let clock = 0;
  let i = 0;
  return {
    now: () => clock,
    bot: {
      def: { key: "orchestrator" },
      bot: {
        launch: async () => {
          const s = steps[Math.min(i, steps.length - 1)];
          i += 1;
          clock += s.livesMs ?? 0;
          if (s.rejectWith !== undefined) throw s.rejectWith;
          return undefined;
        },
      },
    },
  };
}

async function waitsOf(
  bot: LaunchableBot,
  now: () => number,
  opts: Parameters<typeof launchWithRestart>[1] = {},
): Promise<number[]> {
  const waits: number[] = [];
  await launchWithRestart(bot, {
    now,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...opts,
  });
  return waits;
}

describe("nextRestartDelayMs", () => {
  test("первая пауза — базовая, дальше удвоение", () => {
    expect(nextRestartDelayMs(3000, 1)).toBe(3000);
    expect(nextRestartDelayMs(3000, 2)).toBe(6000);
    expect(nextRestartDelayMs(3000, 3)).toBe(12_000);
    expect(nextRestartDelayMs(3000, 4)).toBe(24_000);
  });

  test("упирается в потолок и дальше не растёт", () => {
    expect(nextRestartDelayMs(3000, 5)).toBe(48_000);
    expect(nextRestartDelayMs(3000, 6)).toBe(MAX_RESTART_DELAY_MS);
    expect(nextRestartDelayMs(3000, 7)).toBe(MAX_RESTART_DELAY_MS);
  });

  test("длинный ряд неудач даёт потолок, а не Infinity и не NaN", () => {
    // 3000 * 2**1999 — это Infinity, а не число: без явной проверки
    // Math.min(Infinity, max) вернул бы потолок случайно.
    const v = nextRestartDelayMs(3000, 2000);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(MAX_RESTART_DELAY_MS);
  });

  test("нулевой и отрицательный счётчик не уводят паузу ниже базовой", () => {
    expect(nextRestartDelayMs(3000, 0)).toBe(3000);
    expect(nextRestartDelayMs(3000, -5)).toBe(3000);
  });

  test("потолок задаётся аргументом", () => {
    expect(nextRestartDelayMs(3000, 10, 9000)).toBe(9000);
  });
});

describe("пауза растёт от неудачи к неудаче", () => {
  test("шесть мгновенных отказов подряд — удвоение до потолка", async () => {
    // Ровно тот случай, ради которого правка: launch отклоняется сразу,
    // прогон не живёт ничего, причина сама не пройдёт.
    const { bot, now } = fakeBot([{ rejectWith: new Error("401: Unauthorized") }]);
    const waits = await waitsOf(bot, now, { maxRestarts: 6, delayMs: 3000 });
    expect(waits).toEqual([3000, 6000, 12_000, 24_000, 48_000, 60_000]);
  });

  test("мгновенные штатные завершения растут так же", async () => {
    // launch, который резолвится (поллинг просто остановился), тоже неудача:
    // до правки эта ветка ждала те же 3000 вечно.
    const { bot, now } = fakeBot([{}]);
    expect(await waitsOf(bot, now, { maxRestarts: 3, delayMs: 3000 })).toEqual([
      3000, 6000, 12_000,
    ]);
  });

  test("потолок можно опустить опцией", async () => {
    const { bot, now } = fakeBot([{}]);
    expect(
      await waitsOf(bot, now, { maxRestarts: 3, delayMs: 3000, maxDelayMs: 5000 }),
    ).toEqual([3000, 5000, 5000]);
  });
});

describe("удавшийся прогон начинает счёт заново", () => {
  test("после долгого прогона следующая пауза снова базовая", async () => {
    const { bot, now } = fakeBot([
      { livesMs: 0 },
      { livesMs: 0 },
      { livesMs: HEALTHY_RUN_MS }, // поллинг честно работал — не серия отказов
      { livesMs: 0 },
    ]);
    expect(await waitsOf(bot, now, { maxRestarts: 4, delayMs: 3000 })).toEqual([
      3000, 6000, 3000, 6000,
    ]);
  });

  test("прогон короче порога сбросом не считается", async () => {
    const { bot, now } = fakeBot([{ livesMs: HEALTHY_RUN_MS - 1 }]);
    expect(await waitsOf(bot, now, { maxRestarts: 3, delayMs: 3000 })).toEqual([
      3000, 6000, 12_000,
    ]);
  });

  test("порог настраивается", async () => {
    const { bot, now } = fakeBot([{ livesMs: 100 }]);
    expect(
      await waitsOf(bot, now, { maxRestarts: 3, delayMs: 3000, healthyRunMs: 50 }),
    ).toEqual([3000, 3000, 3000]);
  });
});

describe("429 от Telegram уважается", () => {
  const tooMany = (secs: number) => ({
    code: 429,
    description: "Too Many Requests: retry after " + secs,
    parameters: { retry_after: secs },
  });

  test("предпосылки: такую ошибку telegram-retry.ts разбирает", () => {
    expect(parseRetryAfterSeconds(tooMany(30))).toBe(30);
  });

  test("просьба подождать дольше нашей паузы — ждём столько, сколько просят", async () => {
    const { bot, now } = fakeBot([{ rejectWith: tooMany(30) }]);
    expect(await waitsOf(bot, now, { maxRestarts: 1, delayMs: 3000 })).toEqual([30_000]);
  });

  test("просьба короче нашей паузы её не сокращает", async () => {
    // Иначе 429 с retry_after: 1 обнулял бы весь набранный backoff.
    const { bot, now } = fakeBot([{ rejectWith: tooMany(1) }]);
    expect(await waitsOf(bot, now, { maxRestarts: 2, delayMs: 3000 })).toEqual([
      3000, 6000,
    ]);
  });

  test("блокировка на час не держит бота в паузе час", async () => {
    const { bot, now } = fakeBot([{ rejectWith: tooMany(3600) }]);
    expect(await waitsOf(bot, now, { maxRestarts: 1, delayMs: 3000 })).toEqual([
      MAX_RETRY_AFTER_WAIT_MS,
    ]);
  });

  test("обычный отказ ждёт по нашей арифметике, а не по чужому тексту", async () => {
    // 5xx от промежуточного прокси со словами про retry after — не 429.
    const { bot, now } = fakeBot([
      { rejectWith: { code: 502, description: "Bad Gateway: retry after 900" } },
    ]);
    expect(await waitsOf(bot, now, { maxRestarts: 1, delayMs: 3000 })).toEqual([3000]);
  });
});

describe("прежние инварианты не съехали", () => {
  test("dropPendingUpdates по-прежнему только на холодном старте", async () => {
    const calls: boolean[] = [];
    const bot: LaunchableBot = {
      def: { key: "orchestrator" },
      bot: {
        launch: async (opts) => {
          calls.push(opts.dropPendingUpdates);
          return undefined;
        },
      },
    };
    await launchWithRestart(bot, { maxRestarts: 2, sleep: async () => {} });
    expect(calls).toEqual([true, false, false]);
  });

  test("базовая пауза осталась прежней", () => {
    expect(RESTART_DELAY_MS).toBe(3000);
  });
});

describe("применение", () => {
  const SRC = readFileSync(new URL("../lib/launch-restart.ts", import.meta.url), "utf8");
  const CODE = SRC.split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  test("цикл считает паузу функцией, а не берёт delayMs как есть", () => {
    expect(CODE).toContain("nextRestartDelayMs(delayMs, consecutive, maxDelayMs)");
    expect(CODE).toContain("await sleep(waitMs);");
    expect(CODE).not.toContain("await sleep(delayMs)");
  });

  test("retry_after читается тем же разбором, что и у отправки", () => {
    expect(CODE).toContain('from "./telegram-retry.ts"');
    expect(CODE).toContain("parseRetryAfterSeconds(e)");
  });

  test("в логе стоит фактическая пауза, а не базовая", () => {
    expect(CODE).toContain("restart in ${waitMs}ms");
    expect(CODE).not.toContain("restart in ${delayMs}ms");
  });
});
