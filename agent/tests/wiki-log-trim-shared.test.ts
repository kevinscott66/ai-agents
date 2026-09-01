/**
 * Аудит 2026-08-12: подрезка лога была написана дважды, и копии разъехались.
 *
 * `_team/log.md` подрезается по достижении мегабайта — до хвоста в 64 KB. Одна
 * реализация в memory.ts (`trimWikiLog`), вторая — прямо в теле асинхронного
 * близнеца:
 *
 *   await appendFile(p, …);
 *   try {
 *     if ((await stat(p)).size > WIKI_LOG_MAX_BYTES) {
 *       await writeFile(p, await readTailAsync(p, WIKI_LOG_TAIL_BYTES));
 *     }
 *   } catch { }
 *
 * Три `await` между «сколько весит», «что в хвосте» и «записать»: всё, что
 * успело дописаться в этот промежуток, затирается копией, прочитанной до него.
 * И `catch {}` без единой строки там, где синхронная половина предупреждает в
 * лог: подрезка, переставшая работать, не сказала бы об этом никак.
 *
 * Шапка самого memory-async.ts объясняет, почему так нельзя: «Разъезд этой
 * пары уже стоил двух багов (upsertWikiFts, pagePath), поэтому дублируется
 * только вызов fs, но не решение о том, сколько читать». Решение о том, КАК
 * подрезать, дублировалось.
 *
 * Плюс сама запись: `writeFileSync` сначала обрезает файл в ноль, и падение
 * процесса в этот момент оставляет от общего лога команды пустышку. Пишем во
 * временный файл и переименовываем — `rename` в пределах каталога атомарен.
 *
 * Инвариант: подрезка одна на обе половины; после неё файл — либо старый
 * целиком, либо новый целиком, и мусора рядом не остаётся.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync, rmSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { wikiAppendLog, WIKI_LOG_MAX_BYTES, WIKI_LOG_TAIL_BYTES } from "../lib/memory.ts";
import { wikiAppendLogAsync } from "../lib/memory-async.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const SCOPE = "logtrimshared";
const DIR = join(MEMORY_DIR, SCOPE);
const LOG = join(DIR, "log.md");

/** Лог заведомо за порогом: подрезка сработает на первой же дописке. */
function overflow(): void {
  mkdirSync(DIR, { recursive: true });
  const line = `2026-08-12 12:00 | smm | старая запись ${"ц".repeat(80)}\n`;
  writeFileSync(LOG, line.repeat(Math.ceil((WIKI_LOG_MAX_BYTES * 1.2) / line.length)));
  expect(statSync(LOG).size).toBeGreaterThan(WIKI_LOG_MAX_BYTES);
}

beforeEach(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe("подрезка лога — одна на обе половины", () => {
  test("синхронная и асинхронная дописки оставляют один и тот же файл", async () => {
    overflow();
    wikiAppendLog(SCOPE, "новая строка", "smm");
    const sync = readFileSync(LOG, "utf8");

    rmSync(DIR, { recursive: true, force: true });
    overflow();
    await wikiAppendLogAsync(SCOPE, "новая строка", "smm");
    const async = readFileSync(LOG, "utf8");

    // Обе половины пишут метку времени с точностью до минуты — сравниваем всё,
    // кроме неё, иначе тест падал бы раз в минуту на границе.
    const strip = (s: string) => s.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d /gm, "");
    expect(strip(async)).toBe(strip(sync));
    expect(async.length).toBe(sync.length);
  });

  test("после подрезки остаётся хвост, а не весь файл", async () => {
    overflow();
    await wikiAppendLogAsync(SCOPE, "последняя строка", "smm");
    const body = readFileSync(LOG, "utf8");
    expect(statSync(LOG).size).toBeLessThanOrEqual(WIKI_LOG_TAIL_BYTES + 1024);
    expect(body).toContain("последняя строка");
    expect(body.startsWith("2026-08-12")).toBe(true);
  });

  test("временного файла рядом не остаётся", async () => {
    overflow();
    await wikiAppendLogAsync(SCOPE, "строка", "smm");
    expect(readdirSync(DIR).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(`${LOG}.tmp`)).toBe(false);
  });

  test("файл под порогом не переписывается вовсе", async () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(LOG, "короткий лог");
    await wikiAppendLogAsync(SCOPE, "ещё строка", "smm");
    const body = readFileSync(LOG, "utf8");
    expect(body.startsWith("короткий лог")).toBe(true);
    expect(body).toContain("ещё строка");
  });

  test("в асинхронной половине нет своей подрезки", () => {
    // Отпечаток прежней копии: writeFile хвостом внутри memory-async.ts.
    const src = readFileSync(new URL("../lib/memory-async.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/writeFile\(\s*p,\s*await readTailAsync/);
    expect(src).not.toContain("WIKI_LOG_MAX_BYTES");
    expect(src).toContain("trimWikiLog(p)");
  });
});
