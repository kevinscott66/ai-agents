/**
 * Слой памяти агента.
 *
 * Архитектура:
 *  - Короткая (диалог): SQLite-таблица messages, последние N сообщений чата.
 *  - Длинная (вики): markdown-файлы в memory/<scope>/. scope = "_team" или <role_key>.
 *    Каждая страница попадает в FTS5-индекс wiki_fts при записи через wikiWrite().
 *
 * Пути:
 *   memory/_team/index.md
 *   memory/_team/log.md
 *   memory/_team/projects/<slug>.md
 *   memory/_team/decisions/<slug>.md
 *   memory/<role>/index.md
 *   memory/<role>/log.md
 *   memory/<role>/pages/<slug>.md
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { db, type ChatRow } from "./db.ts";
import { log, scrubSecretString } from "./log.ts";
import { resolveMemoryDir } from "./memory-dir.ts";

const MEMORY_DIR = resolveMemoryDir(process.env.MEMORY_DIR);

/**
 * Typed error thrown when a wiki slug fails validation (T-312 / T-300 HIGH #4).
 * Action-dispatch maps this to a `rejected` action result with `error: "invalid_slug"`.
 */
export class InvalidSlugError extends Error {
  readonly code = "invalid_slug" as const;
  constructor(reason: string) {
    super(`invalid slug: ${reason}`);
    this.name = "InvalidSlugError";
  }
}

/**
 * Имена файлов, которые страницами вики НЕ являются: общий индекс scope и общий
 * лог. Список ровно один на весь модуль — по нему и `pagePath` отказывает в
 * резолве, и `walkAndIndex` пропускает файл при ребилде. Две отдельные копии
 * этого знания и были дырой: индексатор про исключение знал, резолвер — нет.
 */
const RESERVED_PAGE_NAMES = new Set(["index", "log"]);

/**
 * Slug совпал со служебным именем — страницы с таким именем не существует.
 *
 * Наследник `InvalidSlugError` намеренно: все три потребителя (`WRITE_WIKI`,
 * `READ_WIKI`, `GET /api/wiki/page`) уже ловят родителя и отвечают отказом, а не
 * пятисоткой. Отличается только текст — он объясняет модели, почему slug не
 * подошёл, иначе на голое `invalid_slug` она попробует ровно то же самое ещё раз.
 */
export class ReservedSlugError extends InvalidSlugError {
  constructor(name: string) {
    super(
      name === "log"
        ? `'log' — это общий лог scope, а не страница вики: он дописывается сам, и последние записи уже приходят в системном промпте. Возьми другой slug`
        : `'index' — это общий индекс scope, а не страница вики: он уже приходит в системном промпте целиком. Возьми другой slug`,
    );
    this.name = "ReservedSlugError";
  }
}

const SLUG_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}(\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}){0,3}$/;

export function validateSlug(slug: unknown): string {
  if (typeof slug !== "string") throw new InvalidSlugError("not a string");
  const s = slug.trim();
  if (!s) throw new InvalidSlugError("empty");
  if (s.length > 600) throw new InvalidSlugError("too long");
  if (s.includes("\0")) throw new InvalidSlugError("NUL byte");
  if (s.includes("\\")) throw new InvalidSlugError("backslash not allowed");
  if (!SLUG_RE.test(s)) throw new InvalidSlugError(`does not match slug grammar: '${s}'`);
  return s;
}

function assertWithinRoot(canonical: string, rootCanonical: string) {
  if (canonical !== rootCanonical && !canonical.startsWith(rootCanonical + sep)) {
    throw new InvalidSlugError(`escapes wiki root: ${canonical}`);
  }
}

const WIKI_PII_FILTER_DISABLED = process.env.WIKI_PII_FILTER === "0";

/**
 * Огороженный блок (```…```) или инлайн-код (`…`) вместе с обычным текстом
 * между ними. Захватываем ИМЕННО код, чтобы дальше решать по каждому куску
 * отдельно: `split` по этой регулярке с группой отдаёт чередование
 * текст-код-текст-код-…
 *
 * Незакрытый ``` до конца строки/файла считаем кодом: писатель имел в виду
 * код, а не способ пронести ник мимо фильтра — ник в таком куске всё равно
 * останется на странице вики, которую читают только свои же роли, а вот
 * испорченный сниппет ломает саму цель заметки.
 */
const CODE_SPAN_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

/**
 * Аудит 2026-08-12: правило хэндла не отличало телеграм-ник от собаки в коде.
 * Замер до правки: "```css\n@media (max-width: 600px)…" → "<handle-redacted>
 * (max-width…", "@Injectable()" → "<handle-redacted>()", "@param"/"@returns"
 * в JSDoc — так же. Писатель при этом получал ok:true: страница сохранена,
 * ошибки нет, содержимое уже не то. Пишут такие страницы агенты — это
 * решения и архитектура в долгой памяти команды, и заметить порчу можно
 * только глазами.
 *
 * Инлайн-код выживал случайно (перед @ стоял бэктик, а правило требует
 * пробел, скобку или начало строки) — со `` ` @media ` `` уже не выживал.
 *
 * Почта и телефон редактируются везде, включая код: в примере конфига они
 * настоящие. Ограничение касается только хэндла — единственного правила,
 * которое путает синтаксис с персональными данными.
 */
const HANDLE_RE = /(^|[\s(])@([A-Za-z0-9_]{4,})/g;

/**
 * Аудит 2026-08-20: у правила почты не было понятия TLD, и спецификатор
 * пакета разбирался как адрес — `bun@1.1.30` это «локальная часть `bun`,
 * домен `1`, TLD `1.30`». Замер до правки: `"bun@1.1.30 и hono@4.6.5"` ->
 * `"<email-redacted> и <email-redacted>"`, и внутри ``` тоже, потому что
 * почта режется ДО разбиения на код/не-код (это решение аудита 2026-08-12:
 * в примере конфига почта настоящая, и его тут не трогаем). Писатель при
 * этом получал ok:true — страница сохранена, ошибки нет, версия уже не та.
 *
 * Дискриминатор — последняя метка домена: у настоящего TLD это буквы,
 * минимум две (однобуквенных TLD не существует), у semver-хвоста — цифры.
 * Средние метки по-прежнему любые, поэтому `ivan@mail.sub.example.co.uk`
 * матчится целиком.
 */
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g;

/**
 * Аудит 2026-09-10: вики — единственный постоянный текстовый сток проекта, у
 * которого не было скруббера секретов. У логов он есть (`scrubSecretString`,
 * lib/log.ts, «ALWAYS on — secrets must never log»), у `agent_actions.error` и
 * у снапшота health — тот же самый; здесь фильтровались только персональные
 * данные, да и те выключаются переменной `WIKI_PII_FILTER=0`.
 *
 * Разница в цене как раз обратная той, что была в защите. Строку лога
 * перетирает ротация, а страницу вики не перетирает ничто: файл лежит в
 * `<MEMORY_DIR>/<scope>/pages/**` (по умолчанию `memory/`, см. memory-dir.ts —
 * каталог `agent/data/wiki/**`, который тут был назван, кодом не используется
 * нигде, а в проде `data` и `memory` вообще разные каталоги со своими
 * правилами в systemd и в rsync) до конца жизни проекта, попадает в бэкап,
 * в FTS-индекс
 * и в контекст КАЖДОГО хода — `wikiSearch` подмешивает хиты в промпт, а
 * `wikiLog` читается на каждом хендоффе. Пишут туда модели: `WRITE_WIKI` — их
 * собственный аргумент, а компактор кладёт пересказ переписки, в которой
 * владелец мог продиктовать ключ. Одного `TELEGRAM_SESSION=1BQ…`, попавшего в
 * заметку «как мы чинили юзербота», хватает, чтобы секрет пережил и ротацию,
 * и переустановку.
 *
 * Идёт ДО фильтра PII и до его выключателя: `WIKI_PII_FILTER=0` — про имена и
 * телефоны в примерах конфига, а не разрешение писать на диск ключи. Ровно
 * поэтому у скруббера секретов выключателя нет нигде в проекте.
 *
 * Цена ложного срабатывания — три звёздочки вместо плейсхолдера в примере
 * (`Authorization: Bearer <token>` → `Bearer ***`). Обратная цена — ключ,
 * который никто уже не найдёт.
 */
export function sanitizeWikiContent(input: string): string {
  if (!input) return input;
  const scrubbed = scrubSecretString(input);
  if (WIKI_PII_FILTER_DISABLED) return scrubbed;
  const base = scrubbed
    .replace(EMAIL_RE, "<email-redacted>")
    .replace(/\+\d[\d\s\-()]{8,}\d/g, "<phone-redacted>");
  // Чётные индексы — текст вне кода, нечётные — сам код (группа в регулярке).
  return base
    .split(CODE_SPAN_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(HANDLE_RE, "$1<handle-redacted>"),
    )
    .join("");
}

/** Потолок на заголовок страницы — он живёт одной строкой и в файле, и в индексе. */
const MAX_WIKI_TITLE = 200;

/**
 * Заголовок — такой же недоверенный текст, как и тело.
 *
 * Аудит 2026-08-12: фильтр PII применялся только к content, а рядом стоял
 * комментарий «title is agent-authored, not user content». Для обоих писателей
 * это неверно: у WRITE_WIKI title — аргумент модели, у компактора —
 * `raw.title ?? raw.name ?? slug` из ответа модели, которой на вход подали
 * реплику из чата. Утечка через заголовок к тому же заметнее: title уходит
 * каждым хитом wikiSearch в контекст каждого хода и в Mini App, тогда как тело
 * приходит отредактированным.
 *
 * Плюс структурная часть: перевод строки разрывал `# ${title}` — хвост
 * заголовка становился телом, а `\n# …` — вторым заголовком верхнего уровня.
 * Индекс расходился сам с собой, потому что rebuildWikiIndex после рестарта
 * выводит title из первой строки файла.
 */
export function sanitizeWikiTitle(title: string): string {
  return sanitizeWikiContent(String(title ?? ""))
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, MAX_WIKI_TITLE);
}

/**
 * Подготовить страницу к записи: заголовок, тело и готовый markdown.
 *
 * Одна функция на обоих писателей намеренно. `wikiWrite` и `wikiWriteAsync`
 * собирали `# ${title}\n\n${content}` каждый у себя, и починка одной половины
 * уже однажды не доехала до второй (см. upsertWikiFts, аудит 2026-08-10).
 * Здесь расходиться нечему: и файл, и строка FTS берутся из одного результата.
 */
export function prepareWikiPage(
  title: string,
  content: string,
): { safeTitle: string; safeContent: string; body: string } {
  const safeTitle = sanitizeWikiTitle(title);
  const safeContent = sanitizeWikiContent(content).trim();
  return { safeTitle, safeContent, body: `# ${safeTitle}\n\n${safeContent}\n` };
}

/**
 * Тело страницы для колонки `content` в FTS — то же, что положил писатель.
 *
 * Аудит 2026-09-11: писатель индексировал `safeContent`, то есть тело БЕЗ
 * строки заголовка, а `walkAndIndex` при ребилде — весь файл, вместе с
 * `# Заголовок`, который сам же `prepareWikiPage` и приклеил. Колонка `title`
 * при этом сводилась корректно; расходилась ровно `content`.
 *
 * Стоило это устойчивости выдачи. `rebuildWikiIndex()` идёт первой строкой
 * старта команды и переливает таблицу целиком, так что после рестарта слова
 * из заголовка начинали матчиться ещё и по `content`: bm25 менял вес, порядок
 * хитов менялся, `snippet(wiki_fts, 3, …)` начинал отдавать «# Заголовок»
 * вместо начала тела. Потребители читают фиксированные четыре хита и уезжают
 * в system-промпт каждого хода — то есть смена порядка вытесняла страницу из
 * контекста. Одна и та же вика на диске давала разную память до и после
 * рестарта.
 */
export function wikiFtsContent(fileText: string): string {
  return fileText.replace(/^#[^\n]*\n?/, "").trim();
}

/* ────── короткая (диалог) ────── */

export function recordMessage(args: {
  chatId: string;
  agentKey: string | null; // 'orchestrator'|'pm'|... либо null для пользователя
  isBot: boolean;
  fromUserId: string;
  fromName: string | null;
  text: string;
  ts?: number;
  tgMessageId?: number; // Telegram message ID for deduplication
  transport?: 'bot_api' | 'userbot'; // Transport method
}) {
  // T-543: дедуп по (chat_id, tg_message_id), когда известен id Telegram.
  //
  // Аудит 2026-08-12: было `INSERT OR IGNORE`, и оно съедало расшифровки
  // голосовых. У voice-сообщения `msg.message === ""`: userbot пишет пустую
  // строку мгновенно, Whisper приезжает через несколько секунд и отбрасывался
  // целиком — в истории оставалась строка без текста. Замер: «строк в истории:
  // 1 [{"text":"","transport":"userbot"}]».
  //
  // Дозапись разрешена ровно в одну сторону: пустой текст можно заполнить,
  // непустой — переписать нельзя, иначе поздний дубликат подменял бы уже
  // сказанное. `WHERE` в ON CONFLICT — часть таргета частичного индекса
  // idx_messages_dedup (миграция 030), без него SQLite цель не находит.
  if (args.tgMessageId) {
    db.prepare(
      `INSERT INTO messages(
        chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, tg_message_id, transport
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL
       DO UPDATE SET text = excluded.text, transport = excluded.transport
        WHERE messages.text = '' AND excluded.text <> ''`
    ).run(
      args.chatId,
      args.agentKey,
      args.isBot ? 1 : 0,
      args.fromUserId,
      args.fromName,
      args.text,
      args.ts ?? Date.now(),
      args.tgMessageId,
      args.transport ?? 'bot_api'
    );
  } else {
    // Fallback to original behavior for compatibility
    db.prepare(
      `INSERT INTO messages(chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, transport)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.chatId,
      args.agentKey,
      args.isBot ? 1 : 0,
      args.fromUserId,
      args.fromName,
      args.text,
      args.ts ?? Date.now(),
      args.transport ?? 'bot_api'
    );
  }
}

/**
 * Последние `limit` сообщений чата, от старого к новому.
 *
 * Аудит 2026-08-12: сортировка была `ORDER BY ts DESC` без тай-брейкера, и
 * сообщения одной секунды приезжали модели ЗАДОМ НАПЕРЁД. Совпадающий ts — не
 * редкость: входящие пишутся временем Telegram, а у него гранулярность
 * секунда (`date * 1000`). Порядок при этом не случайный, а стабильно
 * обратный: индекс idx_messages_chat_ts(chat_id, ts DESC) сканируется вперёд,
 * внутри равного ts строки идут по rowid возрастающему, а сверху ещё
 * `.reverse()`.
 *
 * `id` — AUTOINCREMENT, то есть настоящий порядок вставки; для равных ts это и
 * есть порядок реплик.
 */
export function getRecentMessages(chatId: string, limit = 30): ChatRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT ?`
    )
    .all(chatId, limit) as ChatRow[];
  return rows.reverse(); // от старого к новому
}

/* ────── длинная (вики, markdown) ────── */

export type Scope = "_team" | (string & {});

function scopeDir(scope: Scope): string {
  return join(MEMORY_DIR, scope);
}

/**
 * Канонический slug страницы — путь файла относительно каталога scope, без
 * `.md`. Один файл = один slug, независимо от того, в какой форме его назвал
 * вызывающий.
 *
 * Аудит 2026-08-08: раньше двух форм было ровно две, и они расходились.
 * wikiWrite индексировал страницу под slug'ом, который пришёл от модели
 * («roadmap»), а файл клал в `<scope>/pages/roadmap.md`. rebuildWikiIndex при
 * старте стирал индекс и заполнял его из файловой системы, выводя slug из пути
 * («pages/roadmap»). Читаются обе формы в один и тот же файл, поэтому
 * расхождение ничем не проявлялось — до первой перезаписи страницы после
 * рестарта: DELETE по «roadmap» не попадал в строку «pages/roadmap», и в
 * индексе оказывались ДВЕ строки на один файл, причём у старой — устаревшее
 * содержимое.
 *
 * Это основной путь, а не край: SYSTEM компактора требует slug вида
 * `<kebab>` без слэша, то есть под правило попадали все личные страницы всех
 * 12 ролей. Последствия — дубли в Wiki-вью Mini App и потраченные слоты в
 * промпте: wikiSearch отдавал один файл дважды, а потребители читают по 4
 * хита.
 */
export function slugFromPath(scope: string, absPath: string): string {
  const rel = relPathSlug(scope, absPath);
  // Канонической берём ту форму, которую агенты уже используют (без каталога
  // по умолчанию): её требует SYSTEM компактора, её же возвращает SEARCH_WIKI,
  // и она обратима — pagePath подставляет этот каталог ровно для slug'ов без
  // слэша, так что схлопываем только один уровень и только его.
  const defaultDir = scope === "_team" ? "projects" : "pages";
  const parts = rel.split("/");
  if (parts.length === 2 && parts[0] === defaultDir) return parts[1]!;
  return rel;
}

/** Путь файла относительно scope без `.md` — форма ключа до этого фикса. */
function relPathSlug(scope: string, absPath: string): string {
  return relative(scopeDir(scope as Scope), absPath)
    .replace(/\\/g, "/")
    .replace(/\.md$/, "");
}

/**
 * Путь файла страницы по её slug'у — обратное к `slugFromPath`.
 *
 * Аудит 2026-08-10: обратным оно было не для всех ключей. rebuildWikiIndex
 * индексирует и файлы, лежащие прямо в корне scope (ручные правки — ровно то,
 * ради чего ребилд и написан): у `<scope>/foo.md` относительный путь «foo»,
 * без слэша. А pagePath для slug'а без слэша подставляет каталог по умолчанию
 * и возвращает `<scope>/pages/foo.md`, которого нет. Страница находилась
 * поиском, попадала в /api/wiki/list и в хиты SEARCH_WIKI — и читалась пустой:
 * потребитель промпта получал заголовок без тела и потраченный слот из четырёх.
 *
 * Поэтому каталог по умолчанию теперь предпочитается, а не назначается: если
 * там файла нет, а в корне scope есть — берётся корневой. Порядок важен и в
 * обратную сторону: новая страница по-прежнему создаётся в каталоге по
 * умолчанию (ни один кандидат не существует → первый), а при коллизии двух
 * файлов на один slug выигрывает тот, куда идёт запись.
 *
 * Ценой стал stat на кандидата. На фоне того, что вызывающий тут же читает или
 * пишет файл (а на пути агентов — ещё и ждёт ответа модели), это ничто; хуже
 * была бы вторая копия резолвинга в async-половине, которая уже один раз
 * разъехалась с синхронной (см. upsertWikiFts).
 */
export function pagePath(scope: Scope, slug: string): string {
  // Validate slug strictly before any filesystem operation — prevents
  // path traversal via `..`, absolute paths, NUL bytes, etc. (T-312).
  const safeSlug = validateSlug(slug);

  // Служебные файлы scope страницами не являются, и резолв в них — это не
  // «коллизия двух страниц на один slug», разобранная выше, а запись мимо
  // пространства страниц вообще. Без этой проверки `slug:"index"` в `_team`
  // проходил корневым кандидатом прямо в `_team/index.md` — общий индекс
  // команды, который уходит в системный промпт всех двенадцати ролей, — и
  // затирал его целиком с ответом `{ok:true}`. `slug:"log"` тем же способом
  // сносил append-only лог команды.
  //
  // Сравнение по последнему сегменту и без учёта регистра: `walkAndIndex`
  // пропускает `index.md` на любой глубине, а на регистронезависимой ФС (Mac
  // разработчика) `Index` и `index` — один файл.
  const base = safeSlug.slice(safeSlug.lastIndexOf("/") + 1);
  if (RESERVED_PAGE_NAMES.has(base.toLowerCase())) {
    throw new ReservedSlugError(base.toLowerCase());
  }

  // slug может быть с подпапками типа "projects/foo" или "decisions/bar"
  const defaultDir = scope === "_team" ? "projects" : "pages";
  const candidates = safeSlug.includes("/")
    ? [join(scopeDir(scope), `${safeSlug}.md`)]
    : [
        join(scopeDir(scope), defaultDir, `${safeSlug}.md`),
        join(scopeDir(scope), `${safeSlug}.md`),
      ];
  const candidate = candidates.find((c) => existsSync(c)) ?? candidates[0]!;

  // Defense-in-depth: even with a validated slug, resolve canonical paths and
  // assert containment within MEMORY_DIR. If anything is fishy, refuse.
  const rootCanonical = resolve(MEMORY_DIR);
  const canonical = resolve(candidate);
  assertWithinRoot(canonical, rootCanonical);
  return canonical;
}

export function wikiRead(scope: Scope, slug: string): string | null {
  const p = pagePath(scope, slug);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

/**
 * Сколько страниц попадает в сгенерированный индекс.
 *
 * Индекс уезжает в system-промпт КАЖДОГО хода двенадцати ролей, причём два из
 * трёх читателей (`buildWikiPagesSystemText` в handoff.ts и в
 * orchestrator/message-handler.ts — координаты не пишем, они разъезжаются) не режут
 * его ничем. 120 строк по ~60 символов — около 7KB, это потолок, а не типичный
 * размер: столько страниц в вики пока нет ни в одной области.
 */
export const WIKI_INDEX_MAX_PAGES = 120;

/**
 * Индекс из фактических страниц области.
 *
 * Аудит 2026-08-13: у `index.md` три читателя и НОЛЬ писателей. Ни компактор, ни
 * WRITE_WIKI, ни ребилд индекса его не создают — файла просто нет. То есть в
 * промпте каждой из 12 ролей каждый ход стояли два пустых блока «ОБЩИЙ ИНДЕКС
 * КОМАНДЫ» и «ЛИЧНЫЙ ИНДЕКС», а правило компактора «посмотри индекс, не создавай
 * дубль» (SYSTEM в compactor.ts) не могло сработать физически: он сверялся с
 * пустой строкой и заводил новую страницу на каждую тему заново.
 *
 * Источник — wiki_fts, а не обход каталога: таблица уже держит (scope, slug,
 * title) для каждой страницы, обновляется на каждой записи (upsertWikiFts) и
 * пересобирается на старте. Отдельного писателя index.md заводить не стали
 * намеренно: третий писатель в ту же папку — это третья гонка с компактором и
 * WRITE_WIKI, а генерация на чтении не может протухнуть.
 */
export function buildWikiIndex(
  scope: Scope,
  limit: number = WIKI_INDEX_MAX_PAGES,
): string {
  let rows: { slug: string; title: string }[];
  try {
    rows = db
      .prepare(
        `SELECT slug, title FROM wiki_fts WHERE scope = ? ORDER BY slug LIMIT ?`,
      )
      .all(scope, limit) as { slug: string; title: string }[];
  } catch (e) {
    // Индекс — украшение промпта, а не его условие. Битая БД не должна ронять
    // ход: пустой индекс агент переживёт, исключение отсюда — нет.
    log.warn("wiki: индекс не собрался — отдаю пустой", { scope, e: String(e) });
    return "";
  }
  return rows
    .map((r) => (r.title && r.title !== r.slug ? `- ${r.slug} — ${r.title}` : `- ${r.slug}`))
    .join("\n");
}

export function wikiIndex(scope: Scope): string {
  const p = join(scopeDir(scope), "index.md");
  // Файл, если его завели руками, главнее: человек мог отобрать страницы
  // осмысленнее, чем алфавит. Пустой файл за такой отбор не считаем.
  if (existsSync(p)) {
    const s = readFileSync(p, "utf8");
    if (s.trim()) return s;
  }
  return buildWikiIndex(scope);
}

/**
 * Сколько байт хвоста лога отдаётся читателям.
 *
 * Обоим потребителям (handoff.ts, orchestrator/message-handler.ts) нужны
 * последние 30 строк — при ~270 байт на строку 64KB это около 240 строк, запас
 * почти в десять раз. Читать больше незачем: остальное всё равно выбрасывается
 * следующей же строкой кода.
 */
export const WIKI_LOG_TAIL_BYTES = 64 * 1024;

/** Порог, после которого дописывание подрезает файл до хвоста. */
export const WIKI_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Выбросить первую строку куска, прочитанного с середины файла.
 *
 * Смещение почти никогда не попадает на границу строки, а внутри строки — ещё
 * и на границу многобайтного символа. Обрубок непригоден и как текст, и как
 * данные: отдаём только то, что начинается с настоящего начала строки.
 */
export function dropPartialFirstLine(chunk: string): string {
  const nl = chunk.indexOf("\n");
  return nl === -1 ? "" : chunk.slice(nl + 1);
}

/** Последние maxBytes байт файла, обрезанные по границе строки. */
function readTail(p: string, maxBytes: number): string {
  const size = statSync(p).size;
  if (size <= maxBytes) return readFileSync(p, "utf8");
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, size - maxBytes);
    return dropPartialFirstLine(buf.subarray(0, read).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/**
 * Лог команды. Читается на каждом хендоффе и на каждом сообщении, поэтому
 * стоимость чтения не должна зависеть от того, сколько команда проработала:
 * раньше файл поднимался целиком ради последних 30 строк, а расти он может
 * бесконечно (см. wikiAppendLog).
 */
export function wikiLog(scope: Scope): string {
  const p = join(scopeDir(scope), "log.md");
  if (!existsSync(p)) return "";
  return readTail(p, WIKI_LOG_TAIL_BYTES);
}

export function wikiAppendLog(scope: Scope, line: string, agentKey: string) {
  if (!line || typeof line !== "string") return;
  const p = join(scopeDir(scope), "log.md");
  mkdirSync(dirname(p), { recursive: true });
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  // T-305 MED-2: sanitize user-PII patterns before persisting to wiki log.
  const safeLine = sanitizeWikiContent(line).replace(/\n/g, " ").slice(0, 240);
  appendFileSync(p, `\n${ts} | ${agentKey} | ${safeLine}`);
  trimWikiLog(p);
}

/**
 * Подрезать лог с головы, если он перерос порог.
 *
 * Ротации у этого файла нет и не было: компактор дописывает строку на каждую
 * сводку, никто и никогда не укорачивал. Старые записи не читает ни один
 * потребитель — из файла всегда берут хвост.
 *
 * Аудит 2026-08-12: подрезок было две. Здесь — `writeFileSync` поверх
 * прочитанного хвоста, и такая же, отдельно написанная, в асинхронном близнеце
 * (`wikiAppendLogAsync`), где между `stat`, чтением хвоста и записью стоят три
 * `await`: дописанное в этот промежуток затирается копией, прочитанной до него.
 * Шапка memory-async.ts сама объясняет, почему так нельзя — «разъезд этой пары
 * уже стоил двух багов (upsertWikiFts, pagePath)» — и ровно этот файл разъехался
 * дальше: синхронная копия о неудаче предупреждает в лог, асинхронная глотала
 * молча. Реализация теперь одна, и зовут её обе.
 *
 * Запись идёт через временный файл и `rename`: `writeFileSync` сперва обрезает
 * файл в ноль, и падение процесса в этот момент оставляло бы от общего лога
 * команды пустышку. `rename` в пределах каталога атомарен — читатель видит либо
 * старый файл целиком, либо новый целиком.
 */
export function trimWikiLog(p: string): void {
  const tmp = `${p}.tmp`;
  try {
    if (statSync(p).size <= WIKI_LOG_MAX_BYTES) return;
    writeFileSync(tmp, readTail(p, WIKI_LOG_TAIL_BYTES));
    renameSync(tmp, p);
  } catch (e) {
    // Подрезка — обслуживание, а не часть записи: строка уже на диске, и терять
    // её из-за неудавшегося обслуживания нельзя.
    log.warn("wiki: лог не удалось подрезать", { file: p, e: String(e) });
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* временный файл переживёт до следующей подрезки — он не читается никем */
    }
  }
}

/**
 * Имя временного файла рядом с целевым — для записи страницы через rename.
 *
 * Уникальное на вызов, а не фиксированное `${p}.tmp` как у подрезки лога: у
 * страницы писателей двое (синхронный компактор и WRITE_WIKI через
 * wikiWriteAsync), и на общий временный файл они наложились бы друг на друга —
 * один пишет тело A, второй поверх тело B, дальше оба зовут rename, и
 * страница получает чужое содержимое дважды. У лога писатель один.
 *
 * Суффикс `.tmp`, а не `.md`: `walkAndIndex` берёт только `*.md`, поэтому
 * недописанный или осиротевший временный файл не попадёт в индекс, даже если
 * переживёт падение процесса.
 */
let pageTmpSeq = 0;
export function pageTmpPath(p: string): string {
  pageTmpSeq = (pageTmpSeq + 1) % 1_000_000;
  return `${p}.${process.pid}.${pageTmpSeq}.tmp`;
}

/**
 * Запись страницы: временный файл рядом → `rename`.
 *
 * Страница писалась поверх себя (`writeFileSync` / `await writeFile`), а это
 * сперва обрезание файла в ноль, потом запись тела. То же самое двумя абзацами
 * выше уже посчитали неприемлемым для log.md — а страница как минимум не
 * дешевле: её содержимое агенты писали руками, и восстановить его неоткуда.
 *
 * Что это чинит: смерть процесса между обрезанием и записью (deploy делает
 * `systemctl restart` в любой момент, OOM-killer тоже) — на диске оставался бы
 * пустой или недописанный файл, и `rebuildWikiIndex` на следующем старте
 * занёс бы обрубок в FTS. И чтение страницы чужим процессом: `tar` бэкапа
 * ходит по этому же каталогу, там однопоточность JS не гарантирует ничего.
 *
 * Чего это НЕ чинит, замерено, а не предположено:
 *  - Читателей внутри процесса. Bun выполняет `fs.promises.writeFile` одной
 *    задачей пула, не отдавая цикл событий между open(O_TRUNC) и write, —
 *    замер на телах 12 KB / 1 MB / 20 MB не показал ни одного промежуточного
 *    состояния. То есть READ_WIKI, сборка промпта и компактор обрубок увидеть
 *    не могли и до правки.
 *  - Потерю обновления. `mergeAndWrite` — read-modify-write без блокировки, и
 *    параллельная запись в тот же слаг по-прежнему может потеряться целиком.
 *    Атомарность записи убирает обрубки, а не гонку за содержимое.
 */
export function writePageAtomic(p: string, body: string): void {
  const tmp = pageTmpPath(p);
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, p);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* осиротевший .tmp не читается никем и не индексируется */
    }
    throw e;
  }
}

export function wikiWrite(args: {
  scope: Scope;
  slug: string;
  title: string;
  content: string;
}) {
  const p = pagePath(args.scope, args.slug);
  mkdirSync(dirname(p), { recursive: true });
  // T-305 MED-2: sanitize user-PII patterns before persisting to wiki + FTS index.
  // Заголовок — не исключение: см. prepareWikiPage.
  const { safeTitle, safeContent, body } = prepareWikiPage(args.title, args.content);
  writePageAtomic(p, body);

  // FTS5 upsert: удаляем строку по (scope, slug), вставляем заново.
  // Ключ — канонический slug из пути файла, а не тот, что назвал вызывающий:
  // иначе «roadmap» и «pages/roadmap» дают две строки на один файл (см.
  // slugFromPath).
  // Удаляем по всем формам ключа, какие могли попасть в индекс для этого
  // файла: канонической, названной вызывающим и путевой (её оставляли старые
  // сборки rebuildWikiIndex). Иначе перезапись не вычистит дубль, а полагаться
  // на то, что рестарт успел пересобрать индекс, — не гарантия.
  upsertWikiFts(args.scope, args.slug, p, safeTitle, safeContent);
}

/**
 * Заменить строку FTS для страницы, лежащей в `absPath`.
 *
 * Вынесено из wikiWrite в общую функцию после аудита 2026-08-10: фикс
 * канонического ключа (2026-08-08) правил только эту, синхронную половину, а
 * асинхронный близнец `wikiWriteAsync` продолжал писать slug вызывающего и
 * удалять ровно одну его форму. Через async идёт WRITE_WIKI — основной путь
 * записи агентами; sync остался у одного компактора. То есть починили ту
 * половину, которой почти не пользуются.
 *
 * Пока деривация ключа скопирована в двух файлах, она будет расходиться снова,
 * поэтому теперь она здесь одна на обоих писателей.
 */
export function upsertWikiFts(
  scope: string,
  callerSlug: string,
  absPath: string,
  title: string,
  safeContent: string,
): void {
  // Ключ — канонический slug из пути файла, а не тот, что назвал вызывающий:
  // иначе «roadmap» и «pages/roadmap» дают две строки на один файл (см.
  // slugFromPath).
  // Удаляем по всем формам ключа, какие могли попасть в индекс для этого
  // файла: канонической, названной вызывающим и путевой (её оставляли старые
  // сборки rebuildWikiIndex). Иначе перезапись не вычистит дубль, а полагаться
  // на то, что рестарт успел пересобрать индекс, — не гарантия.
  const canonical = slugFromPath(scope, absPath);
  // Аудит 2026-08-20: DELETE и INSERT шли двумя отдельными операциями, то есть
  // в WAL — двумя коммитами. Между ними страница уже лежит на диске: и
  // wikiWrite, и wikiWriteAsync сначала делают rename, и только потом идут
  // сюда. Если INSERT не проходит — SQLITE_FULL на забитом разделе (туда же
  // пишутся бэкапы и холодный экспорт), SQLITE_BUSY от второго процесса
  // (tools/*, query-db-worker), сбой FTS5, либо процесс убит при деплое ровно
  // между вызовами, — файл остаётся, а строки в индексе нет ВООБЩЕ. Для
  // wikiSearch и списков в Mini App страница при этом просто исчезает, хотя
  // наружу вернулась ошибка «запись не удалась».
  //
  // Тот же аргумент дословно записан у rebuildWikiIndex («частичный индекс
  // внешне неотличим от полного») — там транзакция есть, сюда она не доехала.
  db.transaction(() => {
    db.prepare(`DELETE FROM wiki_fts WHERE scope = ? AND slug IN (?, ?, ?)`).run(
      scope,
      canonical,
      callerSlug,
      relPathSlug(scope, absPath),
    );
    db.prepare(
      `INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`
    ).run(scope, canonical, title, safeContent);
  })();
}

export interface WikiHit {
  scope: string;
  slug: string;
  title: string;
  snippet: string;
}

export function wikiSearch(query: string, scopes: Scope[] = ["_team"], limit = 5): WikiHit[] {
  // Простой OR-запрос по словам, отбрасываем короткие.
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, " ") // дефис → пробел, чтобы FTS5 не парсил как column:
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 8);
  if (!tokens.length) return [];
  // Оборачиваем каждый токен в двойные кавычки — FTS5 трактует как фразу-литерал.
  const fts = tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
  const placeholders = scopes.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT scope, slug, title, snippet(wiki_fts, 3, '«', '»', '…', 12) as snippet, rank
       FROM wiki_fts
       WHERE wiki_fts MATCH ? AND scope IN (${placeholders})
       ORDER BY rank LIMIT ?`
    )
    .all(fts, ...scopes, limit) as Array<WikiHit & { rank: number }>;
  return rows;
}

export interface WikiPageRef {
  scope: string;
  slug: string;
  title: string;
}

/**
 * Потолок выдачи wikiList. 500 — с запасом больше, чем накопили все 12 ролей,
 * то есть в обычной жизни не срабатывает вовсе; это ограничитель, а не пагинация.
 */
export const WIKI_LIST_MAX = 500;

/**
 * P1 (2026-06-09): список всех wiki-страниц для Mini App «Wiki»-вью.
 * Источник — FTS-индекс (scope, slug, title). Опциональный фильтр по scope.
 *
 * Аудит 2026-08-12: LIMIT не было вообще — ни в запросе, ни у вызывающего.
 * Вики append-only и растёт от каждого хода компактора у каждой из 12 ролей, а
 * `SELECT … ORDER BY scope, slug` без потолка складывает её целиком в память и
 * в один JSON-ответ. Ручка при этом доступна любому из allowlist и не считается
 * рейт-лимитом как GET. Явный аргумент вместо «ну столько не бывает»: у
 * вызывающего есть способ узнать, что выдачу обрезали (запросить limit+1).
 */
export function wikiList(scope?: string, limit: number = WIKI_LIST_MAX): WikiPageRef[] {
  const lim = Math.max(1, Math.floor(limit));
  if (scope) {
    return db
      .prepare(
        `SELECT scope, slug, title FROM wiki_fts WHERE scope = ? ORDER BY slug LIMIT ?`,
      )
      .all(scope, lim) as WikiPageRef[];
  }
  return db
    .prepare(`SELECT scope, slug, title FROM wiki_fts ORDER BY scope, slug LIMIT ?`)
    .all(lim) as WikiPageRef[];
}

/**
 * Разделы, в которых есть хоть одна страница.
 *
 * Аудит 2026-08-21: Wiki-вью строил выпадающий список разделов из УЖЕ
 * полученной выдачи, а выдача обрезана потолком в 500 и упорядочена по
 * (scope, slug). Замер: 600 страниц в `_team` плюс по три в `qa` и `smm` —
 * в списке разделов остаётся один `_team`, страниц `qa` не видно ни одной,
 * и выбрать раздел `qa`, чтобы их достать, тоже нельзя: его нет в списке.
 *
 * Разделов не больше, чем ролей плюс `_team`, так что DISTINCT здесь дешёвый
 * и потолка не требует. Список полный по определению — тем он и отличается от
 * выведенного из обрезанной выдачи.
 */
export function wikiScopes(): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT scope FROM wiki_fts ORDER BY scope`)
    .all() as Array<{ scope: string }>;
  return rows.map((r) => r.scope);
}

/* ────── ребилд FTS5 при старте (на случай ручных правок вики) ────── */

/**
 * Пересобрать FTS-индекс вики из файлов на диске.
 *
 * Зовётся первой строкой main() при каждом старте. Аудит 2026-08-10 нашёл тут
 * две вещи, и обе про порядок.
 *
 * 1. Очистка таблицы стояла ПЕРЕД `if (!existsSync(MEMORY_DIR)) return`.
 *    Проверка, написанная ровно на этот случай, срабатывала уже после
 *    разрушения: опечатка в MEMORY_DIR, непримонтированный том, переезд
 *    каталога — и старт молча оставляет всем 12 ролям пустой индекс, вернувшись
 *    штатно и без единой строки в логе.
 *
 * 2. Сборка шла вне транзакции, по одному INSERT'у в автокоммите. Сбой на
 *    середине обхода оставлял индекс частичным (или пустым — очистка к тому
 *    моменту уже зафиксирована), а исключение уходило в main(): старт падал,
 *    systemd перезапускал, ребилд падал на том же файле.
 *
 * Теперь индекс либо заменяется целиком, либо не трогается. Нечитаемый
 * отдельный файл пропускается — терять из-за него вики всей команде незачем;
 * ошибка БД, наоборот, откатывает всё, потому что частичный индекс внешне
 * неотличим от полного.
 *
 * `root` — тестовый шов: прод зовёт без аргумента.
 */
export function rebuildWikiIndex(root: string = MEMORY_DIR) {
  const fs = require("node:fs");
  if (!existsSync(root)) {
    log.warn("wiki: каталог памяти не найден — индекс оставлен прежним", {
      dir: root,
    });
    return;
  }
  let scopes: string[];
  try {
    scopes = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d: any) => d.isDirectory())
      .map((d: any) => d.name as string);
  } catch (e) {
    log.error("wiki: каталог памяти не читается — индекс оставлен прежним", {
      dir: root,
      e: String(e),
    });
    return;
  }
  try {
    db.transaction(() => {
      db.prepare(`DELETE FROM wiki_fts`).run();
      for (const scope of scopes) {
        walkAndIndex(scope, join(root, scope));
      }
    })();
  } catch (e) {
    log.error("wiki: ребилд индекса не удался — прежний индекс сохранён", {
      e: String(e),
    });
  }
}

function walkAndIndex(scope: string, dir: string) {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndIndex(scope, full);
    } else if (
      entry.name.endsWith(".md") &&
      // Тот же список, что и у `pagePath`: разъезд этих двух знаний и был
      // дырой — индексатор служебные файлы пропускал, резолвер в них писал.
      !RESERVED_PAGE_NAMES.has(entry.name.slice(0, -3).toLowerCase())
    ) {
      // Один нечитаемый файл (битый симлинк, права, исчез между readdir и
      // чтением) не должен стоить вики всей команде: раньше он ронял ребилд
      // целиком, уже после очистки таблицы.
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch (e) {
        log.warn("wiki: страница не прочиталась — пропущена при ребилде", {
          file: full,
          e: String(e),
        });
        continue;
      }
      const firstLine = content.split("\n")[0]?.replace(/^#\s*/, "").trim() ?? entry.name;
      // Ровно то, что кладёт писатель: без строки заголовка (см.
      // wikiFtsContent). Заголовок остаётся в своей колонке.
      const ftsBody = wikiFtsContent(content);
      // Тот же ключ, что и у wikiWrite. Заодно ушёл RegExp, собранный из
      // MEMORY_DIR: путь из окружения попадал в шаблон неэкранированным.
      const slug = slugFromPath(scope, full);
      // Аудит 2026-08-12: слаг сюда клали БЕЗ проверки, а читатель проверяет
      // строго — pagePath первой строкой зовёт validateSlug. Файл, положенный
      // руками (`roadmap.v2.md`, `release notes.md`, кириллица, вложенность >4),
      // давал слаг вне грамматики. Дальше хит SEARCH_WIKI уходил в
      // wikiReadAsync прямо внутри Promise.all при сборке промпта, и
      // InvalidSlugError ронял весь ход: в message-handler — «внутренняя
      // ошибка» пользователю, в handoff — молчащий делегат. И так для любого
      // сообщения, чьи токены попадали в FTS-запрос по этой странице.
      //
      // Пропускаем с предупреждением: страница не видна, зато её имя названо в
      // логе и её можно переименовать. Инвариант — в индексе нет ключей,
      // которые читатель не примет.
      try {
        validateSlug(slug);
      } catch {
        log.warn("wiki: имя файла не укладывается в грамматику слага — страница не проиндексирована", {
          file: full,
          slug,
        });
        continue;
      }
      db.prepare(
        `INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`
      ).run(scope, slug, firstLine, ftsBody);
    }
  }
}
