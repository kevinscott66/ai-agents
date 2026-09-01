/**
 * Аудит 2026-08-08: карта вёдер росла бесконечно.
 *
 * Четыре из пяти форматов ключа содержат chatId и/или userId, то есть число
 * ключей задаёт не наш код, а тот, кто пишет боту: каждый новый собеседник или
 * группа оставляли запись навсегда. Отдельно: checkBucket клал в карту ПУСТОЙ
 * массив даже когда ничего не подтверждалось, а ingest-лимит вызывается на
 * каждом входящем сообщении — до всякой проверки прав.
 *
 * Ключевое свойство фикса — вытеснение здесь тождественно, а не компромиссно:
 * ведро, чей самый свежий штамп старше окна, при следующем обращении всё равно
 * было бы вычищено до пустого. Поэтому тесты ниже проверяют не только «память
 * не течёт», но и «лимит после вытеснения считает ровно так же».
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  checkAndConsumeIngestLimit,
  checkPerChatRateLimit,
  commitPerChatRateLimit,
  _bucketCount,
  _resetRateLimits,
} from "../lib/rate-limits.ts";
import { HOUR_MS, MINUTE_MS } from "../lib/time-constants.ts";

const T0 = 1_900_000_000_000;

beforeEach(() => {
  _resetRateLimits();
});

describe("вёдра не копятся по чужим chatId/userId", () => {
  test("тысяча разовых собеседников не оставляет тысячу записей", () => {
    // Каждый пишет один раз, потом больше никогда: ровно то, как выглядит
    // публичная группа или поток личек.
    for (let i = 0; i < 1000; i++) {
      const r = checkAndConsumeIngestLimit(-100_000 - i, 5_000 + i, T0 + i);
      expect(r.ok).toBe(true);
    }
    expect(_bucketCount()).toBe(1000);

    // Через час после последнего сообщения все они протухли. Достаточно одного
    // нового обращения, чтобы карта вернулась к своему реальному размеру.
    checkAndConsumeIngestLimit(-1, 1, T0 + HOUR_MS + 10_000);
    expect(_bucketCount()).toBe(1);
  });

  test("проверка без подтверждения не заводит ключ", () => {
    // checkPerChatRateLimit вызывается на пути, где действие может быть
    // отклонено дальше по цепочке. Раньше сам факт проверки создавал запись.
    expect(checkPerChatRateLimit(-777, "SEND_MESSAGE", T0).ok).toBe(true);
    expect(_bucketCount()).toBe(0);

    commitPerChatRateLimit(-777, "SEND_MESSAGE", T0);
    expect(_bucketCount()).toBe(1);
  });
});

describe("вытеснение не ослабляет лимит", () => {
  test("живое ведро переживает чистку и продолжает считать", () => {
    const chat = -555;
    // 30/мин по умолчанию — выбираем 30 сообщений в пределах окна.
    for (let i = 0; i < 30; i++) {
      expect(checkPerChatRateLimit(chat, "SEND_MESSAGE", T0 + i).ok).toBe(true);
      commitPerChatRateLimit(chat, "SEND_MESSAGE", T0 + i);
    }
    // Шум от посторонних чатов, из-за которого срабатывает чистка.
    for (let i = 0; i < 50; i++) {
      checkAndConsumeIngestLimit(-900_000 - i, i, T0 + 2_000 + i);
    }
    // 31-е внутри того же окна по-прежнему отбивается.
    const denied = checkPerChatRateLimit(chat, "SEND_MESSAGE", T0 + 3_000);
    expect(denied.ok).toBe(false);
    expect(denied.retryInMs).toBeGreaterThan(0);
  });

  test("после окна счёт начинается заново — как и до фикса", () => {
    const chat = -556;
    for (let i = 0; i < 30; i++) {
      checkPerChatRateLimit(chat, "SEND_MESSAGE", T0 + i);
      commitPerChatRateLimit(chat, "SEND_MESSAGE", T0 + i);
    }
    expect(checkPerChatRateLimit(chat, "SEND_MESSAGE", T0 + 1_000).ok).toBe(false);
    // Окно минута: за его пределами ведро пустое независимо от того, вытеснили
    // его или вычистили на месте.
    expect(
      checkPerChatRateLimit(chat, "SEND_MESSAGE", T0 + MINUTE_MS + 1_000).ok,
    ).toBe(true);
  });

  test("порог вытеснения тянется к самому длинному окну", () => {
    // GENERATE_IMAGE считает за час. Ведро, которому 10 минут, вытеснять нельзя
    // — иначе часовой лимит на дорогом действии сбрасывался бы поминутно.
    const chat = -557;
    checkPerChatRateLimit(chat, "GENERATE_IMAGE", T0);
    commitPerChatRateLimit(chat, "GENERATE_IMAGE", T0);
    expect(_bucketCount()).toBe(1);

    // Чужой трафик спустя 10 минут запускает чистку.
    checkAndConsumeIngestLimit(-42, 42, T0 + 10 * MINUTE_MS);
    expect(_bucketCount()).toBe(2);
  });
});
