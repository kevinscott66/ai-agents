/**
 * Аудит 2026-08-20: `deps.savePending` в runApprovedPublish не был защищён.
 *
 * Путей было два. Первый — прогресс ингеста — исчез вместе с самим ингестом
 * 21.09.2026 (AUD-20260921-033): сайт больше не отдаёт id страницы, и шага,
 * который бы его сохранял, в publish-пути нет. Разбор того пути остался в
 * истории и в `audit-2026-08-28-approve-poll-progress-keeps-pending`, который
 * удалён тем же изменением.
 *
 * Второй путь живой и проверяется здесь — отметка `publishStartedAt`. Она
 * пишется ДО отправки именно потому, что сбой sendFile неотличим от
 * «доставлено, но ответ потерян». Если запись отметки сорвалась, а отправку
 * всё равно выполнить, следующий тик положит подписчикам второй экземпляр
 * поста.
 *
 * Инвариант: наружу не бросаем, публикацию не доводим, pending НЕ трогаем —
 * в канал ничего не ушло, а повтор безопасен и нужен.
 */
import { describe, test, expect } from "bun:test";
import { runApprovedPublish, type PublishDeps } from "../tools/approve-poll.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";

const banner = new Uint8Array([1, 2, 3]);

function pending(n = 2): PendingDraft {
  return {
    createdAt: new Date().toISOString(),
    previewMsgId: 777,
    dayTitle: "Дайджест",
    articles: Array.from({ length: n }, (_, i) => ({
      title: `Новость ${i + 1}`,
      date: "2026-08-20",
      summary: `S${i}`,
      body: `B${i}`,
      items: [],
      sourceCount: 2,
      emoji: "🔥",
      blurb: "коротко о новости",
    })),
  };
}

/** deps со счётчиками; `failSaveAt` — номер вызова savePending, который бросит. */
function harness(failSaveAt: number) {
  const h = { saves: 0, cleared: 0, sent: 0 };
  const deps: PublishDeps = {
    renderBanner: async () => banner,
    send: async () => {
      h.sent++;
      return { msgId: 500, tailSent: 0, tailTotal: 0 };
    },
    savePending: () => {
      h.saves++;
      if (h.saves === failSaveAt) throw new Error("ENOSPC: no space left on device");
    },
    clearPending: () => {
      h.cleared++;
    },
    log: () => {},
  };
  return { h, deps };
}

describe("runApprovedPublish: сорванная запись pending", () => {
  test("отметка публикации не сохранена → отправки нет и pending цел", async () => {
    // savePending теперь зовётся ровно раз — отметкой публикации: шага с
    // прогрессом ингеста больше нет, поэтому первый же вызов и есть отметка.
    const { h, deps } = harness(1);
    const res = await runApprovedPublish(pending(), deps);
    expect(res).toEqual({ published: false, reason: "publish_failed" });
    expect(h.sent).toBe(0);
    // Ничего не публиковалось — стирать черновик нельзя, следующий тик повторит.
    expect(h.cleared).toBe(0);
  });

  test("исправный диск — прежний путь без изменений", async () => {
    const { h, deps } = harness(0);
    const res = await runApprovedPublish(pending(), deps);
    expect(res.published).toBe(true);
    expect(h.sent).toBe(1);
    expect(h.cleared).toBe(1);
  });
});
