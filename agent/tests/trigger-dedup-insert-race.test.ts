/**
 * Дедуп триггеров опирается на результат вставки, а не на исключение
 * (аудит 2026-08-04).
 *
 * Ветка «race condition → считаем дублем» была мертва: `INSERT OR IGNORE` на
 * конфликте UNIQUE(chat_id, tg_message_id) НЕ бросает — он молча ничего не
 * делает. Вся защита держалась на SELECT'е выше, который с INSERT'ом не
 * атомарен. Внутри одного процесса это не стреляло (между SELECT и INSERT нет
 * await), но два процесса на одной БД — ровно тот случай, ради которого дедуп и
 * писался: одно сообщение приходит и по Bot API, и через userbot.
 *
 * Наблюдаемая щель — строка ровно на границе окна: DELETE её не трогает
 * (`processed_at < cutoff` ложно), SELECT её не видит (`> cutoff` тоже ложно), а
 * INSERT упирается в UNIQUE. Раньше это давало «обработать» на уже обработанном
 * сообщении.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { shouldProcessTrigger } from "../lib/trigger-anti-dup.ts";

const CHAT = "-991001";

beforeEach(() => {
  db.prepare(`DELETE FROM processed_triggers WHERE chat_id = ?`).run(CHAT);
});

/** Дождаться начала секунды, чтобы «сейчас» не сместилось внутри вызова. */
function alignToSecond(): void {
  const deadline = Date.now() + 1200;
  while (Date.now() % 1000 > 50 && Date.now() < deadline) {
    /* активное ожидание короче 1с — таймер тут не нужен */
  }
}

describe("вставка, а не исключение", () => {
  test("строка ровно на границе окна считается дублем", () => {
    alignToSecond();
    const now = Math.floor(Date.now() / 1000);
    const msg = 4242;
    // processed_at == cutoff: переживает уборку и невидим для SELECT.
    db.prepare(
      `INSERT INTO processed_triggers (chat_id, tg_message_id, agent_key, processed_at)
       VALUES (?, ?, 'orchestrator', ?)`,
    ).run(CHAT, msg, now - 60);

    expect(shouldProcessTrigger(CHAT, msg, "orchestrator")).toBe(false);
  });

  test("непротиворечивое поведение не сломано", () => {
    // Контроль: обычный первый триггер по-прежнему обрабатывается ровно один раз.
    expect(shouldProcessTrigger(CHAT, 7, "orchestrator")).toBe(true);
    expect(shouldProcessTrigger(CHAT, 7, "orchestrator")).toBe(false);
  });
});

describe("структура решения", () => {
  const SRC = readFileSync(
    new URL("../lib/trigger-anti-dup.ts", import.meta.url),
    "utf8",
  );

  test("дубль определяется по changes вставки", () => {
    expect(SRC).toMatch(/res\.changes/);
  });

  test("сбой БД больше не роняет триггер молча", () => {
    // Пропуск триггера — это молчание бота, которое пользователь не отличит от
    // поломки; лишний повтор хотя бы виден и редок.
    const cat = SRC.slice(SRC.indexOf("} catch (error) {"));
    expect(cat.slice(0, 400)).not.toMatch(/return false/);
  });
});
