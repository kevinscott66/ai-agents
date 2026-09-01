/**
 * Аудит 2026-08-20: ведро юзербота считает УСПЕХИ, а не обращения к серверу.
 *
 * `withUserbotFloodGuard` проверяет ведро ДО `await fn()`, а коммитит после —
 * «Commit only on success». Ведро при этом защищает не бота, а личный аккаунт
 * владельца: «бана здесь стоит не сообщение, а личный Telegram» (докблок
 * exceedsMaxFloodWait). Считать надо обращения, а не удачные из них.
 *
 * Три следствия, каждое занижает счётчик:
 *
 *  1. Гонка. Между проверкой и коммитом стоит await. Пока первая отправка в
 *     полёте, вторая и третья видят то же самое свободное ведро и проходят —
 *     все разом. Превышение равно числу одновременных вызовов минус один, а
 *     вызовы идут от 12 ролей, делящих одну сессию.
 *  2. Ретраи. Цикл обращается к серверу до четырёх раз, коммит один.
 *  3. Ошибка после отправки. Таймаут или RPC-ошибка приходит и тогда, когда
 *     запрос до Telegram уже дошёл; такая попытка не считается вовсе.
 *
 * Занижение здесь всегда в опасную сторону: ведро разрешает больше, чем
 * настроено, ровно в тех случаях, когда аккаунт и так близок к бану.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { withUserbotFloodGuard, _resetFloodCooldowns } from "../lib/userbot-flood.ts";
import { userbotFloodCapacity, _resetRateLimits } from "../lib/rate-limits.ts";

const MAX_KEY = "USERBOT_FLOOD_MAX_PER_WINDOW";
let prevMax: string | undefined;

beforeEach(() => {
  prevMax = process.env[MAX_KEY];
  _resetRateLimits();
  _resetFloodCooldowns();
});
afterEach(() => {
  // env восстанавливаем всегда — иначе он течёт в соседние тесты.
  if (prevMax === undefined) delete process.env[MAX_KEY];
  else process.env[MAX_KEY] = prevMax;
  _resetRateLimits();
  _resetFloodCooldowns();
});

const noopSleep = async (_ms: number) => {};

describe("ведро считает обращения к серверу, а не успехи", () => {
  test("одновременные вызовы не проходят все разом мимо лимита", async () => {
    process.env[MAX_KEY] = "2";
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });

    // Три вызова стартуют, пока ни один не завершился, — ровно то состояние,
    // в котором проверка-до-await видит пустое ведро трижды.
    const runs = [0, 1, 2].map(() =>
      withUserbotFloodGuard("agentR", "-6001", async () => {
        started++;
        await gate;
        return "sent";
      }, { _sleep: noopSleep, _recorder: null }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toBe(2); // третий обязан быть отбит ДО обращения к серверу
    release();
    const res = await Promise.all(runs);
    const limited = res.filter((r) => r.rateLimited !== undefined);
    expect(limited.length).toBe(1);
    expect(limited[0]!.rateLimited!.reason).toContain("flood limit");
  });

  test("каждый ретрай — отдельное обращение, и оно учтено", async () => {
    process.env[MAX_KEY] = "5";
    let calls = 0;
    const r = await withUserbotFloodGuard("agentT", "-6002", async () => {
      calls++;
      if (calls < 3) throw new Error("FLOOD_WAIT_1");
      return "ok";
    }, { _sleep: noopSleep, _recorder: null, maxFloodRetries: 3 });

    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
    // Три обращения к серверу — три слота, а не один.
    expect(userbotFloodCapacity("agentT", "-6002").free).toBe(2);
  });

  test("ошибка после отправки всё равно занимает слот", async () => {
    process.env[MAX_KEY] = "5";
    const r = await withUserbotFloodGuard("agentE", "-6003", async () => {
      // Не FLOOD_WAIT: таймаут приходит и тогда, когда запрос уже ушёл.
      throw new Error("TIMEOUT");
    }, { _sleep: noopSleep, _recorder: null });

    expect(r.ok).toBe(false);
    expect(userbotFloodCapacity("agentE", "-6003").free).toBe(4);
  });

  test("успешная отправка по-прежнему занимает ровно один слот", async () => {
    process.env[MAX_KEY] = "5";
    const r = await withUserbotFloodGuard("agentS", "-6004", async () => "sent",
      { _sleep: noopSleep, _recorder: null });
    expect(r.ok).toBe(true);
    expect(r.value).toBe("sent");
    expect(userbotFloodCapacity("agentS", "-6004").free).toBe(4);
  });

  test("отказ на входе по ведру слот не тратит", async () => {
    process.env[MAX_KEY] = "1";
    await withUserbotFloodGuard("agentF", "-6005", async () => "sent",
      { _sleep: noopSleep, _recorder: null });
    expect(userbotFloodCapacity("agentF", "-6005").free).toBe(0);
    const second = await withUserbotFloodGuard("agentF", "-6005", async () => "sent",
      { _sleep: noopSleep, _recorder: null });
    expect(second.rateLimited).toBeDefined();
    // Ведро уже пусто; отказ не должен уводить счётчик дальше в минус.
    expect(userbotFloodCapacity("agentF", "-6005").free).toBe(0);
  });
});
