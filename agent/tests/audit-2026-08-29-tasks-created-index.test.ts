/**
 * Аудит 2026-08-29: вкладка Tasks в Mini App без фильтра сканировала таблицу
 * целиком.
 *
 * `GET /api/tasks` (lib/miniapp-server.ts:1205-1222) строит
 * `SELECT id FROM tasks${where} ORDER BY created_at DESC LIMIT ?`, где `where`
 * пустой, если клиент не передал `status`. Единственный индекс, который
 * покрывал этот сорт, — idx_tasks_status_created(status, created_at DESC), и
 * без равенства по первой колонке он для порядка бесполезен: SQLite давал
 * `SCAN tasks` + `USE TEMP B-TREE FOR ORDER BY`, то есть материализовал сорт
 * по ВСЕЙ таблице, прежде чем LIMIT отрежет первые N строк.
 *
 * Цена растёт монотонно: `tasks` — единственная lifecycle-таблица без
 * архивации и без удаления (докблок `listTasksByAssignee`, lib/tasks.ts).
 * Всё это в том же процессе, где живут 12 ботов и планировщики.
 *
 * Тест поднимает базу настоящим путём загрузки (lib/db.ts создаёт базовые
 * таблицы и зовёт runMigrations) в ОТДЕЛЬНОМ процессе с MEMORY_DB_PATH во
 * временный файл — импортировать db.ts прямо здесь нельзя, он открывает базу
 * на импорте. Идиома скопирована из tests/migrations-bootstrap.test.ts.
 *
 * Проверяем не наличие строчки в исходнике, а сам план запроса: индекс может
 * существовать и всё равно не использоваться (порядок колонок, DESC,
 * коллизия с другим индексом), а переписанный запрос обязан остаться
 * покрытым.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const BOOT_TIMEOUT_MS = 60_000;

interface Probe {
  indices: string[];
  migrations: string[];
  planNoFilter: string[];
  planOneStatus: string[];
  planTwoStatuses: string[];
}

/**
 * Поднимает чистую базу и возвращает планы запросов. Запросы повторяют то,
 * что реально уходит из `GET /api/tasks`: обе ветки — с фильтром по статусу и
 * без него.
 */
function probeFreshDb(): Probe {
  const dir = mkdtempSync(join(tmpdir(), "tasks-idx-"));
  const script = join(dir, "probe.ts");
  const dbPath = join(dir, "fresh.db");
  writeFileSync(
    script,
    `const { db } = await import(${JSON.stringify(join(REPO, "lib", "db.ts"))});\n` +
      `const plan = (sql, ...p) =>\n` +
      `  db.prepare("EXPLAIN QUERY PLAN " + sql).all(...p).map((r) => r.detail);\n` +
      `const indices = db\n` +
      `  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks' ORDER BY name")\n` +
      `  .all()\n` +
      `  .map((r) => r.name);\n` +
      `const migrations = db\n` +
      `  .prepare("SELECT name FROM schema_migrations ORDER BY name")\n` +
      `  .all()\n` +
      `  .map((r) => r.name);\n` +
      `console.log(JSON.stringify({\n` +
      `  indices,\n` +
      `  migrations,\n` +
      `  planNoFilter: plan("SELECT id FROM tasks ORDER BY created_at DESC LIMIT ?", 10),\n` +
      `  planOneStatus: plan("SELECT id FROM tasks WHERE status IN (?) ORDER BY created_at DESC LIMIT ?", "pending", 10),\n` +
      `  planTwoStatuses: plan("SELECT id FROM tasks WHERE status IN (?,?) ORDER BY created_at DESC LIMIT ?", "pending", "running", 10),\n` +
      `}));\n`,
  );
  try {
    const r = Bun.spawnSync(["bun", "run", script], {
      cwd: REPO,
      env: { ...process.env, MEMORY_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `база не поднялась (код ${r.exitCode}):\n${r.stderr.toString().slice(-1500)}`,
      );
    }
    const last = r.stdout.toString().trim().split("\n").filter(Boolean).pop() ?? "";
    return JSON.parse(last) as Probe;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("миграция 049: индекс tasks(created_at DESC)", () => {
  test(
    "индекс создан и миграция отмечена применённой",
    async () => {
      const p = probeFreshDb();
      expect(p.indices).toContain("idx_tasks_created");
      expect(p.migrations).toContain("049_tasks_created_index");
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    "ветка без фильтра больше не сканирует таблицу с temp b-tree",
    async () => {
      const p = probeFreshDb();
      // До фикса план был ["SCAN tasks", "USE TEMP B-TREE FOR ORDER BY"].
      expect(p.planNoFilter.join(" | ")).toContain("idx_tasks_created");
      expect(p.planNoFilter.some((d) => /TEMP B-TREE/i.test(d))).toBe(false);
      expect(p.planNoFilter).not.toContain("SCAN tasks");
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    "ветка с одним статусом по-прежнему идёт через idx_tasks_status_created",
    async () => {
      const p = probeFreshDb();
      // Новый индекс не должен перетянуть на себя запросы, которые уже
      // обслуживались составным индексом лучше.
      expect(p.planOneStatus.join(" | ")).toContain("idx_tasks_status_created");
      expect(p.planOneStatus.some((d) => /TEMP B-TREE/i.test(d))).toBe(false);
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    "ветка с несколькими статусами тоже держится за составной индекс",
    async () => {
      const p = probeFreshDb();
      // Здесь temp b-tree остаётся: IN по нескольким значениям даёт несколько
      // упорядоченных диапазонов, и SQLite сливает их сортировкой. Это не
      // регрессия и не то, что чинит 049 — фиксируем как есть, чтобы переход
      // на idx_tasks_created (который сделал бы этот запрос полным сканом с
      // фильтром) не проехал незамеченным.
      expect(p.planTwoStatuses.join(" | ")).toContain("idx_tasks_status_created");
      expect(p.planTwoStatuses.join(" | ")).not.toContain("idx_tasks_created");
    },
    BOOT_TIMEOUT_MS,
  );
});
