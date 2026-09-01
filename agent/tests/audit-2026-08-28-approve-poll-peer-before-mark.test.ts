/**
 * Аудит 2026-08-28: сетевая подготовка отправки стояла ПОСЛЕ точки невозврата.
 *
 * Комментарий у шага 3 в `tools/approve-poll.ts` обещал: «Всё, что падает до
 * этой точки (рендер баннера, getInputEntity), повторяется свободно: отметки
 * ещё нет». Фактически `const peer = await client.getInputEntity(CHANNEL_ID)`
 * был первой строкой ВНУТРИ замыкания `send`, а `send` зовётся уже после того,
 * как `pending.publishStartedAt` проставлен и записан на диск. Там же, внутри
 * `send`, впервые исполнялась и разметка (`mdToUserbotHtml` + `HTMLParser`).
 *
 * Цена расхождения: пир не в кэше сессии, FLOOD_WAIT, оборванный коннект — и
 * выпуск получает `publish_failed` с отметкой на диске. Дальше каждый тик
 * отвечает `publish_already_attempted` и не отправляет ничего, а через 20 часов
 * TTL стирает pending со словами «пост мог уйти в канал» — хотя в канал не ушло
 * ни байта. Одобренный владельцем выпуск теряется на сбое, который повторяется
 * бесплатно.
 *
 * Правка: сетевой резолв пира и холостой прогон разметки вынесены в отдельный
 * шаг `prepareSend`, который зовётся рядом с рендером баннера — ДО отметки.
 * Отказ на этом шаге оставляет pending нетронутым, и следующий тик доводит
 * публикацию штатно.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runApprovedPublish, type PublishDeps } from "../tools/approve-poll.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";

const banner = new Uint8Array([9, 9, 9]);

function pending(): PendingDraft {
  return {
    createdAt: new Date().toISOString(),
    previewMsgId: 424,
    dayTitle: "Дайджест",
    articles: [
      {
        title: "Новость 1",
        date: "2026-08-28",
        summary: "S",
        body: "B",
        items: [],
        sourceCount: 2,
        emoji: "🔥",
        blurb: "коротко о новости",
      },
    ],
  };
}

/**
 * Стенд: `prepareSend` падает `failPrepares` раз подряд (FLOOD_WAIT на резолве
 * пира), потом чинится. `disk` — то, что реально дошло до pending.json.
 */
function harness(opts: { failPrepares: number; failSend?: boolean }) {
  let prepares = 0;
  const h = {
    order: [] as string[],
    prepares: 0,
    sent: 0,
    cleared: 0,
    /** Последнее, что записано «на диск». Именно это прочтёт следующий тик. */
    disk: null as PendingDraft | null,
  };
  const deps: PublishDeps = {
    ingest: async (a) => `${a.date}-id`,
    renderBanner: async () => {
      h.order.push("banner");
      return banner;
    },
    prepareSend: async () => {
      h.order.push("prepare");
      h.prepares++;
      if (++prepares <= opts.failPrepares) {
        throw new Error("FLOOD_WAIT_42: peer not resolved");
      }
    },
    send: async () => {
      h.order.push("send");
      if (opts.failSend) throw new Error("connection closed");
      h.sent++;
      return { msgId: 900, tailSent: 0, tailTotal: 0 };
    },
    savePending: (p) => {
      h.order.push("save");
      h.disk = structuredClone(p);
    },
    clearPending: () => {
      h.cleared++;
    },
    log: () => {},
  };
  return { h, deps };
}

describe("approve-poll: сетевая подготовка исполняется до отметки публикации", () => {
  test("сбой prepareSend не ставит отметку и не сжигает выпуск", async () => {
    const { h, deps } = harness({ failPrepares: 1 });
    const onDisk = pending();

    const first = await runApprovedPublish(structuredClone(onDisk), deps);
    expect(first.published).toBe(false);
    expect(first.reason).toBe("prepare_failed");
    // Ни отправки, ни отметки, ни стирания: следующий тик увидит тот же pending.
    // На диске только прогресс ингеста (шаг 1) — отметки публикации там нет,
    // значит `publish_already_attempted` не сработает и повтор разрешён.
    expect(h.sent).toBe(0);
    expect(h.cleared).toBe(0);
    expect(h.disk?.publishStartedAt).toBeUndefined();
    expect(h.order).toEqual(["save", "banner", "prepare"]);

    // Второй тик — пир резолвится, выпуск уходит.
    const second = await runApprovedPublish(structuredClone(onDisk), deps);
    expect(second.published).toBe(true);
    expect(second.msgId).toBe(900);
    expect(h.sent).toBe(1);
    expect(h.cleared).toBe(1);
  });

  test("prepareSend идёт строго перед savePending, а тот — перед send", async () => {
    const { h, deps } = harness({ failPrepares: 0 });
    const res = await runApprovedPublish(pending(), deps);
    expect(res.published).toBe(true);
    // Порядок и есть инвариант: всё повторяемое слева от save, отправка справа.
    // Первый save — прогресс ингеста (шаг 1), второй — отметка публикации.
    expect(h.order).toEqual(["save", "banner", "prepare", "save", "send"]);
  });

  test("сбой самой отправки по-прежнему оставляет отметку на диске", async () => {
    const { h, deps } = harness({ failPrepares: 0, failSend: true });
    const res = await runApprovedPublish(pending(), deps);
    expect(res.published).toBe(false);
    expect(res.reason).toBe("publish_failed");
    // Отметка обязана уцелеть: сбой send неотличим от «доставлено, ответ потерян».
    expect(h.disk?.publishStartedAt).toBeTruthy();
    expect(h.cleared).toBe(0);
  });

  test("prepareSend опционален — старые вызывающие не ломаются", async () => {
    const { deps } = harness({ failPrepares: 5 });
    const res = await runApprovedPublish(pending(), { ...deps, prepareSend: undefined });
    expect(res.published).toBe(true);
  });

  test("резолв пира и разметка живут вне замыкания send", () => {
    const src = readFileSync(new URL("../tools/approve-poll.ts", import.meta.url), "utf8");
    // Сигнал регрессии: getInputEntity снова первой строкой внутри send.
    expect(src).not.toContain("send: async (finalText, _head, banner) => {\n      const peer = await client.getInputEntity");
    expect(src).toContain("prepareSend: async (finalText) => {");
    expect(src).toContain("function renderForUserbot(");
  });
});
