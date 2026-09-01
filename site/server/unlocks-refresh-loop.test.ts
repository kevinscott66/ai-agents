/**
 * Календарь разблокировок обновлялся ровно один раз — при старте процесса.
 *
 * `ensureUnlocks()` вызывается из `bootstrap()` и больше нигде; единственный
 * `setInterval` в index.ts чистит вёдра рейт-лимитера. TTL в 24 часа при этом
 * проверяется только в момент вызова, то есть работает как «протух ли кэш к
 * моменту рестарта», а не как расписание.
 *
 * Замер на живом delabs.space (2026-08-12):
 *
 *   /api/stats.updatedAt : 2026-06-23T10:48:27.914Z
 *   сейчас               : 2026-08-12T19:30Z
 *   простой              : 50 суток = 50× TTL
 *   будущих событий      : 40   (/api/unlocks?limit=100; в выдаче по умолчанию
 *                                 30 — это дефолт limit, а не отсев)
 *   последнее по дате    : 2027-03-24
 *
 * То есть блок «Ближайшие разблокировки» полтора месяца показывает июньский
 * снимок. Он не просто устарел, он ещё и худеет: `listUpcomingUnlocks` отдаёт
 * только `date >= now`, так что каждое прошедшее событие тихо выпадает, а
 * новых взамен не приходит — к весне 2027 календарь опустел бы сам, ничего
 * никому не сообщив. Суммы в долларах всё это время считались по июньским
 * ценам, а перенесённые и отменённые события так и висят в июньском виде.
 *
 * Инварианты здесь:
 *
 *  • после старта обновление повторяется само, а не ждёт рестарта;
 *  • период меньше TTL — иначе расписание не может попасть в окно свежести;
 *  • упавший тик (сеть, парсер) НЕ гасит расписание: сетевая ошибка не должна
 *    останавливать календарь навсегда — а именно так работает голый
 *    `setInterval(async () => { await mayThrow() })` с необработанным reject;
 *  • тик не накладывается сам на себя, если фид отвечает дольше периода.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-refresh-loop-"));
process.env.SITE_DB_PATH = join(TMP, "loop.db");

const { startUnlocksRefresh, UNLOCKS_REFRESH_INTERVAL_MS } = await import("./index.ts");
const { UNLOCKS_TTL_MS } = await import("./unlocks.ts");

const handles: Array<{ stop(): void }> = [];
const track = <T extends { stop(): void }>(h: T): T => (handles.push(h), h);
afterAll(() => handles.forEach((h) => h.stop()));

/** Дождаться, пока счётчик дорастёт до n (или упасть по таймауту). */
async function until(get: () => number, n: number, ms = 2000): Promise<number> {
  const deadline = Date.now() + ms;
  while (get() < n && Date.now() < deadline) await Bun.sleep(2);
  return get();
}

describe("расписание обновления разблокировок", () => {
  test("период меньше TTL — иначе фид не обновится ни разу", () => {
    expect(UNLOCKS_REFRESH_INTERVAL_MS).toBeLessThan(UNLOCKS_TTL_MS);
    expect(UNLOCKS_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
  });

  test("тики идут сами, без рестарта процесса", async () => {
    let calls = 0;
    track(startUnlocksRefresh(5, async () => (calls++, 0)));
    expect(await until(() => calls, 3)).toBeGreaterThanOrEqual(3);
  });

  test("упавший тик не гасит расписание", async () => {
    let calls = 0;
    track(
      startUnlocksRefresh(5, async () => {
        calls++;
        throw new Error("DefiLlama 503");
      }),
    );
    // Именно здесь ломался бы «наивный» вариант: один reject — и календарь
    // встал бы до следующего рестарта, ровно как сейчас в проде.
    expect(await until(() => calls, 3)).toBeGreaterThanOrEqual(3);
  });

  test("медленный фид не накладывает тик на тик", async () => {
    let started = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    track(
      startUnlocksRefresh(5, async () => {
        started++;
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await Bun.sleep(40); // фид отвечает в восемь раз дольше периода
        inFlight--;
        return 0;
      }),
    );
    await until(() => started, 2, 2000);
    expect(maxInFlight).toBe(1);
  });

  test("stop() останавливает: после него новых тиков нет", async () => {
    let calls = 0;
    const h = startUnlocksRefresh(5, async () => (calls++, 0));
    await until(() => calls, 2);
    h.stop();
    const after = calls;
    await Bun.sleep(50);
    expect(calls).toBe(after);
  });

  test("таймер не держит процесс живым", () => {
    const h = track(startUnlocksRefresh(60_000, async () => 0));
    // unref обязателен: иначе `bun test` и любой одноразовый скрипт,
    // импортировавший index.ts, висели бы до таймаута.
    expect(h.unrefd).toBe(true);
  });
});
