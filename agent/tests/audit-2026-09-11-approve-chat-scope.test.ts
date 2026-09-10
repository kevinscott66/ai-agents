/**
 * Аудит 2026-09-11: `/approve` по префиксу дотягивался до соседнего чата.
 *
 * Обе команды принимают `chatId`, но тратили его только на пересылку дальше:
 * заявку искал `resolveApproval` по ВСЕЙ таблице. Между тем очередь, из
 * которой человек переписывает id, чат-локальна — `/approvals` печатает
 * `listPendingApprovals(chatId, …)`, предел на роль считается по чату (аудит
 * 2026-09-10), — а гейт админских команд пускает в ЛЮБОМ чате из allowlist.
 *
 * Отсюда сценарий без злого умысла: в чате A владелец читает `/approvals`,
 * набирает `/approve ab12` по первым символам из списка, промахивается на
 * символ — и префикс однозначно совпадает с единственной подходящей заявкой
 * чата B. Команда исполняет её необратимое действие (пост в канал, удаление
 * сообщения, MAC_RUN_CLAUDE), в чате A при этом не меняется ничего, и заметить
 * подмену нечем: ответ выглядит как обычный успех. Это та же болезнь, что у
 * `/approve ____` (аудит 2026-08-08) — команда решает не ту заявку, которую
 * назвали, — только угадывает здесь не шаблон, а соседняя доска.
 *
 * Сужается ровно префикс. Полный id остаётся межчатовым намеренно: отказ из
 * лички — сценарий аудита 2026-08-09 (reject-identity-and-chat.test.ts), и
 * запись журнала у него уходит в чат заявки, а не в личку. Угадать полный
 * UUID чужой заявки нельзя, поэтому подмены на этом пути нет — есть только
 * человек, у которого id уже на руках.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createApproval, getApproval, resolveApproval } from "../lib/approvals.ts";
import { cmdReject } from "../lib/commands.ts";
import { db } from "../lib/db.ts";

const HERE = -100777011;
const THERE = -100777012;

function pending(chatId: number): { id: string } {
  return createApproval({
    actionId: crypto.randomUUID(),
    chatId,
    requestedBy: "smm",
    actionType: "SEND_MESSAGE",
    payload: { text: "пост, который уйдёт наружу" },
  });
}

afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id IN (?, ?)`).run(HERE, THERE);
});

describe("префикс заявки не выходит за пределы своего чата", () => {
  test("префикс не дотягивается до соседнего чата", () => {
    // Единственная заявка с таким началом висит в чате B. До правки префикс
    // разрешался однозначно — и решал её.
    const foreign = pending(THERE);
    const prefix = foreign.id.slice(0, 8);

    const reply = cmdReject({ approvalId: prefix, decidedBy: "tg:1", chatId: HERE });

    expect(reply).toContain("не найден");
    expect(getApproval(foreign.id)!.status).toBe("pending");
    // Ответ не выдаёт, что заявка с таким началом вообще существует.
    expect(reply).not.toContain(String(THERE));
  });

  test("своя заявка решается по префиксу как прежде", () => {
    const own = pending(HERE);

    const reply = cmdReject({
      approvalId: own.id.slice(0, 8),
      decidedBy: "tg:1",
      chatId: HERE,
      reason: "не сейчас",
    });

    expect(reply).toContain("Rejected");
    expect(getApproval(own.id)!.status).toBe("rejected");
  });

  test("полный id решается из другого чата — путь из аудита 2026-08-09", () => {
    // Админ отклоняет из лички заявку командного чата. Сужение префикса этот
    // путь ломать не должно: id названа целиком, угадывания нет.
    const foreign = pending(THERE);

    const reply = cmdReject({
      approvalId: foreign.id,
      decidedBy: "tg:1",
      chatId: HERE,
      reason: "нет",
    });

    expect(reply).toContain("Rejected");
    expect(getApproval(foreign.id)!.status).toBe("rejected");
  });

  test("resolveApproval без чата ищет по всем чатам", () => {
    // Mini App и инструменты зовут без чата — там свои проверки доступа,
    // и сужать им выборку эта правка не должна.
    const foreign = pending(THERE);
    expect(resolveApproval(foreign.id.slice(0, 8))?.id).toBe(foreign.id);
    expect(resolveApproval(foreign.id.slice(0, 8), HERE)).toBeNull();
  });
});
