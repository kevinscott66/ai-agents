/**
 * Аудит 2026-08-09: FLOOD_WAIT от Telegram не соблюдался ни внутри вызова, ни
 * между вызовами.
 *
 * (1) Внутри вызова. floodBackoffMs режет паузу до MAX_BACKOFF_MS (60s) — это
 *     правильно, держать вызов открытым сутки из-за FLOOD_WAIT_86400 нельзя.
 *     Но цикл ретраев спал урезанные 60s и стучался снова: на FLOOD_WAIT_300
 *     получалось четыре попытки за первые пять минут окна, которое сервер
 *     попросил переждать. Теперь потолок означает «столько ждать не будем — и
 *     повторять не будем»: ошибка уходит наверх сразу.
 *
 * (2) Между вызовами. Про полученный FLOOD_WAIT не помнил никто: локальное
 *     ведро коммитится только при успехе, так что после отказа оно считало,
 *     что мы не отправляли ничего. Следующее действие через минуту било в тот
 *     же бан. Молотьба просто переезжала из цикла в соседние вызовы.
 *
 * Для аккаунта ВЛАДЕЛЬЦА (юзербот — личный Telegram, не бот) цена ошибки —
 * длинная блокировка отправки, а не потерянное сообщение.
 *
 * Гермётично: без сети, без сна (инжектим _sleep и _now).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import {
  withUserbotFloodGuard,
  guardedUserbotCall,
  exceedsMaxFloodWait,
  floodCooldownRemainingMs,
  _resetFloodCooldowns,
  MAX_BACKOFF_MS,
} from "../lib/userbot-flood.ts";

const FLOOD_MAX_KEY = "USERBOT_FLOOD_MAX_PER_WINDOW";
// Аудит 2026-08-28: от него зависит, ведём мы кулдаун на роль или на аккаунт.
const ROUTER_KEY = "USERBOT_ROUTER_ENABLED";

let savedMax: string | undefined;
let savedRouter: string | undefined;

beforeEach(() => {
  savedMax = process.env[FLOOD_MAX_KEY];
  savedRouter = process.env[ROUTER_KEY];
  process.env[FLOOD_MAX_KEY] = "50";
  delete process.env[ROUTER_KEY]; // одна сессия на всех — прод-режим
  _resetRateLimits();
  _resetFloodCooldowns();
});

afterEach(() => {
  if (savedMax === undefined) delete process.env[FLOOD_MAX_KEY];
  else process.env[FLOOD_MAX_KEY] = savedMax;
  if (savedRouter === undefined) delete process.env[ROUTER_KEY];
  else process.env[ROUTER_KEY] = savedRouter;
  _resetRateLimits();
  _resetFloodCooldowns();
});

/** Фиктивные часы: тесты двигают время сами, реального сна нет. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("exceedsMaxFloodWait — граница потолка", () => {
  test("нет требования сервера — не превышает", () => {
    expect(exceedsMaxFloodWait(undefined)).toBe(false);
  });

  test("ровно потолок — укладываемся, ретраим", () => {
    expect(exceedsMaxFloodWait(MAX_BACKOFF_MS / 1000)).toBe(false);
  });

  test("секундой больше — уже нет", () => {
    expect(exceedsMaxFloodWait(MAX_BACKOFF_MS / 1000 + 1)).toBe(true);
  });

  test("FLOOD_WAIT_300 и FLOOD_WAIT_86400 — точно нет", () => {
    expect(exceedsMaxFloodWait(300)).toBe(true);
    expect(exceedsMaxFloodWait(86_400)).toBe(true);
  });
});

describe("длинный FLOOD_WAIT — ни одного повтора внутри окна", () => {
  test("FLOOD_WAIT_300: один вызов, ноль снов, ошибка наверх", async () => {
    const slept: number[] = [];
    let calls = 0;
    const err = new Error("FLOOD_WAIT_300");

    const res = await withUserbotFloodGuard(
      "smm",
      "-6001",
      async () => {
        calls++;
        throw err;
      },
      {
        _sleep: async (ms) => {
          slept.push(ms);
        },
        _recorder: null,
        maxFloodRetries: 3,
      },
    );

    expect(res.ok).toBe(false);
    expect(res.error).toBe(err);
    // До фикса: 4 вызова и 3 сна по 60s — все внутри пятиминутного окна.
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(res.floodRetries).toBe(1);
  });

  test("инцидент записывается — иначе про бан владельца никто не узнает", async () => {
    const lines: string[] = [];
    await withUserbotFloodGuard(
      "smm",
      "-6002",
      async () => {
        throw { seconds: 86_400, message: "FLOOD_WAIT_86400" };
      },
      {
        _sleep: async () => {},
        _recorder: (l) => lines.push(l),
      },
    );

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("FLOOD_WAIT_86400");
    expect(lines[0]).toContain("smm");
  });

  test("короткий FLOOD_WAIT по-прежнему пережидается целиком и ретраится", async () => {
    const slept: number[] = [];
    let calls = 0;

    const res = await withUserbotFloodGuard(
      "smm",
      "-6003",
      async () => {
        calls++;
        if (calls === 1) throw new Error("FLOOD_WAIT_30");
        return "sent";
      },
      {
        _sleep: async (ms) => {
          slept.push(ms);
        },
        _recorder: null,
      },
    );

    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
    // Ровно то, что попросил сервер, — не меньше.
    expect(slept).toEqual([30_000]);
  });
});

describe("кулдаун переживает вызов", () => {
  test("следующий вызов не доходит до Telegram внутри окна", async () => {
    const c = clock();
    let calls = 0;
    const send = async () => {
      calls++;
      throw new Error("FLOOD_WAIT_300");
    };

    const first = await withUserbotFloodGuard("smm", "-6004", send, {
      _sleep: async () => {},
      _recorder: null,
      _now: c.now,
    });
    expect(first.ok).toBe(false);
    expect(calls).toBe(1);

    // Минуту спустя другое действие того же агента — типичный сценарий.
    c.advance(60_000);
    const second = await withUserbotFloodGuard("smm", "-6009", send, {
      _sleep: async () => {},
      _recorder: null,
      _now: c.now,
    });

    // До фикса: calls === 2, то есть повторный стук в аккаунт внутри бана.
    expect(calls).toBe(1);
    expect(second.ok).toBe(false);
    expect(second.rateLimited?.reason).toContain("FLOOD_WAIT");
    expect(second.rateLimited?.retryInMs).toBe(240_000);
  });

  test("кулдаун отпускает по истечении срока", async () => {
    const c = clock();
    let calls = 0;

    await withUserbotFloodGuard(
      "copy",
      "-6005",
      async () => {
        calls++;
        throw new Error("FLOOD_WAIT_120");
      },
      { _sleep: async () => {}, _recorder: null, _now: c.now },
    );
    expect(floodCooldownRemainingMs("copy", c.now())).toBe(120_000);

    c.advance(120_001);
    const after = await withUserbotFloodGuard(
      "copy",
      "-6005",
      async () => {
        calls++;
        return "ok";
      },
      { _sleep: async () => {}, _recorder: null, _now: c.now },
    );

    expect(after.ok).toBe(true);
    expect(calls).toBe(2);
  });

  /**
   * Аудит 2026-08-28: тест назывался «бан одного агента не глушит остальных» и
   * описывал дефект. Пока USERBOT_ROUTER_ENABLED не "true", все роли шлют с
   * ОДНОЙ сессии владельца, и бан на ней — общий: молчать обязаны все, иначе
   * следующая роль бьёт в тот же бан. Раздельные кулдауны верны только когда
   * у роли своя сессия.
   */
  async function banSmm(c: ReturnType<typeof clock>): Promise<void> {
    await withUserbotFloodGuard(
      "smm",
      "-6006",
      async () => {
        throw new Error("FLOOD_WAIT_300");
      },
      { _sleep: async () => {}, _recorder: null, _now: c.now },
    );
  }

  test("на общей сессии бан одной роли глушит остальные", async () => {
    const c = clock();
    await banSmm(c);

    let called = 0;
    const other = await withUserbotFloodGuard(
      "design",
      "-6006",
      async () => {
        called++;
        return "ok";
      },
      { _sleep: async () => {}, _recorder: null, _now: c.now },
    );
    expect(called).toBe(0);
    expect(other.ok).toBe(false);
    expect(other.rateLimited?.reason).toContain("FLOOD_WAIT");
  });

  test("с роутером у роли своя сессия — чужой бан её не трогает", async () => {
    process.env[ROUTER_KEY] = "true"; // восстанавливает afterEach
    const c = clock();
    await banSmm(c);

    const other = await withUserbotFloodGuard("design", "-6006", async () => "ok", {
      _sleep: async () => {},
      _recorder: null,
      _now: c.now,
    });
    expect(other.ok).toBe(true);
  });

  test("успешная отправка снимает кулдаун", async () => {
    const c = clock();
    let calls = 0;
    await withUserbotFloodGuard(
      "pm",
      "-6007",
      async () => {
        calls++;
        if (calls === 1) throw new Error("FLOOD_WAIT_30");
        return "sent";
      },
      { _sleep: async () => {}, _recorder: null, _now: c.now },
    );
    // Внутри вызова паузу выждали, сервер принял отправку — держать запрет
    // дальше не за что.
    expect(floodCooldownRemainingMs("pm", c.now())).toBe(0);
  });

  test("отказ под кулдауном не сдвигает срок и не трогает сеть", async () => {
    const c = clock();
    let calls = 0;
    const hit = () =>
      withUserbotFloodGuard(
        "qa",
        "-6008",
        async () => {
          calls++;
          throw new Error("FLOOD_WAIT_600");
        },
        { _sleep: async () => {}, _recorder: null, _now: c.now },
      );

    await hit();
    expect(calls).toBe(1);

    // Почти всё окно позади; агент пробует снова.
    c.advance(599_000);
    await hit();

    // Вызов не дошёл до Telegram — значит и продлевать бан нечему: срок
    // остаётся ровно тем, что назвал сервер, отсчитанным от его ответа.
    expect(calls).toBe(1);
    expect(floodCooldownRemainingMs("qa", c.now())).toBe(1_000);
  });
});

describe("guardedUserbotCall — вызывающий узнаёт причину", () => {
  test("длинный FLOOD_WAIT прокидывается исходной ошибкой", async () => {
    const err = new Error("FLOOD_WAIT_300");
    await expect(
      guardedUserbotCall(
        "backend",
        "-6010",
        async () => {
          throw err;
        },
        { _sleep: async () => {}, _recorder: null },
      ),
    ).rejects.toBe(err);
  });

  test("вызов под кулдауном падает с человекочитаемым сроком", async () => {
    const c = clock();
    await withUserbotFloodGuard(
      "backend",
      "-6011",
      async () => {
        throw new Error("FLOOD_WAIT_300");
      },
      { _sleep: async () => {}, _recorder: null, _now: c.now },
    );

    await expect(
      guardedUserbotCall("backend", "-6011", async () => "ok", {
        _sleep: async () => {},
        _recorder: null,
        _now: c.now,
      }),
    ).rejects.toThrow(/FLOOD_WAIT.*300s/);
  });
});
