/**
 * Аудит 2026-08-08: два места в approvals.ts, где вход через Telegram вёл себя
 * иначе, чем вход через Mini App.
 *
 * 1. `approval.decided` поднимал только HTTP-роут Mini App. Решение через
 *    Telegram (`/approve`, `/reject` → commands.ts → decideApproval) до шины не
 *    доезжало: открытая вкладка Mini App продолжала показывать карточку
 *    «ожидает решения», и владелец, нажав в ней Approve, получал «already
 *    approved» — то есть UI врал ровно про то, за чем его и держат открытым.
 *
 * 2. `resolveApproval` отдавал prefix в LIKE без экранирования. `%` и `_` —
 *    метасимволы: `/approve ____` подходит к любому id разом, и при
 *    единственной pending-заявке это ровно один ряд, то есть команда решала не
 *    ту заявку, которую назвали.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  createApproval,
  decideApproval,
  resolveApproval,
  markApprovalFailed,
} from "../lib/approvals.ts";
import { subscribe, type BusEvent } from "../lib/events-bus.ts";
import { db } from "../lib/db.ts";

const CHAT = -100777001;

function mkPending(): { id: string } {
  return createApproval({
    actionId: crypto.randomUUID(),
    chatId: CHAT,
    requestedBy: "smm",
    actionType: "SEND_MESSAGE",
    payload: { text: "привет" },
  });
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

afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT);
});

describe("approvals: решение видно обоим входам", () => {
  test("decideApproval поднимает approval.decided — не только роут Mini App", () => {
    const a = mkPending();
    // Ровно то, что делает /approve в Telegram: вызов библиотечной функции,
    // без участия HTTP-слоя.
    const events = captured(() => {
      decideApproval(a.id, "approved", "tg:12345");
    });
    const decided = events.filter((e) => e.name === "approval.decided");
    expect(decided.length).toBe(1);
    expect(decided[0]!.payload).toMatchObject({ id: a.id, status: "approved" });
  });

  test("отклонение через Telegram тоже доезжает до шины", () => {
    const a = mkPending();
    const events = captured(() => {
      decideApproval(a.id, "rejected", "tg:12345", "не сейчас");
    });
    expect(
      events.filter((e) => e.name === "approval.decided").map((e) => e.payload),
    ).toEqual([{ id: a.id, status: "rejected" }]);
  });

  test("проваленное исполнение по-прежнему поднимает событие ровно один раз", () => {
    const a = mkPending();
    decideApproval(a.id, "approved", "tg:12345");
    const events = captured(() => {
      markApprovalFailed(a.id, "telegram 400");
    });
    expect(
      events.filter((e) => e.name === "approval.decided").map((e) => e.payload),
    ).toEqual([{ id: a.id, status: "failed" }]);
  });

  test("повторное решение не поднимает второго события", () => {
    const a = mkPending();
    decideApproval(a.id, "approved", "tg:12345");
    const events = captured(() => {
      expect(() => decideApproval(a.id, "approved", "miniapp:1")).toThrow();
    });
    expect(events.filter((e) => e.name === "approval.decided")).toEqual([]);
  });

  test("метасимволы LIKE в префиксе не подбирают чужую заявку", () => {
    const a = mkPending();
    // `____` — четыре «любых символа»: длину проверку проходит, а под шаблон
    // попадает начало любого UUID.
    expect(resolveApproval("____")).toBeNull();
    expect(resolveApproval("%")).toBeNull();
    expect(resolveApproval("%%%%")).toBeNull();
    // Настоящий префикс той же заявки по-прежнему находится.
    expect(resolveApproval(a.id.slice(0, 8))?.id).toBe(a.id);
    expect(resolveApproval(a.id)?.id).toBe(a.id);
  });

  test("несуществующий префикс — это null, а не первая попавшаяся строка", () => {
    mkPending();
    expect(resolveApproval("zzzzzzzz")).toBeNull();
  });
});
