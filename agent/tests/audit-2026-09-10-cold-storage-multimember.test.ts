/**
 * Аудит 2026-09-10: файл холодного хранилища читается обратно НЕ тем, чем
 * пишется.
 *
 * `exportColdStorage` жмёт по батчу (`BATCH_ROWS = 2000`) и дописывает
 * результат в тот же дескриптор — файл получается конкатенацией gzip-членов.
 * Это осознанно и документировано в шапке модуля: батчи заведены, чтобы не
 * держать три копии архива в памяти единственного потока, а конкатенация
 * gzip-членов — валидный gzip по RFC 1952.
 *
 * Валидный, но не для всех читателей. `Bun.gunzipSync` — парная функция к
 * `Bun.gzipSync`, которой файл здесь и пишется, — на многочленном входе
 * возвращает ТОЛЬКО ПЕРВЫЙ член. Без ошибки, без флага, без короткого чтения.
 * `node:zlib` в том же рантайме читает все.
 *
 * Цена — ровно та, о которой предупреждает шапка: `.ndjson.gz` после prune
 * единственная копия строк, «обратной дороги в БД в репозитории нет вовсе».
 * Восстановление, написанное очевидным для этого репозитория способом (тем же
 * Bun, что и всё остальное), молча вернуло бы первые 2000 строк из скольких
 * угодно — и выглядело бы успешным.
 *
 * Поэтому читатель (`readColdStorageExport`) живёт рядом с писателем и берёт
 * `node:zlib` намеренно. Тест закрепляет ОБЕ половины: что читатель забирает
 * файл целиком и что наивная замена его на `Bun.gunzipSync` теряет данные, —
 * чтобы «упростить» его обратно было нельзя незаметно.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readColdStorageExport } from "../lib/cold-storage.ts";

/** Собрать файл ровно так, как его собирает exportColdStorage: член на батч. */
function writeMultiMemberFile(batches: string[][]): string {
  const dir = mkdtempSync(join(tmpdir(), "cold-multimember-"));
  const file = join(dir, "messages_archive-2026-09-10T00-00-00.ndjson.gz");
  const parts = batches.map((rows) =>
    Buffer.from(Bun.gzipSync(Buffer.from(rows.join("\n") + "\n", "utf8"))),
  );
  writeFileSync(file, Buffer.concat(parts));
  return file;
}

describe("холодное хранилище: многочленный gzip", () => {
  test("readColdStorageExport возвращает строки ВСЕХ батчей", () => {
    const file = writeMultiMemberFile([
      [`{"id":1}`, `{"id":2}`],
      [`{"id":3}`],
      [`{"id":4}`, `{"id":5}`],
    ]);
    const lines = readColdStorageExport(file);
    expect(lines).toEqual([
      `{"id":1}`,
      `{"id":2}`,
      `{"id":3}`,
      `{"id":4}`,
      `{"id":5}`,
    ]);
    // Каждая строка — самостоятельный NDJSON-объект, а не склейка.
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([1, 2, 3, 4, 5]);
  });

  test("однобатчевый файл (обычный случай) читается так же", () => {
    const file = writeMultiMemberFile([[`{"id":1}`, `{"id":2}`]]);
    expect(readColdStorageExport(file)).toEqual([`{"id":1}`, `{"id":2}`]);
  });

  test("Bun.gunzipSync на том же файле теряет всё, кроме первого батча", () => {
    // Это и есть закрепляемая ловушка: не ошибка и не короткое чтение, а
    // тихая недостача. Пока этот тест зелёный, «упрощение» читателя до
    // парной Bun-функции остаётся видимой потерей данных, а не рефакторингом.
    const file = writeMultiMemberFile([[`{"id":1}`], [`{"id":2}`]]);
    const raw = readFileSync(file);

    const naive = Buffer.from(Bun.gunzipSync(raw)).toString("utf8");
    expect(naive).toBe(`{"id":1}\n`);
    expect(naive).not.toContain(`{"id":2}`);

    // Тот же байт-в-байт вход через node:zlib — обе строки.
    expect(readColdStorageExport(file)).toEqual([`{"id":1}`, `{"id":2}`]);
  });
});
