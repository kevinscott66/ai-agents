/**
 * Аудит 2026-08-11: паузу из заголовка `retry-after` никто не ограничивал.
 *
 * 2026-08-04 чинили соседнюю половину той же ветки — собственную догадку: она
 * удваивалась с потолком `Math.min(backoff429 * 2, 30_000)`, и инвариант
 * записан в tests/anthropic-429-backoff.test.ts. Число, пришедшее ПО СЕТИ,
 * потолка не получило вовсе. То есть своей оценке код не доверяет дольше 30
 * секунд, а чужой — сколько угодно.
 *
 * Почему это не косметика: `acquire()` стоит ДО цикла, `release()` — в
 * `finally`, то есть спит вызов, ДЕРЖА слот конкурентности. Слотов по
 * умолчанию три (ANTHROPIC_MAX_CONCURRENCY). Три ответа с большим
 * `retry-after` — и ни один из 12 агентов процесса больше не ходит в API:
 * очередь `queue` растёт, таймаута у ожидания нет, снаружи это выглядит как
 * «боты молчат», а не как ошибка. Заголовок при этом приходит не только от
 * самого API: между нами и ним может стоять прокси или балансировщик.
 * HTTP-date-форма ещё щедрее — дата в следующем году даёт паузу в месяцы.
 *
 * Потолок в минуту не произволен: лимиты Anthropic считаются в минутном окне
 * (RPM/ITPM/OTPM), поэтому осмысленный `retry-after` в него укладывается, а
 * при пяти попытках ожидание сверху ограничено пятью минутами вместо суток.
 *
 * Инвариант: пауза перед повтором ограничена сверху, кто бы её ни назначил.
 *
 * Аудит 2026-08-20 — ожидание про ноль ниже пересмотрено. Оно требовало, чтобы
 * `retry-after: 0` возвращался как 0 мс («можно сразу»). В 429-ветке это два
 * эффекта, а не один: пауза становится меньше jitter'а И собственная догадка
 * `backoff429` перестаёт удваиваться, потому что `ra !== undefined`. Шесть
 * попыток улетают в тот же перегруженный лимит за секунду — то есть заголовок
 * ровно выключал защиту, ради которой этот файл и написан. Цена обратного
 * решения: сервер, который честно имел в виду «прямо сейчас», подождёт секунду.
 * Инвариант файла (пауза ограничена сверху) при этом не тронут — добавился пол.
 */
import { describe, test, expect } from "bun:test";
import {
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
} from "../lib/anthropic-client.ts";


/** Заголовки приходят и объектом, и Headers-подобным — проверяем оба пути. */
function asRecord(v: string) {
  return { headers: { "retry-after": v } };
}
function asHeaders(v: string) {
  return { headers: { get: (k: string) => (k === "retry-after" ? v : null) } };
}

describe("retry-after: секунды", () => {
  test("разумное значение проходит как есть", () => {
    expect(parseRetryAfterMs(asRecord("30"))).toBe(30_000);
    expect(parseRetryAfterMs(asHeaders("5"))).toBe(5_000);
  });

  test("ноль считается отсутствием заголовка — иначе бэкофф не растёт", () => {
    // 429 и «повторяй немедленно» вместе не значат ничего: сервер только что
    // отказал по лимиту. Пусть работает собственный экспоненциальный отступ.
    expect(parseRetryAfterMs(asRecord("0"))).toBeUndefined();
    expect(parseRetryAfterMs(asHeaders("0"))).toBeUndefined();
  });

  test("сутки урезаются до потолка", () => {
    expect(parseRetryAfterMs(asRecord("86400"))).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfterMs(asHeaders("86400"))).toBe(MAX_RETRY_AFTER_MS);
  });

  test("потолок — минута: минутное окно лимитов в него укладывается", () => {
    expect(MAX_RETRY_AFTER_MS).toBe(60_000);
    expect(parseRetryAfterMs(asRecord("60"))).toBe(60_000);
    expect(parseRetryAfterMs(asRecord("61"))).toBe(60_000);
  });
});

describe("retry-after: HTTP-date", () => {
  test("дальняя дата урезается до того же потолка", () => {
    const far = new Date(Date.now() + 400 * 24 * 3600_000).toUTCString();
    expect(parseRetryAfterMs(asRecord(far))).toBe(MAX_RETRY_AFTER_MS);
  });

  test("близкая дата остаётся собой", () => {
    const soon = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(asRecord(soon));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(11_000);
  });

  test("прошедшая дата не даёт отрицательной паузы", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(asRecord(past))).toBeUndefined();
  });
});

describe("прежние правила разбора не тронуты", () => {
  test("без заголовка — undefined, чтобы работала своя догадка", () => {
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs(asRecord("не число и не дата"))).toBeUndefined();
  });

  test("заголовок из err.response тоже читается", () => {
    expect(
      parseRetryAfterMs({ response: { headers: { "retry-after": "7" } } }),
    ).toBe(7_000);
  });

  test("отрицательные секунды не проходят как секунды", () => {
    // Number("-5") конечен, но пауза назад бессмысленна: ветка секунд её не
    // берёт, а Date.parse на такой строке даёт NaN — итог undefined.
    expect(parseRetryAfterMs(asRecord("-5"))).toBeUndefined();
  });
});
