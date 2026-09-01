/**
 * Аудит 2026-08-20 — `getTriggerStats` обещал час и сутки, а знал одну минуту.
 *
 * `shouldProcessTrigger` при каждом вызове делает
 * `DELETE FROM processed_triggers WHERE processed_at < now - 60`. Поэтому окна
 * `lastHour` и `lastDay`, которые функция считала, в живом чате ненаблюдаемы:
 * все три числа совпадали и все три покрывали одну минуту.
 *
 * Ключевая разница с прежним тестом: тут строки попадают в таблицу ЧЕРЕЗ
 * `shouldProcessTrigger`, а не прямым INSERT'ом. Так проверяется мир, который
 * бывает в проде.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { shouldProcessTrigger, getTriggerStats } from "../lib/trigger-anti-dup.ts";

const CHAT = "audit-0820-stats";

beforeEach(() => {
  db.prepare(`DELETE FROM processed_triggers`).run();
});

describe("аудит 2026-08-20: окно статистики триггеров", () => {
  test("контракт называет длину окна явно", () => {
    const stats = getTriggerStats();
    expect(stats.windowSeconds).toBe(60);
  });

  test("ненаблюдаемых полей lastHour/lastDay больше нет", () => {
    const stats = getTriggerStats() as Record<string, unknown>;
    expect("lastHour" in stats).toBe(false);
    expect("lastDay" in stats).toBe(false);
  });

  test("после прохода через shouldProcessTrigger старое не доживает", () => {
    const now = Math.floor(Date.now() / 1000);
    // Строка старше окна — как будто чат работал два часа назад.
    db.prepare(
      `INSERT INTO processed_triggers (chat_id, tg_message_id, processed_at) VALUES (?, ?, ?)`,
    ).run(CHAT, 1, now - 7200);
    expect(getTriggerStats().total).toBe(1);

    // Один живой триггер — и уборка внутри shouldProcessTrigger сносит старьё.
    expect(shouldProcessTrigger(CHAT, 2)).toBe(true);

    const stats = getTriggerStats();
    expect(stats.total).toBe(1);
    expect(stats.inWindow).toBe(1);
  });

  test("реальный счёт равен числу свежих триггеров", () => {
    for (let i = 1; i <= 5; i++) expect(shouldProcessTrigger(CHAT, i)).toBe(true);
    const stats = getTriggerStats();
    expect(stats.inWindow).toBe(5);
    expect(stats.total).toBe(5);
  });

  test("дубль не увеличивает счёт", () => {
    expect(shouldProcessTrigger(CHAT, 42)).toBe(true);
    expect(shouldProcessTrigger(CHAT, 42)).toBe(false);
    expect(getTriggerStats().inWindow).toBe(1);
  });

  test("total может быть больше inWindow: уборка ленивая", () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO processed_triggers (chat_id, tg_message_id, processed_at) VALUES (?, ?, ?)`,
    ).run(CHAT, 100, now - 3600);
    db.prepare(
      `INSERT INTO processed_triggers (chat_id, tg_message_id, processed_at) VALUES (?, ?, ?)`,
    ).run(CHAT, 101, now);

    // Без единого вызова shouldProcessTrigger таблицу никто не подметает.
    const stats = getTriggerStats();
    expect(stats.inWindow).toBe(1);
    expect(stats.total).toBe(2);
  });

  test("граница окна включена, как и в самом дедупе", () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO processed_triggers (chat_id, tg_message_id, processed_at) VALUES (?, ?, ?)`,
    ).run(CHAT, 200, now - 60);
    // `>=` в обоих местах: строка ровно на границе видна поиску и ещё не
    // подметена строгим `<`. Иначе она не попадала бы ни под один предикат.
    expect(getTriggerStats().inWindow).toBe(1);
  });

  test("пустая таблица — нули, а не undefined", () => {
    const stats = getTriggerStats();
    expect(stats.inWindow).toBe(0);
    expect(stats.total).toBe(0);
  });
});
