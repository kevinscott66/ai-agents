/**
 * Аудит 2026-08-11: lib/migrations.ts — 874 строки, 39 миграций, выполняется на
 * КАЖДОМ старте против прод-базы — и не имел ни одного теста. Никто ни разу не
 * проверил, что установка с нуля вообще поднимается: на VPS база живёт с
 * первого дня, все миграции там давно отмечены применёнными, и сломанный
 * порядок вскрылся бы только при развёртывании второго инстанса или при
 * восстановлении из пустого файла.
 *
 * Здесь два разных вопроса.
 *
 * 1. Фактический: поднимается ли схема с нуля и идемпотентен ли повторный
 *    старт. Проверяем на настоящем пути загрузки (lib/db.ts создаёт базовые
 *    таблицы и только потом зовёт runMigrations) в отдельном процессе с
 *    MEMORY_DB_PATH во временный файл — импортировать db.ts прямо в тесте
 *    нельзя, он открывает боевой файл на импорте.
 *
 * 2. Структурный: порядок в массиве MIGRATIONS обязан совпадать с нумерацией
 *    имён. Применяются они по порядку массива, а читает человек по номерам —
 *    035/036 стояли ПОСЛЕ 037/038. Сегодня это работает (сиды прав ни от чего
 *    не зависят), но следующая миграция, вставленная «по номеру» и
 *    рассчитывающая на таблицу из предыдущей, получит её только на боевой базе,
 *    где всё уже создано, и молча развалится на чистой установке.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const MIGRATIONS_SRC = Bun.file(join(REPO, "lib", "migrations.ts"));

/** Имена миграций в том порядке, в каком они лежат в массиве. */
async function migrationNames(): Promise<string[]> {
  const src = await MIGRATIONS_SRC.text();
  return Array.from(src.matchAll(/name: "(\d{3}[a-z]?_[a-z0-9_]+)"/g)).map((m) => m[1]);
}

/**
 * Поднимает базу с нуля настоящим путём загрузки и возвращает её состояние.
 * Отдельный процесс: db.ts выполняет схему как side-effect импорта.
 */
function bootFresh(dbPath: string): { migrations: number; tables: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "mig-boot-"));
  const script = join(dir, "boot.ts");
  writeFileSync(
    script,
    `const { db } = await import(${JSON.stringify(join(REPO, "lib", "db.ts"))});\n` +
      `const c = db.prepare("SELECT COUNT(*) c FROM schema_migrations").get();\n` +
      `const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();\n` +
      `console.log(JSON.stringify({ migrations: c.c, tables: t.map((x) => x.name) }));\n`,
  );
  try {
    const r = Bun.spawnSync(["bun", "run", script], {
      cwd: REPO,
      env: { ...process.env, MEMORY_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString().trim();
    if (r.exitCode !== 0) {
      throw new Error(
        `установка с нуля не поднялась (код ${r.exitCode}):\n${r.stderr.toString().slice(-1500)}`,
      );
    }
    const last = out.split("\n").filter(Boolean).pop() ?? "";
    return JSON.parse(last);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("установка с нуля", () => {
  test(
    "чистая база поднимается и повторный старт ничего не меняет",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "mig-db-"));
      const dbPath = join(dir, "fresh.db");
      try {
        const total = (await migrationNames()).length;

        const first = bootFresh(dbPath);
        expect(first.migrations).toBe(total);
        // Таблицы, без которых система не работает вовсе.
        for (const t of [
          "messages",
          "tasks",
          "permissions",
          "approvals",
          "agent_actions",
          "agent_prompts",
          "schema_migrations",
        ]) {
          expect(first.tables).toContain(t);
        }

        // Второй старт на том же файле: миграции идемпотентны, схема не поехала.
        const second = bootFresh(dbPath);
        expect(second.migrations).toBe(total);
        expect(second.tables).toEqual(first.tables);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("список миграций", () => {
  test("имена уникальны", async () => {
    // Повтор имени = вторая миграция не применится НИКОГДА: runMigrations
    // пропускает по имени, а отметка уже стоит от первой.
    const names = await migrationNames();
    const dups = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dups).toEqual([]);
  });

  test("порядок в массиве совпадает с нумерацией имён", async () => {
    // Применяются по порядку массива, а зависимости человек планирует по
    // номерам. Расхождение — это миграция, которая на чистой установке
    // выполнится раньше той, на которую рассчитывает.
    const names = await migrationNames();
    const nums = names.map((n) => n.slice(0, 3));
    expect(nums).toEqual([...nums].sort());
  });

  test("миграций не меньше, чем уже применено в проде", async () => {
    // Страховка от «случайно удалил кусок массива»: удалённая миграция на
    // боевой базе останется отметкой в schema_migrations, а на чистой — нет.
    const names = await migrationNames();
    expect(names.length).toBeGreaterThanOrEqual(39);
  });
});
