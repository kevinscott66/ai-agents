/**
 * Аудит 2026-08-28: фатальный путь писал секреты в journald мимо скраббера.
 *
 * В обработчике `uncaughtException` два стока одного и того же текста. Первый —
 * `log.error("UNCAUGHT", { error: msg, stack })` — чистится (lib/log.ts:212).
 * Второй — синхронный `writeSync(2, …)` перед `process.exit(1)` — не чистился
 * вовсе, а идёт он прямиком в stderr, то есть в journald на VPS и в любой сбор
 * логов оттуда.
 *
 * Текст сюда приходит произвольный. node-fetch (на нём telegraf 4.16) на любой
 * сетевой ошибке даёт `request to https://api.telegram.org/bot<ТОКЕН>/…
 * failed, reason: …` — форма, ради которой в скраббере заведён TELEGRAM_TOKEN.
 * `snapshotOf` из mac-bridge отдаёт `https://x-access-token:ghp_…@github.com/…`.
 * Ни одна не отсеивается `isTelegrafNoise`: стек указывает в node-fetch или в
 * чужую программу, не в telegraf.
 *
 * Инвариант lib/log.ts:13 — «ALWAYS on — secrets must never log» — на этом
 * пути не исполнялся.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { scrubSecretString } from "../lib/log.ts";

const TOKEN = "7123456789:AAHfaKeToKeNfAkEtOkEnFaKeToKeN012345";
const PAT = "ghp_" + "A".repeat(36);

describe("предпосылки: такие строки правда приходят в обработчик", () => {
  test("скраббер обе формы знает — вопрос был только в том, зовут ли его", () => {
    const fetchErr = `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: socket hang up`;
    expect(scrubSecretString(fetchErr)).not.toContain(TOKEN);
    // bot_id остаётся: он не секрет и говорит, чей именно токен светился.
    expect(scrubSecretString(fetchErr)).toContain("7123456789");

    const gitErr = `fatal: unable to access 'https://x-access-token:${PAT}@github.com/o/r.git/'`;
    expect(scrubSecretString(gitErr)).not.toContain(PAT);
  });
});

describe("фатальная строка в stderr", () => {
  test("токен из сообщения не доезжает до fd 2, а процесс всё равно выходит с 1", () => {
    // Подпроцессом, потому что путь заканчивается process.exit(1): внутри
    // прогона его не проверить, а именно выход и делает эту строку последней
    // и потому важной.
    const dir = mkdtempSync(join(tmpdir(), "fatal-stderr-"));
    try {
      const probe = join(dir, "probe.ts");
      const patch = new URL("../lib/telegraf-patch.ts", import.meta.url).pathname;
      writeFileSync(
        probe,
        [
          `import ${JSON.stringify(patch)};`,
          // Стек укажет в probe.ts, то есть isTelegrafNoise это не отсеет —
          // ровно как у настоящей ошибки node-fetch.
          `setTimeout(() => {`,
          `  throw new Error(${JSON.stringify(
            `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: socket hang up`,
          )});`,
          `}, 0);`,
        ].join("\n"),
      );

      const res = Bun.spawnSync({
        cmd: [process.execPath, "run", probe],
        cwd: dir,
        env: {
          ...process.env,
          // Алерт пишется в БД: уводим на временную, живую трогать нельзя.
          MEMORY_DB_PATH: join(dir, "probe.db"),
          UNCAUGHT_EXCEPTION_POLICY: "exit",
        },
      });

      const err = res.stderr.toString();
      const out = res.stdout.toString();
      expect(err).toContain("FATAL uncaughtException");
      expect(err).not.toContain(TOKEN);
      expect(out).not.toContain(TOKEN);
      // Замена именно скрабберная, а не обрезка: bot_id на месте.
      expect(err).toContain("7123456789");
      expect(res.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("применение", () => {
  const SRC = readFileSync(new URL("../lib/telegraf-patch.ts", import.meta.url), "utf8");
  const CODE = SRC.split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  test("в fd 2 уходит только просеянная строка", () => {
    expect(CODE).toContain("scrubSecretString(`FATAL uncaughtException:");
    // Голого шаблона в вызове writeSync больше нет.
    expect(CODE).not.toContain("writeSync(2, `FATAL");
  });

  test("скраббер берётся из log.ts, а не переписан рядом", () => {
    expect(CODE).toContain('import { log, scrubSecretString } from "./log.ts";');
  });
});
