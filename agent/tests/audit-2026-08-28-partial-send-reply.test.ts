/**
 * Аудит 2026-08-28: половина отправки подавалась как «повтори запрос».
 *
 * `sendChunked` бросает `PartialSendError`, когда k из N частей уже в чате.
 * Класс заведён аудитом 2026-08-13 ровно ради того, чтобы «половина
 * side-effect'а состоялась» была сказана словами. Но на пути к человеку стоит
 * `replyForTurnError`, и до этой правки он про класс не знал: разбирал только
 * `BudgetExceededError`, потом сверял ТЕКСТ ошибки с /429|rate.?limit|overloaded/.
 *
 * Текст `PartialSendError` кончается сообщением причины, поэтому обрыв по
 * флуд-контролю (самый частый: у юзербота FLOOD_WAIT висит на каждой части
 * отдельно) читался человеку как «Модель сейчас перегружена — повтори запрос
 * через минуту». Повтор дописывает ВТОРОЙ экземпляр уже доставленных частей:
 * идемпотентности в Telegram нет ни на одном уровне, плюс лишний ход модели.
 */
import { describe, expect, test } from "bun:test";
import { replyForTurnError } from "../orchestrator/message-handler.ts";
import { PartialSendError } from "../lib/telegram-chunking.ts";
import { BudgetExceededError } from "../lib/token-budget.ts";

const RETRY = "Повтори запрос";
const OVERLOADED = "Модель сейчас перегружена";

describe("частичная доставка", () => {
  test("причина 429 больше не выдаётся за перегрузку модели", () => {
    const err = new PartialSendError(new Error("429: Too Many Requests: retry after 30"), 3, 7);
    const out = replyForTurnError(err);
    expect(out).not.toContain(OVERLOADED);
    expect(out).not.toContain("повтори запрос через минуту");
  });

  test("человеку названы обе цифры: сколько ушло и сколько всего", () => {
    const out = replyForTurnError(new PartialSendError(new Error("boom"), 3, 7));
    expect(out).toContain("3");
    expect(out).toContain("7");
  });

  test("сказано, что повторять не нужно", () => {
    for (const cause of [new Error("429 flood"), new Error("socket hang up"), "строка"]) {
      const out = replyForTurnError(new PartialSendError(cause, 1, 2));
      expect(out.toLowerCase()).toContain("повтор");
      expect(out).not.toContain(RETRY);
    }
  });

  test("ответ не выдаётся за «ничего не произошло»", () => {
    const out = replyForTurnError(new PartialSendError(new Error("boom"), 2, 5));
    expect(out).not.toContain("Не смог обработать сообщение");
    expect(out).not.toContain("внутренняя ошибка");
  });

  test("разбор идёт по классу, а не по тексту причины", () => {
    // Причина без единого узнаваемого слова — ветка всё равно та же.
    const a = replyForTurnError(new PartialSendError(new Error("xyzzy"), 4, 9));
    const b = replyForTurnError(new PartialSendError(new Error("429 rate limit"), 4, 9));
    expect(a).toBe(b);
  });

  test("вложенный в другую ошибку PartialSendError не ломает разбор", () => {
    // Не оборачиваем — фиксируем, что необёрнутый случай единственный, который
    // ветка обязана ловить, а посторонняя ошибка идёт прежним путём.
    expect(replyForTurnError(new Error("что-то своё"))).toContain("внутренняя ошибка");
  });
});

describe("прежние ветки не задеты", () => {
  test("голый 429 по-прежнему читается как перегрузка", () => {
    expect(replyForTurnError(new Error("429 Too Many Requests"))).toContain(OVERLOADED);
    expect(replyForTurnError(new Error("model is overloaded"))).toContain(OVERLOADED);
    expect(replyForTurnError(new Error("rate limit exceeded"))).toContain(OVERLOADED);
  });

  test("бюджет без side-effect'ов — прежний текст", () => {
    const out = replyForTurnError(new BudgetExceededError("pm", 10, 5));
    expect(out).toContain("Дневной лимит токенов");
    expect(out).toContain("00:00 UTC");
  });

  test("бюджет с состоявшимися действиями — прежний текст", () => {
    const err = new BudgetExceededError("pm", 10, 5, { sideEffects: true });
    expect(replyForTurnError(err)).toContain("Часть действий уже выполнена");
  });

  test("произвольная ошибка — прежний общий текст", () => {
    expect(replyForTurnError(new Error("ENOSPC"))).toContain("внутренняя ошибка");
    expect(replyForTurnError("строка")).toContain("внутренняя ошибка");
  });
});
