/**
 * HTTP utilities extracted from lib/miniapp-server.ts (R1).
 *
 * Pure helpers: JSON responses, CORS headers, compression/ETag pass,
 * integer parsing, and per-user token-bucket rate limiter state.
 */

/**
 * T-311 — strict CORS allowlist.
 *
 * Previously `corsHeaders()` echoed `Access-Control-Allow-Origin: *` on all
 * responses (including GETs that leak agent state). The POST handler in
 * miniapp-server.ts gated method-level access via MINIAPP_ALLOWED_ORIGINS,
 * but JSON headers still advertised wildcard access — meaning any origin
 * could read GET responses cross-site.
 *
 * Now: the allowlist is consulted for ALL methods. If the request's Origin
 * is not in the list, the ACAO header is omitted entirely (no wildcard
 * fallback). Telegram WebApp's tgWebAppData flow does not send Origin and
 * authenticates via initData HMAC, so omission is safe for the primary
 * client. For browser-based dev/preview, set MINIAPP_ALLOWED_ORIGINS or
 * rely on the localhost dev default below.
 */
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export function parseAllowedOriginsEnv(
  env: string | undefined = process.env.MINIAPP_ALLOWED_ORIGINS,
): string[] {
  if (!env || !env.trim()) return DEFAULT_DEV_ORIGINS.slice();
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Return `reqOrigin` if it's in the configured allowlist (or in the
 * localhost dev default when env is unset). Returns null otherwise — the
 * caller must then omit the ACAO header entirely instead of echoing `*`.
 */
export function pickAllowedOrigin(reqOrigin: string | null): string | null {
  if (!reqOrigin) return null;
  const list = parseAllowedOriginsEnv();
  return list.includes(reqOrigin) ? reqOrigin : null;
}

/**
 * Build CORS headers. When `origin` is null/undefined, the
 * Access-Control-Allow-Origin header is omitted entirely.
 *
 * Pass the result of `pickAllowedOrigin(req.headers.get("origin"))` to
 * gate cross-origin browser access by the env allowlist.
 */
export function corsHeaders(
  origin?: string | null,
): Record<string, string> {
  const base: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "X-Telegram-Init-Data, Content-Type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (origin) {
    base["access-control-allow-origin"] = origin;
  }
  return base;
}

/**
 * Заголовки, от которых зависит ТЕЛО ответа, а не только его кодировка.
 *
 * Аудит 2026-08-20: один и тот же URL отдаёт разное в зависимости от
 * предъявленного credential'а — и это сделано намеренно:
 *   • `/readyz` — предъявителю METRICS_TOKEN уходит `checks` (ключи заведены?
 *     мост к Mac поднят? когда отрабатывал планировщик?), остальным только `ok`;
 *   • `/api/health` — `mac_online` только своим;
 *   • `/api/actions` — админу `payload`/`result` целиком, зрителю «(скрыто…)».
 * Во всех трёх случаях статус 200 и метод GET, то есть ответ кэшируемый по
 * умолчанию, а `Vary` называл только Origin и Accept-Encoding. Общий кэш
 * (перед nginx с 2026-08-19 стоит Cloudflare — см. комментарий ниже про
 * cf-connecting-ip) вправе сложить ответ привилегированного запроса и отдать
 * его следующему анониму: ключ-то совпал. Ровно та утечка, которую закрывали
 * гейтом 2026-08-08, — гейт есть, а кэшу про него никто не сказал.
 */
const CREDENTIAL_VARY = ["Origin", "X-Telegram-Init-Data", "Authorization"];

/**
 * Дописывает токены в `Vary`, не затирая уже существующие.
 *
 * `headers.set("vary", ...)` в ветке gzip выкидывал всё, что стояло там до
 * него. Origin возвращался следом (applyCorsToResponse), а вот заголовки
 * credential'а — уже нет.
 */
export function mergeVary(headers: Headers, ...tokens: string[]): void {
  const present = (headers.get("vary") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const lower = new Set(present.map((t) => t.toLowerCase()));
  for (const t of tokens) {
    if (!lower.has(t.toLowerCase())) {
      present.push(t);
      lower.add(t.toLowerCase());
    }
  }
  if (present.length) headers.set("vary", present.join(", "));
}

export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
  origin: string | null = null,
): Response {
  // JSON.stringify(undefined) returns undefined rather than a string. Responses
  // still need a valid JSON body and a calculable Content-Length.
  const text = JSON.stringify(body) ?? "null";
  const res = new Response(text, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Ни один JSON-ответ этого сервера не предназначен общему кэшу: это либо
      // живое состояние, либо данные конкретного предъявителя. `private` и
      // `no-store` говорят это прямо, а не полагаются на то, что промежуточный
      // кэш угадает сам.
      "cache-control": "private, no-store",
      // Bun сам Content-Length в конструкторе Response не проставляет, а
      // applyCompressionAndEtag решает по нему, стоит ли вообще буферизовать
      // тело. Крупные ответы (/api/actions с SVG-payload'ами) без заголовка
      // отбраковывались уже ПОСЛЕ буферизации.
      "content-length": String(Buffer.byteLength(text)),
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
  // После extraHeaders: вызывающий мог поставить свой Vary, и его надо
  // дополнить, а не проиграть ему.
  mergeVary(res.headers, ...CREDENTIAL_VARY);
  return res;
}

/**
 * Целое из query-параметра с дефолтом и потолком.
 *
 * Аудит 2026-08-08: имя обещало Int, а функция его не давала. `Number("1.5")`
 * конечен и > 0, `Math.min` дробь сохраняет — и `?limit=1.5` уезжал в
 * `LIMIT ?` (четыре вызова в miniapp-server), где bun:sqlite отвечает
 * `datatype mismatch`. Ловил это общий catch, так что пользователь Mini App
 * видел 500 вместо списка, а в логе — ошибку драйвера без намёка на причину.
 * Отбрасываем дробную часть: `?limit=1.5` — это «полтора элемента», разумное
 * прочтение здесь одно.
 */
export function parseIntOr(v: string | null, def: number, cap?: number): number {
  if (v == null) return def;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return def;
  return cap ? Math.min(n, cap) : n;
}

/**
 * Разобрать chat_id из тела запроса. `null`, если это не целое число.
 *
 * Аудит 2026-08-20: `POST /api/tasks` проверял chat_id одним
 * `Number.isFinite(Number(raw))`, а это не проверка типа, а приведение:
 *
 *   []      → 0      задача уезжает в чат 0
 *   true    → 1      задача уезжает в чат 1
 *   "0x10"  → 16     чат, которого никто не называл
 *   1.9     → 1.9    дробный chat_id ложится в БД как есть
 *
 * Во всех четырёх случаях ответ — 201 с телом созданной задачи, а сама задача
 * не появится ни в одном списке: `listTasksByChat` ищет точное равенство.
 * Ошибку видно только через сравнение доски с ожиданием.
 *
 * Соседний `POST /api/autonomy` уже делал это правильно — предикат взят
 * оттуда и стал общим, чтобы третья копия не разошлась снова.
 */
export function strictChatId(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) ? raw : null;
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * C27: optionally gzip a response body (in-place rebuild) and attach a weak
 * ETag for GET requests. Returns a possibly-new Response. Skips SSE and
 * small bodies. If the client sent a matching `If-None-Match`, returns a
 * 304 with the ETag header and no body.
 */
const GZIP_MIN_BYTES = 1024;
/**
 * Верхняя граница ВСЕЙ пост-обработки тела: буферизации, ETag и gzip. Каждый
 * из трёх шагов синхронно проходит по телу целиком или копирует его, а поток
 * тут один — он же обслуживает SQLite. Ответы бывают многомегабайтными
 * законно: /api/actions?limit=200 по действиям GENERATE_SVG_IMAGE (payload =
 * исходник SVG) или WRITE_WIKI (payload = всё тело страницы). Такие отдаём
 * как есть — трафик дешевле фриза.
 *
 * Имя историческое: сначала граница относилась только к gzip, и это была
 * ошибка — arrayBuffer и Bun.hash оставались без потолка (см. ниже).
 */
const GZIP_MAX_BYTES = 2_000_000;

/**
 * SEC-6 / T-604 — security headers applied to every Mini App response.
 *
 * CSP is tuned for the Telegram WebApp embedding (see miniapp/index.html):
 *  - script-src allows https://telegram.org (the telegram-web-app.js SDK) and
 *    'unsafe-inline' (index.html has inline bootstrap scripts).
 *  - frame-ancestors allows Telegram Web so the WebView/iframe still loads —
 *    we deliberately do NOT send X-Frame-Options (it would conflict and could
 *    break framing inside Telegram Web).
 */
const MINIAPP_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://telegram.org; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self'; " +
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; " +
  "base-uri 'self'; " +
  "form-action 'self'";

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "content-security-policy": MINIAPP_CSP,
};

/**
 * T-311 — strip wildcard ACAO and set the real allowed origin (or none).
 *
 * Call this as the final post-processing step on every response leaving the
 * Mini App. It consults `MINIAPP_ALLOWED_ORIGINS` (via `pickAllowedOrigin`)
 * to decide whether to echo the request Origin. Same-origin requests
 * (no Origin header) keep no ACAO header — they don't need one.
 */
export function applyCorsToResponse(req: Request, resp: Response): Response {
  const reqOrigin = req.headers.get("origin");
  const allowed = pickAllowedOrigin(reqOrigin);
  const headers = new Headers(resp.headers);
  // SEC-6: attach security headers (don't clobber any a handler already set).
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  // Always start by removing any stale wildcard / per-call ACAO so we never
  // leak the previous default.
  headers.delete("access-control-allow-origin");
  if (allowed) {
    headers.set("access-control-allow-origin", allowed);
  }
  // Always advertise that CORS varies on Origin so caches don't reuse a
  // permissive response for a different origin.
  mergeVary(headers, "Origin");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

export async function applyCompressionAndEtag(
  req: Request,
  resp: Response,
): Promise<Response> {
  // Bail on streaming/non-buffered responses (SSE, file streams, etc.).
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) return resp;
  // Only apply to 200/2xx responses that have a body and a known length.
  if (resp.status < 200 || resp.status >= 300) return resp;

  // For static file responses we don't want to read the whole stream
  // into memory unless we're confident. Limit to JSON / HTML / text.
  const isText =
    ct.includes("application/json") ||
    ct.includes("text/") ||
    ct.includes("javascript") ||
    ct.includes("application/xml");

  // Аудит 2026-08-28: обещание выше выполнялось наполовину. `isText` считался
  // до буферизации, а применялся только ниже — в условиях ETag и gzip. Для
  // нетекстового ответа (webp, woff2, ico, wasm, octet-stream) ни того, ни
  // другого не делается вовсе, то есть `arrayBuffer()` втягивал тело целиком в
  // память ради ответа, байт в байт равного исходному. `serveStatic` отдаёт
  // `Bun.file` — до этой строки с диска не читалось ничего, а поток здесь один
  // и общий с SQLite. Ровно тот же промах, что чинили этажом ниже у
  // GZIP_MAX_BYTES: фильтр стоял после работы, которую был обязан отменить.
  if (!isText) return resp;

  // «Larger binary assets fall through unchanged» — так было написано, но не
  // так было сделано: граница GZIP_MAX_BYTES проверялась только у gzipSync, а
  // arrayBuffer() и Bun.hash() выполнялись над телом ЛЮБОГО размера. То есть
  // ровно та работа, ради отказа от которой граница и вводилась (лишняя копия
  // в память плюс синхронный проход по всему телу в потоке, который делит с
  // SQLite), продолжала выполняться — просто без gzip в конце.
  //
  // Content-Length у нас известен и для Bun.file, и для json(): если тело
  // заведомо больше границы, не буферизуем его вовсе — отдаём поток как есть.
  const declaredLength = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > GZIP_MAX_BYTES) {
    return resp;
  }

  // Именно `<ArrayBuffer>`, а не голый Uint8Array: BodyInit не принимает вьюху
  // поверх SharedArrayBuffer, а `new Uint8Array(await resp.arrayBuffer())` даёт
  // обычный ArrayBuffer — сузить тип честнее, чем глушить каст на месте.
  let bodyBytes: Uint8Array<ArrayBuffer>;
  try {
    bodyBytes = new Uint8Array(await resp.arrayBuffer());
  } catch {
    return resp;
  }

  // Content-Length мог отсутствовать (chunked). Тело уже в памяти, отменить
  // это нельзя — но синхронно хешировать и жать его по-прежнему нельзя тоже.
  if (bodyBytes.byteLength > GZIP_MAX_BYTES) {
    return new Response(bodyBytes, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }

  const method = req.method.toUpperCase();
  const isGet = method === "GET" || method === "HEAD";

  // Compute ETag on the raw (pre-gzip) body for GET requests, JSON or text.
  let etag: string | null = null;
  if (isGet) {
    try {
      const h = (Bun as any).hash(bodyBytes);
      etag = `W/"${h.toString(16)}"`;
    } catch {
      etag = null;
    }
    if (etag) {
      const inm = req.headers.get("if-none-match");
      if (inm && inm === etag) {
        const headers = new Headers(resp.headers);
        headers.set("etag", etag);
        headers.delete("content-length");
        return new Response(null, { status: 304, headers });
      }
    }
  }

  const acceptsGzip = (req.headers.get("accept-encoding") ?? "")
    .toLowerCase()
    .includes("gzip");
  // Верхняя граница уже отсечена выше — сюда доходят только тела <= GZIP_MAX.
  // `isText` здесь уже не проверяется: нетекстовые ответы вышли выше.
  const shouldGzip = acceptsGzip && bodyBytes.byteLength > GZIP_MIN_BYTES;

  const headers = new Headers(resp.headers);
  if (etag) headers.set("etag", etag);

  if (shouldGzip) {
    const gz = (Bun as any).gzipSync(bodyBytes);
    headers.set("content-encoding", "gzip");
    // Было `set` — и весь предыдущий Vary улетал. Origin возвращал следом
    // applyCorsToResponse, а заголовки credential'а — уже никто.
    mergeVary(headers, "Accept-Encoding");
    headers.set("content-length", String(gz.byteLength));
    return new Response(gz, { status: resp.status, headers });
  }

  headers.set("content-length", String(bodyBytes.byteLength));
  return new Response(bodyBytes, { status: resp.status, headers });
}

/**
 * M4 — per-user token-bucket rate limiter.
 *
 * Exported for tests. State is module-level so tests can clear it between
 * runs via `_resetRateLimiter()`. Defaults: 60 tokens refilled per minute,
 * burst capacity 20.
 */
export interface RateLimitBucket {
  tokens: number;
  last: number;
}

export interface RateLimitOpts {
  capacity?: number;
  refillPerSec?: number;
  now?: () => number;
  /**
   * Отказывать в СОЗДАНИИ нового ведра, когда карта уперлась в жёсткий потолок
   * (см. HARD_MAX_BUCKETS). Ставится только там, где ключей может быть сколько
   * угодно, — то есть у анонимных вёдер. Для вёдер по user.id этого делать
   * нельзя: их число ограничено allowlist'ом, а отказ означал бы, что чужой
   * флуд запирает владельца из его же Mini App.
   */
  denyOnOverflow?: boolean;
}

const _buckets = new Map<string | number, RateLimitBucket>();

/**
 * Пока ключом был user.id из allowlist'а, размер карты был ограничен списком
 * пользователей. Анонимные вёдра (см. `anon:` в miniapp-server.ts) ключуются
 * адресом клиента, то есть числом ключей управляет тот, кто шлёт запросы.
 * Без вытеснения это утечка памяти в однопроцессном сервере, который делит
 * поток с SQLite.
 *
 * Вытесняем по возрасту, а не по LRU: ведро, к которому не обращались дольше
 * времени полного восстановления, УЖЕ полное — удалить его и создать заново
 * (тоже полным) неотличимо. Поэтому вытеснение здесь не ослабляет лимит,
 * в отличие от LRU, где выбросить можно как раз опустошённое ведро атакующего.
 *
 * Порог с запасом больше самого медленного из наших вёдер (POST: 20 токенов
 * по 1/с = 20 с; GET: 120 по 4/с = 30 с; anon: 300 по 20/с = 15 с).
 */
const EVICT_AT_BUCKETS = 10_000;
const BUCKET_TTL_MS = 120_000;

/**
 * Жёсткий потолок карты.
 *
 * Аудит 2026-08-13: EVICT_AT_BUCKETS назывался MAX_BUCKETS, и по имени читался
 * как предел размера. Он им не был и быть не мог: уборка удаляет только
 * протухшие вёдра, а при потоке РАЗНЫХ клиентов протухших нет — их возраст
 * меньше TTL. Размер поэтому равен `частота новых ключей × BUCKET_TTL_MS` и
 * потолка не имел вовсе. Замер (200 000 ключей, 1000 новых в секунду): карта
 * встаёт на 120 999 вёдер, то есть 12× «предела», 48 МБ, 413 байт на ведро.
 * На 10 000 новых клиентов в секунду это 1.2 млн вёдер и ~480 МБ в том самом
 * однопроцессном сервере, который делит поток с SQLite.
 *
 * Ключ анонимного ведра — адрес, подставленный нашим же прокси (clientIpKey),
 * то есть подделать его нельзя, нужен реально разный источник. Но IPv6 раздаёт
 * одному хосту /64, и «реально разных источников» там 2^64.
 *
 * Отказ при переполнении бьёт только по СОЗДАНИЮ новых анонимных вёдер: уже
 * заведённые обслуживаются как обычно, вёдра по user.id не трогаются вовсе.
 * Это хуже для нового анонимного посетителя во время флуда и лучше для всех
 * остальных, включая владельца: альтернатива — OOM, который уносит и SQLite.
 *
 * 50 000 вёдер — это ~21 МБ по замеру выше.
 */
const HARD_MAX_BUCKETS = 50_000;
/**
 * Сколько советовать подождать при переполнении. Место освобождает ближайшая
 * уборка, а она не чаще раза в секунду (EVICT_MIN_INTERVAL_MS), так что счёт
 * идёт на секунды, а не на BUCKET_TTL_MS: карта разгружается по мере того, как
 * протухают вёдра флуда, а не одним махом через две минуты.
 */
const OVERFLOW_RETRY_AFTER_SEC = 5;
/**
 * Проход по карте — O(n). Если ни одно ведро не протухло, чистка ничего не
 * освободит, и без этой отсечки каждая последующая вставка платила бы за
 * бесполезный полный проход: ровно под нагрузкой, ради которой лимит и стоит.
 */
const EVICT_MIN_INTERVAL_MS = 1_000;
let _lastEvict = 0;

function evictStaleBuckets(now: number): void {
  if (now - _lastEvict < EVICT_MIN_INTERVAL_MS) return;
  _lastEvict = now;
  for (const [k, b] of _buckets) {
    if (now - b.last >= BUCKET_TTL_MS) _buckets.delete(k);
  }
}

export function _resetRateLimiter(): void {
  _buckets.clear();
  _lastEvict = 0;
}

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Ключ анонимного ведра — адрес клиента.
 *
 * За nginx (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`,
 * agent/docs/DEPLOY.md:42) сокет всегда 127.0.0.1, поэтому по peer-адресу
 * лимитировать бессмысленно: всё сольётся в одно ведро. Но и первому элементу
 * XFF верить нельзя — `$proxy_add_x_forwarded_for` ДОПИСЫВАЕТ remote_addr к
 * тому, что прислал клиент, то есть начало списка полностью подконтрольно
 * атакующему и им же тривиально обходится лимит. Доверяем ПОСЛЕДНЕМУ элементу
 * — его подставил наш прокси, — и только когда сокет пришёл с локального
 * адреса. Прямое обращение снаружи XFF игнорирует.
 *
 * 2026-08-19: до этой даты за nginx стоял Cloudflare, и последним элементом
 * оказывался адрес edge-узла CF — то есть все посетители одного PoP делили одно
 * ведро, и любой из них мог выбить лимит остальным. Починено на стороне nginx
 * (`/etc/nginx/conf.d/00-cloudflare-realip.conf`): `set_real_ip_from` по
 * диапазонам CF плюс `real_ip_header CF-Connecting-IP`, поэтому `$remote_addr`
 * — настоящий клиент, и последний элемент XFF стал верным сам собой. Читать
 * `CF-Connecting-IP` прямо здесь было бы хуже: origin слушает 0.0.0.0, и без
 * `set_real_ip_from` это обычный клиентский заголовок.
 */
export function clientIpKey(
  xff: string | null | undefined,
  peer: string | null,
): string {
  // Только loopback, но НЕ `peer === null`. Раньше эти два случая стояли рядом,
  // и неизвестный peer наследовал путь доверенного прокси: значит, весь XFF
  // приходил от клиента, и вращением последнего элемента можно было получать
  // свежее ведро на каждый запрос. Неизвестный источник должен падать в одно
  // общее ведро, а не в личное.
  if (peer !== null && LOOPBACK_PEERS.has(peer)) {
    if (xff) {
      const parts = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return `anon:${last}`;
    }
  }
  return `anon:${peer ?? "unknown"}`;
}

/**
 * Остаток токенов в ведре, или `null`, если ведра нет вовсе. Только для тестов.
 *
 * Долив НЕ применяется намеренно: значение нужно ровно для вопроса «сняли ли за
 * этот запрос токен», а долив по времени сделал бы ответ зависящим от того,
 * насколько загружена машина. Отсутствие ведра — тоже ответ: значит, по этому
 * ключу не считали ни разу.
 */
export function _peekRateTokens(key: string): number | null {
  return _buckets.get(key)?.tokens ?? null;
}

/** Число живых вёдер — для тестов вытеснения. */
export function _rateLimiterSize(): number {
  return _buckets.size;
}

/**
 * Consume one token from the bucket for `userId`. Returns
 * { ok: true } on success, or { ok: false, retryAfter } if rate-limited.
 */
export function consumeRateToken(
  userId: string | number,
  opts: RateLimitOpts = {},
): { ok: true } | { ok: false; retryAfter: number } {
  const capacity = opts.capacity ?? 20;
  const refillPerSec = opts.refillPerSec ?? 60 / 60; // 60 per minute
  const now = opts.now ? opts.now() : Date.now();
  let b = _buckets.get(userId);
  if (!b) {
    if (_buckets.size >= EVICT_AT_BUCKETS) evictStaleBuckets(now);
    // Уборка throttled раз в секунду и намеренно не обходится здесь: обход
    // вернул бы O(n) на каждую вставку ровно под тем флудом, ради которого
    // throttle и стоит. Цена — до секунды отказов там, где протухшие вёдра уже
    // есть; отказ безопаснее лишнего прохода по карте.
    if (opts.denyOnOverflow && _buckets.size >= HARD_MAX_BUCKETS) {
      return { ok: false, retryAfter: OVERFLOW_RETRY_AFTER_SEC };
    }
    b = { tokens: capacity, last: now };
    _buckets.set(userId, b);
  } else {
    const elapsedSec = Math.max(0, (now - b.last) / 1000);
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
    b.last = now;
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true };
  }
  const needed = 1 - b.tokens;
  const retryAfter = Math.max(1, Math.ceil(needed / refillPerSec));
  return { ok: false, retryAfter };
}
