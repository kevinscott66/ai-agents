// db.ts — bun:sqlite (WAL) storage layer for Web3 Пульс.
// Tables: digests, unlocks, drops, activities, meta. Pure read/write helpers,
// no HTTP here.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Activity,
  ActivityCard,
  Digest,
  DigestItem,
  Drop,
  DropStatus,
  Unlock,
} from "./types.ts";

export function resolveDbPath(): string {
  return process.env.SITE_DB_PATH?.trim() || join(import.meta.dir, "data", "site.db");
}

/**
 * Scheme-allowlist for stored URLs (anti stored-XSS). Returns the trimmed URL
 * only if it is http(s); otherwise an empty string. The frontend applies the
 * same check (safeHref) as defence-in-depth.
 */
export function safeStoredUrl(url: unknown): string {
  if (typeof url !== "string") return "";
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : "";
}

let _db: Database | null = null;
let _dbPath: string | null = null;

export function getDb(): Database {
  const path = resolveDbPath();
  // Reopen if the configured path changed (keeps test files isolated even
  // though Bun runs them in one process and shares this module singleton).
  if (_db && _dbPath === path) return _db;
  if (_db && _dbPath !== path) {
    _db.close();
    _db = null;
  }
  // Ensure parent dir exists (e.g. data/ or /tmp).
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* ignore — dir may already exist */
  }
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    migrate(db);
  } catch (e) {
    // Аудит 2026-08-21: без этого соединение оставалось открытым и
    // недостижимым — `_db` присваивается строкой ниже, до неё уже не дошли.
    // Следующий запрос открывал ещё одно, и так каждый: getDb() зовётся из
    // каждой ручки. Замер: 20 упавших вызовов = +40 дескрипторов (WAL — два
    // на соединение), линейно и без потолка.
    //
    // Опасна не утечка сама по себе, а превращение временной ошибки в
    // постоянную: migrate падает от "database is locked" или переполненного
    // диска, то есть от состояния, которое проходит само, — но процесс к
    // тому моменту упирается в EMFILE и не отдаёт ничего до рестарта.
    //
    // Ошибку пробрасываем: проглотить её значит тихо работать на пустой или
    // недомигрированной базе вместо шумного отказа.
    try {
      db.close();
    } catch {
      /* закрытие уже сломанного соединения не должно прятать исходную ошибку */
    }
    throw e;
  }
  _db = db;
  _dbPath = path;
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS digests (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      date         TEXT NOT NULL,
      summary      TEXT NOT NULL,
      items_json   TEXT NOT NULL DEFAULT '[]',
      source_count INTEGER NOT NULL DEFAULT 0,
      body         TEXT NOT NULL DEFAULT '',
      search_text  TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS unlocks (
      project    TEXT NOT NULL,
      symbol     TEXT NOT NULL,
      date       TEXT NOT NULL,
      pct        REAL NOT NULL,
      amount_usd REAL,
      PRIMARY KEY (project, date)
    );
    CREATE TABLE IF NOT EXISTS drops (
      id          TEXT PRIMARY KEY,
      project     TEXT NOT NULL,
      status      TEXT NOT NULL,
      deadline    TEXT,
      url         TEXT NOT NULL,
      description TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activities (
      id              TEXT PRIMARY KEY,
      project         TEXT NOT NULL,
      emoji           TEXT NOT NULL DEFAULT '',
      title           TEXT NOT NULL,
      intro           TEXT NOT NULL DEFAULT '',
      what_is         TEXT NOT NULL DEFAULT '',
      steps_json      TEXT NOT NULL DEFAULT '[]',
      raised          TEXT NOT NULL DEFAULT '',
      -- Аудит 2026-09-11: здесь стояло DEFAULT '[]' — как у соседних
      -- *_json-колонок, но эта хранит JSON-СТРОКУ, а не массив (см.
      -- upsertActivity: COALESCE($investors, '""')). Строка, вставленная мимо
      -- upsert'а, получала '[]' и вылезала пользователю дословным «[]».
      investors_json  TEXT NOT NULL DEFAULT '""',
      spent           TEXT NOT NULL DEFAULT '',
      time            TEXT NOT NULL DEFAULT '',
      reward_type     TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT '',
      date_receive    TEXT NOT NULL DEFAULT '',
      url             TEXT NOT NULL DEFAULT '',
      hashtags_json   TEXT NOT NULL DEFAULT '[]',
      date            TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Additive migrations for already-existing tables (CREATE IF NOT EXISTS above
  // is a no-op when the table predates a new column). Existing rows get '' .
  addColumnIfMissing(db, "digests", "body", "TEXT NOT NULL DEFAULT ''");

  // Аудит 2026-08-13: поиск по кириллице был регистрозависимым. `LIKE` в
  // SQLite складывает регистр только для латиницы (sqlite3UpperToLower ходит
  // по A–Z), а весь контент сайта — русский, и на живом delabs.space один и
  // тот же запрос давал три разных ответа: «Биткоин» → 3, «биткоин» → 8,
  // «БИТКОИН» → 0. Читатель, набравший слово не с той буквы, получал пустую
  // выдачу без единого признака сбоя.
  //
  // `lower()` не помогает — он ASCII-only ровно так же, а ICU в сборке Bun
  // нет. Поэтому регистр складывает JS (`toLowerCase` знает Юникод), а в базе
  // лежит готовая строка. Побочно из горячего пути уходит подзапрос
  // json_each: раньше на каждую строку разбирался items_json.
  //
  // Аудит 2026-08-21: заполнение стояло под `if (addColumnIfMissing(...))`,
  // то есть выполнялось ровно один раз — на том старте, где прошёл ALTER.
  // Но ALTER это DDL: он коммитится сам по себе, а заполнение идёт следом
  // отдельной транзакцией. Между ними окно — падение процесса, SIGKILL при
  // рестарте деплоя, "database is locked", исключение внутри самого
  // заполнения. Что бы там ни случилось, колонка уже есть, значит на
  // следующем старте `addColumnIfMissing` вернёт false и второго шанса не
  // будет НИКОГДА: у переживших окно строк `search_text` остаётся пустым, а
  // `LIKE` по пустой строке не находит ничего. Поиск молча отвечает "ничего
  // не найдено" — ровно тот отказ без признаков сбоя, который чинил сам
  // аудит 2026-08-13.
  //
  // Поэтому заполнение управляется ДАННЫМИ, а не возвратом ALTER: дозаполняем
  // строки с пустым `search_text` на каждом старте. После первого прохода это
  // no-op — `WHERE search_text = ''` не находит ничего.
  addColumnIfMissing(db, "digests", "search_text", "TEXT NOT NULL DEFAULT ''");
  backfillDigestSearchText(db);

  // Аудит 2026-08-13: кроме неявных индексов по первичным ключам не было ни
  // одного, и EXPLAIN QUERY PLAN на всех списочных запросах давал
  // `SCAN <table>` + `USE TEMP B-TREE FOR ORDER BY`. При сегодняшних десятках
  // строк это неважно; важно то, что главная делает пять запросов к /api на
  // загрузку, а /api/stats — ещё четыре полных прохода. Индексы совпадают с
  // ORDER BY соответствующих выборок, поэтому снимают и сортировку.
  db.run("CREATE INDEX IF NOT EXISTS idx_digests_date ON digests(date DESC, id DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date DESC, id DESC)");

  // Аудит 2026-08-14: у разблокировок обещание «индекс совпадает с ORDER BY»
  // не выполнялось. Индекс был (date, symbol, project), а выборка сортирует по
  // (date, project) — symbol стоит МЕЖДУ ними и в ORDER BY не участвует, так
  // что внутри одной даты порядок в индексе не тот, который нужен. Замер:
  //   (date, symbol, project) → SEARCH … USE TEMP B-TREE FOR LAST TERM OF ORDER BY
  //   (date, project)         → SEARCH … (без временного дерева)
  // Индекс правится не на месте: CREATE INDEX IF NOT EXISTS с тем же именем и
  // другими колонками — молчаливый no-op, на живой БД старый трёхколоночный
  // индекс пережил бы правку. Поэтому старое имя дропаем, новое создаём.
  db.run("DROP INDEX IF EXISTS idx_unlocks_date");
  db.run("CREATE INDEX IF NOT EXISTS idx_unlocks_date_project ON unlocks(date ASC, project ASC)");
}

/**
 * Add a column to a table if it does not already exist (idempotent).
 *
 * Возвращает `true`, если колонку действительно добавили. Признак этот
 * диагностический: оба вызывающих его выбрасывают, и решать по нему, делать ли
 * бэкфилл, НЕЛЬЗЯ. Ровно так и было до аудита 2026-08-21 — `if
 * (addColumnIfMissing(...)) backfill...`, — и упавший посреди первого старта
 * процесс терял второй шанс навсегда: колонка уже есть, ALTER возвращает
 * `false`, бэкфилл не случится никогда. Разбор — в `migrate()` выше, там же
 * правило: заполнение управляется ДАННЫМИ (`WHERE search_text = ''`), а не
 * возвратом ALTER.
 */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  decl: string,
): boolean {
  const tx = db.transaction(() => {
    const cols = db
      .query(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return false;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      return true;
    } catch (error) {
      // A second connection can only reach this after the immediate lock was
      // released. Treat exactly the duplicate-column race as already applied.
      if (/duplicate column name/i.test(String(error))) return false;
      throw error;
    }
  });
  return tx.immediate();
}

/** Текст одного пункта дайджеста, либо "" для всего, что на пункт не похоже. */
function digestItemText(item: unknown): string {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return "";
  const text = (item as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/**
 * Строка, по которой ищем: заголовок + аннотация + текст пунктов, в нижнем
 * регистре. Ровно те три поля, что искались и раньше — состав выдачи не
 * меняется, меняется только складывание регистра. `body` намеренно не входит:
 * это отдельное решение о том, что считать областью поиска.
 */
function digestSearchText(
  d: Pick<Digest, "title" | "summary"> & { items?: unknown[] },
): string {
  return [d.title, d.summary, ...(d.items ?? []).map(digestItemText)]
    .join(" ")
    .toLowerCase();
}

/**
 * Дозаполнение `search_text` для строк, где его нет: записанных до миграции
 * или не доживших до конца прерванного заполнения (см. вызов в migrate).
 * Идемпотентно и дёшево: после первого прохода выборка пуста.
 */
function backfillDigestSearchText(db: Database): void {
  const rows = db
    .query("SELECT id, title, summary, items_json FROM digests WHERE search_text = ''")
    .all() as Array<{ id: string; title: string; summary: string; items_json: string }>;
  if (rows.length === 0) return;
  const upd = db.query("UPDATE digests SET search_text = ?1 WHERE id = ?2");
  db.transaction(() => {
    for (const r of rows) {
      let items: unknown[] = [];
      try {
        const parsed = JSON.parse(r.items_json);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        // Блоб пишет модель через ингест; битый JSON не должен ронять старт.
      }
      upd.run(
        digestSearchText({
          title: r.title,
          summary: r.summary,
          items,
        }),
        r.id,
      );
    }
  })();
}

/** COUNT(*) helper. `where`/`params` optional for filtered counts. */
function countRows(
  table: string,
  where = "",
  ...params: unknown[]
): number {
  const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ""}`;
  const row = getDb().query(sql).get(...params) as { n: number };
  return row.n;
}

// ---- meta (timestamps for cache freshness) ------------------------------

export function getMeta(key: string): string | null {
  const row = getDb()
    .query("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .query(
      "INSERT INTO meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

// ---- digests ------------------------------------------------------------

type DigestRow = {
  id: string;
  title: string;
  date: string;
  summary: string;
  items_json: string;
  source_count: number;
  body: string;
};

/** Строка списка: то же самое без `body` (см. `DIGEST_CARD_COLUMNS`). */
type DigestCardRow = Omit<DigestRow, "body">;

/**
 * Колонки карточки — всё, кроме `body` и `search_text`.
 *
 * Аудит 2026-08-20. Списочные ручки шли через `SELECT *`, то есть тянули
 * полный markdown статьи: потолок `INGEST_MAX.body` — 200 000 символов, а
 * `limit` у `/api/digests` клампится до 100. То есть анонимный
 * `GET /api/digests?limit=100` собирал ответ порядка двадцати мегабайт и делал
 * это синхронным `JSON.stringify` в единственном потоке Bun — на время сборки
 * сервер не отвечал никому. То же на `?q=`: поиск использовал тот же `SELECT *`.
 *
 * Фронт `body` в списке не читает ни разу — он есть только на `DigestPage`
 * через `/api/digests/:id` (`getDigest`), а `DigestsSection` просит по шесть
 * штук. Так что весь этот объём был чистым усилением нагрузки. Тем же приёмом
 * аудит 2026-08-12 уже сузил `listSitemapEntries`, до списков тогда не дошли.
 *
 * `search_text` отсекается заодно: это склейка title+summary+тексты пунктов в
 * нижнем регистре, в ответ она не попадала и раньше, но из базы читалась.
 *
 * Аудит 2026-09-11: тот же довод дословно верен и для `items_json` — карточка
 * списка показывает `sourceCount`, а сами пункты разворачивает только страница
 * дайджеста, и та ходит за полной строкой. Убрать колонку сервер в одиночку не
 * может: `Digest.items` на фронте объявлен обязательным. Замер (десятки МиБ
 * против долей) и условие, при котором правка станет возможной, записаны в
 * audit-2026-09-11-digest-card-items-payload.test.ts.
 */
const DIGEST_CARD_COLUMNS = "id, title, date, summary, items_json, source_count";

function rowToDigest(r: DigestRow | DigestCardRow): Digest {
  let items: DigestItem[] = [];
  try {
    const parsed = JSON.parse(r.items_json);
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    /* malformed — fall back to empty list */
  }
  const body = "body" in r ? r.body : "";
  return {
    id: r.id,
    title: r.title,
    date: r.date,
    summary: r.summary,
    ...(body ? { body } : {}),
    items,
    sourceCount: r.source_count,
  };
}

/**
 * Счётчик правок контента, от которого зависят ленты (`/rss.xml`,
 * `/sitemap.xml`). Растёт при записи дайджеста или активности — только они и
 * попадают в ленты; разблокировки и дропы там не встречаются.
 *
 * Нужен, чтобы кэш лент в index.ts был не только «на 10 минут», но и точным:
 * свежая статья должна появляться сразу, а не после истечения TTL.
 */
let contentVersion = 0;

export function contentStamp(): number {
  return contentVersion;
}

/**
 * Пункты, уже лежащие под этим id. Нужны только для пересборки `search_text`
 * при частичном обновлении: сохранить старый search_text целиком нельзя —
 * правка заголовка обязана доехать до поиска.
 *
 * bun:sqlite синхронный, а сервер однопоточный, поэтому между этим чтением и
 * следующим за ним upsert-ом ничего не вклинивается.
 */
function storedDigestItems(id: string): DigestItem[] {
  const row = getDb().query("SELECT items_json FROM digests WHERE id = ?").get(id) as
    | { items_json: string }
    | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.items_json);
    return Array.isArray(parsed) ? (parsed as DigestItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * Вход `upsertDigest`. `items` и `sourceCount` необязательны, и это не
 * послабление типа, а часть контракта: отсутствие поля значит «не трогать
 * сохранённое», ровно как у `body` с аудита 2026-08-21. Пустой массив —
 * обычное значение, то есть явную очистку никто не отнял.
 */
export type DigestUpsert = Omit<Digest, "items" | "sourceCount"> & {
  items?: DigestItem[];
  sourceCount?: number;
  /**
   * `keepDateOnUpdate` — «дата уже есть у сохранённой записи, не трогать её».
   *
   * Аудит 2026-08-29: `date` осталась единственной колонкой обоих апсертов, где
   * «не прислали» означало «перезаписать». Для остальных полей контракт
   * «NULL значит не трогать» выстроен аудитами 2026-08-21/27/28, но у даты
   * NULL до SQL и не доезжал: HTTP-слой (`parseIngestDate`) подставлял
   * отсутствующей дате «сейчас». Для вставки это осмысленный дефолт, для
   * обновления — порча: правка уже опубликованного материала (site-ingest.ts
   * шлёт title/summary/items без даты, а reusableDigestId в пределах 12 часов
   * сводит правку на тот же id) двигала дату публикации на момент правки.
   * Следом ехали порядок ленты (сортировка по date DESC), `<pubDate>` в RSS у
   * тех, кто материал уже видел, `<lastmod>` в sitemap и дата в URL, навсегда
   * разошедшаяся с показанной.
   *
   * Флаг по умолчанию не выставлен, поэтому сид, approve-poll и тесты
   * продолжают перезаписывать дату как раньше; поднимает его только ингест и
   * только когда клиент дату действительно не прислал.
   */
  keepDateOnUpdate?: boolean;
};

export function upsertDigest(d: DigestUpsert): void {
  // Аудит 2026-08-28: пункты нужны ещё и для `search_text`. Когда их не
  // прислали, берём сохранённые — иначе правка одного заголовка выкидывала бы
  // статью из поиска по тексту её же источников.
  const storedItems = d.items === undefined ? storedDigestItems(d.id) : undefined;
  getDb()
    .query(
      `INSERT INTO digests (id, title, date, summary, items_json, source_count, body, search_text)
       VALUES ($id, $title, $date, $summary, COALESCE($items, '[]'), COALESCE($sc, 0), COALESCE($body, ''), $search)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         date = CASE WHEN $dateUpd IS NULL THEN digests.date ELSE $dateUpd END,
         summary = excluded.summary,
         -- Аудит 2026-08-28: было "items_json = excluded.items_json" и
         -- "source_count = excluded.source_count" — безусловно, тогда как
         -- HTTP-слой отсутствующее поле превращал в пустой массив. То есть
         -- «не прислали» означало «стереть»: реингест той же статьи другим
         -- отправителем (у approve-poll и site-ingest наборы полей разные, а
         -- reusableDigestId сводит их на один id) обнулял источники,
         -- sourceCount и поисковый индекс. Ответ эндпоинта оставался ok, а
         -- счётчик droppedItems — нулём, так что в лог не попадало ничего.
         -- Идиома та же, что у body: NULL значит «поле не прислали», пустой
         -- массив остаётся обычным значением.
         items_json = CASE WHEN $items IS NULL THEN digests.items_json ELSE $items END,
         source_count = CASE WHEN $sc IS NULL THEN digests.source_count ELSE $sc END,
         -- Аудит 2026-08-21: было "body = excluded.body", и отсутствие поля
         -- (оно необязательное — types.ts, body со знаком вопроса) означало
         -- не «не трогать», а «стереть». Реингест той же статьи без body —
         -- обычный путь: site-ingest.ts шлёт payload вообще без этого поля,
         -- а слаг при совпадении заголовка переиспользуется намеренно.
         -- Статья, опубликованная через approve-poll с полным текстом,
         -- теряла его молча, ответ эндпоинта оставался ok.
         --
         -- NULL здесь — сигнал «поле не прислали»; пустая строка остаётся
         -- обычным значением, так что явную очистку никто не отнял.
         body = CASE WHEN $body IS NULL THEN digests.body ELSE $body END,
         search_text = excluded.search_text`,
    )
    .run({
      $id: d.id,
      $search: digestSearchText(storedItems ? { ...d, items: storedItems } : d),
      $title: d.title,
      $date: d.date,
      $dateUpd: d.keepDateOnUpdate ? null : d.date,
      $summary: d.summary,
      $body: typeof d.body === "string" ? d.body : null,
      $items:
        d.items === undefined
          ? null
          : JSON.stringify(
              d.items.map((it) => ({
                ...it,
                url: it.url ? safeStoredUrl(it.url) : it.url,
              })),
            ),
      $sc: d.sourceCount ?? null,
    });
  contentVersion++;
}

export function countDigests(): number {
  return countRows("digests");
}

export function listDigests(limit: number, offset: number): Digest[] {
  const rows = getDb()
    .query(
      `SELECT ${DIGEST_CARD_COLUMNS} FROM digests
       ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as DigestCardRow[];
  return rows.map(rowToDigest);
}

/**
 * Escape LIKE wildcards (% _) and the escape char itself so a user query is
 * matched literally. Pairs with `LIKE ? ESCAPE '\'` in the queries below.
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Case-insensitive search across title, summary and the TEXT of items.
 *
 * Аудит 2026-08-13. Раньше третьим условием стояло `items_json LIKE ?`, то
 * есть поиск шёл по сериализованному JSON целиком, а комментарий рядом
 * утверждал, что промахи возможны только по ASCII-ключам и с живыми запросами
 * не столкнутся. Столкнулись, и не по ключам: в блобе лежат ещё и все ссылки
 * на источники. На девяти дайджестах превью запрос `http` находил 9 из 9,
 * `https` — 9 из 9, `com` — 8 из 9 (домены), `text` и `url` — по 9 из 9
 * (ключи). Это ровно те слова, которые читатель набирает не задумываясь, и в
 * ответ он получал всю ленту с видом осмысленной выдачи.
 *
 * Раньше здесь стояли три `LIKE` — по title, summary и по `$.text` каждого
 * пункта через json_each. Теперь те же три поля лежат склеенными и в нижнем
 * регистре в `search_text` (см. `digestSearchText`): `LIKE` в SQLite не
 * складывает регистр кириллицы, поэтому складываем его на стороне JS при
 * записи. Заодно с горячего пути ушёл разбор JSON на каждую строку.
 */
const DIGEST_SEARCH_WHERE = `search_text LIKE ?1 ESCAPE '\\'`;

/** Приводит пользовательский запрос к тому же виду, что и `search_text`. */
function searchLike(q: string): string {
  return `%${escapeLike(q.toLowerCase())}%`;
}

export function searchDigests(
  q: string,
  limit: number,
  offset: number,
): Digest[] {
  const like = searchLike(q);
  const rows = getDb()
    .query(
      `SELECT ${DIGEST_CARD_COLUMNS} FROM digests
       WHERE ${DIGEST_SEARCH_WHERE}
       ORDER BY date DESC, id DESC LIMIT ?2 OFFSET ?3`,
    )
    .all(like, limit, offset) as DigestCardRow[];
  return rows.map(rowToDigest);
}

/** Count of digests matching a search query (for pagination total). */
export function countSearchDigests(q: string): number {
  const like = searchLike(q);
  const row = getDb()
    .query(
      `SELECT COUNT(*) AS n FROM digests WHERE ${DIGEST_SEARCH_WHERE}`,
    )
    .get(like) as { n: number };
  return row.n;
}

/**
 * Самый свежий дайджест с ТОЧНО таким заголовком.
 *
 * Нужен ингесту, чтобы отличить правку уже опубликованного материала от нового
 * выпуска: производный слаг начинается с даты, и на стыке суток правка того же
 * поста получала новый id. Решение о том, считать ли находку тем же
 * материалом, принимает вызывающий — здесь только выборка.
 */
export function findLatestDigestByTitle(
  title: string,
): { id: string; date: string } | null {
  const row = getDb()
    // `id DESC` — тай-брейк, а не украшение: заголовок не уникален, дата у
    // правки того же дня совпадает, и без второго ключа порядок задаёт план
    // запроса. А выбранный здесь id решает, какую опубликованную страницу
    // перезапишет повторная присылка (`reusableDigestId`), и DELETE-роута,
    // чтобы отменить неверный выбор, у сайта нет. Все прочие упорядоченные
    // чтения в этом файле уже несут полный порядок.
    .query(
      "SELECT id, date FROM digests WHERE title = ? ORDER BY date DESC, id DESC LIMIT 1",
    )
    .get(title) as { id: string; date: string } | null;
  return row ?? null;
}

export function getDigest(id: string): Digest | null {
  const row = getDb()
    .query("SELECT * FROM digests WHERE id = ?")
    .get(id) as DigestRow | null;
  return row ? rowToDigest(row) : null;
}

// ---- unlocks ------------------------------------------------------------

type UnlockRow = {
  project: string;
  symbol: string;
  date: string;
  pct: number;
  amount_usd: number | null;
};

function rowToUnlock(r: UnlockRow): Unlock {
  return {
    project: r.project,
    symbol: r.symbol,
    date: r.date,
    pctOfSupply: r.pct,
    amountUsd: r.amount_usd ?? null,
  };
}

export function upsertUnlock(u: Unlock): void {
  getDb()
    .query(
      `INSERT INTO unlocks (project, symbol, date, pct, amount_usd)
       VALUES ($p, $s, $d, $pct, $amt)
       ON CONFLICT(project, date) DO UPDATE SET
         symbol = excluded.symbol,
         pct = excluded.pct,
         amount_usd = excluded.amount_usd`,
    )
    .run({
      $p: u.project,
      $s: u.symbol,
      $d: u.date,
      $pct: u.pctOfSupply,
      $amt: u.amountUsd,
    });
}

export function upsertUnlocks(list: Unlock[]): void {
  const db = getDb();
  const tx = db.transaction((items: Unlock[]) => {
    for (const u of items) upsertUnlock(u);
  });
  tx(list);
}

/**
 * Заменить набор БУДУЩИХ разблокировок снимком фида.
 *
 * Аудит 2026-08-12: `upsertUnlocks` умеет только вставлять и обновлять, а фид
 * отдаёт по проекту одно ближайшее событие, то есть каждый приход — это полный
 * снимок. Разблокировку перенесли — старая строка оставалась навсегда, и,
 * стоя на более ранней дате, вылезала ПЕРВОЙ в «Ближайших разблокировках»
 * (замер: снимок Aave 08-15 → 09-11 давал три строки вместо одной, первая —
 * несуществующая Aave 08-15). Проект, ушедший из фида, не исчезал вовсе.
 *
 * Прошедшие даты не трогаем: это история, фид её больше не содержит. Всё в
 * одной транзакции — промежуточного состояния «календарь пуст» не бывает.
 * Вызывать только с непустым снимком (см. refreshUnlocks: пустой разбор
 * означает сломанный фид, а не отсутствие разблокировок).
 */
export function replaceUpcomingUnlocks(list: Unlock[]): void {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const tx = db.transaction((items: Unlock[]) => {
    db.query("DELETE FROM unlocks WHERE date >= ?").run(nowIso);
    for (const u of items) upsertUnlock(u);
  });
  tx(list);
}

export function countUnlocks(): number {
  return countRows("unlocks");
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UnlockQuery {
  /** Порядок по дате: по умолчанию ближайшие первыми. */
  desc?: boolean;
  /** Окно в днях от «сейчас»; 0 — без верхней границы. */
  withinDays?: number;
  /**
   * Момент отсчёта. Аудит 2026-08-28: маршрут делает два обращения подряд, и
   * без общей метки каждое брало своё «сейчас» — см. unlockWindow ниже.
   * По умолчанию — текущее время, как и было.
   */
  now?: number;
}

/**
 * Границы окна «впереди»: нижняя — «сейчас», верхняя — либо задана, либо её нет.
 *
 * Считать их в одном месте мало: место одно, а вызовов два подряд
 * (`listUpcomingUnlocks` + `countUpcomingUnlocks` в /api/unlocks), и каждый брал
 * СВОЁ `new Date()`. Разблокировка, наступившая между ними, попадала в список и
 * не попадала в счётчик — ответ сам себе противоречит, `total` меньше длины
 * `items`, а кнопка «Показать ещё» либо не появится, либо не кончится никогда.
 * Поэтому момент отсчёта приходит из запроса: вызывающий берёт его один раз.
 */
function unlockWindow(q: UnlockQuery): { where: string; params: string[] } {
  const nowMs = q.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  if (!q.withinDays || q.withinDays <= 0) {
    return { where: "date >= ?", params: [nowIso] };
  }
  const until = new Date(nowMs + q.withinDays * DAY_MS).toISOString();
  return { where: "date >= ? AND date <= ?", params: [nowIso, until] };
}

/** Count of upcoming unlocks (date >= now), optionally within a day window. */
export function countUpcomingUnlocks(q: UnlockQuery = {}): number {
  const { where, params } = unlockWindow(q);
  return countRows("unlocks", where, ...params);
}

/**
 * Ближайшие разблокировки, страницами.
 *
 * `project` добавлен в ORDER BY не для красоты: ключ таблицы — (project, date),
 * и в один день разблокировок бывает несколько. Порядок только по `date` для
 * них не определён, а при пагинации по OFFSET неопределённый порядок означает,
 * что одна и та же строка может прийти дважды либо не прийти вовсе.
 *
 * Сортировка и окно считаются здесь, а не на клиенте: раньше страница брала
 * сто строк и фильтровала их у себя, поэтому «7 дней» показывали не все
 * разблокировки недели, а только те из первой сотни, что в неделю попали.
 *
 * Тайбрейк разворачивается вместе с датой. Раньше было `date DESC, project ASC`,
 * то есть переключатель сортировки давал НЕ обратный список: строки одного дня
 * сохраняли прежний порядок. Развернув и тайбрейк, получаем настоящий разворот
 * и заодно порядок, который целиком лежит в индексе (date, project) — иначе
 * SQLite достраивает временное дерево на каждый запрос.
 */
export function listUpcomingUnlocks(
  limit: number,
  offset = 0,
  q: UnlockQuery = {},
): Unlock[] {
  const { where, params } = unlockWindow(q);
  const dir = q.desc ? "DESC" : "ASC";
  const rows = getDb()
    .query(
      `SELECT * FROM unlocks WHERE ${where} ORDER BY date ${dir}, project ${dir} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as UnlockRow[];
  return rows.map(rowToUnlock);
}

// ---- drops --------------------------------------------------------------

type DropRow = {
  id: string;
  project: string;
  status: string;
  deadline: string | null;
  url: string;
  description: string;
};

function rowToDrop(r: DropRow): Drop {
  return {
    id: r.id,
    project: r.project,
    status: r.status as DropStatus,
    deadline: r.deadline ?? null,
    url: r.url,
    description: r.description,
  };
}

export function upsertDrop(d: Drop): void {
  getDb()
    .query(
      `INSERT INTO drops (id, project, status, deadline, url, description)
       VALUES ($id, $p, $st, $dl, $url, $desc)
       ON CONFLICT(id) DO UPDATE SET
         project = excluded.project,
         status = excluded.status,
         deadline = excluded.deadline,
         url = excluded.url,
         description = excluded.description`,
    )
    .run({
      $id: d.id,
      $p: d.project,
      $st: d.status,
      $dl: d.deadline,
      $url: safeStoredUrl(d.url),
      $desc: d.description,
    });
}

export function countDrops(status?: DropStatus | null): number {
  return status ? countRows("drops", "status = ?", status) : countRows("drops");
}

// Status priority: active first, then soon, then ended; secondary by deadline.
// `id ASC` в конце — не украшение: без полного порядка строки с одинаковым
// статусом и дедлайном могут переставляться между запросами, и постраничная
// выдача начнёт то дублировать, то терять дропы.
export function listDrops(
  limit: number,
  offset = 0,
  status?: DropStatus | null,
): Drop[] {
  const where = status ? "WHERE status = ?" : "";
  const args: (string | number)[] = status ? [status] : [];
  const rows = getDb()
    .query(
      `SELECT * FROM drops
       ${where}
       ORDER BY
         CASE status WHEN 'active' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END ASC,
         (deadline IS NULL) ASC,
         deadline ASC,
         id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as DropRow[];
  return rows.map(rowToDrop);
}

// ---- activities ---------------------------------------------------------

type ActivityRow = {
  id: string;
  project: string;
  emoji: string;
  title: string;
  intro: string;
  what_is: string;
  steps_json: string;
  raised: string;
  investors_json: string;
  spent: string;
  time: string;
  reward_type: string;
  status: string;
  date_receive: string;
  url: string;
  hashtags_json: string;
  date: string;
};

/** Parse a JSON column expected to hold an array of strings; tolerant of junk. */
function parseStrArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* malformed — fall back to empty */
  }
  return [];
}

/**
 * Разобрать колонку инвесторов обратно в простую строку.
 *
 * Аудит 2026-09-11: разобранный, но не строковый JSON проваливался в `return
 * raw`, то есть попадал к читателю дословно. На массиве это давало «[]» в
 * карточке — ровно то, что клало в базу прежнее `DEFAULT '[]'` и что положил
 * бы любой ручной INSERT без этой колонки. Разбор, который УДАЛСЯ, дальше как
 * сырой текст не идёт: массив строк склеиваем (форма из старых выгрузок), всё
 * прочее считаем пустым. `raw` остаётся ответом только там, где JSON не
 * разобрался вовсе, — это легаси-строки без кавычек вида `a16z, Paradigm`.
 */
function parseStr(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string").join(", ");
    }
    return "";
  } catch {
    /* malformed — treat the raw blob as the value */
  }
  return typeof raw === "string" ? raw : "";
}

/** Колонки карточки: всё, кроме тяжёлых `what_is` и `steps_json`. */
const ACTIVITY_CARD_COLUMNS =
  "id, project, emoji, title, intro, raised, investors_json, spent, time, " +
  "reward_type, status, date_receive, url, hashtags_json, date";

type ActivityCardRow = Omit<ActivityRow, "what_is" | "steps_json">;

function rowToActivityCard(r: ActivityCardRow): ActivityCard {
  return {
    id: r.id,
    project: r.project,
    emoji: r.emoji,
    title: r.title,
    intro: r.intro,
    raised: r.raised,
    investors: parseStr(r.investors_json),
    spent: r.spent,
    time: r.time,
    rewardType: r.reward_type,
    status: r.status,
    dateReceive: r.date_receive,
    url: r.url,
    hashtags: parseStrArray(r.hashtags_json),
    date: r.date,
  };
}

function rowToActivity(r: ActivityRow): Activity {
  return {
    id: r.id,
    project: r.project,
    emoji: r.emoji,
    title: r.title,
    intro: r.intro,
    whatIs: r.what_is,
    steps: parseStrArray(r.steps_json),
    raised: r.raised,
    investors: parseStr(r.investors_json),
    spent: r.spent,
    time: r.time,
    rewardType: r.reward_type,
    status: r.status,
    dateReceive: r.date_receive,
    url: r.url,
    hashtags: parseStrArray(r.hashtags_json),
    date: r.date,
  };
}

/**
 * Вход `upsertActivity`: обязателен только идентифицирующий минимум.
 *
 * Аудит 2026-08-27: остальные поля необязательны, потому что отсутствие поля
 * в ингесте и явная его очистка — разные намерения. `Activity` присваивается
 * этому типу без изменений, так что сид и тесты продолжают работать.
 */
export type ActivityUpsert = Pick<Activity, "id" | "project" | "title" | "date"> &
  Partial<Omit<Activity, "id" | "project" | "title" | "date">> & {
    /** См. одноимённое поле `DigestUpsert`. */
    keepDateOnUpdate?: boolean;
  };

export function upsertActivity(a: ActivityUpsert): void {
  getDb()
    .query(
      `INSERT INTO activities (
         id, project, emoji, title, intro, what_is, steps_json, raised,
         investors_json, spent, time, reward_type, status, date_receive,
         url, hashtags_json, date)
       VALUES (
         $id, $project, COALESCE($emoji, ''), $title, COALESCE($intro, ''),
         COALESCE($whatIs, ''), COALESCE($steps, '[]'), COALESCE($raised, ''),
         COALESCE($investors, '""'), COALESCE($spent, ''), COALESCE($time, ''),
         COALESCE($rewardType, ''), COALESCE($status, ''),
         COALESCE($dateReceive, ''), COALESCE($url, ''),
         COALESCE($hashtags, '[]'), $date)
       ON CONFLICT(id) DO UPDATE SET
         -- Аудит 2026-08-27: было "<колонка> = excluded.<колонка>" по всем
         -- полям, и отсутствие поля в запросе означало не «не трогать», а
         -- «стереть». Id гайда выводится из project+title (index.ts,
         -- slugFromProjectTitle), то есть повторная отправка того же гайда —
         -- штатный путь обновления: POST со статусом «Завершено» и без
         -- остального обнулял whatIs, steps, raised, investors и ссылку,
         -- возвращая ok. Ровно тот дефект, что чинили у дайджестов
         -- 2026-08-21 (см. body выше в upsertDigest), не доведённый до
         -- активностей.
         --
         -- NULL здесь — «поле не прислали»; пустая строка остаётся обычным
         -- значением, так что явная очистка по-прежнему возможна.
         project = excluded.project,
         emoji = CASE WHEN $emoji IS NULL THEN activities.emoji ELSE $emoji END,
         title = excluded.title,
         intro = CASE WHEN $intro IS NULL THEN activities.intro ELSE $intro END,
         what_is = CASE WHEN $whatIs IS NULL THEN activities.what_is ELSE $whatIs END,
         steps_json = CASE WHEN $steps IS NULL THEN activities.steps_json ELSE $steps END,
         raised = CASE WHEN $raised IS NULL THEN activities.raised ELSE $raised END,
         investors_json = CASE
           WHEN $investors IS NULL THEN activities.investors_json ELSE $investors END,
         spent = CASE WHEN $spent IS NULL THEN activities.spent ELSE $spent END,
         time = CASE WHEN $time IS NULL THEN activities.time ELSE $time END,
         reward_type = CASE
           WHEN $rewardType IS NULL THEN activities.reward_type ELSE $rewardType END,
         status = CASE WHEN $status IS NULL THEN activities.status ELSE $status END,
         date_receive = CASE
           WHEN $dateReceive IS NULL THEN activities.date_receive ELSE $dateReceive END,
         url = CASE WHEN $url IS NULL THEN activities.url ELSE $url END,
         hashtags_json = CASE
           WHEN $hashtags IS NULL THEN activities.hashtags_json ELSE $hashtags END,
         date = CASE WHEN $dateUpd IS NULL THEN activities.date ELSE $dateUpd END`,
    )
    .run({
      $id: a.id,
      $project: a.project,
      $dateUpd: a.keepDateOnUpdate ? null : a.date,
      $emoji: a.emoji ?? null,
      $title: a.title,
      $intro: a.intro ?? null,
      $whatIs: a.whatIs ?? null,
      $steps:
        a.steps === undefined
          ? null
          : JSON.stringify(
              Array.isArray(a.steps)
                ? a.steps.filter((s) => typeof s === "string")
                : [],
            ),
      $raised: a.raised ?? null,
      $investors:
        a.investors === undefined
          ? null
          : JSON.stringify(typeof a.investors === "string" ? a.investors : ""),
      $spent: a.spent ?? null,
      $time: a.time ?? null,
      $rewardType: a.rewardType ?? null,
      $status: a.status ?? null,
      $dateReceive: a.dateReceive ?? null,
      $url: a.url === undefined ? null : safeStoredUrl(a.url),
      $hashtags:
        a.hashtags === undefined
          ? null
          : JSON.stringify(
              Array.isArray(a.hashtags)
                ? a.hashtags.filter((s) => typeof s === "string")
                : [],
            ),
      $date: a.date,
    });
  contentVersion++;
}

export function countActivities(): number {
  return countRows("activities");
}

/**
 * Пары id+дата для карты сайта — узкий запрос вместо двух `SELECT *`.
 *
 * Аудит 2026-08-12: `/sitemap.xml` звал `listDigests(20_000, 0)` и
 * `listActivities(20_000, 0)`, то есть читал обе таблицы целиком вместе с
 * колонкой `body` и делал `JSON.parse` на каждую строку — ради `id` и `date`,
 * то есть выбрасывал 99% прочитанного. Синхронно, на каждый запрос, без
 * серверного кэша: готовый усилитель нагрузки в цикле `curl`.
 */
export function listSitemapEntries(limit: number): {
  digests: { id: string; date: string }[];
  activities: { id: string }[];
} {
  const db = getDb();
  return {
    digests: db
      .query("SELECT id, date FROM digests ORDER BY date DESC, id DESC LIMIT ?")
      .all(limit) as { id: string; date: string }[],
    activities: db
      .query("SELECT id FROM activities ORDER BY date DESC, id DESC LIMIT ?")
      .all(limit) as { id: string }[],
  };
}

export function listActivities(limit: number, offset: number): ActivityCard[] {
  const rows = getDb()
    .query(
      `SELECT ${ACTIVITY_CARD_COLUMNS} FROM activities
       ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as ActivityCardRow[];
  return rows.map(rowToActivityCard);
}

export function getActivity(id: string): Activity | null {
  const row = getDb()
    .query("SELECT * FROM activities WHERE id = ?")
    .get(id) as ActivityRow | null;
  return row ? rowToActivity(row) : null;
}
