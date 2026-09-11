/**
 * Structured logging module
 * Replaces scattered console.log calls with leveled, structured JSON logging
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogData = Record<string, unknown>;

/**
 * SEC-audit 2026-06-10: centralized secret scrubber. Defense-in-depth so a
 * careless `log.x("...", { token })` or a token-bearing URL never lands in
 * logs verbatim. ALWAYS on (unlike PII redaction) — secrets must never log.
 */
const SENSITIVE_KEY =
  /(token|secret|password|passwd|authorization|bearer|api[-_]?key|access[-_]?key|private[-_]?key|x-figma-token)/i;
// initdata: полноценный, реиграбельный 24 часа credential — перехват даёт
// полную имперсонацию пользователя на всех /api/*. В query-строке его сегодня
// нет: SSE-подключение ходит по одноразовому билету (lib/sse-ticket.ts), а
// приём `?initData=` убран специально. Слово остаётся здесь именно поэтому —
// оно стережёт возврат канала, а не описывает живой: любой будущий лог с
// полным URL уже будет вычищен.
// Аудит 2026-09-10: имя параметра сверялось с началом, а приставки бывают
// почти всегда. `?refresh_token=`, `&client_secret=`, `&x-api-key=` не
// совпадали ни с одной альтернативой: `token` требовалось СРАЗУ после `?`/`&`.
// То есть правило ловило учебную форму и пропускало ту, что выдают настоящие
// OAuth-редиректы и подписанные ссылки. Приставка допускается только
// отделённая `_`, `-` или `.` — иначе `?monkey=` считался бы `key`.
// Длина приставки ограничена: `[…]*` перед обязательным разделителем даёт
// возврат по одному символу с каждой стартовой позиции, то есть ту же
// квадратичную стоимость, из-за которой ниже стоит `{0,30}` у CREDENTIAL_URL.
const QS_SECRET_NAME =
  "(?:token|secret|password|passwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|key|auth|authorization|session|initdata|signature|sig)";
const INLINE_QS_SECRET = new RegExp(
  `([?&](?:[a-z0-9\\[\\].-]{0,40}[_.-])?${QS_SECRET_NAME}=)[^&\\s"']+`,
  "gi",
);
/**
 * `Имя: значение` — вторая форма записи того же самого.
 *
 * Аудит 2026-09-10: скраббер знал `ИМЯ=значение` (форма `.env`) и
 * `?имя=значение` (форма URL), но не знал формы с двоеточием, а именно она
 * выходит из всего, что печатает заголовки и структуры: `X-Api-Key: …` в
 * `curl -v` и в дампе ответа, `{"token":"…"}` в теле ошибки чужого API,
 * `password: …` в YAML. Всё это — вывод произвольной команды с мака
 * (`MAC_RUN_CLAUDE`), который идёт в чат и в `agent_actions.error`, то есть в
 * SQLite и наружу админам через `/api/actions`. Заголовок `Authorization`
 * закрывал BEARER, но только когда у значения есть схема `Bearer`/`Basic`; у
 * ключей в собственных заголовках (`X-Api-Key`, `X-Figma-Token`) схемы нет.
 *
 * Правило намеренно УЖЕ, чем список выше: без голых `key`, `auth`, `session`.
 * В прозе и в выводе программ «key: …», «session: …» — обычные слова
 * («unknown key: foo»), и маскировать их значит ломать диагностику ради
 * ложного срабатывания — тот же довод, по которому узко правило OPENAI_KEY.
 * В query-строке таких слов не бывает, поэтому там список шире.
 *
 * Идёт ПЕРВЫМ в цепочке: схема (`Bearer`, `Basic`, `Token`) входит в
 * сохраняемую часть, так что `Authorization: Bearer abc` даёт
 * `Authorization: Bearer ***` — тип авторизации в логе остаётся. Если бы
 * правило шло после BEARER, оно бы срабатывало на уже замаскированном
 * значении и печатало `*** ***`.
 *
 * `@` из класса значения исключён: без этого в
 * `https://x-access-token:ghp_…@github.com/x` значение съело бы и хост, а имя
 * хоста в логе нужно — CREDENTIAL_URL ниже сохраняет его намеренно.
 *
 * В скрипты-сканеры (deploy/vps-autonomous/scan-staged-secrets.sh и
 * .github/scripts/check-secret-hygiene.sh) эта форма НЕ добавляется, и паритет
 * семи форм это не нарушает: те работают по staged-диффу репозитория, где
 * `token: …` стоит в каждом втором YAML и JSON — гейт стал бы неотличим от
 * шума. Здесь граница выходная, цена ложного срабатывания — три звёздочки в
 * логе.
 */
const LABELED_SECRET_NAME =
  "(?:token|secret|password|passwd|passphrase|api[-_]?key|apikey|access[-_]?key|private[-_]?key|authorization|initdata|credentials?)";
const LABELED_SECRET = new RegExp(
  `((?<![A-Za-z0-9])["']?(?:[A-Za-z0-9\\[\\].-]{0,40}[_.-])?${LABELED_SECRET_NAME}["']?\\s*:\\s*` +
    `(?:(?:Bearer|Basic|Token)\\s+)?["']?)[^\\s,;"'\`}\\]@]+`,
  "gi",
);
/**
 * `curl -u user:password` — форма, в которой пароль печатает сам вызывающий.
 * Имя пользователя остаётся: по нему видно, чей доступ нужно отзывать.
 */
const CURL_USERPASS = /((?:^|\s)(?:-u|--user)[= ]\s*["']?[^\s:"']{1,64}:)[^\s"']+/g;
/**
 * Значение заголовка `Authorization` внутри обычного текста.
 *
 * Аудит 2026-08-29: класс значения был `[A-Za-z0-9._\-]+` — без `+`, `/` и
 * `=`, то есть без трёх символов base64. На обычном base64-токене прогон
 * обрывался на первом же из них, и в лог уезжал хвост: у 44-символьного
 * значения переживало в среднем около двух третей. Уезжало не «в файл на
 * машине владельца» — `scrubSecretString` стоит на выходной границе
 * `agent_actions.error` и снапшота health, то есть остаток ключа попадал в
 * SQLite и наружу админам через `/api/actions` и SSE.
 *
 * Соседний `SECRET_ASSIGNMENT` в этом же файле уже считал `+` и `/` частью
 * секрета (`[A-Za-z0-9_/+.:-]{16,}`) — файл противоречил сам себе. `=` добавлен
 * сверх того класса: там это разделитель, здесь — паддинг base64. `~` — из
 * base64url-вариантов, встречается у сторонних API.
 *
 * `Basic` покрыт тем же правилом: это тот же заголовок, тот же путь наружу и
 * тот же вид значения (base64 от `user:password`), а поймать его больше нечем
 * — `SENSITIVE_KEY` сверяет ИМЕНА полей объекта, и в свободном тексте не
 * участвует. В `SENSITIVE_KEY` слова `basic` при этом быть не должно: поле с
 * таким именем секретом не является.
 */
const BEARER = /((?:Bearer|Basic)\s+)[A-Za-z0-9._\-+/=~]+/gi;
// Токен Telegram-бота внутри обычного текста. node-fetch@2 (на нём telegraf
// 4.16) на любой сетевой ошибке бросает `request to <url> failed, reason: ...`,
// а url у Bot API — `https://api.telegram.org/bot<ТОКЕН>/getMe`. Такие строки
// ходят по коду как рядовой message: ни SENSITIVE_KEY (это не ключ объекта), ни
// INLINE_QS_SECRET (это не query-параметр), ни BEARER их не ловили. Скруббер
// объявлен ALWAYS on — значит, эта форма и была дырой в постоянной защите.
// Оставляем bot_id: он не секрет и говорит, чей именно токен светился.
// Граница слова здесь не работает: в `/bot7123456789:…` между «t» и «7» её нет
// (обе — word-символы), и `\b` молча не совпадал ни разу. Отсекаем только от
// цифр слева, чтобы bot_id захватился целиком.
const TELEGRAM_TOKEN = /(?<!\d)(\d{6,12}):[A-Za-z0-9_-]{30,}/g;

// Аудит 2026-08-20: скраббер не ловил ровно ту форму, ради которой его зовут
// из mac-bridge.ts. Комментарий у `snapshotOf` (lib/mac-bridge.ts) называет
// её дословно: «`git push` по HTTPS печатает в stderr URL вида
// `https://x-access-token:ghp_…@github.com/…`». Это вывод произвольной
// программы, запущенной на машине владельца, и он уходит двумя дорогами — в
// чат и в `agent_actions.error`, то есть на диск в SQLite и наружу админам
// через /api/actions.
//
// Формы взяты из существующего определения «как выглядит секрет» в этом же
// репо — массив PATTERNS в deploy/vps-autonomous/scan-staged-secrets.sh.
// Определений и так
// было два, и на выходной границе стояло более слабое; теперь они совпадают.
//
// Аудит 2026-08-28: совпадали не полностью — из семи форм скрипта здесь было
// шесть, не хватало `ИМЯ=значение`. Паритет теперь проверяется тестом
// (tests/audit-2026-08-28-scrub-secret-assignment.test.ts), а не только этим
// абзацем: правку любой из двух сторон приходится делать вместе.

/**
 * `scheme://user:secret@host` — пароль вырезается, пользователь остаётся.
 *
 * `{0,30}` вместо `*` — не косметика, а граница сложности. С `*` часть про
 * схему жадно съедала любой прогон из букв/цифр/`+.-`, упиралась в отсутствие
 * `://` и отступала по одному символу — и так с каждой стартовой позиции.
 * Получалось O(n²) на строку БЕЗ единого `://`, то есть на обычном выводе
 * чужой программы. Замер на прогоне из `A` (bun 1.x, M1):
 *   32 КБ → 1043 мс,  16 КБ → 261 мс,  8 КБ → 64 мс  (учетверение на каждое
 *   удвоение), 4 МБ — часы. С `{0,30}`: 32 КБ → 2.2 мс, линейно.
 *
 * Важно, ГДЕ это считается: `scrubSecretString` зовёт `snapshotOf`
 * (lib/mac-bridge.ts) на потоке с мака — в том же однопоточном процессе, где
 * 12 ботов, HTTP Mini App и планировщики. Вывод `bun test` или сборки на
 * несколько мегабайт вешал бы их все. 30 символов схемы хватает с запасом:
 * самая длинная реальная — `git+ssh` (7).
 */
const CREDENTIAL_URL = /([a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]+:)[^\s/@]+@/gi;
/** GitHub PAT: classic `ghp_`, а также `gho_`/`ghu_`/`ghs_`/`ghr_`. */
const GITHUB_TOKEN = /\b(gh[pousr]_)[A-Za-z0-9]{20,}/g;
/** GitHub fine-grained PAT. */
const GITHUB_PAT_FG = /\b(github_pat_)[A-Za-z0-9_]{20,}/g;
/** Anthropic. */
const ANTHROPIC_KEY = /\b(sk-ant-)[A-Za-z0-9_-]{20,}/g;
/**
 * OpenAI. Длина 40+ и только буквы-цифры после `sk-` — намеренно узко: `sk-`
 * встречается и в обычном тексте, а рубить лишнее в выводе чужой программы
 * значит ломать диагностику ради ложного срабатывания.
 */
const OPENAI_KEY = /\b(sk-)[A-Za-z0-9]{40,}/g;
/**
 * Аудит 2026-08-28: ключи, которые консоль OpenAI выдаёт сегодня, правилом
 * выше не ловились вовсе. У `sk-proj-…` (а также `sk-svcacct-…`,
 * `sk-admin-…`) четвёртый символ после `sk-` — дефис, прогон
 * `[A-Za-z0-9]{40,}` обрывается на четырёх, совпадения нет.
 *
 * Довод об узости к дефисной форме не применим: `sk-` в прозе встречается,
 * `sk-<слово>-` с двадцатью знаками payload — нет. Проект OpenAI использует
 * (GENERATE_IMAGE), так что это ключ платящего аккаунта.
 */
const OPENAI_PREFIXED_KEY = /\b(sk-[a-z]{2,12}-)[A-Za-z0-9_-]{20,}/g;
/**
 * Присваивание `ИМЯ=значение` — седьмая и последняя форма из
 * deploy/vps-autonomous/scan-staged-secrets.sh, единственная, которой здесь
 * не было. Комментарий выше утверждал, что определения совпадают; аудит
 * 2026-08-28 показал, что нет, и что именно этой формой выглядит всё
 * содержимое `.env`: `printenv` или упавший скрипт с `set -x` на маке отдавал
 * `TELEGRAM_SESSION=1BQ…` — полную сессию юзербота — нетронутой.
 *
 * Идёт ПОСЛЕ префиксных правил: тогда в `GITHUB_TOKEN=ghp_…` остаётся видно
 * `ghp_***`, то есть тип засветившегося ключа, а не голое `***`.
 *
 * Верхний регистр и класс значения — дословно как в скрипте, чтобы двум
 * определениям было не с чего разъезжаться снова. Отсюда же граница в 16
 * символов: ниже неё это счётчик, а не секрет.
 */
const SECRET_ASSIGNMENT =
  /((?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|API_HASH|SESSION)[A-Z0-9_]*\s*=\s*["']?)[A-Za-z0-9_/+.:-]{16,}/g;

/**
 * StringSession юзербота — по форме, а не по имени.
 *
 * Аудит 2026-09-11, круг 51: у самого дорогого секрета проекта правила по
 * форме не было вовсе, в отличие от `ghp_`, `github_pat_` и `sk-ant-`. Ловилась
 * только запись `TELEGRAM_SESSION=…`; `session: 1BQ…` в YAML или JSON проходил
 * насквозь, потому что слово `session` из LABELED_SECRET_NAME исключено
 * намеренно (обоснование — в докблоке того правила). А сессия MTProto — это
 * полная имперсонация владельца: ни TTL, ни второго фактора у неё нет.
 *
 * Порог длины высокий (250) именно затем, чтобы правило было про сессию, а не
 * про «любой base64». Живая строка gramjs — около 350 символов; хвост короче
 * порога бесполезен и тому, кто его перехватил.
 */
const TELEGRAM_STRING_SESSION = /(?<![A-Za-z0-9+/=])1[A-Za-z0-9+/=_-]{250,}/g;

/**
 * Та же форма «имя: значение», но в camelCase.
 *
 * Аудит 2026-09-11: `LABELED_SECRET` требует, чтобы перед ключевым словом
 * стоял разделитель `_`, `-` или `.` либо начало слова — из-за lookbehind
 * `(?<![A-Za-z0-9])`. Поэтому `api_key: …` чистился, а `accessToken: …` —
 * самое обычное имя поля в JS-экосистеме — нет. Внутри объекта такой ключ
 * закрыт `SENSITIVE_KEY` (там границы нет), а вот в строке — например, в
 * сериализованном теле чужого ответа внутри текста ошибки — уезжал целиком.
 *
 * Правило РЕГИСТРОЗАВИСИМО и требует горба: `[a-z0-9]` перед заглавной. Без
 * этого оно повторяло бы `LABELED_SECRET` и ловило бы любое слово,
 * кончающееся на token, — скажем, monkeyToken, — наравне с `accessToken`,
 * чего мы как раз избегаем в соседнем правиле. Слово-пример намеренно без
 * обратных кавычек: в этом репозитории кавычки — обещание, что символ
 * найдётся, а такого символа нет и не должно быть.
 */
const CAMEL_LABELED_SECRET =
  /((?<=[a-z0-9])(?:Token|Secret|Password|Passphrase|ApiKey|AccessKey|PrivateKey|Authorization|InitData|Credentials?)["']?\s*:\s*(?:(?:Bearer|Basic|Token)\s+)?["']?)[^\s,;"'`}\]@]+/g;

/**
 * Вычистить секреты из произвольной строки. Экспортируется, чтобы у «как
 * выглядит секрет» было ровно одно определение: тот же скруббер зовёт
 * lib/health.ts перед тем, как положить текст ошибки в снапшот, который уходит
 * наружу по SSE. Две копии правил разъехались бы — на этом и построен баг.
 */
export function scrubSecretString(s: string): string {
  return s
    .replace(LABELED_SECRET, "$1***")
    .replace(CAMEL_LABELED_SECRET, "$1***")
    .replace(CURL_USERPASS, "$1***")
    .replace(INLINE_QS_SECRET, "$1***")
    .replace(BEARER, "$1***")
    .replace(TELEGRAM_TOKEN, "$1:***")
    // Раньше остальных: в `https://x-access-token:ghp_…@host` вырезается весь
    // пароль целиком, и до префиксных правил ниже там уже нечего ловить.
    .replace(CREDENTIAL_URL, "$1***@")
    .replace(GITHUB_TOKEN, "$1***")
    .replace(GITHUB_PAT_FG, "$1***")
    .replace(ANTHROPIC_KEY, "$1***")
    .replace(OPENAI_PREFIXED_KEY, "$1***")
    .replace(OPENAI_KEY, "$1***")
    .replace(SECRET_ASSIGNMENT, "$1***")
    // Последним: к этому моменту `TELEGRAM_SESSION=…` уже превращено в
    // `TELEGRAM_SESSION=***` правилом выше, и ловить остаётся голую строку —
    // ту, что лежит в YAML или прилетела в тексте чужой ошибки.
    .replace(TELEGRAM_STRING_SESSION, "***");
}

/**
 * Голова строки, ГОТОВАЯ к записи наружу: сначала скраб, потом обрезка.
 *
 * Порядок здесь — не вкусовщина. Почти все правила выше требуют минимальной
 * длины payload'а: `TELEGRAM_TOKEN` — 30 символов после двоеточия,
 * `GITHUB_TOKEN` и прочие префиксные — 20, `SECRET_ASSIGNMENT` — 16,
 * `CREDENTIAL_URL` — замыкающую `@`. Обрезка ПЕРЕД скраббером отрезает хвост
 * секрета, совпадение перестаёт набираться, и наружу уходит начало ключа
 * нетронутым — то есть ровно та часть, по которой его узнают и по которой
 * подбирают остальное. Каверза записана в докстроке `snapshotOf`
 * (lib/mac-bridge.ts, аудит 2026-08-13); аудит 2026-09-11 нашёл три места,
 * где её всё-таки повторили, и завёл этот помощник, чтобы правило было не
 * абзацем в комментарии, а вызовом.
 *
 * Стоимость обратного порядка — прогон правил по полному тексту вместо
 * головы. Она ограничена сверху там, где текст бывает большим: `readCapped`
 * (lib/http.ts) отдаёт не больше 4 КБ, а квадратичные формы в правилах уже
 * расшиты (`{0,30}` у `CREDENTIAL_URL`).
 */
export function scrubbedHead(s: string, max: number): string {
  return scrubSecretString(s).slice(0, max);
}

/**
 * Тот же скраббер, но по произвольной структуре: строки чистятся правилами
 * выше, значения под «говорящими» ключами (`token`, `secret`, …) заменяются
 * целиком. Экспортируется по той же причине, что и `scrubSecretString`:
 * определение «как выглядит секрет» на проекте одно.
 *
 * Кто зовёт, здесь не перечислен намеренно. Тут было сказано «второй сток —
 * строка `audit_logs.payload` в `emitAlert`», и это прочли как «в эту колонку
 * пишет emitAlert»; писателей в неё было два, и второй (отказ
 * UPDATE_AGENT_PROMPT в lib/dispatch/agent-prompt.ts) полтора месяца не чистил
 * ничего. Перечень вызывающих в докблоке устаревает молча — смотреть надо
 * вызовы, а не этот абзац (аудит 2026-09-11, круг 51).
 */
export function scrubSecretsDeep<T>(value: T): T {
  return scrubSecrets(value) as T;
}

function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") return scrubSecretString(value);
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "***" : scrubSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

interface LogEntry {
  level: LogLevel;
  msg: string;
  time: string;
  data?: LogData;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Разбор LOG_LEVEL.
 *
 * Аудит 2026-08-12: значение бралось из env как есть — `process.env.LOG_LEVEL
 * as LogLevel` — и не проверялось ничем. А порог сравнивается через
 * `levels.indexOf(this.level)`: незнакомая строка даёт -1, и `shouldLog`
 * становится истинным ДЛЯ ВСЕХ уровней, включая debug. То есть `verbose`,
 * `INFO` в верхнем регистре или `warning` в /opt/agent-team/.env выглядят
 * рабочей настройкой, а на деле открывают весь debug-поток в journalctl —
 * отказ в сторону «логировать больше, чем просили».
 *
 * Регистр и пробелы теперь нормализуем (это очевидная опечатка, а не другой
 * уровень), а по-настоящему незнакомое значение — дефолт по окружению плюс
 * жалоба в stderr: молча понижать порог нельзя.
 */
export function resolveLogLevel(
  raw: string | undefined,
  isProduction: boolean,
): LogLevel {
  const fallback: LogLevel = isProduction ? 'info' : 'debug';
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if ((LOG_LEVELS as readonly string[]).includes(s)) return s as LogLevel;
  console.warn(
    `[log] LOG_LEVEL='${raw}' не распознан (ожидается ${LOG_LEVELS.join('|')}) — беру '${fallback}'`,
  );
  return fallback;
}

class Logger {
  private level: LogLevel;
  private isProduction: boolean;

  constructor() {
    // Default to 'info' in production, 'debug' locally
    this.isProduction = process.env.NODE_ENV === 'production';
    this.level = resolveLogLevel(process.env.LOG_LEVEL, this.isProduction);
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(this.level);
  }

  private formatEntry(level: LogLevel, msg: string, data?: LogData): LogEntry {
    return {
      level,
      msg: scrubSecretString(msg),
      time: new Date().toISOString(),
      ...(data && { data: scrubSecrets(data) as LogData })
    };
  }

  private output(entry: LogEntry): void {
    if (this.isProduction) {
      // JSON output for production (easier for journalctl parsing)
      console.log(JSON.stringify(entry));
    } else {
      // Human-readable for development
      const timestamp = entry.time.substring(11, 23); // HH:MM:SS.sss
      const levelStr = entry.level.toUpperCase().padEnd(5);
      const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
      console.log(`${timestamp} ${levelStr} ${entry.msg}${dataStr}`);
    }
  }

  debug(msg: string, data?: LogData): void {
    if (this.shouldLog('debug')) {
      this.output(this.formatEntry('debug', msg, data));
    }
  }

  info(msg: string, data?: LogData): void {
    if (this.shouldLog('info')) {
      this.output(this.formatEntry('info', msg, data));
    }
  }

  warn(msg: string, data?: LogData): void {
    if (this.shouldLog('warn')) {
      this.output(this.formatEntry('warn', msg, data));
    }
  }

  error(msg: string, data?: LogData): void {
    if (this.shouldLog('error')) {
      this.output(this.formatEntry('error', msg, data));
    }
  }

  // Convenience method for error objects
  errorWithStack(msg: string, error: Error, data?: LogData): void {
    this.error(msg, {
      ...data,
      error: error.message,
      stack: error.stack
    });
  }
}

// Singleton instance
export const log = new Logger();

/**
 * PII redaction helpers (T-319 / T-305).
 *
 * Use these around any user-supplied string before it lands in:
 *   - console.log / log.info / log.warn / log.error
 *   - persistent stores (wiki notes, SQLite payload columns)
 *   - outbound HTTP bodies to third parties (OpenAI, etc.) when the prompt
 *     was assembled from user content
 *
 * Disable with env LOG_REDACT=0 ONLY for short local debugging.
 */
const REDACT_DISABLED = process.env.LOG_REDACT === "0";

/** Сколько символов отпечатка показывает `redactText` с каждого конца. */
const REDACT_PREFIX = 4;
const REDACT_SUFFIX = 4;

/**
 * Сколько символов обязаны остаться СКРЫТЫМИ, чтобы отпечаток вообще
 * показывался. Не ноль: при нуле отпечаток совпадает со всей строкой —
 * см. докстроку `redactText`.
 */
const REDACT_MIN_HIDDEN = 4;

/**
 * Redact a Telegram user identifier (numeric id or username).
 * Returns a stable short form `uid:<last4>` so logs remain correlatable
 * within a session without leaking the full identifier.
 */
export function redactUserId(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "uid:<empty>";
  if (REDACT_DISABLED) return `uid:${String(value)}`;
  const s = String(value);
  if (s.length <= 4) return `uid:${s}`;
  return `uid:${s.slice(-4)}`;
}

/**
 * Источник сообщения одной строкой: id, если он есть, иначе имя, иначе прочерк.
 *
 * Аудит 2026-08-27: на этом месте стоял `redactUserId(id ?? name)`. Когда id
 * нет (MTProto отдаёт апдейты, где доступно только отображаемое имя), в
 * редактор уезжало ИМЯ и он резал его как идентификатор — `uid:анов`. Строка
 * утверждала «последние 4 символа id», хотя это последние 4 символа фамилии:
 * коррелировать по ней между сообщениями нельзя, а читающий лог об этом не
 * знает и будет считать двух разных Ивановых одним отправителем. Разные вещи
 * должны и выглядеть по-разному, поэтому имя маркируется как `name:` и режется
 * текстовым редактором.
 */
export function redactSender(
  userId: string | number | null | undefined,
  name: string | null | undefined,
): string {
  if (userId !== null && userId !== undefined && String(userId) !== "") {
    return redactUserId(userId);
  }
  if (name) return `name:${redactText(name)}`;
  return "unknown";
}

/**
 * Резать произвольный текст человека. Отдаёт либо `<len=N>`, либо
 * `<len=N first4=XXXX last4=YYYY>` — отпечаток для корреляции одного
 * и того же текста между строками лога.
 *
 * Аудит 2026-09-11: порогом было 7, а подпись обещала «never reveals
 * middle content, regardless of length». При длине 8 середины не
 * существует вовсе: `first4 + last4` — это ВСЯ строка, и обещание
 * выполнялось впустую. Замер: `"12345678"` → `<len=8 first4=1234
 * last4=5678>`, `"7 Baker St"` → `<len=10 first4=7 Ba last4=r St>`. В полосе
 * 8–11 символов лежит ровно то, ради чего резали: одноразовый код,
 * короткий пароль, адрес. Сторожа этого не ловили: они берут строки
 * в 20, 39 и 58 символов и `"да"` — полосу 8–11 не проверял ни один.
 *
 * Поэтому порог не число, а свойство: отпечаток показывается, только
 * если после него СКРЫТЫ хотя бы `REDACT_MIN_HIDDEN` символов. Записанное
 * через длины кусков, это свойство не разъедется с ними: поменяется
 * `first4`/`last4` — порог пересчитается сам.
 *
 * Цена — в полосе 8–11 коррелировать строки по логу больше нельзя. Это
 * ровно та полоса, где корреляция и есть разглашение, так что терять тут
 * нечего.
 */
export function redactText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "<len=0>";
  const s = String(value);
  if (REDACT_DISABLED) return s;
  const shown = REDACT_PREFIX + REDACT_SUFFIX;
  if (s.length < shown + REDACT_MIN_HIDDEN) return `<len=${s.length}>`;
  return `<len=${s.length} first${REDACT_PREFIX}=${s.slice(0, REDACT_PREFIX)} last${REDACT_SUFFIX}=${s.slice(-REDACT_SUFFIX)}>`;
}

// Legacy compatibility - can be used to gradually migrate console.log calls
export function legacyLog(level: LogLevel, ...args: unknown[]): void {
  const msg = args.map(arg => 
    typeof arg === 'string' ? arg : JSON.stringify(arg)
  ).join(' ');
  
  log[level](msg);
}