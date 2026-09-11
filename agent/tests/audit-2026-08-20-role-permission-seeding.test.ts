/**
 * Аудит 2026-08-20: права ролей раздаются ОДНОРАЗОВЫМИ сид-миграциями, которые
 * итерируют ЖИВОЙ импорт `CHARACTERS`, — и это расходится между прод-базой и CI.
 *
 * Четырнадцать миграций (006–013, 017, 018, 020, 021, 023, 032, 033) устроены
 * одинаково: `for (const c of CHARACTERS) ins.run(c.key, at)`. `CHARACTERS`
 * импортирован в `lib/migrations.ts:7` из `characters/index.ts`, то есть это не
 * снимок ролей на момент миграции, а текущий состав команды.
 *
 * Отсюда расхождение при добавлении тринадцатой роли:
 *
 *  - на ПРОДЕ все четырнадцать сидов уже отмечены в `schema_migrations` и
 *    больше не запустятся никогда. Новая роль не получит НИ ОДНОЙ строки в
 *    `permissions`, а `getPermission` (`lib/permissions.ts`) на отсутствие
 *    строки возвращает `{allowed:false}`. Роль отказывает себе во всём, включая
 *    SEND_MESSAGE, — то есть бот поднимается и молчит;
 *  - на ЧИСТОЙ базе (CI, `tests/migrations-bootstrap.test.ts`) те же миграции
 *    выполняются впервые и выдают новой роли полный набор прав. CI зелёный
 *    по построению — ровно в том случае, который на проде сломан.
 *
 * Существующий сторож эту дыру не видит: `unseededActionTypes()`
 * (`permissions.ts:365-371`) делает `SELECT DISTINCT action_type` и считает
 * покрытие по типам действий, а не по парам `(agent_key, action_type)`. Пока
 * хоть одна роль имеет SEND_MESSAGE, тип считается засеянным.
 *
 * Чинить раздачей прав нельзя: какие права получает новая роль и какие из них
 * требуют approval — решение владельца, а в наборе лежат GRANT_PERMISSION и
 * правка системных промптов. Поэтому здесь не фикс, а страховка: тест
 * «состав ролей» краснеет в момент добавления роли и требует новой сид-миграции
 * рядом с ней. Тесты ниже фиксируют и сам механизм, чтобы страховка не
 * выродилась в сверку константы с самой собой.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHARACTERS } from "../characters/index.ts";

const REPO = join(import.meta.dir, "..");

/**
 * Роли, которым права РЕАЛЬНО выданы сид-миграциями 006–033.
 *
 * Снимок на 2026-08-20. Добавляешь роль в `characters/index.ts` — добавь
 * ВМЕСТЕ С НЕЙ новую нумерованную сид-миграцию в `lib/migrations.ts` (старые
 * на проде уже отмечены применёнными и не выполнятся), и только потом впиши
 * ключ сюда. Правка одного этого списка ничего не чинит.
 */
const SEEDED_ROLES = [
  "orchestrator",
  "pm",
  "product",
  "backend",
  "frontend",
  "tgdev",
  "aieng",
  "qa",
  "smm",
  "copy",
  "design",
  "perm",
] as const;

/** Поднять базу настоящим путём загрузки (db.ts + runMigrations) в отдельном
 *  процессе — импортировать db.ts прямо в тесте нельзя, он открывает боевой
 *  файл на импорте. */
function boot(dbPath: string): void {
  const dir = mkdtempSync(join(tmpdir(), "seed-boot-"));
  const script = join(dir, "boot.ts");
  writeFileSync(
    script,
    `await import(${JSON.stringify(join(REPO, "lib", "db.ts"))});\nconsole.log("ok");\n`,
  );
  try {
    const r = Bun.spawnSync(["bun", "run", script], {
      cwd: REPO,
      env: { ...process.env, MEMORY_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      throw new Error(`база не поднялась (код ${r.exitCode}):\n${r.stderr.toString().slice(-1500)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Число строк прав по ролям на указанном файле базы. */
function permRows(dbPath: string): Map<string, { total: number; sendMessage: number }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT agent_key,
                COUNT(*) AS total,
                SUM(CASE WHEN action_type = 'SEND_MESSAGE' AND allowed = 1 THEN 1 ELSE 0 END) AS sm
           FROM permissions
          GROUP BY agent_key`,
      )
      .all() as Array<{ agent_key: string; total: number; sm: number }>;
    return new Map(rows.map((r) => [r.agent_key, { total: r.total, sendMessage: r.sm }]));
  } finally {
    db.close();
  }
}

describe("сид прав ролей", () => {
  test(
    "на чистой базе каждая роль получает права и разрешённый SEND_MESSAGE",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "seed-db-"));
      const dbPath = join(dir, "fresh.db");
      try {
        boot(dbPath);
        const perms = permRows(dbPath);
        // Контроль: сиды вообще отработали, иначе следующие проверки пусты.
        expect(perms.size).toBeGreaterThanOrEqual(CHARACTERS.length);
        for (const c of CHARACTERS) {
          const p = perms.get(c.key);
          expect(p, `роль ${c.key} без строк в permissions`).toBeDefined();
          expect(p!.total).toBeGreaterThan(0);
          // Без этого права бот поднимается и молчит.
          expect(p!.sendMessage, `${c.key} не может SEND_MESSAGE`).toBe(1);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "сиды одноразовые: второй старт не восстановит недостающие права роли",
    () => {
      // Так выглядит прод после добавления роли: миграции отмечены
      // применёнными, строк у роли нет, и рантайм их ниоткуда не возьмёт —
      // единственный не-миграционный INSERT в permissions это ручной
      // GRANT_PERMISSION (permissions.ts:389).
      const dir = mkdtempSync(join(tmpdir(), "seed-db2-"));
      const dbPath = join(dir, "fresh.db");
      try {
        boot(dbPath);
        const victim = "perm";
        const before = permRows(dbPath).get(victim);
        expect(before, "нечего удалять — сид не отработал").toBeDefined();
        expect(before!.total).toBeGreaterThan(0);

        const w = new Database(dbPath);
        w.prepare(`DELETE FROM permissions WHERE agent_key = ?`).run(victim);
        w.close();
        expect(permRows(dbPath).get(victim)).toBeUndefined();

        boot(dbPath);
        expect(
          permRows(dbPath).get(victim),
          "права восстановились сами — появился рантайм-реконсайл, страховку ниже можно пересмотреть",
        ).toBeUndefined();

        // Контроль: перезапуск не снёс права остальным, то есть база жива.
        expect(permRows(dbPath).get("orchestrator")!.total).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test("состав ролей не менялся без новой сид-миграции", () => {
    // Тот самый сторож. Красное здесь = на проде новая роль будет немой.
    expect([...CHARACTERS.map((c) => c.key)].sort()).toEqual([...SEEDED_ROLES].sort());
  });

  test("снимок SEEDED_ROLES совпадает с тем, что реально сеет чистая база", () => {
    // Чтобы список выше нельзя было «починить» дописыванием ключа руками.
    const dir = mkdtempSync(join(tmpdir(), "seed-db3-"));
    const dbPath = join(dir, "fresh.db");
    try {
      boot(dbPath);
      const seeded = [...permRows(dbPath).keys()].sort();
      expect(seeded).toEqual([...SEEDED_ROLES].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
