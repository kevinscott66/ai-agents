/**
 * Аудит 2026-08-20: обработчик uncaughtException глушил ВСЁ.
 *
 * Сам факт наличия обработчика отменяет падение процесса — это и есть
 * механика бага: `log.error("UNCAUGHT", …)` выглядел как «упали с логом», а
 * на деле процесс жил дальше с оборванными цепочками промисов и, возможно,
 * мёртвым polling-циклом одного из ботов. Наружу это не видно вообще никак.
 *
 * Проверять такое можно только в отдельном процессе: assert внутри текущего
 * не отличит «вышли с 1» от «не вышли». Поэтому каждый кейс — реальный
 * `bun run` фикстуры, а утверждение — на код выхода.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { isTelegrafNoise } from "../lib/telegraf-patch.ts";

const PATCH = resolve(import.meta.dir, "../lib/telegraf-patch.ts");
let dir: string;

/** Фикстура: грузит патч и бросает из таймера, т.е. вне всякого try/catch. */
function fixture(name: string, body: string): string {
  const p = join(dir, `${name}.ts`);
  writeFileSync(
    p,
    `import ${JSON.stringify(PATCH)};\n` +
      `setTimeout(() => { ${body} }, 5);\n` +
      `setTimeout(() => { console.log("ALIVE"); process.exit(7); }, 400);\n`,
  );
  return p;
}

async function run(
  file: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", file], {
    env: {
      ...process.env,
      MEMORY_DB_PATH: join(dir, "uncaught.db"),
      LOG_LEVEL: "error",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uncaught-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RUN_TIMEOUT_MS = 30_000;

describe("uncaughtException: неизвестное состояние = выход", () => {
  test("посторонняя ошибка роняет процесс с кодом 1", async () => {
    const f = fixture("fatal", `throw new Error("db is corrupted");`);
    const r = await run(f);
    // Код 7 означал бы, что процесс дожил до последнего таймера, т.е. работал
    // дальше в неизвестном состоянии — ровно то, что чиним.
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("ALIVE");
    // Синхронная запись в fd 2: последняя строка доходит даже при буфере stdout.
    expect(r.out).toContain("FATAL uncaughtException: db is corrupted");

    // След, который переживёт рестарт. Запись идёт через синхронный require
    // прямо в crash-path — самое хрупкое место фикса, поэтому проверяем, что
    // строка действительно успела лечь в базу ДО выхода.
    const probe = new Database(join(dir, "uncaught.db"), { readonly: true });
    try {
      const row = probe
        .prepare(
          `SELECT payload FROM audit_logs WHERE event_type = 'alert.uncaught_exception'`,
        )
        .get() as { payload: string } | null;
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.payload)).toMatchObject({
        severity: "critical",
        policy: "exit",
      });
    } finally {
      probe.close();
    }
  }, RUN_TIMEOUT_MS);

  test("шум telegraf по-прежнему глушится, процесс живёт", async () => {
    // Стек проставлен явно: с аудита 2026-08-28 одного текста недостаточно —
    // см. audit-2026-08-28-uncaught-readonly-scope.
    const f = fixture(
      "noise",
      `const e = new Error("Attempted to assign to readonly property.");
       e.stack = "Error\\n    at redactToken (/app/node_modules/telegraf/lib/core/network/client.js:1:1)";
       throw e;`,
    );
    const r = await run(f);
    expect(r.code).toBe(7);
    expect(r.out).toContain("ALIVE");
  }, RUN_TIMEOUT_MS);

  test("шум опознаётся и по стеку, не только по тексту", async () => {
    const f = fixture(
      "noise-stack",
      `const e = new Error("socket hang up");
       e.stack = "Error: socket hang up\\n    at redactToken (x.js:1:1)";
       throw e;`,
    );
    const r = await run(f);
    expect(r.code).toBe(7);
    expect(r.out).toContain("ALIVE");
  }, RUN_TIMEOUT_MS);

  test("аварийный тормоз UNCAUGHT_EXCEPTION_POLICY=keep возвращает старое поведение", async () => {
    // Нужен дежурному, если выход всё-таки уйдёт в петлю рестартов: снимается
    // одной переменной в /opt/agent-team/.env, без передеплоя.
    const f = fixture("keep", `throw new Error("db is corrupted");`);
    const r = await run(f, { UNCAUGHT_EXCEPTION_POLICY: "keep" });
    expect(r.code).toBe(7);
    expect(r.out).toContain("ALIVE");
  }, RUN_TIMEOUT_MS);

  test("любое значение кроме keep — это exit", async () => {
    const f = fixture("typo", `throw new Error("db is corrupted");`);
    // Опечатка в env не должна ТИХО оставлять процесс жить: fail-safe в
    // сторону выхода. (Ср. LOG_LEVEL, где незнакомое значение открывало debug.)
    for (const v of ["", "Keep", "yes", "exit"]) {
      const r = await run(f, { UNCAUGHT_EXCEPTION_POLICY: v });
      expect({ v, code: r.code }).toEqual({ v, code: 1 });
    }
  }, RUN_TIMEOUT_MS);
});

describe("isTelegrafNoise: граница «безвредно / неизвестное состояние»", () => {
  test("известные формы шума — все из telegraf-стека", () => {
    // Аудит 2026-08-28: текст «readonly property» сам по себе шумом больше не
    // считается, нужен стек telegraf — см. audit-2026-08-28-uncaught-readonly-scope.
    expect(
      isTelegrafNoise("Attempted to assign to readonly property.", "at redactToken (client.js:1)"),
    ).toBe(true);
    expect(isTelegrafNoise("x", "at redactToken (client.js:1:1)")).toBe(true);
    expect(isTelegrafNoise("x", "at telegraf/lib/core/network/client.js:9")).toBe(true);
  });

  test("всё остальное — не шум", () => {
    expect(isTelegrafNoise("SQLITE_CORRUPT", "at db.ts:10")).toBe(false);
    expect(isTelegrafNoise("", "")).toBe(false);
    // Похожая, но другая ошибка: telegraf ни при чём, состояние неизвестно.
    expect(isTelegrafNoise("Cannot read properties of undefined", "at handler.ts:3")).toBe(false);
  });
});
