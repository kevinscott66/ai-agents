/**
 * Аудит 2026-09-10: порог вытеснения вёдер поднимался только в `checkBucket`,
 * а `reserveUserbotFloodSlots` работает с картой сам — читает ёмкость, пишет
 * слоты — и при этом зовёт вытеснение. Окно userbot-flood настраивается
 * переменной и допускает до семи суток, так что при
 * `USERBOT_FLOOD_WINDOW_MS` больше часа порог оставался часовым.
 *
 * Что это значит на практике: ведро, набранное владельцем, вычищал любой
 * посторонний вызов через час после последней записи — входящее сообщение
 * зовёт `checkAndConsumeIngestLimit`, тот зовёт вытеснение, — и следующая
 * резервация видела ведро пустым. Ограничение на личный аккаунт владельца
 * молча превращалось из «N за окно» в «N в час»: ровно тот антифлуд, ради
 * которого переменную и выставляют длинной.
 *
 * Тест рядом, `rate-limits-bucket-eviction.test.ts`, проверяет ровно это
 * свойство — но через `checkPerChatRateLimit`, то есть через путь, который и
 * так поднимал порог. Здесь путь второй.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  reserveUserbotFloodSlots,
  checkAndConsumeIngestLimit,
  _resetRateLimits,
  _bucketCount,
} from "../lib/rate-limits.ts";

const HOUR = 3_600_000;
const CHAR = "__evict_window_test__";
const CHAT = 991_001;

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  _resetRateLimits();
  // Окно шире часового порога по умолчанию — ровно случай из находки.
  setEnv("USERBOT_FLOOD_WINDOW_MS", String(6 * HOUR));
  setEnv("USERBOT_FLOOD_MAX_PER_WINDOW", "3");
  setEnv("USERBOT_FLOOD_ENABLED", "1");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
  _resetRateLimits();
});

describe("вытеснение не сбрасывает длинное окно userbot-flood", () => {
  test("ведро переживает посторонний вызов через час после последней записи", () => {
    const t0 = Date.now();
    const first = reserveUserbotFloodSlots(CHAR, CHAT, 3, t0);
    expect(first.ok).toBe(true);
    // Ведро полно: четвёртый слот в том же окне не даётся.
    expect(reserveUserbotFloodSlots(CHAR, CHAT, 1, t0 + 1000).ok).toBe(false);

    // Проходит час с небольшим. Постороннее входящее сообщение запускает
    // вытеснение — раньше оно и стирало ведро целиком.
    const later = t0 + HOUR + 60_000;
    checkAndConsumeIngestLimit(555, 777, later);

    expect(reserveUserbotFloodSlots(CHAR, CHAT, 1, later).ok).toBe(false);
    expect(_bucketCount()).toBeGreaterThan(0);
  });

  test("по истечении САМОГО окна слоты возвращаются", () => {
    const t0 = Date.now();
    expect(reserveUserbotFloodSlots(CHAR, CHAT, 3, t0).ok).toBe(true);
    const after = t0 + 6 * HOUR + 1000;
    expect(reserveUserbotFloodSlots(CHAR, CHAT, 3, after).ok).toBe(true);
  });

  test("резервация сама поднимает порог — до неё в процессе ничего не было", () => {
    // Отдельная проверка того, что порог поднимает именно этот путь, а не
    // случайный сосед: после _resetRateLimits порог снова часовой.
    _resetRateLimits();
    const t0 = Date.now();
    expect(reserveUserbotFloodSlots(CHAR, CHAT, 3, t0).ok).toBe(true);
    checkAndConsumeIngestLimit(556, 778, t0 + HOUR + 60_000);
    expect(reserveUserbotFloodSlots(CHAR, CHAT, 1, t0 + HOUR + 60_000).ok).toBe(false);
  });
});
