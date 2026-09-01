/**
 * Аудит 2026-08-12: ежедневный публикатор открывал боевую БД каждые 30 минут.
 *
 * tools/approve-poll.ts тянул `ensureChannelFooter` из lib/action-dispatch.ts,
 * а тот через permissions.ts → audit.ts доходит до lib/db.ts, где `new
 * Database(DB_PATH)`, PRAGMA, CREATE TABLE и runMigrations стоят НА УРОВНЕ
 * МОДУЛЯ. Юнит крутится из /opt/agent-team, то есть это тот же data/memory.db,
 * в который пишет живой agent-team.service.
 *
 * Замер (зонд, MEMORY_DB_PATH в пустую временную папку):
 *   до импорта, файл БД существует: false
 *   после импорта action-dispatch, файл БД существует: true
 *   WAL: true
 *
 * Чем это плохо, по возрастанию:
 *  • DDL/WAL-нагрузка и конкуренция за блокировки с продом каждые 30 минут —
 *    ради одной регулярки футера;
 *  • любая ошибка БД или миграции бросает во время ВЫЧИСЛЕНИЯ модуля, до
 *    main(), — то есть одобренный владельцем черновик не публикуется, а
 *    catch в `import.meta.main` даже не срабатывает.
 *
 * Ровно для этого случая и заведён lib/channel-footer.ts — в его шапке прямым
 * текстом: «тот тянет за собой пол-рантайма (telegram, юзербот, БД), и
 * импортировать его ради одной регулярки нельзя».
 *
 * Инвариант: импорт oneshot-скриптов публикации не создаёт БД.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const TOOLS = new URL("../tools/", import.meta.url).pathname;

/** Импортирует модуль в отдельном процессе и говорит, появился ли файл БД. */
async function dbTouchedByImport(relPath: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "no-db-"));
  const dbPath = join(dir, "memory.db");
  try {
    const proc = Bun.spawn(
      ["bun", "-e", `await import(${JSON.stringify(TOOLS + relPath)});`],
      {
        cwd: new URL("../", import.meta.url).pathname,
        env: { ...process.env, MEMORY_DB_PATH: dbPath },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await proc.exited;
    return existsSync(dbPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

describe("публикатор дайджеста не трогает боевую БД", () => {
  test("импорт tools/approve-poll.ts не создаёт memory.db", async () => {
    expect(await dbTouchedByImport("approve-poll.ts")).toBe(false);
  }, 30_000);

  test("импорт tools/daily-draft.ts не создаёт memory.db", async () => {
    // Этап 1 конвейера болел тем же и был пойман этим тестом: он тянул
    // `buildSubscriptionEnv` из lib/agent-sdk-runtime.ts, а тот — tools-schema
    // → permissions → audit → db. Функция при этом чистая, девять строк
    // фильтра по process.env; переехала в lib/subscription-env.ts.
    expect(await dbTouchedByImport("daily-draft.ts")).toBe(false);
  }, 30_000);

  test("футер берётся из выделенного модуля, а не из action-dispatch", () => {
    // Структурная страховка: поведенческий тест выше поймает и обходной путь,
    // но по нему не видно, ЧТО чинить.
    const src = readFileSync(join(TOOLS, "approve-poll.ts"), "utf8");
    expect(src).toContain('from "../lib/channel-footer.ts"');
    expect(src).not.toContain('from "../lib/action-dispatch.ts"');
  });
});
