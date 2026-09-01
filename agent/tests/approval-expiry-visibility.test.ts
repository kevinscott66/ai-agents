/**
 * Аудит 2026-08-13: истечение заявки меняло статус молча.
 *
 * У decideApproval стоит заметка, написанная предыдущим аудитом: «место, где
 * строка меняет статус, ровно одно — здесь ему и место [busEmit]». Мест
 * оказалось два: `expireStaleApprovals` (lib/db-maint.ts) переводит pending в
 * терминальный 'expired' прямым UPDATE'ом и на шину ничего не отдаёт.
 *
 * Открытая вкладка Mini App узнаёт об изменениях только из SSE — Approvals и
 * Dashboard перезапрашивают список на `approval.created` / `approval.decided`.
 * Без события карточка висит «ожидает решения» сколько угодно долго, а
 * «Approve» по ней возвращает 400 `already expired`. Ломается ровно тот
 * сценарий, ради которого TTL и вводили: не давать нажимать на протухшее.
 *
 * Инвариант: проход санитара, который что-то закрыл, виден на шине. Событие
 * одно на проход, а не по строке на заявку — оба подписчика на каждое событие
 * делают полный перезапрос, и первый проход после включения TTL превратил бы
 * накопленную очередь в столько же запросов с телефона.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createApproval, getApproval } from "../lib/approvals.ts";
import { expireStaleApprovals } from "../lib/db-maint.ts";
import { subscribe, type BusEvent } from "../lib/events-bus.ts";

const CHAT = -100_930_013;
const HOUR = 3600_000;

afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT);
});

function mk(ageMs: number): { id: string } {
  const a = createApproval({
    actionId: crypto.randomUUID(),
    chatId: CHAT,
    requestedBy: "smm",
    actionType: "SEND_MESSAGE",
    payload: { chatId: CHAT, text: "привет" },
  });
  if (ageMs > 0) {
    db.prepare(`UPDATE approvals SET created_at = ? WHERE id = ?`).run(
      Date.now() - ageMs,
      a.id,
    );
  }
  return a;
}

/**
 * Сколько ЧУЖИХ заявок уже просрочено к этому моменту.
 *
 * `expireStaleApprovals` ходит по всей таблице — ни chat_id, ни автора он не
 * различает, и это правильно: TTL общий. Но тогда `expect(res.expired).toBe(1)`
 * — утверждение про весь прогон, а не про нашу строку: соседний файл, оставивший
 * одну нерешённую заявку старше суток, делает счётчик двойкой. Порядок файлов у
 * `bun test` не фиксирован, так что падало бы через раз. T-751.
 *
 * То же и с событиями: подписка глобальная, и в `events` попадут чужие
 * `approval.decided`. Поэтому ниже они фильтруются по СВОИМ id, а не берутся
 * целиком.
 */
function foreignStale(ttlMs: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM approvals
         WHERE chat_id != ? AND status = 'pending' AND created_at < ?`,
      )
      .get(CHAT, Date.now() - ttlMs) as { n: number }
  ).n;
}

/** Собрать события шины, пока идёт `run`. */
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

const decidedEvents = (events: BusEvent[]) =>
  events.filter((e) => e.name === "approval.decided");

/** Только события про наши заявки — чужие санитар закрывает в том же проходе. */
const oursOnly = (events: BusEvent[], ids: string[]) =>
  decidedEvents(events).filter((e) =>
    ids.includes((e.payload as { id: string }).id),
  );

describe("истечение заявки видно открытой вкладке", () => {
  test("проход санитара, закрывший заявку, поднимает approval.decided", () => {
    const a = mk(50 * HOUR);
    const foreign = foreignStale(48 * HOUR);
    const events = captured(() => {
      const res = expireStaleApprovals({ ttlMs: 48 * HOUR });
      expect(res.expired - foreign).toBe(1);
    });

    const decided = oursOnly(events, [a.id]);
    expect(decided).toHaveLength(1);
    expect(decided[0]!.payload).toMatchObject({ id: a.id, status: "expired" });
    // И статус действительно терминальный — событие не про «почти закрыли».
    expect(getApproval(a.id)!.status).toBe("expired");
  });

  test("проход вхолостую молчит — вкладка не перезапрашивает список зря", () => {
    const a = mk(1 * HOUR);
    const foreign = foreignStale(48 * HOUR);
    const events = captured(() => {
      const res = expireStaleApprovals({ ttlMs: 48 * HOUR });
      expect(res.expired - foreign).toBe(0);
    });
    expect(oursOnly(events, [a.id])).toEqual([]);
  });

  test("на каждую закрытую заявку — своё событие, ни одна не потеряна", () => {
    // Форма события — `{ id, status }`, ровно та же, что у `decideApproval` и
    // `markApprovalFailed`; пакетный вариант с `ids[]` завёл бы второй диалект
    // одного имени. Экономия на перезапросах списка того не стоит: санитар
    // ходит раз в час, просрочек за проход единицы, а если шквал перезагрузок
    // когда-нибудь станет заметен — лечить его надо дебаунсом у подписчика.
    const ids = Array.from({ length: 10 }, () => mk(50 * HOUR).id);
    const foreign = foreignStale(48 * HOUR);
    const events = captured(() => {
      expect(expireStaleApprovals({ ttlMs: 48 * HOUR }).expired - foreign).toBe(
        10,
      );
    });

    const decided = oursOnly(events, ids);
    expect(decided).toHaveLength(10);
    const seen = decided.map((e) => (e.payload as { id: string }).id);
    expect([...seen].sort()).toEqual([...ids].sort());
    for (const e of decided) {
      expect((e.payload as { status: string }).status).toBe("expired");
    }
  });

  test("в событие попадают только реально закрытые id", () => {
    const stale = mk(50 * HOUR);
    const fresh = mk(1 * HOUR);
    const events = captured(() => {
      expireStaleApprovals({ ttlMs: 48 * HOUR });
    });

    const seen = oursOnly(events, [stale.id, fresh.id]).map(
      (e) => (e.payload as { id: string }).id,
    );
    expect(seen).toEqual([stale.id]);
    expect(getApproval(fresh.id)!.status).toBe("pending");
  });

  test("повторный проход по уже истёкшим заявках молчит", () => {
    const a = mk(50 * HOUR);
    expireStaleApprovals({ ttlMs: 48 * HOUR });
    // Первый проход закрыл и чужие тоже — ко второму просроченных не осталось
    // ни у кого, поэтому здесь вычитать нечего.
    const events = captured(() => {
      expect(expireStaleApprovals({ ttlMs: 48 * HOUR }).expired).toBe(0);
    });
    // Строка терминальная, менять нечего — второй раз вкладку дёргать не за что.
    expect(oursOnly(events, [a.id])).toEqual([]);
  });
});
