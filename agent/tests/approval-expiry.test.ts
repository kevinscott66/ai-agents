/**
 * Аудит 2026-08-12: очередь одобрений не имела ни срока, ни дна.
 *
 * `approvals` — единственный контур, через который проходят необратимые
 * действия (пост в канал, сообщение от лица владельца, MAC_RUN_CLAUDE). Строка
 * создаётся со status='pending' и в этом статусе живёт вечно: ни gcStaleTasks,
 * ни archiveOldRows её не касаются, срока годности у неё нет.
 *
 * Отсюда две беды, и вторая хуже первой.
 *
 * 1. listPendingApprovals — `ORDER BY a.created_at ASC LIMIT 20`. FIFO для
 *    очереди, которую разгребают, правилен; для очереди, из которой ничего не
 *    выбывает, он означает голодание: двадцать позавчерашних карточек намертво
 *    занимают выдачу, и сегодняшнее одобрение в Mini App просто не появляется.
 *    Отклонённое молча не хуже — но здесь оно НЕ отклонено, а невидимо.
 *
 * 2. Нажатие «Approve» на карточке трёхмесячной давности исполняет действие с
 *    payload'ом трёхмесячной давности. executeApproved перепроверяет вызывающего
 *    и deny-гейты — то есть авторы уже понимали, что между созданием и решением
 *    мир меняется, — но не возраст самой заявки. Для SEND_MESSAGE в канал это
 *    отправка устаревшего текста, для MAC_RUN_CLAUDE — запуск по устаревшему
 *    промпту.
 *
 * Лечим сроком: pending старше TTL переводится в терминальный 'expired'
 * санитаром, а executeApproved отказывается исполнять просроченное сам —
 * на случай, если санитар не отработал (процесс лежал). Автоотклонения по
 * существу здесь нет: 'expired' — это «человек не решил», а не «человек
 * отказал», и в reason записано ровно это.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  createApproval,
  listPendingApprovals,
  getApproval,
  decideApproval,
  APPROVAL_TTL_MS,
} from "../lib/approvals.ts";
import { expireStaleApprovals } from "../lib/db-maint.ts";
import { executeApproved } from "../lib/commands.ts";

const CHAT_ID = -100_930_001;

afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
});

/**
 * Сколько ЧУЖИХ заявок протухло к моменту `now`.
 *
 * `expireStaleApprovals` ходит по ВСЕЙ таблице — ни chat_id, ни автора он не
 * различает, и это правильно: срок годности общий. Но тогда «просрочено ровно
 * 20» (и «ровно 0») — утверждение про весь прогон, а не про наши строки: любой
 * соседний файл, оставивший позади себя протухший pending, ломает счёт. Порог
 * считаем тем же `now`/`ttlMs`, что передаём уборщику, иначе они разъезжаются
 * на миллисекунды между двумя вызовами. T-751.
 */
function foreignStale(now: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM approvals
         WHERE status = 'pending' AND chat_id != ? AND created_at < ?`,
      )
      .get(CHAT_ID, now - APPROVAL_TTL_MS) as { n: number }
  ).n;
}

function mk(ageMs: number, text: string): string {
  const a = createApproval({
    actionId: `act-exp-${Math.random().toString(36).slice(2)}`,
    chatId: CHAT_ID,
    requestedBy: "smm",
    actionType: "SEND_MESSAGE",
    payload: { chatId: CHAT_ID, text },
  });
  if (ageMs > 0) {
    db.prepare(`UPDATE approvals SET created_at = ? WHERE id = ?`).run(
      Date.now() - ageMs,
      a.id,
    );
  }
  return a.id;
}

describe("срок годности одобрения", () => {
  test("протухшие уходят из очереди, свежее видно", () => {
    // Двадцать позавчерашних — ровно потолок выдачи listPendingApprovals.
    const stale: string[] = [];
    for (let i = 0; i < 20; i++) {
      stale.push(mk(APPROVAL_TTL_MS * 2 + i, `старое ${i}`));
    }
    const fresh = mk(0, "сегодняшнее");

    // До уборки: свежего в выдаче нет вовсе — его вытеснили старые.
    const before = listPendingApprovals(CHAT_ID, 20);
    expect(before.some((a) => a.id === fresh)).toBe(false);

    const now = Date.now();
    const foreign = foreignStale(now);
    const res = expireStaleApprovals({ now, ttlMs: APPROVAL_TTL_MS });
    expect(res.expired - foreign).toBe(20);

    const after = listPendingApprovals(CHAT_ID, 20);
    expect(after.some((a) => a.id === fresh)).toBe(true);
    expect(after.some((a) => stale.includes(a.id))).toBe(false);

    // Строка не удалена: видно, что заявка была и чем кончилась.
    const one = getApproval(stale[0]!)!;
    expect(one.status).toBe("expired");
    expect(one.reason ?? "").toContain("не решён");
    // «Не решено» ≠ «отказано»: решение человека не подделываем.
    expect(one.status).not.toBe("rejected");
  });

  test("свежее одобрение санитар не трогает", () => {
    const fresh = mk(APPROVAL_TTL_MS / 2, "ещё живое");
    const now = Date.now();
    // «Ноль» — только про нас: чужие протухшие уборщик заберёт по праву.
    // Считать их обязательно ДО вызова: после него они уже не `pending`, и
    // счётчик вернул бы ноль, сойдясь с любым результатом.
    const foreign = foreignStale(now);
    expect(
      expireStaleApprovals({ now, ttlMs: APPROVAL_TTL_MS }).expired,
    ).toBe(foreign);
    expect(getApproval(fresh)!.status).toBe("pending");
  });

  test("решать просроченное больше нельзя", () => {
    const id = mk(APPROVAL_TTL_MS * 2, "давнее");
    expireStaleApprovals();
    expect(() => decideApproval(id, "approved", "admin")).toThrow(/expired/);
  });

  test("executeApproved отказывается исполнять просроченное сам", async () => {
    // Санитар мог не отработать: процесс лежал, интервал не наступил. Проверка
    // возраста обязана быть и в точке необратимого действия.
    const id = mk(APPROVAL_TTL_MS * 3, "устаревший текст в канал");
    const row = getApproval(id)!;
    expect(row.status).toBe("pending");
    await expect(executeApproved(row)).rejects.toThrow(/expired|просроч/i);
  });
});
