/**
 * Аудит 2026-08-10: шаблон окружения называл токен оркестратора не тем именем.
 *
 * `agent/.env.example` просил заполнить TG_TOKEN_ORCHESTRATOR, а код читает
 * `def.envToken`, и у оркестратора это `TELEGRAM_BOT_TOKEN`
 * (characters/index.ts). Переменной TG_TOKEN_ORCHESTRATOR в коде нет нигде.
 * Кто разворачивал по шаблону — получал молчащего главного бота: 11 ролей
 * поднимаются, оркестратор нет. Остальные 11 имён совпадали, поэтому расхождение
 * выглядело опечаткой в одной строке и жило.
 *
 * Тот же фантом дублировался в `getBotTokenForAuth` (lib/miniapp-auth.ts) —
 * и не просто как мёртвый fallback: текст ошибки советовал задать
 * TG_TOKEN_ORCHESTRATOR, то есть чинить конфиг способом, который auth ломает
 * тише (initData начнёт проверяться чужим токеном → «bad hash» вместо внятного
 * «не задан токен»).
 *
 * Инвариант: имя переменной задаёт код, а шаблон его отражает. Не наоборот.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHARACTERS } from "../characters/index.ts";
import { getBotTokenForAuth } from "../lib/miniapp-auth.ts";

const ENV_EXAMPLE = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");

/** Имена переменных, объявленных в шаблоне (строки вида `NAME=...`). */
const declared = new Set(
  [...ENV_EXAMPLE.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]),
);

describe("шаблон окружения совпадает с кодом", () => {
  for (const def of CHARACTERS) {
    test(`${def.key}: ${def.envToken} есть в .env.example`, () => {
      expect(declared.has(def.envToken)).toBe(true);
    });
  }

  test("несуществующих имён токенов в шаблоне нет", () => {
    // Любой `TG_TOKEN_*`/`TELEGRAM_*TOKEN` в шаблоне должен быть чьим-то
    // envToken — иначе это инструкция заполнить переменную, которую никто не
    // читает.
    const real = new Set(CHARACTERS.map((c) => c.envToken));
    const tokenVars = [...declared].filter(
      (v) => v.startsWith("TG_TOKEN_") || /^TELEGRAM_.*TOKEN$/.test(v),
    );
    expect(tokenVars.length).toBeGreaterThan(0);
    for (const v of tokenVars) expect(real.has(v)).toBe(true);
  });
});

describe("auth Mini App не отсылает к фантомной переменной", () => {
  const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;

  function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("MINIAPP_BOT_TOKEN по-прежнему главный", () => {
    withEnv(
      { MINIAPP_BOT_TOKEN: "primary", [ORCH.envToken]: "fallback" },
      () => expect(getBotTokenForAuth()).toBe("primary"),
    );
  });

  test("fallback — реальный токен оркестратора, а не мёртвое имя", () => {
    withEnv(
      { MINIAPP_BOT_TOKEN: undefined, [ORCH.envToken]: "orch-token" },
      () => expect(getBotTokenForAuth()).toBe("orch-token"),
    );
  });

  test("ошибка называет переменные, которые действительно читаются", () => {
    withEnv(
      { MINIAPP_BOT_TOKEN: undefined, [ORCH.envToken]: undefined },
      () => {
        let message = "";
        try {
          getBotTokenForAuth();
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        expect(message).toContain("MINIAPP_BOT_TOKEN");
        expect(message).toContain(ORCH.envToken);
        // Совет задать её увёл бы отладку в «bad hash».
        expect(message).not.toContain("TG_TOKEN_ORCHESTRATOR");
      },
    );
  });
});
