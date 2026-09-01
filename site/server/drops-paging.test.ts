/**
 * Аудит 2026-08-12: за первую страницу дропов и активностей было не выйти.
 *
 * `/api/drops` не принимал offset и не отдавал total, а фронт просил ровно 30
 * штук — всё, что дальше, недостижимо: ни ссылки, ни кнопки, ни способа
 * узнать, что там вообще что-то есть. Фильтр по статусу в секции работает по
 * уже загруженному куску, поэтому «Закончился» показывал не завершённые дропы,
 * а те из первых тридцати, которые случайно оказались завершёнными.
 *
 * Замер до правки (сид: 11 дропов, запрос с offset):
 *   GET /api/drops?limit=5           → items=5, total отсутствует
 *   GET /api/drops?limit=5&offset=5  → items=5, те же самые пять (offset игнорируется)
 *
 * Заодно: у ORDER BY не было полного порядка (статус, дедлайн — и всё), а без
 * него LIMIT/OFFSET вправе переставлять строки с одинаковыми ключами, то есть
 * страницы могли и дублировать, и терять дропы.
 *
 * Инварианты: offset действительно сдвигает окно, total равен числу дропов,
 * склейка страниц даёт тот же список, что и один большой запрос, без повторов.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-paging-"));
process.env.SITE_DB_PATH = join(TMP, "paging.db");

const { seedIfEmpty } = await import("./seed.ts");
const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const db = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => _resetRateLimiter());

async function drops(qs: string) {
  const r = await fetch(`${base}/api/drops${qs}`);
  expect(r.status).toBe(200);
  return (await r.json()) as { items: { id: string }[]; total: number };
}

describe("GET /api/drops постранично", () => {
  test("total равен числу дропов", async () => {
    const j = await drops("?limit=5");
    // Старое поведение: поля total не было вовсе.
    expect(j.total).toBe(db.countDrops());
    expect(j.total).toBeGreaterThan(5);
  });

  test("offset сдвигает окно, а не игнорируется", async () => {
    const first = await drops("?limit=5");
    const second = await drops("?limit=5&offset=5");
    expect(first.items.length).toBe(5);
    expect(second.items.length).toBeGreaterThan(0);
    // Старое поведение: те же пять строк.
    const overlap = second.items.filter((d) =>
      first.items.some((f) => f.id === d.id),
    );
    expect(overlap).toEqual([]);
  });

  test("страницы склеиваются в тот же список, что и один запрос", async () => {
    const total = db.countDrops();
    const whole = await drops(`?limit=100`);
    expect(whole.items.length).toBe(total);

    const paged: string[] = [];
    for (let off = 0; off < total; off += 4) {
      const page = await drops(`?limit=4&offset=${off}`);
      paged.push(...page.items.map((d) => d.id));
    }
    expect(paged).toEqual(whole.items.map((d) => d.id));
    expect(new Set(paged).size).toBe(total);
  });

  test("offset за концом — пустая страница, а не ошибка", async () => {
    const j = await drops("?limit=10&offset=100000");
    expect(j.items).toEqual([]);
    expect(j.total).toBe(db.countDrops());
  });

  test("мусорный offset не ломает выдачу", async () => {
    const j = await drops("?limit=5&offset=-3");
    expect(j.items.length).toBe(5);
  });
});

describe("фильтр по статусу считает сервер", () => {
  for (const s of ["active", "soon", "ended"] as const) {
    test(`status=${s} — только этот статус и правильный total`, async () => {
      const j = (await drops(`?limit=100&status=${s}`)) as unknown as {
        items: { id: string; status: string }[];
        total: number;
      };
      expect(j.items.every((d) => d.status === s)).toBe(true);
      expect(j.total).toBe(j.items.length);
      expect(j.total).toBe(db.countDrops(s));
    });
  }

  test("сумма по статусам равна общему числу дропов", async () => {
    let sum = 0;
    for (const s of ["active", "soon", "ended"] as const) {
      sum += (await drops(`?limit=100&status=${s}`)).total;
    }
    expect(sum).toBe(db.countDrops());
  });

  test("незнакомый статус — как будто фильтра нет, а не пустая выдача", async () => {
    const j = await drops("?limit=100&status=' OR 1=1 --");
    expect(j.total).toBe(db.countDrops());
    expect(j.items.length).toBe(db.countDrops());
  });
});

describe("GET /api/activities постранично", () => {
  test("total есть и offset работает", async () => {
    const r = await fetch(`${base}/api/activities?limit=1`);
    const j = (await r.json()) as { items: { id: string }[]; total: number };
    expect(j.total).toBe(db.countActivities());
    if (j.total > 1) {
      const r2 = await fetch(`${base}/api/activities?limit=1&offset=1`);
      const j2 = (await r2.json()) as { items: { id: string }[] };
      expect(j2.items[0]!.id).not.toBe(j.items[0]!.id);
    }
  });
});
