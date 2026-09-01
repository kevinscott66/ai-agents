/**
 * Аудит 2026-08-28: «readonly property» глушилось откуда угодно.
 *
 * Шапка telegraf-patch.ts обещает глушить uncaughtException «если он пришёл
 * изнутри telegraf-стека, — и ТОЛЬКО его». Аудит 2026-08-20 закрыл внешнюю
 * половину этой дыры (обработчик глушил вообще всё), но внутри `isTelegrafNoise`
 * осталась третья альтернатива: первая ветка смотрела ОДИН текст сообщения,
 * без всякого требования к стеку.
 *
 * Присваивание в замороженный объект — не редкость и не привилегия telegraf:
 * `Object.freeze` стоит, например, на `DISPATCH_ONLY_ACTIONS`
 * (`lib/permissions.ts:60`), и любое присваивание в такой объект даёт под Bun
 * ровно `TypeError: Attempted to assign to readonly property.`. Прилетев из
 * таймера или из колбэка — то есть мимо try/catch — такая ошибка попадала в
 * ветку «безвредный шум telegraf», писалась одной warn-строкой и процесс ехал
 * дальше в неизвестном состоянии. Это ровно тот сценарий, ради которого
 * аудит 2026-08-20 и вводил выход с рестартом от systemd.
 *
 * Требование к стеку — обязательное условие, а не одна из альтернатив.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isTelegrafNoise } from "../lib/telegraf-patch.ts";

const PATCH = resolve(import.meta.dir, "../lib/telegraf-patch.ts");
const RUN_TIMEOUT_MS = 30_000;
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uncaught-scope-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Бросаем из таймера — то есть вне всякого try/catch, как в проде. */
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

async function run(file: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", file], {
    env: {
      ...process.env,
      MEMORY_DB_PATH: join(dir, "uncaught-scope.db"),
      LOG_LEVEL: "error",
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

describe("предпосылки", () => {
  test("замороженный объект даёт именно тот текст, который считался шумом", () => {
    "use strict";
    const frozen = Object.freeze({ a: 1 });
    let msg = "";
    try {
      (frozen as any).a = 2;
    } catch (e) {
      msg = (e as Error).message;
    }
    // Если Bun однажды сменит формулировку — тест об этом скажет, и ветку
    // можно будет пересобрать осознанно, а не обнаружить дыру в проде.
    expect(msg).toContain("readonly property");
  });
});

describe("isTelegrafNoise: стек обязателен", () => {
  test("«readonly property» без telegraf-стека — не шум", () => {
    expect(
      isTelegrafNoise(
        "Attempted to assign to readonly property.",
        "at applyDispatchOnly (lib/permissions.ts:60:3)",
      ),
    ).toBe(false);
    expect(isTelegrafNoise("Attempted to assign to readonly property.", "")).toBe(false);
  });

  test("тот же текст изнутри telegraf-стека — по-прежнему шум", () => {
    for (const stack of [
      "at redactToken (client.js:1:1)",
      "at telegraf/lib/core/network/client.js:9",
      "at f (/app/node_modules/telegraf/lib/core/network/client.js:120:5)",
    ]) {
      expect(isTelegrafNoise("Attempted to assign to readonly property.", stack)).toBe(true);
    }
  });

  test("прочий шум telegraf-клиента глушится как и раньше", () => {
    expect(isTelegrafNoise("socket hang up", "at redactToken (client.js:1:1)")).toBe(true);
    expect(isTelegrafNoise("x", "at telegraf/lib/core/network/client.js:9")).toBe(true);
  });

  test("посторонние ошибки остаются не-шумом", () => {
    expect(isTelegrafNoise("SQLITE_CORRUPT", "at db.ts:10")).toBe(false);
    expect(isTelegrafNoise("", "")).toBe(false);
  });
});

describe("обработчик: выход, а не молчаливое продолжение", () => {
  test(
    "readonly-ошибка вне telegraf роняет процесс с кодом 1",
    async () => {
      const f = fixture(
        "readonly-foreign",
        `"use strict"; const o = Object.freeze({ a: 1 }); (o as any).a = 2;`,
      );
      const r = await run(f);
      // До правки здесь было ALIVE и код 7: ошибку принимали за шум telegraf.
      expect({ code: r.code, alive: r.out.includes("ALIVE") }).toEqual({
        code: 1,
        alive: false,
      });
    },
    RUN_TIMEOUT_MS,
  );

});
