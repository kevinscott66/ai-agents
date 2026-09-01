/**
 * Аудит 2026-08-20: учебный restore бэкапа рапортует ✅ на битой БД.
 *
 * Смысл инструмента записан в эпизоде 2026-06-06 одной строкой: «Untested
 * backup = no backup». Проверка целостности устроена так:
 *
 *   const result = db.query(`SELECT COUNT(*) FROM "${t}"`).get();
 *   counts[t] = result.count;            // а при ошибке — counts[t] = -1
 *   …
 *   else if (originalCount !== restoredCount && originalCount >= 0 && restoredCount >= 0)
 *     result.errors.push(`row count mismatch`);
 *
 * Сравнение идёт между файлом бэкапа и его же копией, сделанной `copyFileSync`
 * строкой выше, — она совпадает всегда. А единственный случай, когда числа
 * РЕАЛЬНО расходятся с истиной, помечается сентинелом `-1`, и охранник
 * `>= 0` его из проверки исключает. Итог: `errors` пуст, `success: true`,
 * `process.exit(0)` — таймер видит зелёный, бэкапа нет.
 *
 * Битая страница данных — не выдуманный сценарий: заголовок и `sqlite_master`
 * лежат в начале файла, поэтому оборванная или частично записанная копия
 * открывается, отдаёт список таблиц и падает только на чтении страниц.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreFromBackup } from "../tools/restore-from-backup.ts";

let workDir: string;
let goodDir: string;
let badDir: string;
let overflowDir: string;

/** Снимок с крупной таблицей `bulk` (много страниц) и крошечной `small`. */
function writeSnapshot(path: string): void {
  const db = new Database(path);
  db.run(`CREATE TABLE bulk (id INTEGER PRIMARY KEY, v TEXT)`);
  const ins = db.prepare(`INSERT INTO bulk (v) VALUES (?)`);
  db.run("BEGIN"); // без транзакции 3000 вставок — это 3000 fsync и таймаут хука
  for (let i = 0; i < 3000; i++) ins.run("x".repeat(200));
  db.run("COMMIT");
  db.run(`CREATE TABLE small (id INTEGER PRIMARY KEY, v TEXT)`);
  db.run(`INSERT INTO small (v) VALUES ('ok')`);
  db.close();
}

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "audit-restore-"));
  goodDir = join(workDir, "good");
  badDir = join(workDir, "bad");
  fs.mkdirSync(goodDir, { recursive: true });
  fs.mkdirSync(badDir, { recursive: true });

  writeSnapshot(join(goodDir, "db-2026-08-20.sqlite"));
  // ПОПРАВКА 2026-08-28: «целый» бэкап теперь обязан быть целым и по составу.
  // Раньше здесь лежал только снапшот БД, и дрилл считал такой каталог
  // успехом — при том что сам бэкап на пропавшую половину поднимает
  // `backup_partial`. Тесты ниже про ЛОЖНУЮ тревогу, поэтому фикстура должна
  // быть полной; проверку самой половинчатости держит
  // audit-2026-08-28-restore-drill-green-on-nothing.
  {
    const wikiSrc = join(workDir, "wiki-src");
    fs.mkdirSync(join(wikiSrc, "memory"), { recursive: true });
    fs.writeFileSync(join(wikiSrc, "memory", "note.md"), "# note\n");
    const res = Bun.spawnSync([
      "tar", "-czf", join(goodDir, "memory-2026-08-20.tgz"), "-C", wikiSrc, "memory",
    ]);
    if (res.exitCode !== 0) throw new Error("tar create failed");
  }

  overflowDir = join(workDir, "overflow");
  fs.mkdirSync(overflowDir, { recursive: true });
  const ovPath = join(overflowDir, "db-2026-08-20.sqlite");
  {
    // Три записи по 50 КБ: каждая не влезает в страницу и уходит в цепочку
    // overflow-страниц. Рвём цепочку в середине — счётчик строк этого НЕ видит
    // (COUNT(*) обходит b-tree и считает ячейки, содержимое не читая), а сама
    // запись уже не восстановима.
    const db = new Database(ovPath);
    db.run(`CREATE TABLE docs (id INTEGER PRIMARY KEY, blob TEXT)`);
    const ins = db.prepare(`INSERT INTO docs (blob) VALUES (?)`);
    db.run("BEGIN");
    for (let i = 0; i < 3; i++) ins.run("y".repeat(50000));
    db.run("COMMIT");
    db.close();
    const ov = fs.readFileSync(ovPath);
    const ps = ov.readUInt16BE(16) || 65536;
    expect(ov.length).toBeGreaterThan(ps * 21);
    ov.fill(0, ps * 20, ps * 21);
    fs.writeFileSync(ovPath, ov);
  }

  const badPath = join(badDir, "db-2026-08-20.sqlite");
  writeSnapshot(badPath);
  // Затираем ОДНУ страницу в середине — это b-tree таблицы `bulk`. Страница 1
  // (заголовок + sqlite_master) и корень `small` не тронуты, так что файл
  // по-прежнему открывается и отдаёт список таблиц.
  const buf = fs.readFileSync(badPath);
  const pageSize = buf.readUInt16BE(16) || 65536;
  expect(buf.length).toBeGreaterThan(pageSize * 41);
  buf.fill(0, pageSize * 40, pageSize * 41);
  fs.writeFileSync(badPath, buf);
});

afterAll(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("битая страница данных: sqlite_master читается, таблица — нет", () => {
  // Опора теста. Если SQLite перестанет открывать такой файл вовсе, дефект
  // ловится внешним catch, и проверки ниже потеряют смысл — пусть это будет
  // видно здесь, а не в виде загадочно позеленевшего гейта.
  const db = new Database(join(badDir, "db-2026-08-20.sqlite"), { readonly: true });
  const tables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((t) => t.name);
  expect(tables).toContain("bulk");
  expect(() => db.query(`SELECT COUNT(*) as count FROM "bulk"`).get()).toThrow();
  expect(db.query(`SELECT COUNT(*) as count FROM "small"`).get()).toEqual({ count: 1 });
  db.close();
});

test("битый бэкап НЕ проходит учебный restore", async () => {
  const r = await restoreFromBackup({ backupDir: badDir });
  expect(r.success).toBe(false);
});

test("в ошибках названа таблица, которая не прочиталась", async () => {
  const r = await restoreFromBackup({ backupDir: badDir });
  expect(r.errors.join("\n")).toContain("bulk");
});

test("сентинел -1 сохраняется — CLI печатает по нему ERROR", async () => {
  const r = await restoreFromBackup({ backupDir: badDir });
  expect(r.originalRowCounts.bulk).toBe(-1);
});

test("здоровая таблица рядом с битой считается как обычно", async () => {
  const r = await restoreFromBackup({ backupDir: badDir });
  expect(r.originalRowCounts.small).toBe(1);
});

test("--verify-only на битом бэкапе тоже красный", async () => {
  // Дешёвый ночной прогон ходит именно этим путём: если он зелёный, ни один
  // другой сигнал о порче бэкапа не появится.
  const r = await restoreFromBackup({ backupDir: badDir, verifyOnly: true });
  expect(r.success).toBe(false);
});

test("целый бэкап по-прежнему проходит — ложной тревоги нет", async () => {
  const r = await restoreFromBackup({ backupDir: goodDir });
  expect(r.errors).toEqual([]);
  expect(r.success).toBe(true);
  expect(r.originalRowCounts).toEqual({ bulk: 3000, small: 1 });
});

test("целый бэкап проходит и в режиме --verify-only", async () => {
  const r = await restoreFromBackup({ backupDir: goodDir, verifyOnly: true });
  expect(r.success).toBe(true);
});

test("рваная цепочка overflow: COUNT(*) её не видит", () => {
  // Опора для теста ниже. Если бы счётчик строк ловил такую порчу, проверка
  // целостности была бы лишней — а он её не ловит.
  const db = new Database(join(overflowDir, "db-2026-08-20.sqlite"), { readonly: true });
  expect(db.query(`SELECT COUNT(*) as count FROM "docs"`).get()).toEqual({ count: 3 });
  expect(() => db.query(`SELECT length(blob) as n FROM "docs"`).all()).toThrow();
  db.close();
});

test("рваную цепочку overflow ловит integrity_check, а не счётчик строк", async () => {
  const r = await restoreFromBackup({ backupDir: overflowDir });
  expect(r.originalRowCounts.docs).toBe(3); // сентинела -1 здесь нет вообще
  expect(r.errors.join("\n")).toContain("integrity_check");
  expect(r.success).toBe(false);
});
