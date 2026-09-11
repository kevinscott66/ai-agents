/**
 * Аудит 2026-08-12: одобренный дайджест мог опубликоваться дважды — и мог
 * опубликоваться пустым.
 *
 * approve-poll.ts запускается таймером каждые 30 минут. При ЛЮБОЙ ошибке
 * публикации pending НЕ удалялся («попробуем на след. поллинге»), а реакция ✅
 * на превью оставалась на месте — то есть следующий тик проходил весь путь
 * заново, до 48 раз в сутки. Ингест при этом не идемпотентен: в POST уходят
 * только title/date/summary/body/items/sourceCount, ключа, по которому сайт
 * узнал бы дубль, нет вовсе (процессный дедуп в lib/site-ingest.ts на этот
 * oneshot не распространяется).
 *
 * Замер старого control flow на тех же фейках (зонд, дословная копия main()):
 *   СЦЕНАРИЙ 1: ингест 1/2 упал, отправка упала, три тика таймера
 *     вызовов ingest: 6 ["Новость А","Новость Б","Новость А","Новость Б",…]
 *   СЦЕНАРИЙ 2: отправка «упала» (ответ потерян), потом ок
 *     вызовов ingest: 4 → страниц на сайте: 4
 *     постов отправлено в канал: 1 (+1 возможный от «потерянного» ответа)
 *   СЦЕНАРИЙ 3: ингест упал полностью
 *     ссылки в посте: ["https://delabs.space","https://delabs.space"]
 *     pending после публикации: удалён (шаг 3 выполняется безусловно)
 *
 * Сценарий 3 — отдельная дыра: дайджест уходил подписчикам, обещая «детали по
 * ссылкам на сайте», каждое «Подробнее →» вело на главную, статей не было, а
 * pending стирался. Владелец одобрил не то, что вышло, и откатить нечем.
 *
 * Ключевое: «ошибка публикации» ≠ «не доставлено». Если sendFile дошёл до
 * Telegram, а ответ оборвался, повтор кладёт подписчикам ВТОРОЙ экземпляр
 * поста. Этот класс закрыт по всему остальному коду с явными комментариями
 * (`sendWithHtml` в lib/telegram-format.ts, `isPhotoRejected` в
 * lib/telegram-actions.ts, ветка таймаута в `ingestDigestToSite` —
 * lib/site-ingest.ts) — ежедневный публикатор канала был единственным местом,
 * где правило не применили.
 *
 * Инварианты: ингест ровно один раз на статью; без полного ингеста публикации
 * нет; после начала отправки автоповтора нет.
 */
import { describe, test, expect } from "bun:test";
import {
  runApprovedPublish,
  buildFinalText,
  type PublishDeps,
} from "../tools/approve-poll.ts";
import type { PendingDraft, DraftArticle } from "../tools/daily-draft.ts";

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
  ingestCalls: string[];
  sendCalls: string[];
  saved: number;
  cleared: number;
}

function harness(opts: {
  ingest?: (a: DraftArticle, n: number) => string | null;
  send?: (n: number) => number; // бросает — через throwOnSend
  throwOnSend?: number[]; // номера вызовов (с 1), на которых send бросает
  throwOnBanner?: boolean;
}): Harness {
  const h: any = { ingestCalls: [], sendCalls: [], saved: 0, cleared: 0 };
  h.deps = {
    ingest: async (a: DraftArticle) => {
      h.ingestCalls.push(a.title);
      return opts.ingest
        ? opts.ingest(a, h.ingestCalls.length)
        : `id-${h.ingestCalls.length}`;
    },
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
  test("успешный путь: ингест обеих, отправка, pending очищен", async () => {
    const p = makePending();
    const h = harness({});
    const res = await runApprovedPublish(p, h.deps);
    expect(res.published).toBe(true);
    expect(h.ingestCalls).toEqual(["Новость А", "Новость Б"]);
    expect(h.sendCalls.length).toBe(1);
    expect(h.cleared).toBe(1);
  });

  test("повтор после сбоя отправки не ингестит статьи заново", async () => {
    const p = makePending();
    // Первый тик: ингест ок, отправка бросает.
    const h1 = harness({ throwOnSend: [1] });
    const r1 = await runApprovedPublish(p, h1.deps);
    expect(r1.published).toBe(false);
    expect(r1.reason).toBe("publish_failed");
    expect(h1.ingestCalls.length).toBe(2);
    // Прогресс сохранён в самом pending — второй тик читает его же.
    expect(p.articles.every((a) => a.siteId)).toBe(true);

    const h2 = harness({});
    await runApprovedPublish(p, h2.deps);
    expect(h2.ingestCalls).toEqual([]); // старое поведение: 2 (итого 4 страницы)
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

  test("провал ингеста отменяет публикацию, а не подменяет ссылки главной", async () => {
    const p = makePending();
    const h = harness({ ingest: (a) => (a.title === "Новость А" ? "id-1" : null) });
    const res = await runApprovedPublish(p, h.deps);
    expect(res.published).toBe(false);
    expect(res.reason).toBe("ingest_failed");
    expect(h.sendCalls.length).toBe(0);
    expect(h.cleared).toBe(0); // pending жив — повтор осмыслен
  });

  test("повтор после провала ингеста добирает только недостающие статьи", async () => {
    const p = makePending();
    const h1 = harness({ ingest: (a) => (a.title === "Новость А" ? "id-1" : null) });
    await runApprovedPublish(p, h1.deps);
    expect(h1.ingestCalls).toEqual(["Новость А", "Новость Б"]);

    const h2 = harness({ ingest: () => "id-2" });
    const r2 = await runApprovedPublish(p, h2.deps);
    expect(h2.ingestCalls).toEqual(["Новость Б"]); // «Новость А» больше не дублируется
    expect(r2.published).toBe(true);
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

  test("в тексте поста ссылки ведут на статьи, а не на главную", async () => {
    const p = makePending();
    p.articles[0]!.siteId = "aaa111";
    p.articles[1]!.siteId = "bbb222";
    const text = buildFinalText(p);
    expect(text).toContain("/digest/aaa111");
    expect(text).toContain("/digest/bbb222");
    // Голая главная как «Подробнее →» — тот самый пустой дайджест.
    expect(text).not.toContain("](https://delabs.space)");
  });
});
