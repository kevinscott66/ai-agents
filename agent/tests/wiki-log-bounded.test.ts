/**
 * Аудит 2026-08-10: общий лог команды читается целиком на каждое сообщение и
 * не подрезается никогда.
 *
 * `_team/log.md` пополняет компактор — по строке на каждую сводку. Читают его
 * двое, и оба на горячем пути: handoff.ts:260 (синхронный readFileSync, то
 * есть с блокировкой event loop) и orchestrator/message-handler.ts:266. Обоим
 * нужны последние 30 строк — и оба ради этого читают файл целиком.
 *
 * Файл не ротируется и не обрезается ничем: ни по размеру, ни по возрасту, ни
 * по числу строк. Строка ≈ 270 байт, компактор пишет её на каждую сводку —
 * файл растёт линейно и навсегда. Через год работы это десятки мегабайт,
 * которые читаются с диска и разбиваются на строки при КАЖДОМ сообщении в
 * любом чате, чтобы взять из них 30 последних.
 *
 * Инвариант: стоимость чтения лога не зависит от того, сколько команда уже
 * проработала, а сам файл не растёт неограниченно.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  wikiLog,
  wikiAppendLog,
  WIKI_LOG_TAIL_BYTES,
  WIKI_LOG_MAX_BYTES,
} from "../lib/memory.ts";
import { wikiLogAsync } from "../lib/memory-async.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const SCOPE = "logbounded";
const SCOPE_DIR = join(MEMORY_DIR, SCOPE);
const LOG = join(SCOPE_DIR, "log.md");

/** Лог из n строк; каждая помечена номером, чтобы хвост был узнаваем. */
function writeLog(n: number): string[] {
  mkdirSync(SCOPE_DIR, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(`2026-08-10 12:00 | smm | запись номер ${i} ${"ц".repeat(80)}`);
  }
  writeFileSync(LOG, lines.join("\n"));
  return lines;
}

beforeEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(SCOPE_DIR, { recursive: true, force: true });
});

describe("чтение лога не зависит от его размера", () => {
  test("из большого файла читается только хвост", () => {
    const lines = writeLog(40_000);
    expect(statSync(LOG).size).toBeGreaterThan(WIKI_LOG_TAIL_BYTES * 4);

    const got = wikiLog(SCOPE);

    // До фикса тут был весь файл целиком — на каждое сообщение.
    expect(Buffer.byteLength(got, "utf8")).toBeLessThanOrEqual(WIKI_LOG_TAIL_BYTES);
    // Но именно те строки, ради которых читают: последние.
    expect(got.split("\n").slice(-30)).toEqual(lines.slice(-30));
  });

  test("граница чтения не оставляет обрубка строки", () => {
    writeLog(40_000);
    const got = wikiLog(SCOPE);
    // Первая строка отдаётся целиком или не отдаётся вовсе: смещение попадает
    // в середину строки почти всегда, а внутри строки — ещё и в середину
    // многобайтного символа.
    expect(got.split("\n")[0]).toMatch(/^2026-08-10 12:00 \| smm \| запись номер \d+/);
    expect(got).not.toContain("�");
  });

  test("маленький файл возвращается целиком", () => {
    const lines = writeLog(5);
    expect(wikiLog(SCOPE)).toBe(lines.join("\n"));
  });

  test("отсутствующий лог — по-прежнему пустая строка", () => {
    expect(wikiLog(SCOPE)).toBe("");
  });

  test("асинхронный читатель ведёт себя так же", async () => {
    const lines = writeLog(40_000);
    const got = await wikiLogAsync(SCOPE);
    expect(Buffer.byteLength(got, "utf8")).toBeLessThanOrEqual(WIKI_LOG_TAIL_BYTES);
    expect(got.split("\n").slice(-30)).toEqual(lines.slice(-30));
    expect(got).not.toContain("�");
  });
});

describe("лог не растёт неограниченно", () => {
  test("дописывание подрезает переросший файл", () => {
    writeLog(40_000);
    expect(statSync(LOG).size).toBeGreaterThan(WIKI_LOG_MAX_BYTES);

    wikiAppendLog(SCOPE, "свежая запись", "smm");

    // До фикса файл только рос — ничто его не подрезало.
    expect(statSync(LOG).size).toBeLessThanOrEqual(WIKI_LOG_MAX_BYTES);
    // Подрезка идёт с головы: свежая запись обязана остаться.
    expect(readFileSync(LOG, "utf8")).toContain("свежая запись");
    // И история непосредственно перед ней тоже — иначе это не подрезка, а
    // обнуление.
    expect(wikiLog(SCOPE).split("\n").length).toBeGreaterThan(30);
  });

  test("файл в пределах лимита не трогается", () => {
    writeLog(10);
    const before = readFileSync(LOG, "utf8");
    wikiAppendLog(SCOPE, "ещё одна", "smm");
    const after = readFileSync(LOG, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("ещё одна");
  });
});
