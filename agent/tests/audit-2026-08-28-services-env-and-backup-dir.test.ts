/**
 * Аудит 2026-08-28: две дыры на пути «переменная окружения → фоновая служба».
 *
 * 1. `_envPositiveInt` (orchestrator/services.ts) чинил NaN, но не имел
 *    верхней границы. Лишняя цифра в `WATCHDOG_INTERVAL_MS` даёт целое
 *    положительное число, которое setInterval не может уложить в 32-битный
 *    знаковый int и схлопывает в **1 мс** — ровно тот исход, ради которого
 *    санитайзер и писался.
 *
 * 2. `BACKUP_DIR` читался через `??`, поэтому пустое значение доезжало до
 *    `ensureDir("")` внутри runBackup. Тот бросал ENOENT ДО try, вопреки
 *    docstring «Never throws», и бросок ловил catch планировщика, умеющий
 *    только log.warn. Ни одного emitAlert — при том что бэкапов не было
 *    вообще.
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { _envPositiveInt } from "../orchestrator/services.ts";
import { runBackup } from "../lib/backup.ts";
import { MAX_TIMER_MS } from "../lib/constants.ts";

const VAR = "TEST_ENV_OVERFLOW_PROBE";
const prev = process.env[VAR];

afterEach(() => {
  // Без восстановления env течёт в соседние тесты (CLAUDE.md §3.8 п.7).
  if (prev === undefined) delete process.env[VAR];
  else process.env[VAR] = prev;
});

const SERVICES_SRC = readFileSync(
  new URL("../orchestrator/services.ts", import.meta.url),
  "utf-8",
);
const BACKUP_SRC = readFileSync(new URL("../lib/backup.ts", import.meta.url), "utf-8");

describe("предпосылки", () => {
  test("setInterval схлопывает задержку больше 2^31-1 в 1 мс", async () => {
    // Именно из-за этого «раз в год» превращается в «257 раз за 300 мс».
    let ticks = 0;
    const t = setInterval(() => ticks++, 3_000_000_000);
    await new Promise((r) => setTimeout(r, 150));
    clearInterval(t);
    expect(ticks).toBeGreaterThan(20);
  });

  test("fs.mkdirSync('') бросает, а не создаёт cwd", () => {
    expect(() => fs.mkdirSync("", { recursive: true })).toThrow();
  });
});

describe("_envPositiveInt: верхняя граница", () => {
  test("значение больше 2^31-1 — дефолт, а не 1 мс", () => {
    // Лишняя цифра: «раз в 100 секунд» → «раз в 27 часов» на вид,
    // 1 мс на деле.
    for (const bad of ["2147483648", "99999999999", "9007199254740991"]) {
      process.env[VAR] = bad;
      expect(_envPositiveInt(VAR, 30_000)).toBe(30_000);
    }
  });

  test("без дефолта переполнение даёт undefined, а не число", () => {
    // WATCHDOG_INTERVAL_MS и HEALTH_INTERVAL_MS зовутся без fallback —
    // undefined там означает «дефолт самого шедулера».
    process.env[VAR] = "99999999999";
    expect(_envPositiveInt(VAR)).toBeUndefined();
  });

  test("ровно 2^31-1 всё ещё принимается", () => {
    // Граница включительная: это последнее значение, которое таймер
    // отрабатывает честно.
    process.env[VAR] = "2147483647";
    expect(_envPositiveInt(VAR, 30_000)).toBe(2_147_483_647);
  });

  test("обычные значения не задеты", () => {
    for (const [raw, want] of [
      ["45000", 45_000],
      ["1", 1],
      ["3600000", 3_600_000],
    ] as const) {
      process.env[VAR] = raw;
      expect(_envPositiveInt(VAR, 30_000)).toBe(want);
    }
  });

  test("потолок объявлен константой и применён в проверке", () => {
    // Само значение переехало в lib/constants.ts — одно определение на
    // проект (аудит 2026-08-28: ту же границу не хватало alerting.ts).
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
    expect(SERVICES_SRC).toContain("n > MAX_TIMER_MS");
  });
});

describe("BACKUP_DIR", () => {
  test("пустое значение больше не проходит через `??`", () => {
    expect(SERVICES_SRC).toContain('process.env.BACKUP_DIR?.trim() || "./backups"');
    expect(SERVICES_SRC).not.toContain('process.env.BACKUP_DIR ?? "./backups"');
  });
});

describe("runBackup: сломанный каталог бэкапов не проходит молча", () => {
  test("пустой backupDir не бросает и попадает в errors", async () => {
    // errors.length — это ровно то, на чём планировщик поднимает
    // `backup_failed`; бросок наружу давал один log.warn и ничего больше.
    const res = await runBackup(os.tmpdir(), "");
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.dbPath).toBeNull();
    expect(res.wikiPath).toBeNull();
  });

  test("backupDir внутри файла (ENOTDIR) — тоже errors, а не бросок", async () => {
    const work = fs.mkdtempSync(join(os.tmpdir(), "backup-dir-probe-"));
    try {
      const file = join(work, "not-a-dir");
      fs.writeFileSync(file, "x");
      const res = await runBackup(work, join(file, "sub"));
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors.join(" ")).toContain("cannot create the backup dir");
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test("исправный каталог по-прежнему отрабатывает без ошибок каталога", async () => {
    // Страж от ложной тревоги: правка не должна ломать нормальный путь.
    const work = fs.mkdtempSync(join(os.tmpdir(), "backup-dir-ok-"));
    // Вики берём свою: без этого runBackup потащит боевой каталог памяти,
    // разрешённый от cwd.
    const prevWiki = process.env.MEMORY_DIR;
    process.env.MEMORY_DIR = join(work, "wiki");
    fs.mkdirSync(join(work, "wiki"), { recursive: true });
    fs.writeFileSync(join(work, "wiki", "note.md"), "# note\n");
    try {
      const res = await runBackup(join(work, "data"), join(work, "backups"));
      expect(res.errors.join(" ")).not.toContain("cannot create the backup dir");
      expect(fs.existsSync(join(work, "backups"))).toBe(true);
    } finally {
      if (prevWiki === undefined) delete process.env.MEMORY_DIR;
      else process.env.MEMORY_DIR = prevWiki;
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test("ensureDir в runBackup обёрнут, docstring «Never throws» больше не врёт", () => {
    const at = BACKUP_SRC.indexOf("export async function runBackup(");
    expect(at).toBeGreaterThan(0);
    const head = BACKUP_SRC.slice(at, at + 1400);
    expect(head).toContain("try {\n    ensureDir(backupDir);\n  } catch (e) {");
    expect(head).not.toContain("): Promise<BackupResult> {\n  ensureDir(backupDir);");
  });
});
