/**
 * Аудит 2026-08-12: два предиката окна дедупа не были дополняющими.
 *
 *   DELETE FROM processed_triggers WHERE processed_at <  cutoff   -- уборка
 *   SELECT 1 ... WHERE ... AND            processed_at >  cutoff   -- поиск
 *
 * Строка ровно на `cutoff` не попадала ни под один: уборка её не трогала,
 * поиск её не видел. Ответ «дубль» она всё равно давала — но не потому, что её
 * нашли, а потому что следом INSERT OR IGNORE упирался в UNIQUE, changes
 * оказывался нулём, и путь возврата был тот, что предназначен для гонки двух
 * процессов: `[trigger-anti-dup] строку уже вставил кто-то другой`.
 *
 * То есть наблюдаемый ответ верный, а объяснение в логе — ложное, и любая
 * будущая проверка «сколько у нас реальных гонок Bot API против userbot»
 * считала бы каждую границу окна за гонку. Плюс по коду невозможно понять,
 * какой из двух предикатов задаёт окно.
 *
 * Чиним не ответ, а рассуждение: границу окна включает поиск (`>= cutoff`),
 * уборка остаётся строгой (`< cutoff`). Предикаты стали дополняющими, и до
 * ветки «кто-то вставил раньше нас» теперь доходит только настоящая гонка.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { log } from "../lib/log.ts";
import { shouldProcessTrigger } from "../lib/trigger-anti-dup.ts";

const CHAT = "-991002";
const SRC = readFileSync(
  new URL("../lib/trigger-anti-dup.ts", import.meta.url),
  "utf8",
);

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

describe("границы окна дедупа", () => {
  test("уборка и поиск делят шкалу без щели", () => {
    const del = SRC.match(/DELETE FROM processed_triggers WHERE processed_at (<=?) \?/);
    const sel = SRC.match(/AND processed_at (>=?) \?/);
    expect(del?.[1]).toBeDefined();
    expect(sel?.[1]).toBeDefined();
    // Дополняющие пары ровно две: (<, >=) и (<=, >). Любая другая оставляет
    // значение, которое не удаляется и не находится.
    expect([`${del![1]}${sel![1]}`]).toContain(
      del![1] === "<" ? "<>=" : "<=>",
    );
  });

  test("строка ровно на границе — дубль, и найденный, а не столкнувшийся", () => {
    alignToSecond();
    const now = Math.floor(Date.now() / 1000);
    const msg = 4243;
    db.prepare(
      `INSERT INTO processed_triggers (chat_id, tg_message_id, agent_key, processed_at)
       VALUES (?, ?, 'orchestrator', ?)`,
    ).run(CHAT, msg, now - 60);

    // Аудит 2026-08-21: одного `toBe(false)` тут мало — до фикса пограничная
    // строка отвечала «дубль» ТОЖЕ, только приходил ответ снизу, из ветки
    // гонки. То есть проверка проходила и на сломанном коде и защищала не то,
    // что заявлено в её названии. Отличить пути можно ровно одним наблюдаемым
    // следом: ветка гонки пишет log.debug, ветка поиска молчит.
    const seen: string[] = [];
    const orig = log.debug;
    log.debug = ((msgText: string, ...rest: unknown[]) => {
      seen.push(msgText);
      return (orig as any).call(log, msgText, ...rest);
    }) as typeof log.debug;
    try {
      expect(shouldProcessTrigger(CHAT, msg, "orchestrator")).toBe(false);
    } finally {
      log.debug = orig;
    }
    expect(seen.join("|")).not.toContain("строку уже вставил кто-то другой");
  });

  test("строка старше окна убирается, триггер обрабатывается снова", () => {
    alignToSecond();
    const now = Math.floor(Date.now() / 1000);
    const msg = 4244;
    db.prepare(
      `INSERT INTO processed_triggers (chat_id, tg_message_id, agent_key, processed_at)
       VALUES (?, ?, 'orchestrator', ?)`,
    ).run(CHAT, msg, now - 61);
    expect(shouldProcessTrigger(CHAT, msg, "orchestrator")).toBe(true);
  });

  test("свежий дубль по-прежнему отбивается", () => {
    expect(shouldProcessTrigger(CHAT, 8, "orchestrator")).toBe(true);
    expect(shouldProcessTrigger(CHAT, 8, "orchestrator")).toBe(false);
  });
});
