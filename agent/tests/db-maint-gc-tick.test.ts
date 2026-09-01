/**
 * Аудит 2026-08-13: gc-тик db-maint, две находки.
 *
 * 1. `expireStaleApprovals` меняет статус заявки мимо шины. Это третий писатель
 *    статуса, который молчит: ровно ту же дыру чинили 2026-08-08 решению из
 *    Telegram (см. tests/approval-decide-visibility.test.ts). Без события
 *    открытая вкладка Mini App держит карточку «ожидает решения», и владелец,
 *    нажав в ней Approve, получает ошибку «already expired» вместо действия.
 *
 * 2. Один общий `try` накрывал оба шага тика — падение `gcStaleTasks` отменяло
 *    просрочку заявок целиком, и она не выполнялась бы, пока не починят соседа.
 *    Заодно в тот же try попадала отметка живости `_schedulerLastRun`: через два
 *    часа падений /readyz объявлял процесс заклинившим, хотя таймер исправно
 *    тикал, — а health-гейт деплоя читает именно /readyz.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  expireStaleApprovals,
  startMaintScheduler,
  getSchedulerLastRun,
  setSchedulerLastRunForTests,
  type MaintSchedulerHandle,
} from "../lib/db-maint.ts";
import { getApproval, APPROVAL_TTL_MS } from "../lib/approvals.ts";
import { subscribe, type BusEvent } from "../lib/events-bus.ts";
import { db } from "../lib/db.ts";

const CHAT = -100777013;
const HOUR = 3600_000;

/**
 * pending-заявка возраста `ageMs`, вставленная напрямую в таблицу.
 *
 * Мимо `createApproval` сознательно: он поднимает `approval.created`, а в полном
 * прогоне на общей тестовой БД живёт чужой неотписанный слушатель, который на
 * это событие заявку решает — и наша строка переставала быть pending ещё до
 * проверки (T-751). Здесь проверяется db-maint, а не создание заявки.
 */
function mkPending(ageMs: number): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO approvals(
       id, action_id, chat_id, requested_by, action_type, payload,
       status, created_at
     ) VALUES (?, ?, ?, 'smm', 'SEND_MESSAGE', '{}', 'pending', ?)`,
  ).run(id, crypto.randomUUID(), CHAT, Date.now() - ageMs);
  return id;
}

function captured(run: () => void): BusEvent[] {
  const events: BusEvent[] = [];
  const off = subscribe((e) => events.push(e));
  try {
    run();
  } finally {
    off();
  }
  return events;
}

/** Событий `approval.decided` про конкретную строку — сколько именно. */
function decidedFor(events: BusEvent[], id: string): unknown[] {
  return events
    .filter((e) => e.name === "approval.decided")
    .map((e) => e.payload)
    .filter((p) => (p as { id?: string }).id === id);
}

afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT);
});

describe("просрочка заявки доезжает до шины", () => {
  // Счётчик `expired` глобален — уборка идёт по всей таблице, а БД у тестов
  // общая. Поэтому всё утверждаем про СВОИ строки, а срок берём дефолтный
  // (как в соседнем tests/approval-expiry.test.ts): сдвигать `now` вперёд
  // нельзя, иначе один этот тест просрочит чужие живые заявки.
  test("на каждую просроченную строку — своё approval.decided", () => {
    const a = mkPending(2 * APPROVAL_TTL_MS);
    const b = mkPending(2 * APPROVAL_TTL_MS);

    const events = captured(() => {
      expireStaleApprovals();
    });

    expect(decidedFor(events, a)).toEqual([{ id: a, status: "expired" }]);
    expect(decidedFor(events, b)).toEqual([{ id: b, status: "expired" }]);
    expect(getApproval(a)?.status).toBe("expired");
    expect(getApproval(b)?.status).toBe("expired");
  });

  test("свежая заявка не просрочена и события не поднимает", () => {
    const fresh = mkPending(0);
    const events = captured(() => {
      expireStaleApprovals();
    });
    expect(decidedFor(events, fresh)).toEqual([]);
    expect(getApproval(fresh)?.status).toBe("pending");
  });

  test("повторный прогон не поднимает событий второй раз", () => {
    const id = mkPending(2 * APPROVAL_TTL_MS);
    expireStaleApprovals();
    const events = captured(() => {
      expireStaleApprovals();
    });
    expect(decidedFor(events, id)).toEqual([]);
  });
});

describe("шаги gc-тика изолированы друг от друга", () => {
  let sched: MaintSchedulerHandle | null = null;
  let savedLastRun: number | null = null;

  beforeEach(() => {
    savedLastRun = getSchedulerLastRun();
  });

  afterEach(() => {
    sched?.stop();
    sched = null;
    setSchedulerLastRunForTests(savedLastRun);
  });

  function start(
    gcStaleTasksImpl: () => unknown,
    expireStaleApprovalsImpl: () => unknown,
  ): MaintSchedulerHandle {
    // Интервалы заведомо больше жизни теста: тик дёргаем руками через _gcTick,
    // чтобы не зависеть от таймеров.
    sched = startMaintScheduler({
      gcIntervalMs: HOUR,
      dailyPollMs: HOUR,
      gcStaleTasksImpl,
      expireStaleApprovalsImpl,
      exportColdStorageImpl: () => [],
    });
    return sched;
  }

  test("падение уборки задач не отменяет просрочку заявок", () => {
    let expired = 0;
    const s = start(
      () => {
        throw new Error("tasks gc boom");
      },
      () => {
        expired++;
      },
    );
    s._gcTick();
    expect(expired).toBe(1);
  });

  test("падение просрочки не отменяет уборку задач", () => {
    let gced = 0;
    const s = start(
      () => {
        gced++;
      },
      () => {
        throw new Error("approvals boom");
      },
    );
    s._gcTick();
    expect(gced).toBe(1);
  });

  test("отметка живости ставится и когда шаг упал", () => {
    // Метка отвечает на вопрос «таймер вообще тикает?», а не «всё ли прошло».
    // До фикса падающая уборка через два часа гасила /readyz — то есть
    // health-гейт деплоя откатывал выкладку по чужой причине.
    const s = start(
      () => {
        throw new Error("boom");
      },
      () => {
        throw new Error("boom too");
      },
    );
    // Обнуляем ПОСЛЕ старта: `startMaintScheduler` ставит метку на буте (T-411),
    // и обнуление до него замаскировало бы разницу — тест проходил бы и на
    // старом коде, где метка стояла внутри общего try.
    setSchedulerLastRunForTests(null);
    s._gcTick();
    const last = getSchedulerLastRun();
    expect(last).not.toBeNull();
    expect(Date.now() - last!).toBeLessThan(5000);
  });

  test("на здоровом тике выполняются оба шага", () => {
    let gced = 0;
    let expired = 0;
    const s = start(
      () => {
        gced++;
      },
      () => {
        expired++;
      },
    );
    s._gcTick();
    expect([gced, expired]).toEqual([1, 1]);
  });
});
