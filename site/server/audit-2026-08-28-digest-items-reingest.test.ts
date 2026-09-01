/**
 * Аудит 2026-08-28: повторный ингест дайджеста без items стирал источники.
 *
 * `items_json = excluded.items_json` и `source_count = excluded.source_count`
 * писались безусловно, а HTTP-слой отсутствующее поле превращал в пустой
 * массив (`Array.isArray(b.items) ? b.items : []`). То есть «не прислали»
 * означало не «не трогать», а «стереть» — ровно то, что для соседнего `body`
 * уже починили 2026-08-21 идиомой `CASE WHEN $body IS NULL`, а для всех полей
 * активности — 2026-08-27.
 *
 * Заодно ломался поиск: `digestSearchText` склеивает тексты items, поэтому
 * `search_text` перезаписывался усечённым и статья пропадала из выдачи.
 *
 * Достижимо штатным путём: у `agent/tools/approve-poll.ts` и
 * `agent/lib/site-ingest.ts` наборы полей разные, а `reusableDigestId` в
 * пределах 12 часов сводит их на один id. Ответ эндпоинта при этом — ok, и
 * счётчик `droppedItems` равен нулю, так что в лог не попадает ничего.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SITE_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "web3puls-items-reingest-")),
  "site.db",
);
const { upsertDigest, getDigest, searchDigests } = await import("./db.ts");

const ITEMS = [
  { text: "эфир обновил максимум", url: "https://example.tld/a" },
  { text: "второй источник", url: "https://example.tld/b" },
];
const base = {
  id: "d-items",
  title: "Заголовок",
  date: "2026-08-28T00:00:00.000Z",
  summary: "аннотация",
};

describe("отсутствующие items не стирают сохранённые", () => {
  beforeEach(() => {
    upsertDigest({ ...base, items: ITEMS, sourceCount: 2 });
  });

  test("пункты остаются на месте", () => {
    upsertDigest({ ...base, body: "полный текст" });
    expect(getDigest(base.id)?.items).toEqual(ITEMS);
  });

  test("sourceCount не обнуляется", () => {
    upsertDigest({ ...base, body: "полный текст" });
    expect(getDigest(base.id)?.sourceCount).toBe(2);
  });

  test("статья остаётся в поиске по тексту пункта", () => {
    expect(searchDigests("эфир", 10, 0).length).toBe(1);
    upsertDigest({ ...base, body: "полный текст" });
    expect(searchDigests("эфир", 10, 0).length).toBe(1);
  });

  test("правка заголовка всё равно доезжает до поиска", () => {
    // search_text не просто сохраняется — он пересчитывается по сохранённым
    // пунктам, иначе новый заголовок в выдачу бы не попал.
    upsertDigest({ ...base, title: "Совершенно другой заголовок" });
    expect(searchDigests("совершенно", 10, 0).length).toBe(1);
    expect(searchDigests("эфир", 10, 0).length).toBe(1);
  });
});

describe("явно присланные items по-прежнему перезаписывают", () => {
  beforeEach(() => {
    upsertDigest({ ...base, items: ITEMS, sourceCount: 2 });
  });

  test("новый набор пунктов заменяет старый", () => {
    const next = [{ text: "единственный пункт" }];
    upsertDigest({ ...base, items: next, sourceCount: 1 });
    const d = getDigest(base.id);
    expect(d?.items).toEqual(next);
    expect(d?.sourceCount).toBe(1);
  });

  test("пустой массив — это по-прежнему очистка", () => {
    // Явная пустота остаётся значением: отнимать очистку правка не должна.
    upsertDigest({ ...base, items: [], sourceCount: 0 });
    const d = getDigest(base.id);
    expect(d?.items).toEqual([]);
    expect(d?.sourceCount).toBe(0);
  });

  test("поиск по старому пункту после замены не находит", () => {
    upsertDigest({ ...base, items: [{ text: "другое" }], sourceCount: 1 });
    expect(searchDigests("эфир", 10, 0).length).toBe(0);
    expect(searchDigests("другое", 10, 0).length).toBe(1);
  });

  test("первая вставка без items даёт пустой список, а не падение", () => {
    upsertDigest({ ...base, id: "d-fresh", title: "Свежий" });
    const d = getDigest("d-fresh");
    expect(d?.items).toEqual([]);
    expect(d?.sourceCount).toBe(0);
  });
});
