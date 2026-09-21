/**
 * AUD-20260921-033: ингест сайта в пути публикации — мёртвая ветка, которая
 * молча съедала одобренный выпуск.
 *
 * Как было. Шаг 1 постил каждую статью на backend сайта и получал id её
 * страницы, шаг 2 на любом провале ОТМЕНЯЛ публикацию — сам по себе правильно:
 * пост обещал «детали по ссылкам», и без страниц выходить ему было нельзя.
 * Но backend'а больше нет — хост из `SITE_INGEST_URL` не резолвится (та же
 * NXDOMAIN, что в AUD-20260919-022). Значит id не вернётся НИКОГДА, значит
 * ✅ владельца не давало ничего, а `MAX_AGE_MS` через 20 часов стирал pending
 * вместе со сгоревшим на него ресёрчем. Отказ был тихий: в канал не уходит
 * ничего, и заметить можно только по логу.
 *
 * Почему не «починить ингест». Живой сайт устроен наоборот: `/digest/[slug]`
 * строится из корпуса, а корпус догоняется из снапшота канала уже ПОСЛЕ поста.
 * Адреса страницы выпуска в момент публикации не существует by design, и
 * никакой ингест этого не меняет.
 *
 * Тест держит границу с двух сторон: в модуле не осталось ни ингеста, ни
 * ожидания ответа от сайта, и публикация доезжает до канала на deps, где сайта
 * нет вовсе.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runApprovedPublish,
  buildFinalText,
  type PublishDeps,
} from "../tools/approve-poll.ts";
import type { PendingDraft } from "../tools/daily-draft.ts";

/**
 * Исходник без комментариев: сам разбор выше называет и `SITE_INGEST_URL`, и
 * `ingestArticle` — на то он и объяснение, почему их больше нет. Ищем в КОДЕ.
 */
const CODE = readFileSync(
  join(import.meta.dir, "..", "tools", "approve-poll.ts"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

function pending(): PendingDraft {
  return {
    createdAt: new Date().toISOString(),
    previewMsgId: 1,
    dayTitle: "Дайджест",
    articles: [
      {
        title: "Новость А",
        date: "2026-09-21",
        summary: "S",
        body: "B",
        items: [],
        sourceCount: 1,
        emoji: "🔥",
        blurb: "первая",
      },
    ],
  };
}

describe("approve-poll: ингеста сайта в публикации нет", () => {
  test("модуль не знает ни про SITE_INGEST, ни про ingestArticle", () => {
    // Строкой по исходнику, а не по типам: вернуть ингест легче всего
    // «временно, до починки сайта», и тип бы этого не заметил.
    expect(CODE).not.toContain("SITE_INGEST");
    expect(CODE).not.toMatch(/ingest/i);
    // И заодно — что вырезать комментарии не значит вырезать весь файл.
    expect(CODE).toContain("runApprovedPublish");
  });

  test("публикация проходит на deps без единого обращения к сайту", async () => {
    const sent: string[] = [];
    let cleared = 0;
    const deps: PublishDeps = {
      renderBanner: async () => new Uint8Array([1]),
      send: async (text) => {
        sent.push(text);
        return { msgId: 5, tailSent: 0, tailTotal: 0 };
      },
      savePending: () => {},
      clearPending: () => {
        cleared++;
      },
      log: () => {},
    };
    const res = await runApprovedPublish(pending(), deps);
    // Раньше этот же набор данных давал published:false / ingest_failed.
    expect({ published: res.published, sent: sent.length, cleared }).toEqual({
      published: true,
      sent: 1,
      cleared: 1,
    });
  });

  test("в тексте нет ссылки на страницу выпуска", () => {
    const text = buildFinalText(pending());
    expect(text).not.toMatch(/\/digest\/\S/);
    expect(text).toContain("Разделы:");
  });
});
