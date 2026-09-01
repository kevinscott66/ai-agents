/**
 * Одноразовый воркер для QUERY_DB. Читает {dbPath, sql, limit, maxBytes} из
 * stdin, печатает JSON-результат в stdout и умирает.
 *
 * Существует ровно затем, чтобы запрос можно было УБИТЬ. bun:sqlite не
 * отдаёт ни sqlite3_progress_handler, ни sqlite3_interrupt, а вызов
 * .all() синхронный — то есть внутри основного процесса зависший запрос
 * блокирует и всех 12 ботов, и HTTP-сервер Mini App, и планировщики.
 * Отдельный процесс убивается сигналом снаружи, чего внутрипроцессный
 * таймаут принципиально не умеет.
 *
 * Второй бюджет — на РАЗМЕР ответа, и он тоже принадлежит воркеру. limit
 * ограничивает число строк, но не их вес: `SELECT hex(zeroblob(50000000))`
 * — это одна строка на 100 МБ, проходящая и валидатор, и таймаут (запрос
 * быстрый). Замер 2026-08-02: такой запрос поднимал RSS основного процесса
 * с 34 до 425 МБ, а 20 таких строк — до 1.5 ГБ; при limit=200 это OOM-kill
 * всего юнита. Поэтому строки сериализуются по одной и складываются, пока
 * влезают в бюджет: перебор обрывается ДО того, как в памяти окажется
 * полный набор.
 */
import { Database } from "bun:sqlite";

const input = (await Bun.stdin.json()) as {
  dbPath: string;
  sql: string;
  limit: number;
  maxBytes?: number;
};

const maxBytes =
  typeof input.maxBytes === "number" && input.maxBytes > 0
    ? input.maxBytes
    : 512_000;

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

try {
  const db = new Database(input.dbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 2000;");
  const stmt = db.prepare(input.sql);

  const parts: string[] = [];
  let bytes = 0;
  let truncated = false;
  let taken = 0;
  for (const row of stmt.iterate() as Iterable<unknown>) {
    if (taken >= input.limit) {
      // Аудит 2026-08-28: здесь `truncated` не ставился, хотя итератор уже
      // отдал строку сверх лимита — значит в результате есть ещё как минимум
      // одна. Байтовый обрыв ниже помечался, строчный молчал, и модель,
      // написавшая свой `LIMIT 200` без аргумента `limit`, получала 50 строк
      // как полный ответ. Ровно по лимиту итератор завершается, не заходя в
      // тело, — там флаг по-прежнему остаётся false.
      truncated = true;
      break;
    }
    const s = JSON.stringify(row);
    bytes += Buffer.byteLength(s, "utf8") + 1; // +1 на разделитель
    if (bytes > maxBytes) {
      truncated = true;
      break;
    }
    parts.push(s);
    taken += 1;
  }
  db.close();

  if (truncated && parts.length === 0) {
    // Даже одна строка не влезла — обрезать нечего, честно отказываем.
    write({
      ok: false,
      error: `результат больше ${maxBytes} байт уже на первой строке — выбери конкретные колонки вместо * и не тяни BLOB/длинный текст`,
    });
  } else {
    // Собираем вручную: строки уже сериализованы, повторный JSON.stringify
    // экранировал бы их и удвоил объём.
    process.stdout.write(
      `{"ok":true,"truncated":${truncated},"rows":[${parts.join(",")}]}`,
    );
  }
} catch (e) {
  write({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
