/**
 * Аудит 2026-08-12: календарь разблокировок врал двумя способами.
 *
 * (1) `upsertUnlocks` только вставляет и обновляет — удалять не умеет. Фид
 *     DefiLlama отдаёт по проекту ОДНО ближайшее будущее событие (см. шапку
 *     unlocks.ts), то есть каждый приход фида — это новый полный снимок. Если
 *     разблокировку перенесли, старая строка остаётся в таблице навсегда; а
 *     раз она стоит на более ранней дате, `listUpcomingUnlocks` (ORDER BY date
 *     ASC) ставит её ПЕРВОЙ в блоке «Ближайшие разблокировки». Проект, который
 *     из фида ушёл совсем (событие отменили, токен делистнули), не исчезает
 *     никогда.
 *
 * (2) `lastUnlocksRefreshIso()` при отсутствии отметки о загрузке возвращал
 *     `new Date().toISOString()` — то есть «обновлено прямо сейчас» ровно в том
 *     случае, когда данных не приходило ни разу.
 *
 * Замер до правки (зонд поверх настоящих db.ts / index.ts):
 *
 *   снимок №1: Aave 2026-08-15, Sui 2026-08-17
 *   снимок №2 (перенос + уход Sui): Aave 2026-09-11
 *   → строк в БД: 3 | ближайших: 3
 *       Aave 2026-08-15   ← призрак: этой разблокировки в фиде уже нет
 *       Sui  2026-08-17   ← проект из фида ушёл
 *       Aave 2026-09-11
 *     первая в списке «ближайших»: Aave 2026-08-15
 *
 *   фид ни разу не приезжал (meta unlocks_fetched_at пуст):
 *     lastUnlocksRefreshIso(): 2026-08-12T11:36:55.834Z
 *     сейчас                 : 2026-08-12T11:36:55.834Z
 *     /api/stats → {"digests":0,...,"updatedAt":"2026-08-12T11:36:55.833Z"}
 *
 * На главной это и наблюдалось живьём: «отслеживаем 0 разблокировок ·
 * обновлено 12 августа 2026 г.».
 *
 * Инварианты: набор будущих разблокировок — это ровно последний снимок фида
 * (история прошедших дат остаётся); «обновлено» показывается только если
 * обновление действительно было.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-unlocks-"));
process.env.SITE_DB_PATH = join(TMP, "unlocks.db");

const db = await import("./db.ts");
const { lastUnlocksRefreshIso } = await import("./unlocks.ts");
const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

// Ведро лимитера общее на процесс, а соседние файлы тестов делают сотни
// запросов с той же петли — иначе сюда прилетает чужой 429.
beforeEach(() => _resetRateLimiter());

describe("«обновлено» без единого обновления", () => {
  test("отметки о загрузке нет — значит и даты обновления нет", () => {
    // Старое поведение: возвращалось «сейчас».
    expect(lastUnlocksRefreshIso()).toBeNull();
  });

  test("/api/stats не выдаёт свежесть за отсутствующие данные", async () => {
    const r = await fetch(`${base}/api/stats`);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.updatedAt).toBeNull();
  });

  test("/api/unlocks — то же самое", async () => {
    const r = await fetch(`${base}/api/unlocks`);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.updatedAt).toBeNull();
  });

  test("после настоящей загрузки дата берётся из отметки", async () => {
    const at = Date.now() - 3 * 60 * 60 * 1000;
    db.setMeta("unlocks_fetched_at", String(at));
    expect(lastUnlocksRefreshIso()).toBe(new Date(at).toISOString());
    const body = await (await fetch(`${base}/api/stats`)).json();
    expect(body.updatedAt).toBe(new Date(at).toISOString());
  });

  test("битая отметка не превращается в «обновлено сегодня»", () => {
    db.setMeta("unlocks_fetched_at", "не-число");
    expect(lastUnlocksRefreshIso()).toBeNull();
  });
});

describe("снимок фида заменяет предыдущий", () => {
  const snapshot1 = [
    { project: "Aave", symbol: "AAVE", date: iso(3 * DAY), pctOfSupply: 1.2, amountUsd: 1_000_000 },
    { project: "Sui", symbol: "SUI", date: iso(5 * DAY), pctOfSupply: 2, amountUsd: 2_000_000 },
  ];
  // Событие Aave перенесли на месяц, Sui из фида ушёл совсем.
  const snapshot2 = [
    { project: "Aave", symbol: "AAVE", date: iso(30 * DAY), pctOfSupply: 1.2, amountUsd: 1_000_000 },
  ];

  test("перенесённая дата не остаётся призраком в начале списка", () => {
    db.replaceUpcomingUnlocks(snapshot1);
    db.replaceUpcomingUnlocks(snapshot2);
    const up = db.listUpcomingUnlocks(10);
    // Старое поведение: три строки, первая — Aave на старой дате.
    expect(up.map((u) => u.project)).toEqual(["Aave"]);
    expect(up[0]!.date).toBe(snapshot2[0]!.date);
  });

  test("проект, ушедший из фида, из ближайших исчезает", () => {
    db.replaceUpcomingUnlocks(snapshot1);
    expect(db.listUpcomingUnlocks(10).map((u) => u.project)).toEqual([
      "Aave",
      "Sui",
    ]);
    db.replaceUpcomingUnlocks(snapshot2);
    expect(db.countUpcomingUnlocks()).toBe(1);
  });

  test("прошедшие разблокировки остаются историей", () => {
    const past = "2020-05-01T00:00:00.000Z";
    db.replaceUpcomingUnlocks([
      ...snapshot1,
      { project: "Old", symbol: "OLD", date: past, pctOfSupply: 0.5, amountUsd: null },
    ]);
    db.replaceUpcomingUnlocks(snapshot2);
    expect(db.countUnlocks()).toBe(2); // Old + Aave
    expect(db.listUpcomingUnlocks(10).map((u) => u.project)).toEqual(["Aave"]);
  });

  test("повторный тот же снимок ничего не плодит", () => {
    db.replaceUpcomingUnlocks(snapshot2);
    db.replaceUpcomingUnlocks(snapshot2);
    expect(db.countUpcomingUnlocks()).toBe(1);
  });
});
