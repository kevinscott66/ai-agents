/**
 * Cold-storage: батчи, fsync и «prune только после проверенного экспорта»
 * (аудит 2026-08-04).
 *
 * Шапка модуля обещала: строки удаляются ТОЛЬКО после того, как файл записан,
 * fsync'нут и число строк на диске сошлось. Код не делал ни одного из трёх:
 * `writeFileSync` доводил данные лишь до страничного кэша, проверкой служил
 * `existsSync`, а сам экспорт читал таблицу одним `SELECT *` без лимита и
 * собирал из неё одну NDJSON-строку, которую целиком отдавал в gzip — три
 * полные копии архива в памяти единственного потока, где живут 12 ботов и
 * HTTP Mini App. И всё это в первый прогон месяца, когда архив максимален.
 *
 * fsync поведенчески не наблюдаем, поэтому здесь проверяется то, что наблюдаемо:
 * многобатчевый экспорт читается как один gzip-поток, число строк сходится,
 * prune не превышает выгруженного, а неудача экспорта не удаляет из БД ничего и
 * не оставляет обрывок файла. Порядок fsync→DELETE закреплён структурно.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, rmSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { statSync, writeSync } from "node:fs";
import { db } from "../lib/db.ts";
import {
  exportColdStorage,
  coldStorageFileName,
  _io,
} from "../lib/cold-storage.ts";

const TMP = `/tmp/cold-dur-${Math.floor(performance.now())}`;
const BASE = 8_100_000;
const NOW = 1_900_000_000_000;
const OLD = NOW - 400 * 86_400_000;

function seedRange(count: number, archivedAt = OLD) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO messages_archive
       (id, chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, archived_at)
     VALUES (?, '-777', NULL, 0, 'u1', 'tester', 'hi', ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) ins.run(BASE + i, archivedAt, archivedAt);
  })();
}

function remaining(): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM messages_archive WHERE id >= ${BASE} AND id < ${BASE + 10_000}`,
    )
    .get() as { n: number };
  return row.n;
}

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* каталога могло не быть */
  }
  db.prepare(
    `DELETE FROM messages_archive WHERE id >= ${BASE} AND id < ${BASE + 10_000}`,
  ).run();
});

describe("cold-storage: батчи и порядок fsync→DELETE", () => {
  test("экспорт больше одного батча читается как один gzip и сходится по строкам", () => {
    // BATCH_ROWS = 2000: 2500 строк — это два батча, то есть два gzip-члена
    // подряд в одном файле. Конкатенация gzip-членов — валидный gzip; если бы
    // батчи склеивались неверно, `gunzipSync`/`zcat` увидели бы только первый.
    const N = 2500;
    seedRange(N);

    const res = exportColdStorage({ now: NOW, coldDays: 365, dir: TMP });
    const msgs = res.find((r) => r.table === "messages_archive")!;
    expect(msgs.file).not.toBeNull();

    const dump = gunzipSync(readFileSync(msgs.file!)).toString("utf8");
    const lines = dump.split("\n").filter((l) => l.length > 0);
    const mine = lines.filter((l) => {
      const id = (JSON.parse(l) as { id: number }).id;
      return id >= BASE && id < BASE + 10_000;
    });
    expect(mine).toHaveLength(N);

    // Первая и последняя строки на месте — хвост второго батча не потерян.
    const ids = new Set(mine.map((l) => (JSON.parse(l) as { id: number }).id));
    expect(ids.has(BASE)).toBe(true);
    expect(ids.has(BASE + N - 1)).toBe(true);

    expect(remaining()).toBe(0);
    expect(msgs.exported).toBeGreaterThanOrEqual(N);
    // Удалено ровно столько, сколько выгружено: prune ограничен последним
    // выгруженным rowid, а не одним лишь предикатом по времени.
    expect(msgs.pruned).toBe(msgs.exported);
  });

  test("строки новее cutoff переживают многобатчевый экспорт", () => {
    seedRange(2100);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO messages_archive
         (id, chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, archived_at)
       VALUES (?, '-777', NULL, 0, 'u1', 'tester', 'hi', ?, ?)`,
    );
    const fresh = BASE + 9_000;
    const recent = NOW - 10 * 86_400_000;
    ins.run(fresh, recent, recent);

    exportColdStorage({ now: NOW, coldDays: 365, dir: TMP });
    expect(remaining()).toBe(1);
    expect(
      !!db.prepare(`SELECT 1 FROM messages_archive WHERE id=${fresh}`).get(),
    ).toBe(true);
  });

  test("неудачная запись файла не удаляет из БД ничего", () => {
    seedRange(50);
    // Занимаем путь будущего экспорта каталогом: openSync(file,"w") упрётся в
    // EISDIR. Это самый честный доступный стенд «файл не записался» — важен не
    // способ отказа, а то, что за ним не следует DELETE.
    const dir = join(TMP, "cold-storage");
    mkdirSync(join(dir, coldStorageFileName("messages_archive", NOW)), {
      recursive: true,
    });

    const res = exportColdStorage({ now: NOW, coldDays: 365, dir: TMP });
    const msgs = res.find((r) => r.table === "messages_archive")!;
    expect(msgs.pruned).toBe(0);
    expect(msgs.file).toBeNull();
    // Данных без второй копии не теряем.
    expect(remaining()).toBe(50);
  });

  test("пустая выборка не создаёт файлов", () => {
    // Нечего выгружать → каталога с обрывками быть не должно.
    //
    // Пустоту задаём порогом, а не надеждой на пустую таблицу: `coldDays: 365`
    // при NOW=2030 забирает вообще всё, что соседние файлы оставили в
    // messages_archive со своими (настоящими, 2026-го года) метками — и тогда
    // выборка не пуста, файл создаётся, и тест падает на предпосылке, а не на
    // проверяемом свойстве. Порог в 100k дней уводит cutoff в XVIII век. T-751.
    const res = exportColdStorage({ now: NOW, coldDays: 100_000, dir: TMP });
    for (const r of res) expect(r.file).toBeNull();
    const dir = join(TMP, "cold-storage");
    if (existsSync(dir)) expect(readdirSync(dir)).toHaveLength(0);
  });

  test("fsync стоит ДО DELETE, а не после", () => {
    // Структурная привязка: перестановка этих двух шагов поведенчески не
    // наблюдаема (данные всё равно окажутся на диске — вопрос лишь в том, что
    // будет при пропаже питания между ними), но это ровно тот баг, который
    // теряет строки навсегда.
    const src = readFileSync(
      new URL("../lib/cold-storage.ts", import.meta.url),
      "utf8",
    );
    const fsyncAt = src.indexOf("fsyncSync(fd)");
    const deleteAt = src.indexOf("DELETE FROM ${table}");
    expect(fsyncAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(fsyncAt);
    // И сам prune ограничен выгруженным rowid.
    expect(src.slice(deleteAt, deleteAt + 200)).toMatch(/rowid <= \?/);
  });

  test("частичная запись батча не даёт удалить строки из БД", () => {
    // write(2) на заполнившемся разделе не бросает: пишет сколько влезло и
    // возвращает короткий счётчик. До фикса файл при этом обрывался посреди
    // gzip-члена, сверка шла по буферу в памяти и сходилась, «размер не ноль»
    // тоже проходил — и строки удалялись. zcat такой файл не дочитывает.
    seedRange(50);
    const orig = _io.write;
    let shortened = false;
    _io.write = (fd, data) => {
      // Первый батч режем пополам — так же, как это сделал бы кончившийся диск.
      const half = Math.max(1, Math.floor(data.byteLength / 2));
      shortened = true;
      return writeSync(fd, data.subarray(0, half));
    };
    let res;
    try {
      res = exportColdStorage({ now: NOW, coldDays: 365, dir: TMP });
    } finally {
      _io.write = orig;
    }

    expect(shortened).toBe(true);
    const msgs = res.find((r) => r.table === "messages_archive")!;
    expect(msgs.pruned).toBe(0);
    expect(msgs.file).toBeNull();
    expect(remaining()).toBe(50);
    // Обрывок не остаётся рядом с валидными экспортами.
    expect(
      existsSync(
        join(TMP, "cold-storage", coldStorageFileName("messages_archive", NOW)),
      ),
    ).toBe(false);
  });

  test("на успешном экспорте размер файла сходится с записанным", () => {
    // Обратная сторона той же проверки: она не должна ложно срабатывать на
    // многобатчевом экспорте, где файл — конкатенация gzip-членов.
    seedRange(2500);
    const res = exportColdStorage({ now: NOW, coldDays: 365, dir: TMP });
    const msgs = res.find((r) => r.table === "messages_archive")!;
    expect(msgs.file).not.toBeNull();
    expect(msgs.pruned).toBe(msgs.exported);
    // Файл читается целиком — значит, ни один член не обрезан.
    const dump = gunzipSync(readFileSync(msgs.file!)).toString("utf8");
    expect(dump.split("\n").filter((l) => l.length > 0).length).toBe(
      msgs.exported,
    );
    expect(statSync(msgs.file!).size).toBeGreaterThan(0);
  });

  test("экспорт не читает таблицу без LIMIT", () => {
    // Мутационная проверка предыдущего свойства: без LIMIT весь архив снова
    // окажется в памяти одним куском.
    const src = readFileSync(
      new URL("../lib/cold-storage.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/LIMIT \$\{BATCH_ROWS\}/);
    expect(src).not.toMatch(/SELECT \* FROM \$\{table\} WHERE archived_at < \?`/);
  });
});
