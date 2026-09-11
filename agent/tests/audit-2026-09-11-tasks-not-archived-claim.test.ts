/**
 * Аудит 2026-09-11, круг 46: перечень архивируемых таблиц был переписан в две
 * чужие докстроки и там протух.
 *
 * Довод, ради которого перечень туда попал, один и тот же в обоих местах:
 * `tasks` растёт всю жизнь деплоя, потому что её никто не архивирует и не
 * чистит. На этом доводе стоят `limit` в `listTasksByAssignee` (lib/tasks.ts)
 * и индекс `idx_tasks_created` (миграция 049). Довод верен. Неверен был
 * способ его подпереть: оба места писали «db-maint трогает только
 * agent_actions/audit_logs/messages», то есть закрытым списком — и список
 * разошёлся с кодом на две таблицы. `approvals` архивируется с миграции 042,
 * `role_runtime_queue` — с 046; обе прошли РАНЬШЕ 049, то есть докблок
 * миграции был неверен уже в день, когда его писали.
 *
 * Это копия правила в чистом виде, и любопытно, где оригинал: шапка
 * lib/db-maint.ts перечисляет все четыре и прямо говорит «Список имён держать
 * полным обязательно: по нему планируют ретенцию». А внутри `archiveOldRows`
 * есть и предупреждение ровно об этом способе сгнить — «Числом шаги здесь НЕ
 * считаем. Абзац писали на трёх вызовах, четвёртый добавили ниже и прозу не
 * тронули». Правило записано дважды в одном файле и оба раза соблюдено; два
 * удалённых экземпляра о нём не знали.
 *
 * Цена — в планировании ретенции. Читающий любой из двух абзацев выносит, что
 * `approvals` и `role_runtime_queue` не архивируются, и либо заводит второй
 * путь архивации поверх существующего, либо снимает существующий как
 * ненужный. Именно эти две таблицы хранят самое чувствительное:
 * `approvals.payload` — тело поста, ушедшего на согласование, и
 * `role_runtime_queue.system_prompt` — системный промпт роли целиком.
 *
 * Починка — не обновить копии, а убрать их: перечень остаётся там, где его
 * растят. Проверки ниже держат ровно то, на чём стоит довод, — что `tasks` ни
 * в одном списке архивации нет и что из неё нигде не удаляют, — и отдельно
 * стерегут, чтобы перечень не переписали сюда снова.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const AGENT = join(import.meta.dir, "..");
const src = (p: string) => readFileSync(join(AGENT, p), "utf8");

const DB_MAINT = src("lib/db-maint.ts");
const COLD = src("lib/cold-storage.ts");
const TASKS = src("lib/tasks.ts");
const MIGRATIONS = src("lib/migrations.ts");

/** Исполняемые строки: без строчных комментариев и тел докблоков. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join("\n");
}

/** Таблицы-источники всех спек архивации: `source: "..."` в db-maint.ts. */
function archivedSources(): string[] {
  return [...DB_MAINT.matchAll(/^\s*source: "([a-z_]+)",$/gm)].map((m) => m[1]!);
}

/** Холодные таблицы, выгружаемые cold-storage. */
function coldTables(): string[] {
  const start = COLD.indexOf("const ARCHIVE_TABLES = [");
  const end = COLD.indexOf("\n] as const;", start);
  expect(end).toBeGreaterThan(start);
  return [...COLD.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("предпосылка: tasks действительно никто не архивирует", () => {
  test("списки читаются — иначе сторож молчит ни о чём", () => {
    // Четыре спеки archiveOldRows плюс messages: пять источников.
    expect(archivedSources().length).toBeGreaterThanOrEqual(5);
    expect(coldTables().length).toBeGreaterThanOrEqual(5);
    expect(archivedSources()).toContain("approvals");
    expect(archivedSources()).toContain("role_runtime_queue");
  });

  test("tasks нет ни в одном списке архивации", () => {
    expect(archivedSources()).not.toContain("tasks");
    expect(coldTables()).not.toContain("tasks");
    expect(coldTables()).not.toContain("tasks_archive");
  });

  test("рабочего пути с DELETE FROM tasks нет", () => {
    // Тесты чистят свои строки сами — это про них и не считается. Комментарии
    // тоже: докстроки в lib/tasks.ts и migrations.ts называют этот запрос
    // ровно затем, чтобы сказать, что его нет.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /DELETE\s+FROM\s+tasks\b/i.test(code(readFileSync(p, "utf8")))) {
          offenders.push(p.slice(AGENT.length));
        }
      }
    };
    walk(join(AGENT, "lib"));
    walk(join(AGENT, "tools"));
    expect(offenders).toEqual([]);
  });
});

describe("перечень архивируемых таблиц живёт в одном месте", () => {
  test("шапка db-maint перечисляет все источники archiveOldRows", () => {
    const header = DB_MAINT.slice(0, DB_MAINT.indexOf("*/"));
    for (const t of archivedSources()) {
      if (t === "messages") continue; // messages архивирует gcMessages, не archiveOldRows
      expect(header).toContain(t);
    }
  });

  test("докстроки tasks.ts и migrations.ts перечень не повторяют", () => {
    // Прежняя формулировка обеих: «db-maint трогает только
    // agent_actions/audit_logs/messages». Когда падает: не дописывать сюда
    // недостающие имена, а убрать перечень — он растёт в db-maint.ts.
    //
    // Сторож знает про цитату: обе докстроки приводят прежнюю формулировку в
    // кавычках-ёлочках, чтобы объяснить, что именно убрано и почему. Снести
    // цитату ради зелёного теста значило бы стереть единственное место, где
    // записано, как этот перечень протух.
    const copied = /db-maint (?:трогает|архивирует)[^.]*agent_actions/;
    const unquoted = (t: string) => t.replace(/«[^»]*»/g, "«…»");
    expect(unquoted(TASKS)).not.toMatch(copied);
    expect(unquoted(MIGRATIONS)).not.toMatch(copied);
    // Цитата при этом обязана быть на месте — иначе абзац теряет смысл.
    expect(TASKS).toMatch(copied);
  });

  test("довод про рост tasks на месте — убирали копию, а не смысл", () => {
    expect(TASKS).toContain("растёт всю жизнь деплоя");
    expect(MIGRATIONS).toContain("растёт всю жизнь деплоя");
  });
});
