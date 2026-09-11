/**
 * Аудит 2026-09-11, круг 45: докблок `/api/db-stats` называл 19 таблиц, их 18.
 *
 * Абзац над веткой в lib/miniapp-server.ts — единственное письменное
 * обоснование гейта `requireAdmin` на этой ручке. Довод в нём ценовой: N
 * полных `COUNT(*)` плюс полный скан `dbstat`, всё синхронно, на единственном
 * потоке, который держит SQLite, двенадцать ботов, HTTP и SSE. Число N — та
 * самая величина, на которой довод и стоит, и именно она разошлась с кодом:
 * `STAT_TABLES` в db-maint.ts перечисляет 18 имён.
 *
 * Разошлась она предсказуемо. Список рос дважды после того, как абзац был
 * написан (пометки «Аудит 2026-08-08» — три таблицы, «Аудит 2026-08-27» — ещё
 * две), и оба раза правку вносили в db-maint.ts, не открывая miniapp-server.
 * Соседний абзац того же файла — про пять админских ЧИТАЮЩИХ ручек — сверяется
 * с кодом тестом (audit-2026-09-11-admin-read-routes) и потому не сгнил; у
 * этого сторожа не было. Три проверки целостности комментариев в репозитории
 * (stale-line-coordinates, stale-symbol-names, symbol-plus-coordinate) держат
 * координаты и имена символов, но не числа.
 *
 * Цена ошибки двусторонняя, как и у соседа. Добавляющий девятнадцатую таблицу
 * сверится с абзацем, увидит там «19» и решит, что его правку уже учли.
 * Проверяющий гейт насчитает 18 и получит абзац, который врёт ровно в том
 * месте, ради которого написан.
 *
 * Поэтому число не вычитывается глазами, а сверяется: тест достаёт длину
 * `STAT_TABLES` из исходника и требует, чтобы докблок называл именно её.
 * Девятнадцатая таблица, добавленная мимо абзаца, роняет этот тест.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LIB = join(import.meta.dir, "..", "lib");
const MAINT = readFileSync(join(LIB, "db-maint.ts"), "utf8");
const SERVER = readFileSync(join(LIB, "miniapp-server.ts"), "utf8");

/**
 * Имена таблиц из литерала `STAT_TABLES`.
 *
 * Массив не экспортирован, поэтому читается из текста — так же, как соседний
 * сторож читает ветки маршрутов. Строки комментариев внутри литерала
 * пропускаются: там встречаются имена таблиц в обратных кавычках, и считать их
 * элементами нельзя.
 */
function statTables(): string[] {
  const start = MAINT.indexOf("const STAT_TABLES = [");
  expect(start).toBeGreaterThan(-1);
  const end = MAINT.indexOf("\n] as const;", start);
  expect(end).toBeGreaterThan(start);
  return MAINT.slice(start, end)
    .split("\n")
    .slice(1)
    .filter((l) => !l.trim().startsWith("//"))
    .flatMap((l) => [...l.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
}

/** Число, которое докблок ручки называет как количество таблиц. */
function claimedCount(): number {
  const m = SERVER.match(/по всем (\d+)\n\s*\/\/ таблицам STAT_TABLES/);
  expect(m).not.toBeNull();
  return Number(m![1]);
}

describe("докблок /api/db-stats считает те же таблицы, что и код", () => {
  test("список читается — иначе сторож молчит ни о чём", () => {
    const tables = statTables();
    expect(tables.length).toBeGreaterThan(10);
    expect(new Set(tables).size).toBe(tables.length);
    // Три имени, которые абзац называет поимённо как самые дорогие.
    expect(tables).toContain("messages");
    expect(tables).toContain("messages_archive");
    expect(tables).toContain("agent_actions_archive");
  });

  test("число в абзаце равно длине STAT_TABLES", () => {
    // Когда падает: не подгонять список под абзац, а поправить абзац —
    // при девятнадцатой таблице довод про цену только крепнет.
    expect(claimedCount()).toBe(statTables().length);
  });

  test("предпосылка: dbStats действительно обходит весь список", () => {
    // Абзац говорит «COUNT(*) по всем таблицам STAT_TABLES». Если обход когда-
    // нибудь станет выборочным, число перестанет быть ценой запроса, и узнать
    // об этом надо здесь, а не по времени отклика на проде.
    const body = MAINT.slice(MAINT.indexOf("export function dbStats"));
    expect(body).toContain("for (const t of STAT_TABLES)");
    expect(body).toContain("COUNT(*)");
  });
});
