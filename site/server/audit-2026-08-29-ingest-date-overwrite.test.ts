/**
 * Аудит 2026-08-29: `date` — последнее поле ингеста, где «не прислали»
 * означало «перезаписать».
 *
 * Оба апсерта писали `date = excluded.date` безусловно, а `parseIngestDate`
 * гарантировал, что NULL до SQL не доедет: отсутствующая дата превращалась в
 * «сейчас» (index.ts). Для вставки это осмысленный дефолт, для обновления —
 * порча данных.
 *
 * Штатный путь: правка уже опубликованного материала. `site-ingest.ts`
 * шлёт `{title, summary, items, sourceCount}` без даты, а `reusableDigestId`
 * в пределах 12 часов сводит правку на тот же id — то есть это UPDATE, и
 * дата прыгала на момент правки. Следом едут перетасовка ленты (сортировка
 * по `date DESC`), `<pubDate>` в RSS у тех, кто материал уже видел,
 * `<lastmod>` в sitemap и дата в URL, навсегда разошедшаяся с показанной.
 *
 * Все остальные поля обоих апсертов этот контракт уже получили: `body`
 * (2026-08-21), поля активности (2026-08-27), `items_json`/`source_count`
 * (2026-08-28). Здесь закрывается последнее.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-date-keep-"));
process.env.SITE_DB_PATH = join(TMP, "date-keep.db");
process.env.SITE_INGEST_TOKEN = "date-keep-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const { getDigest, getActivity } = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

async function post(kind: "digests" | "activities", body: unknown) {
  const r = await fetch(`${base}/api/internal/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer date-keep-token",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** Заведомо не «сейчас» и внутри допустимого диапазона ингеста. */
const OLD = "2026-08-01T09:00:00.000Z";
const NEWER = "2026-08-15T12:30:00.000Z";

describe("правка дайджеста не двигает дату публикации", () => {
  test("реингест без даты сохраняет исходную", async () => {
    const id = "d-keep-1";
    const first = await post("digests", {
      id,
      title: "Заголовок дайджеста",
      date: OLD,
      summary: "первая версия",
    });
    expect(first.status).toBe(200);
    expect(getDigest(id)?.date).toBe(OLD);

    // Ровно то, что шлёт site-ingest.ts при правке: даты в теле нет.
    const second = await post("digests", {
      id,
      title: "Заголовок дайджеста",
      summary: "исправленная версия",
    });
    expect(second.status).toBe(200);

    const after = getDigest(id);
    expect(after?.summary).toBe("исправленная версия");
    expect(after?.date).toBe(OLD);
  });

  test("явно присланная дата по-прежнему перезаписывает", async () => {
    const id = "d-keep-2";
    await post("digests", {
      id,
      title: "Второй заголовок",
      date: OLD,
      summary: "первая версия",
    });
    const r = await post("digests", {
      id,
      title: "Второй заголовок",
      date: NEWER,
      summary: "вторая версия",
    });
    expect(r.status).toBe(200);
    expect(getDigest(id)?.date).toBe(NEWER);
  });

  test("вставка без даты по-прежнему получает «сейчас»", async () => {
    const id = "d-keep-3";
    const before = Date.now();
    const r = await post("digests", {
      id,
      title: "Третий заголовок",
      summary: "единственная версия",
    });
    expect(r.status).toBe(200);
    const stored = Date.parse(String(getDigest(id)?.date));
    expect(stored).toBeGreaterThanOrEqual(before - 1000);
    expect(stored).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("негодная дата всё ещё 400, а не молчаливая подмена", async () => {
    const r = await post("digests", {
      id: "d-keep-4",
      title: "Четвёртый заголовок",
      date: "12.08.2026",
      summary: "версия",
    });
    expect(r.status).toBe(400);
    expect(getDigest("d-keep-4")).toBeNull();
  });
});

describe("правка активности не двигает дату публикации", () => {
  test("реингест без даты сохраняет исходную", async () => {
    const id = "a-keep-1";
    const first = await post("activities", {
      id,
      project: "Проект",
      title: "Гайд по проекту",
      date: OLD,
      status: "active",
    });
    expect(first.status).toBe(200);
    expect(getActivity(id)?.date).toBe(OLD);

    // Правка одного статуса — самый частый повторный ингест активности.
    const second = await post("activities", {
      id,
      project: "Проект",
      title: "Гайд по проекту",
      status: "ended",
    });
    expect(second.status).toBe(200);

    const after = getActivity(id);
    expect(after?.status).toBe("ended");
    expect(after?.date).toBe(OLD);
  });

  test("явно присланная дата по-прежнему перезаписывает", async () => {
    const id = "a-keep-2";
    await post("activities", {
      id,
      project: "Проект",
      title: "Второй гайд",
      date: OLD,
    });
    const r = await post("activities", {
      id,
      project: "Проект",
      title: "Второй гайд",
      date: NEWER,
    });
    expect(r.status).toBe(200);
    expect(getActivity(id)?.date).toBe(NEWER);
  });

  test("вставка без даты по-прежнему получает «сейчас»", async () => {
    const id = "a-keep-3";
    const before = Date.now();
    const r = await post("activities", {
      id,
      project: "Проект",
      title: "Третий гайд",
    });
    expect(r.status).toBe(200);
    const stored = Date.parse(String(getActivity(id)?.date));
    expect(stored).toBeGreaterThanOrEqual(before - 1000);
    expect(stored).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
