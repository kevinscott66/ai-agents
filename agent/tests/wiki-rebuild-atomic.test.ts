/**
 * Аудит 2026-08-10: ребилд FTS-индекса вики стирал индекс до того, как
 * убеждался, что есть из чего его собрать.
 *
 * rebuildWikiIndex вызывается первой строкой main() при каждом старте. Порядок
 * был такой: `DELETE FROM wiki_fts`, потом `if (!existsSync(MEMORY_DIR))
 * return`. То есть проверка, которую специально написали, срабатывала уже
 * после разрушения: неверный MEMORY_DIR в /opt/agent-team/.env, переезд
 * каталога — и старт молча оставляет всем 12 ролям пустой индекс. SEARCH_WIKI перестаёт находить что-либо, Wiki-вью Mini App
 * пустеет, а в логах — ничего: функция возвращается штатно.
 *
 * Второе: сборка шла вне транзакции, по одному INSERT'у в автокоммите. Любой
 * сбой на середине обхода (нечитаемый файл, битый симлинк, исчезнувший
 * каталог) оставлял индекс частичным или пустым — DELETE к тому моменту уже
 * зафиксирован. Ошибка при этом улетала в main(), то есть старт падал; systemd
 * перезапускал сервис, ребилд падал на том же файле, и так по кругу — с пустым
 * индексом между попытками.
 *
 * Инвариант: индекс либо заменяется целиком на собранный с диска, либо не
 * трогается вовсе. Один нечитаемый файл — не повод терять вики.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { rebuildWikiIndex } from "../lib/memory.ts";
import { db } from "../lib/db.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const SCOPE = "rebuildtest";
const SCOPE_DIR = join(MEMORY_DIR, SCOPE);

/** Строка, которой нет на диске: переживает только НЕсостоявшийся ребилд. */
function seedOrphanRow(): void {
  db.prepare(
    `INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`,
  ).run("rebuildkeep", "kept", "Kept", "прежний индекс");
}

function rowCount(scope: string): number {
  const r = db
    .prepare(`SELECT count(*) as n FROM wiki_fts WHERE scope = ?`)
    .get(scope) as { n: number };
  return r.n;
}

beforeEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  db.prepare(`DELETE FROM wiki_fts WHERE scope IN ('rebuildkeep', ?)`).run(SCOPE);
});

afterEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
  db.prepare(`DELETE FROM wiki_fts WHERE scope IN ('rebuildkeep', ?)`).run(SCOPE);
});

describe("ребилд не разрушает индекс раньше, чем убедился в источнике", () => {
  test("отсутствующий каталог памяти оставляет прежний индекс", () => {
    seedOrphanRow();
    // Ровно то, что даёт опечатка в MEMORY_DIR или переезд каталога.
    // Непримонтированного тома в этом списке нет намеренно: точка монтирования
    // существует и пуста, `existsSync` её пропускает — см. пункт 3 докблока
    // rebuildWikiIndex и tests/audit-2026-09-11-wiki-rebuild-empty-root.
    rebuildWikiIndex(join(MEMORY_DIR, "no-such-memory-root"));
    // До фикса: DELETE уже прошёл, и здесь 0 — вики нет ни у кого до тех пор,
    // пока кто-нибудь не перепишет каждую страницу вручную.
    expect(rowCount("rebuildkeep")).toBe(1);
  });

  test("нормальный ребилд по-прежнему собирает индекс с диска", () => {
    seedOrphanRow();
    mkdirSync(join(SCOPE_DIR, "pages"), { recursive: true });
    writeFileSync(join(SCOPE_DIR, "pages", "alpha.md"), "# Alpha\n\nтело альфы\n");
    writeFileSync(join(SCOPE_DIR, "pages", "beta.md"), "# Beta\n\nтело беты\n");

    rebuildWikiIndex();

    expect(rowCount(SCOPE)).toBe(2);
    // Строка, которой нет на диске, обязана уйти — иначе это не ребилд.
    expect(rowCount("rebuildkeep")).toBe(0);
  });

  test("нечитаемый файл не обнуляет вики и не роняет старт", () => {
    mkdirSync(join(SCOPE_DIR, "pages"), { recursive: true });
    writeFileSync(join(SCOPE_DIR, "pages", "alpha.md"), "# Alpha\n\nтело альфы\n");
    // Битый симлинк: readdir его видит как файл .md, readFileSync бросает ENOENT.
    symlinkSync(
      join(SCOPE_DIR, "pages", "nowhere.md"),
      join(SCOPE_DIR, "pages", "broken.md"),
    );

    // До фикса: исключение уходит наверх из main(), старт падает, а DELETE уже
    // зафиксирован — на следующем старте всё повторяется с пустым индексом.
    expect(() => rebuildWikiIndex()).not.toThrow();
    // Соседняя страница обязана быть проиндексирована: один битый файл не
    // должен стоить вики всей команде.
    expect(rowCount(SCOPE)).toBe(1);
  });

  test("сбой записи посреди сборки откатывает весь ребилд", () => {
    seedOrphanRow();
    mkdirSync(join(SCOPE_DIR, "pages"), { recursive: true });
    for (const name of ["a", "b", "c"]) {
      writeFileSync(join(SCOPE_DIR, "pages", `${name}.md`), `# ${name}\n\nтело\n`);
    }

    // Ошибка БД (а не файла) обязана прервать сборку целиком: частичный индекс
    // неотличим от полного, и никто уже не узнает, что половины страниц нет.
    const origPrepare = db.prepare.bind(db);
    let inserts = 0;
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      if (/INSERT INTO wiki_fts/i.test(sql) && ++inserts >= 2) {
        throw new Error("disk I/O error");
      }
      return origPrepare(sql);
    };
    try {
      expect(() => rebuildWikiIndex()).not.toThrow();
    } finally {
      (db as unknown as { prepare: unknown }).prepare = origPrepare;
    }

    // Прежний индекс на месте, нового нет: либо целиком, либо никак.
    expect(rowCount("rebuildkeep")).toBe(1);
    expect(rowCount(SCOPE)).toBe(0);
  });
});
