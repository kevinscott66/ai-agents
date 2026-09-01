/**
 * Аудит 2026-08-20 — `MEMORY_DB_PATH` читался как `process.env.X ?? "data/memory.db"`.
 *
 * `??` спасает только от ОТСУТСТВУЮЩЕЙ переменной. Строка `MEMORY_DB_PATH=`
 * переменную задаёт — пустой. А пустой путь SQLite понимает не как ошибку, а
 * как «заведи приватную временную базу»: она открывается, в неё пишется, и она
 * исчезает вместе с процессом. Проверено зондом и закреплено тестом ниже:
 * после close/reopen таблиц в ней нет. Пробел вместо пустой строки даёт ровно
 * то же самое.
 *
 * Достижимость не гипотетическая. `agent/.env.example` строка 54 —
 * `MEMORY_DB_PATH=` без значения, и весь файл написан в этом стиле: у всех
 * необязательных переменных пустое значение. Копирование примера в
 * `/opt/agent-team/.env` (то есть штатная установка) даёт агенту базу, которая
 * молча обнуляется на каждом рестарте `agent-team.service`: сообщения, задачи,
 * заявки на одобрение, права, аудит-лог, FTS-индекс вики. Ни одной ошибки в
 * логах — процесс живой, запросы проходят, данных нет.
 *
 * Тот же класс, что и `PORT=` в site/server (PR #557): `??` вместо проверки
 * значения. Разница в цене — там 502 при живом процессе, здесь тихая потеря
 * всей памяти.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_DB_PATH, resolveDbPath } from "../lib/db.ts";

function capture(fn: () => string): { value: string; warns: string[] } {
  const orig = console.warn;
  const warns: string[] = [];
  try {
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    return { value: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

describe("почему пустой путь опасен (характеристика bun:sqlite)", () => {
  test("пустой путь = приватная временная БД: после reopen данных нет", () => {
    const a = new Database("", { create: true });
    a.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    const list = a.query("PRAGMA database_list;").all() as { file: string }[];
    expect(list[0]!.file).toBe(""); // не файл на диске
    a.close();

    const b = new Database("", { create: true });
    const tables = b.query(
      "SELECT name FROM sqlite_master WHERE type='table';",
    ).all();
    b.close();
    expect(tables).toEqual([]); // всё, что записали, исчезло
  });

  test("путь из пробелов ведёт себя так же", () => {
    const a = new Database("   ", { create: true });
    const list = a.query("PRAGMA database_list;").all() as { file: string }[];
    a.close();
    expect(list[0]!.file).toBe("");
  });
});

describe("resolveDbPath", () => {
  test("переменной нет — дефолт, молча", () => {
    const r = capture(() => resolveDbPath(undefined));
    expect(r.value).toBe(DEFAULT_DB_PATH);
    expect(r.warns).toEqual([]);
  });

  test("пустая строка — дефолт, с предупреждением", () => {
    const r = capture(() => resolveDbPath(""));
    expect(r.value).toBe(DEFAULT_DB_PATH);
    expect(r.warns.length).toBe(1);
    expect(r.warns[0]).toContain("MEMORY_DB_PATH");
  });

  test.each(["   ", "\t", "\n", " \t\n "])(
    "путь из одних пробельных символов (%j) — дефолт с предупреждением",
    (raw) => {
      const r = capture(() => resolveDbPath(raw));
      expect(r.value).toBe(DEFAULT_DB_PATH);
      expect(r.warns.length).toBe(1);
    },
  );

  test("нормальный путь возвращается как есть и молча", () => {
    const r = capture(() => resolveDbPath("/var/lib/agent/memory.db"));
    expect(r.value).toBe("/var/lib/agent/memory.db");
    expect(r.warns).toEqual([]);
  });

  test("пробелы вокруг пути срезаются", () => {
    expect(capture(() => resolveDbPath("  data/memory.db \n")).value).toBe(
      "data/memory.db",
    );
  });

  test(":memory: — осознанный выбор, его не подменяем", () => {
    const r = capture(() => resolveDbPath(":memory:"));
    expect(r.value).toBe(":memory:");
    expect(r.warns).toEqual([]);
  });

  test("MEMORY_DB_PATH= в окружении процесса даёт файл на диске, а не временную БД", () => {
    // Сквозная проверка всей связки, а не только чистой функции: настоящий
    // процесс bun с пустой переменной должен открыть data/memory.db в своём
    // рабочем каталоге. Каталог — временный, чтобы не насорить в репозитории.
    const cwd = mkdtempSync(join(tmpdir(), "db-path-e2e-"));
    try {
      const r = Bun.spawnSync(
        [
          "bun",
          "-e",
          `import { DB_PATH, db } from ${JSON.stringify(join(import.meta.dir, "..", "lib", "db.ts"))};` +
            `const l = db.query("PRAGMA database_list;").all();` +
            `console.log(JSON.stringify({ DB_PATH, file: l[0].file }));`,
        ],
        { cwd, env: { ...process.env, MEMORY_DB_PATH: "" } },
      );
      const out = r.stdout.toString();
      const line = out.trim().split("\n").pop() ?? "";
      const parsed = JSON.parse(line) as { DB_PATH: string; file: string };
      expect(parsed.DB_PATH).toBe(DEFAULT_DB_PATH);
      expect(parsed.file).not.toBe(""); // не приватная временная БД
      expect(parsed.file).toContain("memory.db");
      expect(r.stderr.toString()).toContain("MEMORY_DB_PATH");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("исходник lib/db.ts", () => {
  const src = readFileSync(join(import.meta.dir, "..", "lib", "db.ts"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

  test("прежнего `process.env.MEMORY_DB_PATH ??` в коде не осталось", () => {
    // Guard: если стриппер комментариев съел лишнее, проверка ниже прошла бы
    // вхолостую — поэтому убеждаемся, что тело функции на месте.
    expect(code).toContain("resolveDbPath");
    expect(code).not.toContain("process.env.MEMORY_DB_PATH ??");
  });

  test("DB_PATH получается через resolveDbPath, а не напрямую из env", () => {
    expect(code).toMatch(/DB_PATH\s*=\s*resolveDbPath\(process\.env\.MEMORY_DB_PATH\)/);
  });
});
