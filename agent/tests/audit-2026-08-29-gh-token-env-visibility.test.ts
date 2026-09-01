/**
 * Аудит 2026-08-29 (LOW 22): `gh` в проде аутентифицируется токеном из
 * /opt/agent-team/.env, а шаблон этого файла о нём молчал.
 *
 * Причина не в забывчивости, а в конструкции. `lib/dispatch/github.ts` читал
 * оба имени индексом по КОПИИ окружения, а гейт шаблона
 * (tests/env-example-coverage.test.ts) сканирует только прямые обращения к
 * `process.env`. То есть двусторонний инвариант «что читает код — то есть в
 * шаблоне» физически не мог увидеть эти две переменные: гейт был зелёный, а
 * оператор, поднимающий сервис по шаблону, получал неаутентифицированный `gh`
 * и ошибку от него вместо результата действия.
 *
 * Здесь пинится и правило подстановки (чистой функцией, без запуска `gh`), и
 * сама видимость чтения для сканера — иначе первый же рефакторинг вернёт
 * индекс по копии, и слепое пятно молча восстановится.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGhEnv, resolveGhToken } from "../lib/dispatch/github.ts";

const ROOT = join(import.meta.dir, "..");
const GITHUB_TS = readFileSync(join(ROOT, "lib", "dispatch", "github.ts"), "utf8");
const ENV_EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf8");

/**
 * Комментарии выкидываем построчно: docblock самого github.ts теперь ЦИТИРУЕТ
 * убранную форму чтения, и проверка «в коде нет индекса по копии» без этого
 * ловила бы собственное объяснение фикса.
 */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

function declaredLine(name: string): string | undefined {
  return ENV_EXAMPLE.split("\n").find((l) => l.startsWith(`${name}=`));
}

describe("resolveGhToken: правило подстановки", () => {
  test("свой GH_TOKEN важнее GITHUB_TOKEN", () => {
    expect(resolveGhToken("gh-own", "github-ci")).toBe("gh-own");
  });

  test("без GH_TOKEN берётся GITHUB_TOKEN (случай CI)", () => {
    expect(resolveGhToken(undefined, "github-ci")).toBe("github-ci");
  });

  test("пустая строка из EnvironmentFile= равносильна отсутствию", () => {
    // systemd на строку `GH_TOKEN=` кладёт "" — не undefined. Токен-пустышка
    // не аутентифицирует ничего, поэтому подставляется GITHUB_TOKEN.
    expect(resolveGhToken("", "github-ci")).toBe("github-ci");
  });

  test("не задано ничего — undefined, а не пустая строка", () => {
    expect(resolveGhToken(undefined, undefined)).toBeUndefined();
    expect(resolveGhToken("", "")).toBe("");
  });
});

describe("чтение токенов видно сканеру шаблона", () => {
  const code = codeLines(GITHUB_TS).join("\n");

  test("оба имени читаются напрямую из process.env", () => {
    expect(code).toContain("process.env.GH_TOKEN");
    expect(code).toContain("process.env.GITHUB_TOKEN");
  });

  test("нет чтения индексом по копии окружения", () => {
    const offenders = codeLines(GITHUB_TS).filter(
      (l) => /env\["GITHUB_TOKEN"\]/.test(l) || /env\["GH_TOKEN"\]\s*(?:&&|\|\||\))/.test(l),
    );
    expect(offenders).toEqual([]);
  });

  test("те же две регулярки, что у гейта шаблона, находят оба имени", () => {
    // Дословно из tests/env-example-coverage.test.ts: если сканер там поменяют,
    // а тут нет — расхождение станет видно, а не тихо восстановит слепое пятно.
    const found = new Set<string>();
    for (const m of GITHUB_TS.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) found.add(m[1]!);
    for (const m of GITHUB_TS.matchAll(/process\.env\["([A-Z][A-Z0-9_]*)"\]/g)) found.add(m[1]!);
    expect(found.has("GH_TOKEN")).toBe(true);
    expect(found.has("GITHUB_TOKEN")).toBe(true);
  });
});

describe(".env.example описывает токены, без которых не работает gh и цикл", () => {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    test(`${name} объявлен`, () => {
      expect(declaredLine(name)).toBeDefined();
    });

    test(`${name} объявлен пустым и с пояснением`, () => {
      const line = declaredLine(name)!;
      expect(line.slice(name.length + 1).split("#")[0]!.trim()).toBe("");
      expect(line).toContain("#");
    });
  }

  test("GITHUB_READ_TOKEN не подменён — это отдельная read-only переменная", () => {
    // Разные вещи: READ_TOKEN для GET_GITHUB_STATUS, GH_TOKEN для действий `gh`.
    expect(declaredLine("GITHUB_READ_TOKEN")).toBeDefined();
  });
});

describe("окружение дочернего gh", () => {
  test("не передаёт ему секреты процесса кроме GitHub-токена", () => {
    const names = ["GH_TOKEN", "GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN_TEST", "USERBOT_SESSION_KEY"];
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.GH_TOKEN = "gh-audit-token";
      process.env.GITHUB_TOKEN = "github-test-token";
      process.env.TELEGRAM_BOT_TOKEN_TEST = "telegram-secret";
      process.env.USERBOT_SESSION_KEY = "session-secret";

      const env = buildGhEnv();
      expect(env.GH_TOKEN).toBe("gh-audit-token");
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.TELEGRAM_BOT_TOKEN_TEST).toBeUndefined();
      expect(env.USERBOT_SESSION_KEY).toBeUndefined();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
