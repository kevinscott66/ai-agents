/**
 * Аудит 2026-08-28: несохранённый прогресс ингеста уничтожал одобренный выпуск.
 *
 * Ветка `progress_unsaved` в `tools/approve-poll.ts` звала `clearPending()` и
 * писала владельцу «Выпуск за этот день потерян, чините диск». Обоснование
 * стояло прямо в комментарии: «ингест не идемпотентен, в POST не уходит ни
 * одного ключа, по которому сайт мог бы узнать дубль».
 *
 * Посылка неверна. Дедупликация на сайте идёт по ЗАГОЛОВКУ:
 * `site/server/index.ts` считает id занятым только если
 * `existing !== null && existing.title !== title`, то есть «занято» = «под
 * этим id лежит ДРУГОЙ материал». Повтор того же title+date возвращает ТОТ ЖЕ
 * id двумя путями — `reusableDigestId(findLatestDigestByTitle(title))` с окном
 * 12 ч (а `a.date` в pending зафиксирован) и
 * `freeSlug(slugFromTitle(title, dateIso), taken)`. На стороне сайта это уже
 * запинено: `site/server/ingest-slug.test.ts` — «повторная отправка той же
 * статьи обновляет её, а не плодит копии».
 *
 * Цена повтора, которого боялись, — обновление страницы на месте. Цена
 * `clearPending()` — уничтоженный выпуск: апрув владельца и оплаченный ресёрч
 * сгорают, а починить нечем. Сценарий не экзотический: ENOSPC на `data/`,
 * EACCES, том `/opt/web3-puls` перемонтирован read-only ровно в момент первого
 * `savePending`. Обычный повтор через 30 минут вернул бы те же id и
 * опубликовал штатно.
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
      date: "2026-08-28",
      summary: `S${i}`,
      body: `B${i}`,
      items: [],
      sourceCount: 2,
      emoji: "🔥",
      blurb: "коротко о новости",
    })),
  };
}

/**
 * Стенд с диском, который ломается на `failFrom`-м вызове `savePending` и
 * чинится после `healAfter` отказов — как настоящий ENOSPC после ротации логов.
 */
function harness(opts: { failFrom: number; healAfter?: number }) {
  const h = {
    ingested: [] as string[],
    saves: 0,
    faults: 0,
    cleared: 0,
    sent: 0,
    /** Что реально лежит «на сайте»: заголовок → id. Дедуп по заголовку. */
    site: new Map<string, string>(),
  };
  const deps: PublishDeps = {
    ingest: async (a) => {
      h.ingested.push(a.title);
      // Модель сайта: тот же заголовок → тот же id, страница обновляется.
      const existing = h.site.get(a.title);
      if (existing) return existing;
      const id = `${a.date}-novost-${h.site.size + 1}`;
      h.site.set(a.title, id);
      return id;
    },
    renderBanner: async () => banner,
    send: async () => {
      h.sent++;
      return { msgId: 500, tailSent: 0, tailTotal: 0 };
    },
    savePending: () => {
      h.saves++;
      const broken =
        h.saves >= opts.failFrom &&
        (opts.healAfter === undefined || h.faults < opts.healAfter);
      if (broken) {
        h.faults++;
        throw new Error("ENOSPC: no space left on device");
      }
    },
    clearPending: () => {
      h.cleared++;
    },
    log: () => {},
  };
  return { h, deps };
}

describe("несохранённый прогресс ингеста не уничтожает выпуск", () => {
  test("pending остаётся, отправки нет, наружу не бросаем", async () => {
    const { h, deps } = harness({ failFrom: 1 });
    const res = await runApprovedPublish(pending(), deps);

    expect(res).toEqual({ published: false, reason: "progress_unsaved" });
    expect(h.cleared).toBe(0);
    expect(h.sent).toBe(0);
  });

  test("следующий тик по тому же pending доводит публикацию, не плодя страниц", async () => {
    // Первый прогон: диск сломан, одна статья уехала, siteId не сохранён.
    const { h, deps } = harness({ failFrom: 1, healAfter: 1 });
    // Ровно то, что лежит в pending.json: `savePending` не прошёл, значит
    // siteId первой статьи на диск не попал. Следующий тик читает файл заново,
    // а не объект из памяти упавшего процесса — моделируем это клоном.
    const onDisk = pending(2);
    const first = await runApprovedPublish(structuredClone(onDisk), deps);
    expect(first.reason).toBe("progress_unsaved");
    expect(h.cleared).toBe(0);

    // Диск починился. Тот же pending, тот же тик через 30 минут — владелец
    // ничего заново не одобряет.
    const second = await runApprovedPublish(structuredClone(onDisk), deps);
    expect(second.published).toBe(true);
    expect(h.sent).toBe(1);

    // Первая статья ингестилась дважды, но страниц ровно две — по числу
    // заголовков. Именно этого дубля боялась старая ветка.
    expect(h.ingested).toEqual(["Новость 1", "Новость 1", "Новость 2"]);
    expect(h.site.size).toBe(2);
  });

  test("сорванная отметка публикации по-прежнему не трогает pending", async () => {
    // 1-й и 2-й вызовы savePending — прогресс ингеста, 3-й — publishStartedAt.
    const { h, deps } = harness({ failFrom: 3 });
    const res = await runApprovedPublish(pending(2), deps);

    expect(res).toEqual({ published: false, reason: "publish_failed" });
    expect(h.sent).toBe(0);
    expect(h.cleared).toBe(0);
  });
});

describe("обоснование ветки больше не ссылается на опровергнутую посылку", () => {
  test("комментарий не утверждает неидемпотентность ингеста", async () => {
    const src = await Bun.file(
      new URL("../tools/approve-poll.ts", import.meta.url),
    ).text();
    // Старый текст владельцу — единственный след прежнего инварианта.
    expect(src.includes("Выпуск за этот день потерян")).toBe(false);
    expect(src.includes("дедуп по заголовку")).toBe(true);
  });
});
