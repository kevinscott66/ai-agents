/**
 * QUERY_DB: валидация и песочница.
 *
 * SQL приходит из tool-call модели, то есть управляем prompt-injection
 * (пересланное сообщение, вложение, страница из web_search). Отсюда три
 * независимых слоя, каждый со своей зоной ответственности:
 *
 *  1. `validateQueryDbSql` — префикс + денилист таблиц. Это НЕ граница
 *     безопасности: SQLite разрешает CTE перед DML, поэтому
 *       WITH x AS (SELECT 1) UPDATE permissions SET allowed=1 WHERE …
 *     начинается с `with`, не содержит ';' и не упоминает ни одной таблицы
 *     из денилиста — и переписывает саму таблицу прав. Проверено 2026-08-02.
 *     Слой нужен для внятной ошибки модели и для отсечки приватных таблиц.
 *  2. Соединение `readonly: true` — настоящая граница на запись: SQLite сам
 *     не даст выполнить DML, чем бы запрос ни притворялся.
 *  3. `runQueryDbSandboxed` — граница на *ресурсы*. Readonly не мешает
 *     запросу молотить процессор вечно:
 *       WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c
 *                               WHERE x < 1000000000)
 *       SELECT count(*) FROM c
 *     проходит все проверки выше (начинается с `with`, таблиц не упоминает),
 *     а автоматический `LIMIT 50` приписывается СНАРУЖИ агрегата и не
 *     ограничивает ничего. Замеры 2026-08-02: 200k строк — 40мс, 2M — 400мс,
 *     линейно, то есть 1e9 ≈ 200 секунд. Тот же эффект даёт декартово
 *     произведение по разрешённым таблицам (`FROM tasks a, tasks b, tasks c`),
 *     так что запретом одного `RECURSIVE` вектор не закрывается.
 *
 *     Ресурс тут не только процессорный. `limit` считает СТРОКИ, а не байты:
 *     `SELECT hex(zeroblob(50000000))` — одна строка на 100 МБ, быстрая
 *     (250мс, таймаут не срабатывает) и проходящая валидатор. Замер
 *     2026-08-02: RSS основного процесса 34 → 425 МБ на один такой запрос и
 *     до 1.5 ГБ на двадцать, то есть при limit=200 — OOM-kill юнита вместо
 *     фриза. Поэтому у песочницы два бюджета: время (SIGKILL по таймеру) и
 *     объём (QUERY_DB_MAX_BYTES, обрывается и в воркере, и при чтении).
 */
import { fileURLToPath } from "node:url";

import { DB_PATH } from "./db.ts";
import { log } from "./log.ts";

/** Приватный контент: переписка, вики, промпты, аудит с payload. */
const BLOCKED_TABLES = [
  "messages",
  "messages_archive",
  "wiki_fts",
  "wiki_fts_content",
  "wiki_fts_data",
  "wiki_fts_config",
  "wiki_fts_docsize",
  "wiki_fts_idx",
  "agent_prompts",
  "audit_log_telegram",
  "audit_logs",
  "audit_logs_archive",
  "agent_actions",
  "agent_actions_archive",
  "approvals",
  // Аудит 2026-08-20: архива тут не было, а `\b` его и не подтягивает —
  // между `s` и `_` границы слова нет (оба символа словесные), поэтому
  // `\bapprovals\b` не матчит `approvals_archive`. Запрос
  // `SELECT payload, reason FROM approvals_archive` проходил валидацию целиком:
  // префикс `select` разрешён, `;` нет, ни одна строка денилиста не совпала.
  // На выходе — тела постов, тексты сообщений, аргументы MAC_RUN_CLAUDE и
  // причины отказов владельца, то есть ровно то, ради чего в списке стоят
  // `approvals`, `messages` и `audit_logs`.
  //
  // Остальные три архива тут были с самого начала; `approvals` начал
  // архивироваться позже (миграция 042, см. cold-storage.ts), а список с тех
  // пор не обновляли. Полноту теперь держит тест
  // tests/audit-2026-08-20-query-db-archive-tables.test.ts: он сверяет
  // денилист со схемой и краснеет на любую новую `*_archive`.
  "approvals_archive",
  // Аудит 2026-08-27: очередь временных ролей хранит `system_prompt` целиком —
  // тот же класс данных, что `agent_prompts` двумя строками выше. С этого
  // прогона у неё есть и архив (миграция 046), поэтому закрыты обе.
  //
  // Аудит 2026-09-11: сам по себе этот запрет ничего не закрывал. Тот же текст
  // вторым экземпляром лежал в `tasks.input` (`enqueueRoleTask` писал обе
  // строки разом), а `tasks` читаема намеренно и пришпилена читаемой тестом
  // audit-2026-08-20-query-db-archive-tables. Обход был длиной в одну строку:
  // `SELECT input FROM tasks WHERE input LIKE '%_spawn_role%'`. Денилист —
  // не то место, где это чинить: правильный ответ — не хранить приватный
  // текст в читаемой таблице, поэтому дубль убран у источника
  // (`queue_version: 2`), а старые строки чистит миграция 052.
  "role_runtime_queue",
  "role_runtime_queue_archive",
  "content_calendar",
];

const ALLOWED_PREFIX =
  /^(select|with|explain\s+query\s+plan|explain|pragma\s+table_info|pragma\s+index_list|pragma\s+index_info)\b/i;

export const QUERY_DB_TIMEOUT_MS = 5000;

export type ValidationResult =
  | { ok: true; sql: string; limit: number }
  | { ok: false; error: string };

/**
 * Нормализует и проверяет запрос. Возвращает готовый к исполнению SQL
 * (с дописанным LIMIT, если его не было) и эффективный лимит строк.
 */
export function validateQueryDbSql(
  rawInput: unknown,
  limitInput?: unknown,
): ValidationResult {
  const raw = String(rawInput ?? "")
    .trim()
    .replace(/;+\s*$/, "");
  if (!raw) return { ok: false, error: "sql is required" };
  if (raw.includes(";")) {
    return { ok: false, error: "только один SELECT-запрос (без ';')" };
  }
  // Аудит 2026-08-20: комментарий глотал дописанный LIMIT. `SELECT id FROM
  // tasks --` превращалось в `SELECT id FROM tasks -- LIMIT 50`, то есть
  // клауза оказывалась ВНУТРИ комментария и не значила ничего. Разбирать
  // комментарии наравне с SQLite мы не умеем и не будем: роли они не нужны ни
  // для чего, поэтому отказ целиком, а не попытка угадать границу.
  if (/--|\/\*/.test(raw)) {
    return {
      ok: false,
      error: "комментарии в SQL не допускаются: они прячут текст от проверок",
    };
  }
  if (!ALLOWED_PREFIX.test(raw)) {
    return {
      ok: false,
      error:
        "разрешены только SELECT/WITH/EXPLAIN/PRAGMA table_info|index_list|index_info",
    };
  }
  const lower = raw.toLowerCase();
  const hit = BLOCKED_TABLES.find((t) => new RegExp(`\\b${t}\\b`).test(lower));
  if (hit) {
    return {
      ok: false,
      error: `таблица '${hit}' закрыта (приватный контент). Для логов используй GET_LOGS, для вики — SEARCH_WIKI/READ_WIKI.`,
    };
  }
  const rawLimit = typeof limitInput === "number" ? limitInput : 50;
  const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)));
  // `limit` внутри строкового литерала — это данные, а не клауза. На
  // `WHERE title LIKE '%limit%'` проверка считала, что граница уже есть, и
  // запрос уходил в базу без неё вовсе. Литералы вырезаем ТОЛЬКО для этой
  // проверки: денилист выше работает по исходному тексту, поэтому закавыченное
  // имя закрытой таблицы (`"messages"`) по-прежнему ловится.
  //
  // Число строк это не спасало и не ломало — воркер обрывает итерацию по
  // input.limit в любом случае (проверка `taken >= input.limit` в query-db-worker.ts). Спасает оно работу
  // САМОЙ базы: без LIMIT движок честно отрабатывает полный скан и сортировку,
  // и единственной защитой остаётся SIGKILL через 5 секунд.
  const withoutLiterals = lower
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
  // Аудит 2026-08-28: здесь стояло `LIMIT ${limit}` — ровно то число, которое
  // уходит воркеру как input.limit. SQLite отдавал по этой границе ровно
  // столько строк, итератор завершался, и проверка `taken >= input.limit`
  // (проверка `taken >= input.limit` в query-db-worker.ts), на которой держится признак `truncated`, в тело
  // не заходила НИКОГДА. Обрыв по числу строк на дефолтном пути был
  // структурно непомечаем: пятьдесят строк из трёхсот приезжали к модели как
  // полный ответ.
  //
  // Разведочная строка: спрашиваем на одну больше, чем готовы отдать. Воркер
  // режет по `limit` как и раньше — в ответе ни одной лишней строки, — но
  // снова видит сигнал, на котором построен.
  const sql =
    /^select|^with/i.test(raw) && !/\blimit\b/.test(withoutLiterals)
      ? `${raw} LIMIT ${limit + 1}`
      : raw;
  return { ok: true, sql, limit };
}

// `.pathname` отдаёт путь в процентной кодировке, и установка в каталоге с
// пробелом или кириллицей ломала бы весь QUERY_DB — та же причина, что и в
// svg-render.ts (докблок WORKER_PATH там).
const WORKER_PATH = fileURLToPath(new URL("./query-db-worker.ts", import.meta.url));

/**
 * Потолок на объём ответа воркера. Таймаут ловит долгие запросы, но не
 * жирные: `SELECT hex(zeroblob(50000000))` отрабатывает за 250мс и отдаёт
 * 100 МБ одной строкой, а дальше та же строка проходит JSON.parse здесь,
 * fmt() в tools-schema и ещё один JSON.parse в tool-loop — четыре копии.
 * Бюджет держится в двух местах: воркер обрывает перебор строк сам, а мы
 * дополнительно режем чтение — на случай, если воркер отдаст что-то
 * непредусмотренное.
 */
export const QUERY_DB_MAX_BYTES = 512_000;

export type QueryDbResult =
  | { ok: true; count: number; rows: unknown[]; truncated?: boolean }
  | { ok: false; error: string };

/** Читает поток, оборвавшись, как только суммарный объём превысил `max`. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<{ text: string; overflow: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        overflow = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* поток уже закрыт вместе с убитым процессом */
    }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), overflow };
}

/**
 * Сколько песочниц может крутиться одновременно.
 *
 * Аудит 2026-08-08: время и объём ограничены НА ОДИН запрос, а число запросов
 * не ограничено ничем. Каждая песочница — отдельный процесс bun (~40 МБ RSS
 * только на рантайм) плюс до `maxBytes * 2` в буфере читателя. QUERY_DB отдан
 * backend и orchestrator, у хода лимит MAX_TOOL_ITERS=14, а в discussion-режиме
 * роли отвечают веером — то есть десяток одновременных песочниц набирается без
 * всякого злого умысла, и упирается в это не агент, а systemd-юнит целиком.
 *
 * Лишний запрос не ставится в очередь, а получает отказ сразу: ожидание всё
 * равно съело бы ход (5 секунд на каждую песочницу впереди), а модель на
 * внятную ошибку реагирует лучше, чем на подвисший инструмент.
 */
export const QUERY_DB_MAX_CONCURRENT = 2;
let running = 0;

/** Для тестов: сколько песочниц занято прямо сейчас. */
export function _queryDbRunning(): number {
  return running;
}

/**
 * Выполняет уже проверенный SQL в отдельном процессе с жёстким таймаутом.
 * Процесс убивается сигналом, поэтому зависший запрос не может утащить с
 * собой основной — см. шапку модуля.
 */
export async function runQueryDbSandboxed(
  sql: string,
  limit: number,
  opts?: {
    dbPath?: string;
    timeoutMs?: number;
    maxBytes?: number;
    maxConcurrent?: number;
  },
): Promise<QueryDbResult> {
  const timeoutMs = opts?.timeoutMs ?? QUERY_DB_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? QUERY_DB_MAX_BYTES;
  const maxConcurrent = opts?.maxConcurrent ?? QUERY_DB_MAX_CONCURRENT;
  if (running >= maxConcurrent) {
    log.warn("[QUERY_DB] отказ: все песочницы заняты", {
      running,
      maxConcurrent,
      sql: sql.slice(0, 200),
    });
    return {
      ok: false,
      error: `сейчас выполняются другие запросы к БД (${running}/${maxConcurrent}), повтори через несколько секунд`,
    };
  }
  running++;
  try {
    return await spawnQueryDbWorker(sql, limit, {
      dbPath: opts?.dbPath,
      timeoutMs,
      maxBytes,
    });
  } finally {
    running--;
  }
}

/** Минимум процесса воркера, которым пользуется spawnQueryDbWorker. */
export interface QueryDbProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/** Запуск воркера. Параметром — чтобы гонку с таймером можно было проверить. */
export type QueryDbSpawn = (payload: string) => QueryDbProc;

const realQueryDbSpawn: QueryDbSpawn = (payload) =>
  Bun.spawn([process.execPath, WORKER_PATH], {
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as QueryDbProc;

export async function spawnQueryDbWorker(
  sql: string,
  limit: number,
  opts: { dbPath?: string; timeoutMs: number; maxBytes: number },
  spawn: QueryDbSpawn = realQueryDbSpawn,
): Promise<QueryDbResult> {
  const timeoutMs = opts.timeoutMs;
  const maxBytes = opts.maxBytes;
  const proc = spawn(
    JSON.stringify({
      dbPath: opts.dbPath ?? DB_PATH,
      sql,
      limit,
      maxBytes,
    }),
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Аудит 2026-08-28: kill без обёртки. Исключение из колбэка таймера
    // некому ловить — оно уходит в uncaughtException всего процесса, где
    // живут все 12 ботов, ради процесса, который и так пора хоронить.
    try {
      proc.kill("SIGKILL");
    } catch {
      /* уже мёртв */
    }
  }, timeoutMs);

  try {
    // stderr дренируем параллельно: pipe на 64 КБ, и воркер, забивший его
    // трассой, заблокировался бы на write, пока мы ждём stdout — расходилось
    // бы только по таймауту, с потерей настоящей причины ошибки.
    const errP = new Response(proc.stderr).text().catch(() => "");
    const { text: out, overflow } = await readCapped(proc.stdout, maxBytes * 2);
    // Снимок ДО оставшихся await. Аудит 2026-08-28: флаг читался ниже, уже
    // после `await proc.exited` и `await errP`, а таймер срабатывает ровно в
    // этих окнах — колбэк ждёт, пока цикл событий уступит. Воркер, успевший
    // за 4.99с из 5, дописывал полный ответ, получал EOF на stdout, и его
    // результат выбрасывался ради «не уложился в 5000ms»: ошибка тем чаще,
    // чем ближе запрос к границе, то есть ровно там, где повтор не поможет.
    // Настоящий таймаут этим не задет — колбэк ставит флаг ДО kill, а EOF на
    // stdout приходит уже следствием kill, то есть после флага.
    const timedOutBeforeEof = timedOut;
    if (overflow) proc.kill("SIGKILL");
    await proc.exited;
    const err = await errP;

    if (timedOutBeforeEof) {
      log.warn("[QUERY_DB] запрос убит по таймауту", {
        timeoutMs,
        sql: sql.slice(0, 200),
      });
      return {
        ok: false,
        error: `запрос не уложился в ${timeoutMs}ms и был прерван — сузь выборку (добавь WHERE/LIMIT, убери самосоединения и рекурсивные CTE)`,
      };
    }
    if (overflow) {
      log.warn("[QUERY_DB] ответ превысил бюджет — воркер убит", {
        maxBytes,
        sql: sql.slice(0, 200),
      });
      return {
        ok: false,
        error: `ответ превысил ${maxBytes} байт — выбери конкретные колонки вместо * и не тяни BLOB/длинный текст`,
      };
    }
    if (!out.trim()) {
      return {
        ok: false,
        error: `воркер не вернул результат${err.trim() ? `: ${err.trim().slice(0, 300)}` : ""}`,
      };
    }
    const parsed = JSON.parse(out) as
      | { ok: true; rows: unknown[]; truncated?: boolean }
      | { ok: false; error: string };
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return {
      ok: true,
      count: parsed.rows.length,
      rows: parsed.rows,
      ...(parsed.truncated ? { truncated: true } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
    // Убиваем безусловно. Раньше единственным источником SIGKILL был таймер,
    // и если чтение stdout бросало (а самый вероятный триггер — как раз
    // огромный ответ), воркер оставался жить и жечь ядро уже после того,
    // как вызывающий получил ошибку.
    try {
      proc.kill("SIGKILL");
    } catch {
      /* уже мёртв */
    }
  }
}
