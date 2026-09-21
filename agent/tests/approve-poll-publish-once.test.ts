/**
 * Аудит 2026-08-12: одобренный дайджест мог опубликоваться дважды — и мог
 * опубликоваться пустым.
 *
 * approve-poll.ts запускается таймером каждые 30 минут. При ЛЮБОЙ ошибке
 * публикации pending НЕ удалялся («попробуем на след. поллинге»), а реакция ✅
 * на превью оставалась на месте — то есть следующий тик проходил весь путь
 * заново, до 48 раз в сутки.
 *
 * Ключевое: «ошибка публикации» ≠ «не доставлено». Если sendFile дошёл до
 * Telegram, а ответ оборвался, повтор кладёт подписчикам ВТОРОЙ экземпляр
 * поста. Этот класс закрыт по всему остальному коду с явными комментариями
 * (`sendWithHtml` в lib/telegram-format.ts, `isPhotoRejected` в
 * lib/telegram-actions.ts) — ежедневный публикатор канала был единственным
 * местом, где правило не применили.
 *
 * Вторая половина аудита — про ингест: шаг 1 постил каждую статью на backend
 * сайта, получал id её страницы и подставлял его в «Подробнее →», а при
 * провале публикация отменялась, чтобы в канал не ушёл пост со ссылками на
 * голую главную. 21.09.2026 ингест убран целиком (AUD-20260921-033): того
 * backend'а больше нет, а живой сайт страницу выпуска до публикации и не
 * может отдать. Тесты про идемпотентность ингеста ушли вместе с ним; проверки
 * «ровно один пост» ниже остались — они про отправку, а не про сайт.
 *
 * Инварианты: после начала отправки автоповтора нет; всё до отметки
 * повторяется свободно; ссылка в посте ведёт туда, что существует.
 */
import { describe, test, expect } from "bun:test";
import {
  runApprovedPublish,
  buildFinalText,
  type PublishDeps,
} from "../tools/approve-poll.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";
import { DELABS_SECTIONS } from "../lib/delabs-sections.ts";

function makePending(): PendingDraft {
  return {
    createdAt: new Date().toISOString(),
    previewMsgId: 777,
    dayTitle: "Дайджест: биткоин и AI",
    articles: [
      {
        title: "Новость А",
        date: "2026-08-12",
        summary: "S1",
        body: "B1",
        items: [],
        sourceCount: 2,
        emoji: "🔥",
        blurb: "первая",
      },
      {
        title: "Новость Б",
        date: "2026-08-12",
        summary: "S2",
        body: "B2",
        items: [],
        sourceCount: 3,
        emoji: "💰",
        blurb: "вторая",
      },
    ],
  };
}

interface Harness {
  deps: PublishDeps;
  sendCalls: string[];
  saved: number;
  cleared: number;
}

function harness(opts: {
  throwOnSend?: number[]; // номера вызовов (с 1), на которых send бросает
  throwOnBanner?: boolean;
}): Harness {
  const h: any = { sendCalls: [], saved: 0, cleared: 0 };
  h.deps = {
    renderBanner: async () => {
      if (opts.throwOnBanner) throw new Error("шрифт не найден");
      return new Uint8Array([1, 2, 3]);
    },
    send: async (text: string) => {
      h.sendCalls.push(text);
      if (opts.throwOnSend?.includes(h.sendCalls.length)) {
        throw new Error("timeout после доставки");
      }
      return { msgId: 1000 + h.sendCalls.length, tailSent: 0, tailTotal: 0 };
    },
    savePending: () => {
      h.saved++;
    },
    clearPending: () => {
      h.cleared++;
    },
    log: () => {},
  };
  return h as Harness;
}

describe("approve-poll: публикация ровно один раз", () => {
  test("успешный путь: один пост, pending очищен", async () => {
    const p = makePending();
    const h = harness({});
    const res = await runApprovedPublish(p, h.deps);
    expect(res.published).toBe(true);
    expect(h.sendCalls.length).toBe(1);
    expect(h.cleared).toBe(1);
  });

  test("после начала отправки автоповтора нет — пост мог уйти", async () => {
    const p = makePending();
    const h1 = harness({ throwOnSend: [1] });
    await runApprovedPublish(p, h1.deps);
    expect(p.publishStartedAt).toBeString();

    const h2 = harness({});
    const r2 = await runApprovedPublish(p, h2.deps);
    expect(r2.published).toBe(false);
    expect(r2.reason).toBe("publish_already_attempted");
    expect(h2.sendCalls.length).toBe(0); // старое поведение: 1 — дубль подписчикам
    expect(h2.cleared).toBe(0);
  });

  test("сбой рендера баннера повторяется свободно — отметки ещё нет", async () => {
    // Граница намеренная: всё до sendFile однозначно «не доставлено».
    const p = makePending();
    const h1 = harness({ throwOnBanner: true });
    const r1 = await runApprovedPublish(p, h1.deps);
    expect(r1.reason).toBe("banner_failed");
    expect(p.publishStartedAt).toBeUndefined();

    const h2 = harness({});
    expect((await runApprovedPublish(p, h2.deps)).published).toBe(true);
  });

  test("в посте одна ссылка на разделы, а не «Подробнее →» у каждой новости", async () => {
    // Исходная дыра была в том, что пост обещал «детали по ссылкам», а вёл на
    // страницы, которых нет. Теперь адресов ровно столько, сколько разделов, и
    // ни один из них не зависит от того, успел ли сайт пересобрать корпус.
    const text = buildFinalText(makePending());
    expect(text).toContain("Разделы:");
    for (const s of DELABS_SECTIONS) expect(text).toContain(s.href);
    expect(text).not.toContain("Подробнее");
    expect(text).not.toContain("/digest/"); // страница выпуска, которой нет
  });
});
