/**
 * Аудит 2026-09-11, круг 30: watchdog демона лечил обрыв, который и без него
 * лечился, и не лечил тот, ради которого написан.
 *
 * Watchdog заведён против полуоткрытого сокета: туннель умер молча, кадров нет,
 * события `close` нет. Делал он при этом `stopWatchdog(); ws.close();` — и
 * дальше рассчитывал на обработчик `close`, в котором стоит реконнект. Но
 * `close()` лишь НАЧИНАЕТ закрывающее рукопожатие, ответный кадр идёт через тот
 * же мёртвый туннель, и события можно не дождаться. Watchdog уже остановлен,
 * второй попытки нет — демон висит навсегда.
 *
 * Теперь решение живёт в mac-daemon/reconnect.ts: у принудительного закрытия
 * есть запасной срок, а объявить соединение потерянным можно ровно один раз.
 */
import { describe, test, expect } from "bun:test";
import {
  createSocketLifecycle,
  type GiveUpReason,
  type SocketLifecycleDeps,
} from "../mac-daemon/reconnect.ts";

/** Ручные таймеры: срок «истекает» только когда тест этого захочет. */
function harness(opts: { closeThrows?: boolean } = {}) {
  const calls: GiveUpReason[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 1;
  let closes = 0;
  let cleared = 0;

  const deps: SocketLifecycleDeps = {
    close: () => {
      closes += 1;
      if (opts.closeThrows) throw new Error("socket already dead");
    },
    onGiveUp: (r) => calls.push(r),
    setTimer: (fn, ms) => {
      expect(ms).toBe(5_000);
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (t) => {
      cleared += 1;
      timers.delete(t as number);
    },
    graceMs: 5_000,
  };

  return {
    life: createSocketLifecycle(deps),
    calls,
    closes: () => closes,
    cleared: () => cleared,
    pending: () => timers.size,
    /** «Прошло graceMs». */
    fire: () => {
      for (const fn of [...timers.values()]) fn();
    },
  };
}

describe("тихо умерший туннель всё-таки даёт реконнект", () => {
  test("события close нет — реконнект случается по запасному сроку", () => {
    const h = harness();

    h.life.forceClose();
    // Рукопожатие начато, но мост мёртв: `close` не придёт.
    expect(h.closes()).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.life.abandoned()).toBe(false);

    h.fire();

    expect(h.calls).toEqual(["close_timeout"]);
    expect(h.life.abandoned()).toBe(true);
  });

  test("различающее свидетельство: прежняя форма не реконнектилась вовсе", () => {
    // Прежний watchdog — ровно эти две строки и ничего больше.
    let closes = 0;
    let reconnects = 0;
    const stopWatchdog = () => {};
    const wsClose = () => {
      closes += 1; /* событие `close` не придёт: туннель мёртв */
    };
    stopWatchdog();
    wsClose();

    // Реконнект стоял только в обработчике `close`, который не вызовут.
    expect(closes).toBe(1);
    expect(reconnects).toBe(0);

    // Сегодня тот же сценарий (см. тест выше) заканчивается close_timeout.
    const h = harness();
    h.life.forceClose();
    h.fire();
    expect(h.calls).toEqual(["close_timeout"]);
  });

  test("close(), бросивший на мёртвом сокете, не отменяет запасной срок", () => {
    const h = harness({ closeThrows: true });

    h.life.forceClose();
    h.fire();

    expect(h.calls).toEqual(["close_timeout"]);
  });
});

describe("ровно один реконнект на одно соединение", () => {
  test("обычный обрыв идёт через close и срока не заводит", () => {
    const h = harness();

    h.life.noticedClose();

    expect(h.calls).toEqual(["close_event"]);
    expect(h.closes()).toBe(0);
    expect(h.pending()).toBe(0);
  });

  test("close после forceClose снимает срок и реконнектит один раз", () => {
    const h = harness();

    h.life.forceClose();
    h.life.noticedClose();

    expect(h.calls).toEqual(["close_event"]);
    expect(h.cleared()).toBe(1);
    // Срок снят: запоздалый тик уже ничего не сделает.
    h.fire();
    expect(h.calls).toEqual(["close_event"]);
  });

  test("запоздавший close после сработавшего срока второго сокета не плодит", () => {
    const h = harness();

    h.life.forceClose();
    h.fire();
    // Рукопожатие всё-таки завершилось — минутой позже, через launchd.
    h.life.noticedClose();

    expect(h.calls).toEqual(["close_timeout"]);
  });

  test("повторный forceClose не закрывает дважды и не взводит второй срок", () => {
    const h = harness();

    h.life.forceClose();
    h.life.forceClose();

    expect(h.closes()).toBe(1);
    expect(h.pending()).toBe(1);
  });

  test("после объявления потери forceClose уже ничего не делает", () => {
    const h = harness();

    h.life.noticedClose();
    h.life.forceClose();

    expect(h.closes()).toBe(0);
    expect(h.calls).toEqual(["close_event"]);
  });

  test("несостоявшийся коннект тоже реконнектит, и тоже один раз", () => {
    const h = harness();

    h.life.connectFailed();
    h.life.noticedClose();

    expect(h.calls).toEqual(["connect_failed"]);
    expect(h.life.abandoned()).toBe(true);
  });
});

describe("кадры брошенного сокета", () => {
  test("до потери abandoned() ложь, после — правда", () => {
    // Демон спрашивает ровно это перед разбором кадра: зомби-сокет не должен
    // ни запускать `run`, ни продлевать lastBridgeMsg.
    const h = harness();

    expect(h.life.abandoned()).toBe(false);
    h.life.noticedClose();
    expect(h.life.abandoned()).toBe(true);
  });
});
