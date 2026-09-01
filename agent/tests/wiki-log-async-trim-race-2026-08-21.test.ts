/**
 * Аудит 2026-08-21: асинхронное чтение хвоста лога нарушало ровно тот
 * инвариант, ради которого подрезка сделана через `rename`.
 *
 * Шапка `trimWikiLog` обещает: «`rename` в пределах каталога атомарен —
 * читатель видит либо старый файл целиком, либо новый целиком». Синхронный
 * `readTail` это обещание держит: `statSync` → `openSync` → `readSync` идут
 * одним куском, между ними ничего не выполняется.
 *
 * Асинхронный близнец брал размер у ПУТИ, а читал из ОТКРЫТОГО ПОТОМ файла:
 *
 *   const size = (await stat(p)).size;   // старый инод, ~1 MB
 *   const fh = await open(p, "r");       // ← сюда успевает лечь rename
 *   await fh.read(buf, 0, maxBytes, size - maxBytes);
 *
 * Если подрезка легла между этими двумя `await`, смещение `size - maxBytes`
 * считано по мегабайтному файлу, а читаем мы новый, 64-килобайтный: смещение
 * за EOF, `bytesRead === 0`, наружу уходит пустая строка. Читатель увидел не
 * «старый целиком» и не «новый целиком», а НИЧЕГО.
 *
 * Цена: `wikiLogAsync` зовёт `message-handler` на каждое входящее сообщение
 * всех 12 ролей, и блок «ЛОГ КОМАНДЫ» в промпте на этот ход пустеет —
 * агент теряет общий контекст команды. Самолечится к следующему сообщению,
 * поэтому в логах выглядит как «показалось».
 *
 * Инвариант теста: чем бы ни кончилась гонка с подрезкой, чтение возвращает
 * непустой валидный хвост. После фикса (открыть → `fh.stat()` → читать из
 * того же дескриптора) окна нет вовсе: `rename` не трогает уже открытый инод.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { trimWikiLog, WIKI_LOG_MAX_BYTES, WIKI_LOG_TAIL_BYTES } from "../lib/memory.ts";
import { wikiLogAsync } from "../lib/memory-async.ts";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const SCOPE = "logasyncrace";
const DIR = join(MEMORY_DIR, SCOPE);
const LOG = join(DIR, "log.md");

/** Лог заведомо за порогом подрезки. */
function overflow(): void {
  mkdirSync(DIR, { recursive: true });
  const line = `2026-08-21 12:00 | smm | запись-МЕТКА ${"ц".repeat(80)}\n`;
  writeFileSync(LOG, line.repeat(Math.ceil((WIKI_LOG_MAX_BYTES * 1.2) / line.length)));
  expect(statSync(LOG).size).toBeGreaterThan(WIKI_LOG_MAX_BYTES);
}

const tick = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe("wikiLogAsync против подрезки лога", () => {
  // Подрезка сдвигается по шкале «сколько тиков цикла событий прошло с начала
  // чтения»: одно фиксированное значение попадало бы в окно случайно, а на
  // перебор глубин окно шириной в один await ловится всегда. После фикса окна
  // нет ни на одной глубине.
  test("хвост не пустеет, на какой бы стадии чтения ни легла подрезка", async () => {
    const empties: number[] = [];
    for (let depth = 0; depth <= 8; depth++) {
      overflow();
      const reading = wikiLogAsync(SCOPE);
      for (let i = 0; i < depth; i++) await tick();
      trimWikiLog(LOG);
      const got = await reading;
      if (got.length === 0) empties.push(depth);
      else expect(got).toContain("запись-МЕТКА");
      rmSync(DIR, { recursive: true, force: true });
    }
    expect(empties).toEqual([]);
  });

  test("без гонки хвост читается как обычно", async () => {
    overflow();
    const got = await wikiLogAsync(SCOPE);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(WIKI_LOG_TAIL_BYTES);
    expect(got).toContain("запись-МЕТКА");
    // Обрезка по границе строки сохранена: первая строка не огрызок.
    expect(got.startsWith("2026-08-21 12:00 |")).toBe(true);
  });

  test("файла нет — пустая строка, а не бросок", async () => {
    expect(await wikiLogAsync(SCOPE)).toBe("");
  });

  test("файл меньше порога хвоста читается целиком", async () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(LOG, "2026-08-21 12:00 | smm | короткий лог\n");
    expect(await wikiLogAsync(SCOPE)).toBe("2026-08-21 12:00 | smm | короткий лог\n");
  });
});
