/**
 * Аудит 2026-08-28: два признака тестового прогона снимались одной командой.
 *
 * `isTestRun()` держался на preload'е (`agent/bunfig.toml` → `tests/_setup.ts`)
 * и на `NODE_ENV === "test"`. Каждый по отдельности снять нельзя — а вместе
 * можно, и обе половины описаны в репозитории как обычная практика:
 *
 *   1. прогон из корня репо не подхватывает `agent/bunfig.toml`, то есть
 *      preload'а нет (CLAUDE.md §3.8.1 разбирает это как частую ошибку);
 *   2. `set -a; . /opt/agent-team/.env; set +a` — обычный ops-приём «взять
 *      боевое окружение» — экспортирует `NODE_ENV=production` вместе с
 *      `SITE_INGEST_URL`/`SITE_INGEST_TOKEN`.
 *
 * На их пересечении `ingestBlockedByTestRun()` возвращал false, и мост на живой
 * delabs.space открывался с боевым токеном прямо под `bun test` — ровно T-743,
 * ради которого этот файл и написан.
 *
 * Третий признак — `Bun.main`: под тест-раннером это путь текущего тестового
 * файла, и переменной окружения его не подделать.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _looksLikeTestFile, isTestRun } from "../lib/test-run-marker.ts";

const MARKER = fileURLToPath(new URL("../lib/test-run-marker.ts", import.meta.url));

describe("предпосылки", () => {
  test("Bun.main под раннером — путь текущего тестового файла", () => {
    // Не «какого-то», а именно этого: в прогоне каталога значение меняется от
    // файла к файлу, поэтому признак работает и в полном прогоне.
    expect(Bun.main).toBe(fileURLToPath(import.meta.url));
  });

  test("враждебное сочетание снимает оба прежних признака", () => {
    // Проверяем это в отдельном процессе, потому что снять preload внутри
    // текущего прогона нельзя. Каталог временный — bunfig.toml там не найдётся.
    const dir = mkdtempSync(join(tmpdir(), "trm-rootprod-"));
    try {
      const probe = join(dir, "probe.test.ts");
      writeFileSync(
        probe,
        [
          `import { test } from "bun:test";`,
          `import { isTestRun } from ${JSON.stringify(MARKER)};`,
          `test("p", () => {`,
          `  console.log("NODE_ENV=" + process.env.NODE_ENV);`,
          `  console.log("IS_TEST_RUN=" + isTestRun());`,
          `});`,
        ].join("\n"),
      );
      const res = Bun.spawnSync({
        cmd: [process.execPath, "test", probe],
        cwd: dir,
        env: { ...process.env, NODE_ENV: "production" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = res.stdout.toString() + res.stderr.toString();

      // Первый признак снят: preload не выполнялся — иначе бы NODE_ENV не
      // остался production'ом только благодаря экспорту.
      expect(out).toContain("NODE_ENV=production");
      // Второй снят по определению. А гейт всё равно стоит — это и есть правка.
      expect(out).toContain("IS_TEST_RUN=true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("_looksLikeTestFile", () => {
  test("весь дефолтный набор bun'а считается тестовым", () => {
    for (const p of [
      "/x/a.test.ts",
      "/x/a.test.tsx",
      "/x/a.test.js",
      "/x/a.test.jsx",
      "/x/a.test.mjs",
      "/x/a.test.cjs",
      "/x/a_test.ts",
      "/x/a.spec.ts",
      "/x/a_spec.tsx",
    ]) {
      expect(_looksLikeTestFile(p)).toBe(true);
    }
  });

  test("боевые точки входа тестовыми не считаются", () => {
    for (const p of [
      "/opt/agent-team/agent/orchestrator-main.ts",
      "/opt/agent-team/agent/lib/site-ingest.ts",
      "/x/testing.ts",
      "/x/latest.ts",
      "/x/protest.ts",
      "/x/tests/helpers.ts",
      "/x/a.test.ts.bak",
      "/x/a.test",
    ]) {
      expect(_looksLikeTestFile(p)).toBe(false);
    }
  });

  test("нестроковое значение не роняет признак", () => {
    for (const v of [undefined, null, 0, {}, []]) {
      expect(_looksLikeTestFile(v)).toBe(false);
    }
  });
});

describe("применение", () => {
  test("третий признак действительно в isTestRun, а не рядом", () => {
    const src = Bun.file(MARKER);
    void src;
    // Значение читается живьём — то же, что вычисляет сама функция.
    expect(_looksLikeTestFile(Bun.main)).toBe(true);
    expect(isTestRun()).toBe(true);
  });

  test("прежние два признака не выброшены", async () => {
    const src = await Bun.file(MARKER).text();
    const CODE = src
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(CODE).toContain("_isTestRun || process.env.NODE_ENV === \"test\" || mainIsTestFile()");
  });
});
