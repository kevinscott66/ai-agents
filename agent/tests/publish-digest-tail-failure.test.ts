/**
 * Аудит 2026-08-12: у публикации дайджеста хвост не был защищён — и падение на
 * нём оставляло в публичном канале обрезанный пост без возможности починить.
 *
 * `sendDigest` (tools/approve-poll.ts):
 *
 *   msgId = await io.sendPhoto(parts[0]!, banner);   // в try
 *   for (const tail of parts.slice(1)) await io.sendMessage(tail);   // без try
 *
 * Это не край, а обычный путь: типовой дайджест из 4 статей с блёрбами по ~180
 * символов даёт 1191 «плоский» символ при CAPTION_PLAIN_LIMIT = 1000, то есть
 * ДВЕ части. Последняя новость и весь футер канала уезжают вторым сообщением.
 * При повторе по caption_too_long лимит падает до 600 — частей больше, окно
 * шире.
 *
 * Что происходило при FLOOD_WAIT на втором сообщении (замер по коду
 * runApprovedPublish):
 *
 *   в канале осталось: [PHOTO+CAPTION] — без последней новости и без футера
 *   исход:             { published: false, reason: "publish_failed" }
 *   publishStartedAt:  проставлен (пишется ДО deps.send, строки 381-382)
 *   clearPending:      НЕ вызван
 *   следующий тик:     { published: false, reason: "publish_already_attempted" }
 *
 * То есть в публичном канале висит обрезанный пост, а штатно доделать его
 * нельзя: гард автоповтора заперт, pending не очищен, владельцу остаётся
 * править pending.json руками — и повторная публикация продублирует медиа.
 *
 * Тот же класс уже решён в соседнем транспорте: lib/telegram-actions.ts,
 * sendCaptionTail ловит ошибку на каждой части, пишет «[tg] хвост подписи не
 * доставлен», прерывает цикл и возвращает счётчик — «медиа уже в чате, и
 * объявить отправку неудачной значит спровоцировать повторную генерацию за
 * деньги». В approve-poll правило не применили.
 *
 * Инвариант: сбой хвоста — не сбой публикации. Медиа с подписью ушло → это
 * успех, состояние очищается, а недоставленный хвост виден в логе.
 *
 * Аудит 2026-08-20: «виден в логе» оказалось мало. `sendDigest` возвращал один
 * msgId, поэтому обрезанный пост был неотличим от целого: runApprovedPublish
 * отдавал `{published: true}`, main печатал «published» и выходил нулём —
 * юнит зелёный, в публичном канале пост без последних новостей и без футера.
 * Теперь наверх едет счётчик `tailSent/tailTotal`, а main превращает недобор в
 * ненулевой код выхода. Публикация при этом по-прежнему НЕ повторяется.
 */
import { describe, test, expect } from "bun:test";
import {
  sendDigest,
  runApprovedPublish,
  type PublishDeps,
} from "../tools/approve-poll.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";

const banner = new Uint8Array([1, 2, 3]);

/** Длинный текст: гарантированно больше одной части. */
const LONG = `${"Первая новость. ".repeat(60)}\n\n${"Хвост поста. ".repeat(60)}`;

function io(opts: { failMessageAt?: number } = {}) {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    io: {
      async sendPhoto(caption: string): Promise<number> {
        calls.push(`photo:${caption.slice(0, 12)}`);
        return 555;
      },
      async sendMessage(text: string): Promise<void> {
        n++;
        if (opts.failMessageAt === n) throw new Error("FLOOD_WAIT_31");
        calls.push(`message:${text.slice(0, 12)}`);
      },
    },
  };
}

describe("sendDigest: сбой на хвосте", () => {
  test("медиа ушло — публикация не объявляется неудачной", async () => {
    const r = io({ failMessageAt: 1 });
    const res = await sendDigest(LONG, banner, r.io);
    expect(res.msgId).toBe(555);
    expect(r.calls[0]).toStartWith("photo:");
  });

  test("после сбоя оставшиеся части не досылаются вслепую", async () => {
    const r = io({ failMessageAt: 1 });
    await sendDigest(LONG, banner, r.io, 200);
    expect(r.calls.filter((c) => c.startsWith("message:")).length).toBe(0);
  });

  test("сбой на самом медиа по-прежнему уходит наверх", async () => {
    await expect(
      sendDigest("привет", banner, {
        async sendPhoto(): Promise<number> {
          throw new Error("FLOOD_WAIT_42");
        },
        async sendMessage(): Promise<void> {},
      }),
    ).rejects.toThrow("FLOOD_WAIT_42");
  });
});

describe("runApprovedPublish: состояние после сбоя хвоста", () => {
  function pending(): PendingDraft {
    return {
      createdAt: new Date().toISOString(),
      previewMsgId: 777,
      dayTitle: "Дайджест",
      articles: [
        {
          title: "Новость А",
          date: "2026-08-12",
          summary: "S1",
          body: "B1",
          items: [],
          sourceCount: 2,
          emoji: "🔥",
          blurb: "первая новость дня, ".repeat(30),
        },
      ],
    };
  }

  test("пост в канале → published, pending очищен, тупика нет", async () => {
    let cleared = 0;
    const r = io({ failMessageAt: 1 });
    const deps: PublishDeps = {
      ingest: async () => "id-1",
      renderBanner: async () => banner,
      // Транспорт публикации — это sendDigest: медиа ушло, хвост нет.
      send: async (text) => sendDigest(text, banner, r.io, 200),
      savePending: () => {},
      clearPending: () => {
        cleared++;
      },
      log: () => {},
    };
    const res = await runApprovedPublish(pending(), deps);
    // Хвост действительно был — иначе тест ничего не проверяет.
    expect(r.calls[0]).toStartWith("photo:");
    expect({ published: res.published, cleared }).toEqual({
      published: true,
      cleared: 1,
    });
  });

  test("недобор хвоста доезжает наверх как tailIncomplete", async () => {
    // Без этого поля main печатает «published» и выходит нулём — обрезанный
    // пост в публичном канале не отличить от целого.
    const r = io({ failMessageAt: 1 });
    const res = await runApprovedPublish(pending(), {
      ingest: async () => "id-1",
      renderBanner: async () => banner,
      send: async (text) => sendDigest(text, banner, r.io, 200),
      savePending: () => {},
      clearPending: () => {},
      log: () => {},
    });
    expect(res.tailIncomplete?.sent).toBe(0);
    expect(res.tailIncomplete?.total).toBeGreaterThan(0);
  });

  test("хвост доставлен полностью — tailIncomplete не выставляется", async () => {
    const r = io();
    const res = await runApprovedPublish(pending(), {
      ingest: async () => "id-1",
      renderBanner: async () => banner,
      send: async (text) => sendDigest(text, banner, r.io, 200),
      savePending: () => {},
      clearPending: () => {},
      log: () => {},
    });
    expect(res.tailIncomplete).toBeUndefined();
  });
});
