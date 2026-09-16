/**
 * Аудит 2026-09-11, круг 47: докблок rebuildWikiIndex назвал среди причин,
 * от которых спасает `existsSync`, ту, от которой не спасает никогда.
 *
 * Перечень в пункте 1 звучал так: «неверный MEMORY_DIR в /opt/agent-team/.env,
 * непримонтированный том, переезд каталога». Две крайние причины сторож ловит
 * — пути нет, `existsSync` возвращает false, таблицу не трогают. Средняя
 * устроена наоборот: непримонтированная точка монтирования СУЩЕСТВУЕТ и пуста.
 * `existsSync` её пропускает, `readdirSync` отдаёт ноль каталогов, обход
 * индексирует ноль страниц, `DELETE FROM wiki_fts` фиксируется — то есть ровно
 * тот исход, ради которого проверку и писали, причём снова молча: функция
 * возвращается штатно, в логе ничего.
 *
 * Цена та же, что у находки 2026-08-10: SEARCH_WIKI перестаёт находить
 * что-либо у всех 12 ролей, Wiki-вью Mini App пустеет. Разница только в
 * поводе — не опечатка в конфиге, а том, который не поднялся к моменту старта
 * юнита; порядок тут systemd не гарантирует.
 *
 * Правка из двух частей. Причину убрали из перечня — она была ложью, а не
 * неточностью, — и случай сделали слышным: если индекс был непуст, а стал
 * пуст, ребилд пишет `log.error`.
 *
 * Почему только лог. Откат сохранил бы строки страниц, которых на диске уже
 * нет, а выдача SEARCH_WIKI уходит в контекст ролей и в Mini App; массовое
 * удаление вики руками — законная операция, и пустой индекс после неё верен.
 * Откат остаётся за ошибкой БД (пункт 2 докблока): там нельзя доверять ни
 * новому состоянию, ни старому.
 *
 * Тесты ниже держат обе части: поведение (обнуление слышно, нормальный ребилд
 * и первый старт молчат) и текст (мёртвая причина не вернулась в перечень).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildWikiIndex } from "../lib/memory.ts";
import { db } from "../lib/db.ts";
import { log } from "../lib/log.ts";

const SRC = readFileSync(join(import.meta.dir, "..", "lib", "memory.ts"), "utf8");
const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const SCOPE = "rebuildemptytest";
const KEEP = "rebuildemptykeep";
/**
 * Корни живут ВНУТРИ каталога памяти: `slugFromPath` считает слаг относительно
 * `scopeDir`, то есть относительно MEMORY_DIR, а не переданного `root`. Корень
 * со стороны дал бы слаг вида `../../…`, страница не прошла бы `validateSlug`
 * и молча выпала из индекса — тест «нормальный ребилд» мерил бы не то.
 */
const EMPTY_ROOT = join(MEMORY_DIR, "rebuild-empty-root-47");
const SCOPE_DIR = join(MEMORY_DIR, SCOPE);

/** Каталог, который есть, но пуст, — то же, что видит обход у непримонтированного тома. */
function emptyRoot(): string {
  mkdirSync(EMPTY_ROOT, { recursive: true });
  return EMPTY_ROOT;
}

/** Тот же корень, но со скоупом без единой страницы: пустой том смонтирован внутрь. */
function rootWithEmptyScope(): string {
  mkdirSync(join(emptyRoot(), SCOPE, "pages"), { recursive: true });
  return EMPTY_ROOT;
}

function seedRows(n: number): void {
  const st = db.prepare(`INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`);
  for (let i = 0; i < n; i++) st.run(KEEP, `k${i}`, `K${i}`, "прежний индекс");
}

function total(): number {
  return (db.prepare(`SELECT count(*) as n FROM wiki_fts`).get() as { n: number }).n;
}

function rowCount(scope: string): number {
  return (
    db.prepare(`SELECT count(*) as n FROM wiki_fts WHERE scope = ?`).get(scope) as { n: number }
  ).n;
}

/** Прогон с перехватом log.error. Возвращает сообщения, а не объект шпиона. */
function errorsDuring(fn: () => void): string[] {
  const spy = spyOn(log, "error").mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}

const wipes = (msgs: string[]) => msgs.filter((m) => /ребилд обнулил индекс/.test(m));

function clean(): void {
  rmSync(EMPTY_ROOT, { recursive: true, force: true });
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  db.prepare(`DELETE FROM wiki_fts WHERE scope IN (?, ?)`).run(KEEP, SCOPE);
}

beforeEach(clean);
afterEach(clean);

describe("предпосылка: сторож existsSync этот случай пропускает", () => {
  test("пустой каталог существует — проверка на нём не срабатывает", () => {
    // Этим непримонтированный том и отличается от опечатки в MEMORY_DIR: там
    // пути нет вовсе, здесь путь есть, а содержимого нет.
    expect(existsSync(emptyRoot())).toBe(true);
    expect(existsSync(join(MEMORY_DIR, "no-such-memory-root-47"))).toBe(false);
  });

  test("обход пустого каталога обнуляет индекс — находка целиком", () => {
    seedRows(3);
    expect(total()).toBeGreaterThanOrEqual(3);
    rebuildWikiIndex(emptyRoot());
    // Не регрессия, а описание поведения: DELETE к этому моменту зафиксирован.
    // Держим явно — на этом факте стоит весь пункт 3 докблока.
    expect(total()).toBe(0);
  });
});

describe("обнуление индекса теперь слышно", () => {
  test("непустой индекс и пустой каталог — в логе error", () => {
    seedRows(2);
    expect(wipes(errorsDuring(() => rebuildWikiIndex(emptyRoot())))).toHaveLength(1);
  });

  test("скоуп есть, страниц нет — то же самое", () => {
    seedRows(2);
    expect(wipes(errorsDuring(() => rebuildWikiIndex(rootWithEmptyScope())))).toHaveLength(1);
  });

  test("первый старт на пустом деплое молчит — обнулять там нечего", () => {
    // before === 0: индекса не было. Это не потеря, это установка. Чистим
    // таблицу целиком, потому что мерка — весь индекс, а не свои скоупы.
    db.prepare(`DELETE FROM wiki_fts`).run();
    expect(total()).toBe(0);
    expect(wipes(errorsDuring(() => rebuildWikiIndex(emptyRoot())))).toEqual([]);
  });

  test("нормальный ребилд молчит, хотя таблицу тоже чистит", () => {
    seedRows(2);
    mkdirSync(join(SCOPE_DIR, "pages"), { recursive: true });
    writeFileSync(join(SCOPE_DIR, "pages", "alpha.md"), "# Alpha\n\nтело альфы\n");

    // Без аргумента — как в проде; страница лежит в каталоге памяти.
    expect(wipes(errorsDuring(() => rebuildWikiIndex()))).toEqual([]);
    expect(rowCount(SCOPE)).toBe(1);
    expect(rowCount(KEEP)).toBe(0);
  });

  test("отсутствующий каталог по-прежнему не доходит до чистки", () => {
    seedRows(2);
    const msgs = errorsDuring(() => rebuildWikiIndex(join(MEMORY_DIR, "no-such-memory-root-47")));
    // Сторож 2026-08-10 на месте: строки целы, а значит и обнулять нечего.
    expect(rowCount(KEEP)).toBe(2);
    expect(wipes(msgs)).toEqual([]);
  });
});

describe("мёртвая причина не вернулась в перечень", () => {
  test("пункт 1 докблока не обещает защиты от непримонтированного тома", () => {
    const item1 = SRC.slice(SRC.indexOf(" * 1. Очистка таблицы"), SRC.indexOf(" * 2. Сборка шла"));
    expect(item1.length).toBeGreaterThan(100);
    expect(item1).toContain("MEMORY_DIR");
    // Когда падает: причину в перечень не возвращать — `existsSync` её не
    // ловит. Разбор и замер — пункт 3 докблока и тесты выше.
    expect(item1).not.toContain("непримонтир");
  });

  test("пункт 3 на месте и называет случай своим именем", () => {
    // Докблок разбит переносами и звёздочками — утверждение про текст, а
    // не про раскладку абзаца.
    const flat = SRC.replace(/^\s*\*/gm, "").replace(/\s+/g, " ");
    expect(flat).toContain("римонтированная точка монтирования существует и пуста");
    expect(flat).toContain("ребилд обнулил индекс");
  });
});
