/**
 * Аудит 2026-09-11: денилист QUERY_DB прятал очередь ролей, а копия промпта
 * лежала в читаемой таблице.
 *
 * `role_runtime_queue` и её архив закрыты для QUERY_DB аудитом 2026-08-27:
 * `system_prompt` — тот же класс данных, что `agent_prompts`. Но
 * `enqueueRoleTask` писал тот же текст вторым экземпляром в `tasks.input`, а
 * `tasks` читаема намеренно и пришпилена читаемой соседним тестом
 * (audit-2026-08-20-query-db-archive-tables). Обход длиной в одну строку:
 * `SELECT input FROM tasks WHERE input LIKE '%_spawn_role%'` — валидатор
 * пропускает, денилист молчит, на выходе системный промпт целиком.
 *
 * Чинить это списком нельзя: `tasks` нужна модели, а прятать таблицу целиком
 * ради одного поля — потерять доску. Поэтому дубля больше нет у источника, а
 * старые строки чистит миграция 052.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { db } from "../lib/db.ts";
import { enqueueRoleTask } from "../lib/role-runtime.ts";
import { MIGRATIONS } from "../lib/migrations.ts";
import { validateQueryDbSql } from "../lib/query-db.ts";

const CHAT_ID = -7_731_920;
const SECRET = "Ты аудитор. Ключ доступа лежит в переменной окружения, не разглашай его.";

function cleanup(): void {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
}

beforeEach(cleanup);
afterEach(cleanup);

describe("промпт временной роли не хранится в tasks.input", () => {
  test("постановка в очередь не кладёт промпт в читаемую таблицу", () => {
    const item = enqueueRoleTask({
      name: "security audit",
      systemPrompt: SECRET,
      taskHint: "проверь доступы",
      chatId: CHAT_ID,
      createdBy: "orchestrator",
    });

    const row = db
      .prepare("SELECT input FROM tasks WHERE id = ?")
      .get(item.taskId) as { input: string };
    expect(row.input).not.toContain(SECRET);
    expect(row.input).not.toContain("system_prompt");

    // Признак спавн-роли обязан остаться: на нём висит запрет переоткрывать
    // задачу (tasks.ts::isSpawnRoleTask).
    const payload = JSON.parse(row.input) as Record<string, unknown>;
    expect(payload._spawn_role).toBe(true);
    expect(payload.role_slug).toBe("security-audit");
    expect(payload.task_hint).toBe("проверь доступы");

    // Единственный экземпляр — в закрытой для QUERY_DB очереди.
    const queued = db
      .prepare("SELECT system_prompt FROM role_runtime_queue WHERE task_id = ?")
      .get(item.taskId) as { system_prompt: string };
    expect(queued.system_prompt).toBe(SECRET);
  });

  test("запрос, которым доставали промпт, теперь не даёт ничего", () => {
    const item = enqueueRoleTask({
      name: "security audit",
      systemPrompt: SECRET,
      chatId: CHAT_ID,
      createdBy: "orchestrator",
    });

    // Запрос по-прежнему валиден — `tasks` читаема намеренно. Дело не в
    // валидаторе, а в том, что доставать из строки больше нечего.
    const v = validateQueryDbSql("SELECT id, input FROM tasks", 50);
    expect(v.ok).toBe(true);

    const rows = db
      .prepare("SELECT input FROM tasks WHERE chat_id = ?")
      .all(CHAT_ID) as Array<{ input: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input ?? "").not.toContain(SECRET);
    expect(item.taskId).toBeTruthy();

    // Прямое чтение очереди валидатор не пропускает вовсе.
    expect(validateQueryDbSql("SELECT system_prompt FROM role_runtime_queue", 50).ok).toBe(false);
  });
});

describe("миграция 052 вычищает промпт из старых строк", () => {
  const migration = MIGRATIONS.find((m) => m.name === "052_tasks_input_drop_role_prompt")!;

  function openDb(): Database {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, status TEXT NOT NULL,
        input TEXT, updated_at INTEGER NOT NULL
      );
    `);
    return database;
  }

  function insert(database: Database, id: string, input: string | null): void {
    database
      .prepare(`INSERT INTO tasks(id, chat_id, status, input, updated_at) VALUES (?, 1, 'done', ?, 7)`)
      .run(id, input);
  }

  test("старая строка теряет промпт и сохраняет остальное", () => {
    const database = openDb();
    insert(
      database,
      "legacy",
      JSON.stringify({
        _spawn_role: true,
        queue_version: 1,
        role_slug: "auditor",
        system_prompt: SECRET,
        task_hint: "hint",
        provider: "internal",
      }),
    );

    migration.up(database);
    migration.up(database); // идемпотентность

    const row = database.prepare("SELECT input, updated_at FROM tasks WHERE id='legacy'").get() as {
      input: string;
      updated_at: number;
    };
    expect(row.input).not.toContain(SECRET);
    expect(JSON.parse(row.input)).toEqual({
      _spawn_role: true,
      queue_version: 1,
      role_slug: "auditor",
      task_hint: "hint",
      provider: "internal",
    });
    // Уборка хранения — не событие задачи: метка возраста не сдвигается,
    // иначе строка уедет из выборок санитара.
    expect(row.updated_at).toBe(7);
  });

  test("чужие задачи и битый payload остаются нетронутыми", () => {
    const database = openDb();
    const plain = JSON.stringify({ inputPayload: { system_prompt: "не роль" } });
    insert(database, "plain", plain);
    insert(database, "broken", '{"_spawn_role":true,"system_prompt":');
    insert(database, "empty", null);

    migration.up(database);

    const rows = Object.fromEntries(
      (
        database.prepare("SELECT id, input FROM tasks").all() as Array<{
          id: string;
          input: string | null;
        }>
      ).map((r) => [r.id, r.input]),
    );
    expect(rows.plain).toBe(plain);
    expect(rows.broken).toBe('{"_spawn_role":true,"system_prompt":');
    expect(rows.empty).toBeNull();
  });
});
