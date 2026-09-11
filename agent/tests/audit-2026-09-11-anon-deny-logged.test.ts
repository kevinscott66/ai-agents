/**
 * Аудит 2026-09-11, круг 30: отбой анонимного ведра не оставлял в журнале
 * ничего — ровно там, где журнал нужнее всего.
 *
 * Ветка `preAuth` в `fetch()` возвращала 429 своим `return`'ом, а обе точки
 * access-лога стоят ниже: статическая — в ветке отдачи файла, общая — в
 * пост-обработке. Получалось расхождение между двумя видами одного и того же
 * отбоя: 429 от ретроспективного счёта (провал аутентификации на /api/) в лог
 * попадал, потому что идёт через пост-обработку, а 429 от `preAuth` — нет.
 *
 * Цена: при потоке в тысячи запросов с адреса владелец видит тормозящий Mini
 * App и флапающий /readyz, а в логе — десяток обычных строк и тишина. Сигнал
 * «идёт флуд, ведро держит» не выходил за пределы процесса.
 *
 * Второй тест здесь про объём: строка на каждый из ~2000 отбоев в секунду —
 * это исчерпание диска руками атакующего. Одна строка на ключ за окно плюс
 * счётчик проглоченных.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_anon_deny_log";

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import { startMiniappServer, type MiniappServerHandle } from "../lib/miniapp-server.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";
import { createLogThrottle } from "../lib/log-throttle.ts";
import { log } from "../lib/log.ts";

const BOT_TOKEN = "test_bot_token_for_anon_deny_log";
const USER_ID = 88011;

/** Зеркало ANON_LIMIT.capacity из miniapp-server — намеренная копия. */
const ANON_CAPACITY = 300;

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
});

beforeEach(() => {
  _resetRateLimiter();
});

/** Слить ведро и получить хотя бы один отбой. Возвращает число 429. */
async function drain(path: string, extra = 5): Promise<number> {
  let denied = 0;
  for (let i = 0; i < ANON_CAPACITY + extra; i++) {
    const r = await fetch(`${base}${path}`);
    await r.text().catch(() => {});
    if (r.status === 429) denied += 1;
  }
  return denied;
}

describe("отбой анонимного ведра виден в журнале", () => {
  /**
   * Один слив на весь describe, а не по одному на тест.
   *
   * Окно дросселя — секунда, и оно общее на процесс сервера. Три теста,
   * сливающих ведро подряд, укладываются в ту же секунду: первый получил бы
   * строки, а второй и третий — ноль, и «ноль строк» прошло бы мимо проверки
   * «строк меньше, чем отбоев». Тест, зелёный от того, что нечего проверять,
   * хуже отсутствующего.
   */
  let denied = 0;
  let lines: unknown[][] = [];

  beforeAll(async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      denied = await drain("/readyz", 60);
      lines = warn.mock.calls.filter((c) =>
        String(c[0]).includes("анонимное ведро отбило"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("429 из ветки preAuth пишет строку", () => {
    expect(denied).toBeGreaterThan(0);
    // До правки здесь был ноль: `return` из preAuth уходил раньше обеих точек
    // access-лога, и ни одна строка про эти 429 не писалась.
    expect(lines.length).toBeGreaterThan(0);
  });

  test("в строке есть путь, ключ и счётчик проглоченных", () => {
    const meta = lines[0]![1] as Record<string, unknown>;
    expect(meta.path).toBe("/readyz");
    // Ключ ведра, а не «адрес»: при XFF от доверенного пира это разные вещи.
    expect(String(meta.key)).toStartWith("anon:");
    expect(typeof meta.suppressed).toBe("number");
    expect(typeof meta.retryAfter).toBe("number");
  });

  test("шторм не печатается построчно", () => {
    // Точное число отбоев зависит от времени: ведро доливает 20 токенов в
    // секунду, и за те десятки миллисекунд, что идёт слив, один-два успевают
    // вернуться. Требовать ровно 60 — значит завести тест, падающий от
    // загрузки машины. Проверяем то, ради чего тест написан: отбоев много.
    expect(denied).toBeGreaterThan(30);
    // Окно — секунда, весь слив укладывается заведомо быстрее, так что строк
    // должно быть на порядок меньше самих отбоев, а не «просто меньше».
    expect(lines.length * 10).toBeLessThan(denied);
  });
});

describe("сам дроссель", () => {
  const W = 1_000;

  test("первое событие печатается, остальные в окне — нет", () => {
    const t = createLogThrottle(W);
    expect(t.take("a", 0)).toEqual({ emit: true, suppressed: 0 });
    expect(t.take("a", 1)).toEqual({ emit: false });
    expect(t.take("a", 999)).toEqual({ emit: false });
  });

  test("после окна печатается снова и приносит число проглоченных", () => {
    const t = createLogThrottle(W);
    t.take("a", 0);
    for (let i = 1; i <= 7; i++) t.take("a", i);
    expect(t.take("a", W)).toEqual({ emit: true, suppressed: 7 });
    // Счётчик сброшен: следующая строка не повторит то же число.
    for (let i = 1; i <= 2; i++) t.take("a", W + i);
    expect(t.take("a", 2 * W)).toEqual({ emit: true, suppressed: 2 });
  });

  test("ключи независимы", () => {
    const t = createLogThrottle(W);
    expect(t.take("a", 0).emit).toBe(true);
    expect(t.take("b", 0).emit).toBe(true);
    expect(t.take("a", 0).emit).toBe(false);
  });

  test("поток разных ключей не растит карту без предела", () => {
    const t = createLogThrottle(W, 16);
    for (let i = 0; i < 500; i++) t.take(`k${i}`, 0);
    // Это тот же урок, что у HARD_MAX_BUCKETS: при потоке РАЗНЫХ ключей
    // протухших записей нет, и «уборка по возрасту» потолка не даёт.
    expect(t.size()).toBe(16);
  });

  test("переполнение давит на молчание, а не на рост", () => {
    const t = createLogThrottle(W, 2);
    expect(t.take("a", 0).emit).toBe(true);
    expect(t.take("b", 0).emit).toBe(true);
    expect(t.take("c", 0).emit).toBe(false);
    expect(t.size()).toBe(2);
  });

  test("место освобождается, когда старые ключи замолчали", () => {
    const t = createLogThrottle(W, 2);
    t.take("a", 0);
    t.take("b", 0);
    // Окно по обоим истекло, глотать было нечего — записи больше ничего не
    // хранят, и новый ключ проходит.
    expect(t.take("c", W).emit).toBe(true);
    expect(t.size()).toBeLessThanOrEqual(2);
  });

  test("ключ с непрочитанным счётчиком переживает уборку", () => {
    const t = createLogThrottle(W, 2);
    t.take("a", 0);
    t.take("a", 1); // есть что рассказать: suppressed = 1
    t.take("b", 0); // рассказывать нечего

    // Место под "c" освобождает "b": его окно истекло и он ничего не хранит.
    expect(t.take("c", W).emit).toBe(true);
    // А "a" уборка не тронула — выбросить его значило бы потерять число
    // проглоченных, ради которого дроссель и заведён.
    expect(t.take("a", W)).toEqual({ emit: true, suppressed: 1 });
  });
});
