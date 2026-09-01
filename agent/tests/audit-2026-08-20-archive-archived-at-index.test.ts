/**
 * Аудит 2026-08-20: индексы архивных таблиц стояли на столбце, по которому их
 * никто не спрашивает.
 *
 * `agent_actions_archive` и `audit_logs_archive` получили индекс по
 * `created_at` (миграция 019), `messages_archive` — по `ts` (029),
 * `approvals_archive` — по `created_at` (042). Все три столбца — время события
 * в ИСХОДНОЙ таблице.
 *
 * А единственный диапазонный читатель архивов — холодное хранилище — ходит
 * только по `archived_at`: `cold-storage.ts:151` считает, сколько выгружать,
 * `:163` берёт страницу, `:290` удаляет выгруженное. Остальные обращения к
 * архивам идут по первичному ключу.
 *
 * Проверяем не «индекс существует» (это сверка константы с самой собой), а то,
 * что планировщик РЕАЛЬНО берёт индекс на том запросе, который выполняется в
 * проде. План снимается с настоящей схемы, поднятой миграциями с нуля.
 *
 * Про страничный SELECT здесь нарочно ничего не утверждается: у него
 * `ORDER BY rowid`, и SQLite остаётся на обходе по первичному ключу даже с
 * индексом. Замер на копии схемы (80k строк, совпадает 300) — 5.5ms до и
 * после. Ускорился COUNT (6.22ms -> 0.01ms) и DELETE.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

/** Таблицы холодного хранилища и ожидаемое имя индекса по archived_at. */
const ARCHIVES = [
  ["agent_actions_archive", "idx_agent_actions_archive_archived_at"],
  ["audit_logs_archive", "idx_audit_logs_archive_archived_at"],
  ["messages_archive", "idx_messages_archive_archived_at"],
  ["approvals_archive", "idx_approvals_archive_archived_at"],
  // Аудит 2026-08-27: `role_runtime_queue_archive` приехала миграцией 046 уже
  // после 043 и повторила ту же ошибку — индекс по `created_at`. Миграция 047.
  ["role_runtime_queue_archive", "idx_role_runtime_queue_archive_archived_at"],
] as const;

function bootFresh(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "arch-idx-"));
  const dbPath = join(dir, "fresh.db");
  const script = join(dir, "boot.ts");
  writeFileSync(
    script,
    `await import(${JSON.stringify(join(REPO, "lib", "db.ts"))});\nconsole.log("ok");\n`,
  );
  const r = Bun.spawnSync(["bun", "run", script], {
    cwd: REPO,
    env: { ...process.env, MEMORY_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`база не поднялась (код ${r.exitCode}):\n${r.stderr.toString().slice(-1500)}`);
  }
  return { dir, dbPath };
}

describe("индексы холодного хранилища", () => {
  // Список выше — ручной, и в этом его слабое место: `role_runtime_queue_archive`
  // проехала мимо него ровно потому, что таблицу завели в одном файле, а
  // проверку держат в другом. Сверяем список с тем, по которому реально ходит
  // холодное хранилище: новая архивная таблица теперь роняет этот тест, а не
  // тихо получает полный скан на суточном прогоне.
  test("список таблиц совпадает с ARCHIVE_TABLES в cold-storage.ts", async () => {
    const src = await Bun.file(join(REPO, "lib", "cold-storage.ts")).text();
    const block = src.match(/const ARCHIVE_TABLES = \[([\s\S]*?)\] as const;/);
    expect(block, "не нашли ARCHIVE_TABLES — файл переписали, поправь тест").not.toBeNull();
    const declared = [...block![1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.slice().sort()).toEqual(ARCHIVES.map(([t]) => t).slice().sort());
  });


  test(
    "запросы cold-storage по archived_at идут через индекс, а не сканом",
    () => {
      const { dir, dbPath } = bootFresh();
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          for (const [table, index] of ARCHIVES) {
            // Ровно тот запрос, что стоит в cold-storage.ts:151.
            const plan = db
              .prepare(`EXPLAIN QUERY PLAN SELECT count(*) AS n FROM ${table} WHERE archived_at < ?`)
              .all(0) as Array<{ detail: string }>;
            const detail = plan.map((r) => r.detail).join(" | ");
            // Контроль: план вообще снялся, иначе проверки ниже пусты.
            expect(detail.length, `пустой план для ${table}`).toBeGreaterThan(0);
            expect(detail, `${table}: полный скан вместо индекса`).not.toMatch(
              new RegExp(`SCAN ${table}(?!_)`),
            );
            expect(detail, `${table}: план не использует ${index}`).toContain(index);
          }
        } finally {
          db.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "прополка выгруженного тоже опирается на archived_at",
    () => {
      // cold-storage.ts:290 — удаление после успешной выгрузки. Полный скан
      // здесь держит write-лок на том же потоке, что обслуживает 12 ботов.
      const { dir, dbPath } = bootFresh();
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          for (const [table, index] of ARCHIVES) {
            const plan = db
              .prepare(
                `EXPLAIN QUERY PLAN SELECT rowid FROM ${table} WHERE archived_at < ? AND rowid <= ?`,
              )
              .all(0, 0) as Array<{ detail: string }>;
            const detail = plan.map((r) => r.detail).join(" | ");
            expect(detail.length).toBeGreaterThan(0);
            expect(detail, `${table}: прополка идёт сканом`).toContain(index);
          }
        } finally {
          db.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test("старые индексы не снесены — миграция только добавляет", () => {
    // Снос индекса на живой базе — решение владельца, а не побочный эффект.
    const { dir, dbPath } = bootFresh();
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const names = (
          db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{
            name: string;
          }>
        ).map((r) => r.name);
        for (const old of [
          "idx_agent_actions_archive_created",
          "idx_audit_logs_archive_created",
          "idx_messages_archive_ts",
          "idx_approvals_archive_created",
        ]) {
          expect(names, `${old} исчез`).toContain(old);
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
