/**
 * Аудит 2026-08-10: подтверждение стояло не на той стороне решения.
 *
 * Отклонение аппрува — обратимое и ничего не исполняющее — требовало
 * window.confirm, а для одиночного ещё и второго экрана с полем причины.
 * Одобрение исполнялось с первого тапа, включая «Одобрить все (N)».
 *
 * Между тем одобрение и есть исполнение: аппрув висит ровно на действиях,
 * уходящих наружу — публикация в канал, сообщение в чат, отправка документа.
 * Отменить их нельзя (никакого undo у Telegram-публикации нет), а промах
 * пальцем в Mini App на телефоне — обычное дело. Дороже всего групповая
 * кнопка: один тап исполняет весь request_id разом.
 *
 * Инвариант: необратимая половина решения защищена не слабее обратимой.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmApproveText } from "../miniapp/src/pages/Approvals.tsx";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Approvals.tsx"),
  "utf8",
);

function ap(action_type: string) {
  return { id: `a${action_type}`, action_type } as never;
}

describe("одобрение подтверждается не слабее отклонения", () => {
  test("в вопросе названо, что именно исполнится", () => {
    // Иначе подтверждение вырождается в лишний тап, который жмут не глядя.
    expect(confirmApproveText([ap("PUBLISH_POST")])).toContain("PUBLISH_POST");
  });

  test("в групповом вопросе названо количество", () => {
    const text = confirmApproveText([ap("SEND_MESSAGE"), ap("SEND_MESSAGE"), ap("PUBLISH_POST")]);
    expect(text).toContain("3");
    expect(text).toContain("SEND_MESSAGE ×2");
    expect(text).toContain("PUBLISH_POST");
  });

  test("кнопка одобрения проходит через confirm", () => {
    const btn = SRC.slice(SRC.indexOf('className="btn success"'), SRC.indexOf('className="btn danger"', SRC.indexOf('className="btn success"')));
    expect(btn).toContain("window.confirm(confirmApproveText");
    // Прежняя форма — одобрение прямо из onClick, без единого вопроса.
    expect(btn).not.toMatch(/onClick=\{\(\) => decideMany\(ids, "approved"\)\}/);
  });

  test("отклонение по-прежнему подтверждается", () => {
    // Симметрия достигается добавлением защиты, а не снятием существующей.
    expect(SRC).toContain("function confirmReject");
    expect(SRC).toContain("if (confirmReject(n))");
  });
});
