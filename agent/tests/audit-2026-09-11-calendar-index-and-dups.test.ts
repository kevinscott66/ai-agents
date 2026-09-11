/**
 * Аудит 2026-09-11: индексы content_calendar и четыре дубликата.
 *
 * Два независимых утверждения, обе проверки — на базе, поднятой с нуля
 * настоящим путём загрузки (db.ts создаёт базовые таблицы и зовёт
 * runMigrations). Отдельный процесс: db.ts открывает боевой файл на импорте,
 * поэтому база подсовывается через MEMORY_DB_PATH — та же схема, что в
 * migrations-bootstrap.test.ts.
 *
 * 1. У `content_calendar` появился индекс, ведущий с `chat_id`, и планировщик
 *    его выбирает на настоящем WHERE из `LIST_SCHEDULED_POSTS`. Проверяем не
 *    наличие строки в sqlite_master, а именно выбор планировщика: индекс,
 *    который никто не берёт, — это только лишняя запись при вставке.
 *
 * 2. Ни один индекс не дублирует другой. Инвариант сильнее, чем «эти четыре
 *    удалены»: дубликат — это индекс, чей список колонок является префиксом
 *    списка другого индекса той же таблицы (полное совпадение — частный
 *    случай). Такой всегда обслуживает подмножество запросов близнеца и
 *    платит за это записью в ещё одно B-дерево. Неявные UNIQUE-индексы
 *    (sqlite_autoindex) считаются наравне: ровно на таком погорел
 *    `idx_agent_prompts_key_version`.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

type Probe = {
  indexes: Record<string, string[]>;
  plan: string;
};

/** Поднять базу с нуля и снять с неё индексы и план запроса расписания. */
function probeFresh(): Probe {
  const dir = mkdtempSync(join(tmpdir(), "mig-idx-"));
  const script = join(dir, "probe.ts");
  writeFileSync(
    script,
    `const { db } = await import(${JSON.stringify(join(REPO, "lib", "db.ts"))});\n` +
      `const idx = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' ORDER BY tbl_name, name").all();\n` +
      `const indexes = {};\n` +
      `for (const i of idx) {\n` +
      `  const cols = db.prepare("PRAGMA index_info(" + JSON.stringify(i.name) + ")").all();\n` +
      `  indexes[i.tbl_name + "." + i.name] = cols.map((c) => c.name);\n` +
      `}\n` +
      // Тот самый WHERE, который собирает LIST_SCHEDULED_POSTS (tools-schema.ts).
      `const plan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM content_calendar WHERE status = 'scheduled' AND chat_id = ?").all(-1).map((r) => r.detail).join(" | ");\n` +
      `console.log(JSON.stringify({ indexes, plan }));\n`,
  );
  const dbDir = mkdtempSync(join(tmpdir(), "mig-idx-db-"));
  try {
    const r = Bun.spawnSync(["bun", "run", script], {
      cwd: REPO,
      env: { ...process.env, MEMORY_DB_PATH: join(dbDir, "fresh.db") },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `установка с нуля не поднялась (код ${r.exitCode}):\n${r.stderr.toString().slice(-1500)}`,
      );
    }
    const last = r.stdout.toString().trim().split("\n").filter(Boolean).pop() ?? "";
    return JSON.parse(last) as Probe;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
}

let cached: Probe | null = null;
function probe(): Probe {
  cached ??= probeFresh();
  return cached;
}

describe("индексы схемы", () => {
  test(
    "расписание чата читается по индексу, а не полным сканом",
    () => {
      const { indexes, plan } = probe();
      expect(indexes["content_calendar.idx_content_calendar_chat_status_at"]).toEqual([
        "chat_id",
        "status",
        "scheduled_at",
      ]);
      // До миграции 054 здесь стояло «SCAN content_calendar»: оба прежних
      // индекса вели с колонки, которой в этом WHERE нет.
      expect(plan).toContain("idx_content_calendar_chat_status_at");
      expect(plan).not.toContain("SCAN content_calendar");
    },
    60_000,
  );

  test(
    "ни один индекс не дублирует другой на той же таблице",
    () => {
      const { indexes } = probe();
      const byTable = new Map<string, Array<[string, string[]]>>();
      for (const [key, cols] of Object.entries(indexes)) {
        const dot = key.indexOf(".");
        const table = key.slice(0, dot);
        const list = byTable.get(table) ?? [];
        list.push([key.slice(dot + 1), cols]);
        byTable.set(table, list);
      }

      const dups: string[] = [];
      for (const [table, list] of byTable) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const [n1, c1] = list[i];
            const [n2, c2] = list[j];
            const prefix =
              c1.slice(0, c2.length).join() === c2.join() ||
              c2.slice(0, c1.length).join() === c1.join();
            if (prefix) dups.push(`${table}: ${n1}(${c1}) ⊇ ${n2}(${c2})`);
          }
        }
      }
      expect(dups).toEqual([]);
    },
    60_000,
  );

  test(
    "у каждого удалённого дубликата остался живой близнец",
    () => {
      const { indexes } = probe();
      // Удаление не должно было увести за собой запросы: префикс каждого
      // выброшенного индекса по-прежнему обслуживается.
      expect(indexes["approvals.idx_approvals_status_chat"]).toEqual([
        "status",
        "chat_id",
      ]);
      expect(indexes["tasks.idx_tasks_assigned_status"]).toEqual([
        "assigned_to",
        "status",
      ]);
      expect(indexes["agent_actions.idx_agent_actions_agent_ts"]).toEqual([
        "agent_key",
        "created_at",
      ]);
      expect(indexes["agent_prompts.sqlite_autoindex_agent_prompts_1"]).toEqual([
        "agent_key",
        "version",
      ]);
      for (const gone of [
        "approvals.idx_approvals_status_chat_v2",
        "tasks.idx_tasks_assigned_to",
        "agent_actions.idx_agent_actions_agent_created",
        "agent_prompts.idx_agent_prompts_key_version",
      ]) {
        expect(indexes[gone]).toBeUndefined();
      }
    },
    60_000,
  );
});
