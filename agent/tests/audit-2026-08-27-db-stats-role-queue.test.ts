/**
 * Аудит 2026-08-27: вкладка «БД» не показывала очередь ролей.
 *
 * `role_runtime_queue` — единственная таблица, где лежит ЦЕЛИКОМ системный
 * промпт временной роли (`system_prompt NOT NULL`), то есть килобайты на
 * строку. Аудит 2026-08-27 завёл ей архивацию (миграция 046 + спека в
 * `db-maint.ts`), но ни исходной таблицы, ни архива не было в `STAT_TABLES` —
 * их вес молча уезжал в строку `__other__`, «неизвестно откуда». Проверить по
 * экрану, что суточный прогон действительно разгружает живую БД, было негде:
 * обе цифры, между которыми едут строки, отсутствовали.
 *
 * Проверяем не константу (сверка списка с самим собой), а выход `dbStats()`:
 * что обе таблицы получили СВОЮ строку и что вес ушёл из `__other__` в них.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { dbStats } from "../lib/db-maint.ts";

const CHAT_ID = -100999827;
const BIG = "П".repeat(4096);

function clean() {
  db.prepare("DELETE FROM role_runtime_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM role_runtime_queue_archive WHERE chat_id = ?").run(
    CHAT_ID,
  );
  db.prepare("DELETE FROM tasks WHERE chat_id = ?").run(CHAT_ID);
}

/** `role_runtime_queue.task_id` — внешний ключ на `tasks`. */
function seedTask(id: string): string {
  const taskId = `t-${id}`;
  db.prepare(
    `INSERT INTO tasks(id, depth, chat_id, created_by, title, status, priority,
                       created_at, updated_at)
     VALUES (?, 0, ?, 'orchestrator', ?, 'done', 'normal', ?, ?)`,
  ).run(taskId, CHAT_ID, `audit ${id}`, 1_700_000_000_000, 1_700_000_000_000);
  return taskId;
}

function seedLive(id: string) {
  const taskId = seedTask(id);
  db.prepare(
    `INSERT INTO role_runtime_queue
       (id, task_id, role_slug, system_prompt, task_hint, provider, state,
        chat_id, created_by, created_at)
     VALUES (?, ?, 'audit-role', ?, '', 'internal', 'done', ?, 'owner', ?)`,
  ).run(id, taskId, BIG, CHAT_ID, 1_700_000_000_000);
}

function seedArchived(id: string) {
  const taskId = seedTask(id);
  db.prepare(
    `INSERT INTO role_runtime_queue_archive
       (id, task_id, role_slug, system_prompt, task_hint, provider, state,
        chat_id, created_by, created_at, archived_at)
     VALUES (?, ?, 'audit-role', ?, '', 'internal', 'done', ?, 'owner', ?, ?)`,
  ).run(id, taskId, BIG, CHAT_ID, 1_700_000_000_000, 1_700_000_100_000);
}

function statOf(rows: ReturnType<typeof dbStats>, table: string) {
  const hit = rows.filter((r) => r.table === table);
  expect(hit.length, `${table}: ожидали ровно одну строку, получили ${hit.length}`).toBe(1);
  return hit[0]!;
}

describe("вкладка «БД» видит очередь ролей (аудит 2026-08-27)", () => {
  beforeEach(clean);
  afterEach(clean);

  test("обе таблицы присутствуют в выдаче отдельными строками", () => {
    const rows = dbStats();
    statOf(rows, "role_runtime_queue");
    statOf(rows, "role_runtime_queue_archive");
  });

  test("вставленные строки видны в счётчике, а не только в __other__", () => {
    const before = statOf(dbStats(), "role_runtime_queue").rows;
    seedLive("q-1");
    seedLive("q-2");
    const after = statOf(dbStats(), "role_runtime_queue").rows;
    expect(after - before).toBe(2);
  });

  test("архив считается отдельно от живой очереди", () => {
    seedLive("q-live");
    seedArchived("q-cold");
    const rows = dbStats();
    const live = statOf(rows, "role_runtime_queue");
    const cold = statOf(rows, "role_runtime_queue_archive");
    // Разные таблицы — разные счётчики: если бы имя схлопнулось, обе цифры
    // менялись бы вместе и следить за переездом строк было бы нельзя.
    expect(live.rows).toBeGreaterThan(0);
    expect(cold.rows).toBeGreaterThan(0);
  });

  test("сумма по строкам по-прежнему сходится с файлом БД", () => {
    seedLive("q-sum");
    seedArchived("q-sum-cold");
    const rows = dbStats();
    const total = (
      db.prepare(`SELECT SUM(pgsize) AS s FROM dbstat`).get() as {
        s: number | null;
      }
    ).s;
    const sum = rows
      .filter((r) => r.table !== "__db_file__")
      .reduce((a, r) => a + r.size_bytes, 0);
    // Контроль на регрессию 2026-08-12: добавление таблиц в STAT_TABLES не
    // должно приписать одни и те же страницы дважды.
    expect(sum).toBe(total ?? 0);
  });

  test("вес очереди приписан ей, а не растворён в __other__", () => {
    const otherBefore = statOf(dbStats(), "__other__").size_bytes;
    for (let i = 0; i < 12; i++) seedLive(`q-w-${i}`);
    const rows = dbStats();
    const live = statOf(rows, "role_runtime_queue");
    const otherAfter = statOf(rows, "__other__").size_bytes;
    // 12 строк по 4 КБ промпта — это десятки килобайт, они обязаны появиться
    // в столбце таблицы. Раньше ровно этот прирост уходил в «неизвестно куда».
    expect(live.size_bytes).toBeGreaterThan(24_000);
    expect(otherAfter - otherBefore).toBeLessThan(live.size_bytes);
  });
});
