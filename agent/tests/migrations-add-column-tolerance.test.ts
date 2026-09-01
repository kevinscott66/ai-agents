/**
 * Аудит 2026-08-12: три миграции из шести, добавляющих колонку, не переживали
 * повторного применения — и это кирпичило старт целиком.
 *
 * `026_add_request_id`, `027_agent_states_status` и `040_archive_missing_columns`
 * оборачивают ADD COLUMN в try/catch и глушат «duplicate column name» — прямо с
 * комментарием «SQLite has no ADD COLUMN IF NOT EXISTS». А `024_add_tg_message_id`,
 * `030_messages_dedup` и `035_content_calendar_chat_scope` тот же ALTER делают
 * голым `db.exec`.
 *
 * Когда это стреляет: колонка на боевой базе появилась раньше отметки в
 * schema_migrations — добавили руками по месту (в этом файле прямо описан такой
 * случай, `messages.kind`), восстановили базу из дампа, откатили отметку.
 * Тогда ALTER бросает, а runMigrations зовётся на уровне модуля из lib/db.ts
 * (:49) — то есть исключение летит из импорта, и процесс не поднимается вообще.
 * Не «одна миграция не прошла», а «12 ботов не стартовали».
 *
 * Проверяем ровно этот сценарий на настоящем пути загрузки: поднять базу,
 * снять отметки о трёх миграциях (колонки при этом остаются) и загрузиться
 * снова.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const REPO = join(import.meta.dir, "..");

/** Миграции, которые добавляют колонку — все обязаны быть идемпотентны. */
const COLUMN_MIGRATIONS = [
  "024_add_tg_message_id",
  "026_add_request_id",
  "027_agent_states_status",
  "030_messages_dedup",
  "035_content_calendar_chat_scope",
  "040_archive_missing_columns",
];

/** Поднять базу настоящим путём (db.ts выполняет схему на импорте). */
function boot(dbPath: string): { ok: boolean; migrations: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "mig-tol-"));
  const script = join(dir, "boot.ts");
  writeFileSync(
    script,
    `const { db } = await import(${JSON.stringify(join(REPO, "lib", "db.ts"))});\n` +
      `const c = db.prepare("SELECT COUNT(*) c FROM schema_migrations").get();\n` +
      `console.log(JSON.stringify({ migrations: c.c }));\n`,
  );
  try {
    const r = Bun.spawnSync(["bun", "run", script], {
      cwd: REPO,
      env: { ...process.env, MEMORY_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const last = r.stdout.toString().trim().split("\n").filter(Boolean).pop() ?? "";
    return {
      ok: r.exitCode === 0,
      migrations: r.exitCode === 0 ? JSON.parse(last).migrations : -1,
      stderr: r.stderr.toString().slice(-1500),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("повторное применение миграций с ADD COLUMN", () => {
  test(
    "снятая отметка при уже существующей колонке не роняет старт",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "mig-db-"));
      const dbPath = join(dir, "fresh.db");
      try {
        const first = boot(dbPath);
        expect(first.ok).toBe(true);

        // Отметки снимаем, колонки оставляем — ровно то состояние, в котором
        // база оказывается после ручного ALTER или отката schema_migrations.
        const db = new Database(dbPath);
        const del = db.prepare(`DELETE FROM schema_migrations WHERE name = ?`);
        for (const n of COLUMN_MIGRATIONS) del.run(n);
        db.close();

        const second = boot(dbPath);
        expect(second.stderr).not.toMatch(/duplicate column name/i);
        expect(second.ok).toBe(true);
        expect(second.migrations).toBe(first.migrations);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe("структура", () => {
  test("ни один ADD COLUMN не идёт мимо общего помощника", async () => {
    // Иначе правило «глушим дубль имени» живёт копиями и разъезжается —
    // именно так три миграции из шести и оказались без него.
    const src = await Bun.file(join(REPO, "lib", "migrations.ts")).text();
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const hits = [...code.matchAll(/ADD COLUMN/g)];
    expect(hits.length).toBe(1);
  });
});
