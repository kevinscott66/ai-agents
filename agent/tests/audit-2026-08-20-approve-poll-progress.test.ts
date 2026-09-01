/**
 * Аудит 2026-08-20: `deps.savePending` в runApprovedPublish не был защищён.
 *
 * Путь 1 — прогресс ингеста (`approve-poll.ts`, шаг 1). Статья уже уехала на
 * сайт, `a.siteId` присвоен в памяти, и тут запись pending на диск бросает
 * (ENOSPC на data/, EACCES, отвалившийся том). Исключение улетало вверх мимо
 * всех catch, и процесс падал с кодом 1.
 *
 * ПОПРАВКА 2026-08-28. Тогда ветку закрыли вызовом `clearPending()`, считая,
 * что повтор ингеста создаст вторую публичную страницу. Посылка неверна: сайт
 * дедуплицирует по ЗАГОЛОВКУ, повтор обновляет ту же страницу на месте
 * (`site/server/ingest-slug.test.ts` это пинит). Инвариант исправлен —
 * подробности и разбор в `audit-2026-08-28-approve-poll-progress-keeps-pending`.
 *
 * Путь 2 — отметка `publishStartedAt` (шаг 3). Она пишется ДО отправки именно
 * потому, что сбой sendFile неотличим от «доставлено, но ответ потерян». Если
 * запись отметки сорвалась, а отправку всё равно выполнить, следующий тик
 * положит подписчикам второй экземпляр поста.
 *
 * Инвариант у обоих путей теперь один: наружу не бросаем, публикацию не
 * доводим, pending НЕ трогаем — в канал ничего не ушло, а повтор безопасен и
 * нужен.
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
  const h = { ingested: [] as string[], saves: 0, cleared: 0, sent: 0 };
  const deps: PublishDeps = {
    ingest: async (a) => {
      h.ingested.push(a.title);
      return `id-${h.ingested.length}`;
    },
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
  test("прогресс ингеста не сохранён → не бросаем наружу и pending цел", async () => {
    const { h, deps } = harness(1);
    const res = await runApprovedPublish(pending(), deps);
    expect(res).toEqual({ published: false, reason: "progress_unsaved" });
    // Ровно одна статья успела уехать на сайт — вторую не трогаем.
    expect(h.ingested).toEqual(["Новость 1"]);
    // pending НЕ снят: одобренный владельцем выпуск не уничтожается ради
    // дубля, которого сайт не создаёт (аудит 2026-08-28).
    expect(h.cleared).toBe(0);
    expect(h.sent).toBe(0);
  });

  test("сорванный прогресс не доводит дело до публикации", async () => {
    const { h, deps } = harness(1);
    await runApprovedPublish(pending(3), deps);
    expect(h.sent).toBe(0);
  });

  test("отметка публикации не сохранена → отправки нет и pending цел", async () => {
    // savePending: 1-й и 2-й вызовы — прогресс ингеста двух статей, 3-й — отметка.
    const { h, deps } = harness(3);
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
