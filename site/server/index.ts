// index.ts — Web3 Пульс HTTP server (Bun.serve).
// Serves /api/* (real data from bun:sqlite) and the static frontend from
// ../web/dist with SPA fallback.

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import {
  countActivities,
  countDigests,
  countDrops,
  countSearchDigests,
  countUpcomingUnlocks,
  getActivity,
  getDigest,
  findLatestDigestByTitle,
  listActivities,
  listDigests,
  contentStamp,
  listDrops,
  listSitemapEntries,
  listUpcomingUnlocks,
  safeStoredUrl,
  searchDigests,
  upsertActivity,
  upsertDigest,
} from "./db.ts";
import type { ActivityUpsert, DigestUpsert } from "./db.ts";
import type { Activity, Digest, DigestItem } from "./types.ts";
import { seedIfEmpty } from "./seed.ts";
import {
  ensureUnlocks,
  refreshUnlocks,
  lastUnlocksRefreshIso,
} from "./unlocks.ts";

/** Порт, который ждут оба обратных прокси на проде. */
export const DEFAULT_PORT = 8790;

/**
 * Порт HTTP-сервера. Раньше — `Number(process.env.PORT ?? 8790)`.
 *
 * `??` спасает только от отсутствующей переменной. Строка `PORT=` в
 * EnvironmentFile переменную ЗАДАЁТ пустой, `Number("")` это 0, а
 * `Bun.serve({ port: 0 })` слушает случайный свободный порт. И nginx, и
 * tonutils-reverse-proxy ходят строго в `127.0.0.1:8790`, так что весь сайт
 * отвечал бы 502 при живом процессе: systemd видит active, в stdout честное
 * "listening on http://localhost:53412", а причина — одна пустая строка в
 * конфиге. Мусор вроде `PORT=abc` давал NaN и ронял старт уже внутри Bun.
 *
 * Поэтому: годным считаем только целое из диапазона портов, всё остальное —
 * дефолт плюс предупреждение. Ноль тоже негоден: «займи любой свободный» для
 * сервиса за прокси не бывает намеренным выбором, а тихо ломает всё.
 * Соседние `trustedProxyHops()` и `sharedLocalCapacity()` устроены так же,
 * только молчат — им есть куда деградировать, порту некуда.
 */
export function serverPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  console.warn(
    `[web3-puls] PORT=${JSON.stringify(raw)} — не порт, слушаем ${DEFAULT_PORT}`,
  );
  return DEFAULT_PORT;
}

/**
 * Каталог собранного фронта. Переопределяется `SITE_WEB_DIST` — по той же
 * причине, что и `SITE_DB_PATH`: в CI серверные тесты идут ДО сборки веба
 * (`checks.yml`, джоба site-tests), то есть `../web/dist` там не существует, и
 * без подмены всё, что зависит от оболочки, проверялось бы только локально.
 * Прод значение не задаёт — путь остаётся прежним.
 */
const DEFAULT_WEB_DIST = join(import.meta.dir, "..", "web", "dist");

/**
 * Аудит 2026-08-21: значение читалось ОДИН РАЗ, на загрузке модуля, и подмена
 * выше не работала для того, кто импортировал `index.ts` позже. Именно так и
 * получалось: `digest-meta.test.ts` тянет модуль статически и грузится раньше
 * по алфавиту, поэтому `digest-not-found.test.ts` выставлял переменную уже
 * закешированному модулю. На чистом чекауте без `site/web/dist` это давало
 * 271 pass / 5 fail в общем прогоне при 5 pass / 0 fail в одиночном — то есть
 * ровно тот CI-сценарий, ради которого переменная и заводилась.
 *
 * Пустая строка задана НЕ считается: `PORT=`-грабли из аудита 2026-08-20, и
 * пустой путь увёл бы `serveStatic` в корень файловой системы.
 */
export function webDist(): string {
  const v = process.env.SITE_WEB_DIST?.trim();
  if (!v) return DEFAULT_WEB_DIST;
  // Аудит 2026-09-10: хвостовой разделитель ломал ВСЮ статику. Гейт обхода
  // путей в `serveStatic` сверяет `filePath.startsWith(dist + sep)`, а `join`
  // хвостовой слэш схлопывает: при `SITE_WEB_DIST=/opt/web/dist/` сравнение
  // шло с `/opt/web/dist//`, чему не соответствует ни один реальный путь.
  // Каждый бандл, шрифт и картинка сбрасывались на `dist`, который не файл, и
  // уходили в 404; `/` при этом продолжал отдавать index.html (там `join`
  // даёт ровно `dist`). Снаружи — пустая оболочка сайта без единой строки в
  // логе сервера. Значение переменной задаёт оператор, а хвостовой слэш в
  // пути к каталогу — не опечатка, а обычная форма записи.
  const stripped = v.replace(/[/\\]+$/, "");
  return stripped || sep;
}

// ---- helpers ------------------------------------------------------------

function clampInt(v: string | null, def: number, min: number, max: number): number {
  // Treat missing/empty as "use default" (Number(null) === 0, so guard first).
  if (v === null || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Порты локальной разработки, которым отвечаем CORS-заголовком.
 *
 * Раньше пускался ЛЮБОЙ origin с хостом localhost — без схемы и без порта.
 * Это значит, что любая чужая страница, поднятая у разработчика на локальной
 * машине (чей-нибудь `npm start` на 3000, локальный докер, расширение со своим
 * сервером), читала наш API из браузера напрямую. Данные тут анонимные и
 * `Access-Control-Allow-Credentials` не выставляется, так что утечки нет —
 * но и раздавать доступ всему localhost незачем. Оставляем ровно два своих:
 * Vite dev (5173) и сам сервер сайта (8790). Переопределяется списком через
 * запятую в `SITE_DEV_ORIGIN_PORTS`.
 */
function devOriginPorts(): Set<string> {
  const raw = process.env.SITE_DEV_ORIGIN_PORTS;
  if (!raw || !raw.trim()) return new Set(["5173", "8790"]);
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function corsHeaders(origin: string | null): Record<string, string> {
  // Allow same-origin and the known dev ports. No third-party CORS.
  let allow = "";
  if (origin) {
    try {
      const u = new URL(origin);
      const host = u.hostname;
      // Схема проверяется отдельно: `URL` разберёт и `ftp://delabs.space`, и
      // расширенческие `chrome-extension://…` — hostname у них наш, а доверия
      // им никакого.
      const web = u.protocol === "https:" || u.protocol === "http:";
      const local = host === "localhost" || host === "127.0.0.1";
      // delabs.space — канонический домен с ребренда 2026-06-20; dobropalm.tech
      // остаётся легаси-именем и тоже отвечает. Проверяем точное совпадение и
      // поддомены с точкой: без неё сюда пролезал бы evil-delabs.space.
      const ours =
        host === "delabs.space" ||
        host.endsWith(".delabs.space") ||
        host === "dobropalm.tech" ||
        host.endsWith(".dobropalm.tech");
      if (web && (ours || (local && devOriginPorts().has(u.port)))) {
        allow = origin;
      }
    } catch {
      /* malformed Origin — no CORS */
    }
  }
  // Аудит 2026-09-11: список методов НЕ совпадает с `Allow: POST, OPTIONS`,
  // которым отвечает 405 на `/api/internal/*`, и это намеренно. `Allow` (RFC
  // 9110 §15.5.6) описывает, что умеет ресурс; `Access-Control-Allow-Methods`
  // — что мы разрешаем браузеру чужой вкладки. Ингест ходит с VPS по петле
  // curl'ом, преflight'а не делает вовсе, так что POST здесь не нужен никому.
  //
  // Круг 15 правит формулировку. Прежняя говорила, что, назвав POST, мы бы
  // «разрешили любой странице на delabs.space слать ингест с чужого
  // происхождения», и это неверно дважды: страница на delabs.space для
  // delabs.space — своё происхождение, CORS её не касается вовсе, а чужая
  // страница и с разрешённым методом упрётся в Bearer-токен. Причина скромнее
  // и от этого не слабее: называть в преflight'е то, чем никто не пользуется,
  // — лишняя поверхность. По той же причине в Allow-Headers нет
  // `Authorization`: заголовок нужен только POST'у.
  // HEAD не называем сознательно: CORS считает его простым методом всегда.
  const h: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (allow) h["Access-Control-Allow-Origin"] = allow;
  return h;
}

function json(data: unknown, init: ResponseInit = {}, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
      ...(init.headers ?? {}),
    },
  });
}

// ---- in-memory token-bucket rate limit (per IP) -------------------------

const RL_CAPACITY = 60; // tokens
export const RATE_LIMIT_MAX_BUCKETS = 50_000;
const RATE_LIMIT_BUCKET_TTL_MS = 10 * 60_000;
const RATE_LIMIT_EVICT_MIN_INTERVAL_MS = 1_000;
type Bucket = { tokens: number; last: number };
const buckets = new Map<string, Bucket>();
let lastRateLimitEviction = 0;

export function _resetRateLimiter(): void {
  buckets.clear();
  lastRateLimitEviction = 0;
}

// Аудит 2026-09-01: при полном кэше `rateLimitOk` отказывал КАЖДОМУ новому IP,
// пока в карте нет ни одного протухшего ведра. То есть 50 000 запросов с разных
// адресов (ботнет, скан, да просто ipv6-провайдер с /64 на клиента) закрывают
// сайт для всех, кто пришёл после них, на все десять минут TTL — отказ в
// обслуживании ценой одного всплеска. Поэтому под давлением вытесняем самые
// холодные вёдра: у живого клиента `last` свежий, он переживает вытеснение, а
// у выдохшегося всплеска — старый, и он уходит первым. Доля, а не одно ведро,
// чтобы сортировка амортизировалась по следующим вставкам.
const RATE_LIMIT_PRESSURE_EVICT_FRACTION = 0.1;

function evictColdestRateLimitBuckets(): void {
  const drop = Math.max(1, Math.floor(buckets.size * RATE_LIMIT_PRESSURE_EVICT_FRACTION));
  const byAge = [...buckets.entries()].sort((a, b) => a[1].last - b[1].last);
  for (let i = 0; i < drop && i < byAge.length; i++) buckets.delete(byAge[i][0]);
}

function evictStaleRateLimitBuckets(now: number): void {
  if (now - lastRateLimitEviction < RATE_LIMIT_EVICT_MIN_INTERVAL_MS) return;
  lastRateLimitEviction = now;
  for (const [ip, bucket] of buckets) {
    if (now - bucket.last > RATE_LIMIT_BUCKET_TTL_MS) buckets.delete(ip);
  }
}

export function _rateLimiterSize(): number {
  return buckets.size;
}

// Трафик .ton приходит через tonutils-reverse-proxy: сокет с петли и ВООБЩЕ
// без XFF/заголовка клиента — clientIpKey отдаёт `ip:127.0.0.1`, и всё
// .ton-сообщество делит одно ведро на 60 токенов. Клиентской идентичности у
// ADNL нет в принципе, поэтому ёмкость этого общего пула настраивается:
// на VPS с ton-прокси владелец ставит SITE_LOOPBACK_RL_CAPACITY=600.
// Дефолт равен RL_CAPACITY — без переменной поведение не меняется (в том
// числе потолок на дорогие не-API маршруты, который проверяют тесты).
const SHARED_LOCAL_KEYS = new Set(
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].map((a) => `ip:${a}`),
);

function sharedLocalCapacity(): number {
  const n = Number(process.env.SITE_LOOPBACK_RL_CAPACITY);
  return Number.isFinite(n) && n >= RL_CAPACITY ? Math.trunc(n) : RL_CAPACITY;
}

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const capacity = SHARED_LOCAL_KEYS.has(ip)
    ? sharedLocalCapacity()
    : RL_CAPACITY;
  let b = buckets.get(ip);
  if (!b) {
    if (buckets.size >= RATE_LIMIT_MAX_BUCKETS) evictStaleRateLimitBuckets(now);
    if (buckets.size >= RATE_LIMIT_MAX_BUCKETS) evictColdestRateLimitBuckets();
    b = { tokens: capacity, last: now };
    buckets.set(ip, b);
  }
  // refill: полная ёмкость за минуту
  b.tokens = Math.min(capacity, b.tokens + ((now - b.last) * capacity) / 60_000);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Periodic cleanup so the map doesn't grow unbounded.
setInterval(() => {
  evictStaleRateLimitBuckets(Date.now());
}, 5 * 60_000).unref?.();

export { rateLimitOk as _rateLimitOk };

type ServerLike = { requestIP?: (r: Request) => { address: string } | null };

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Ключ ведра для адреса, ПРИСЛАННОГО клиентом (заголовок владельца или XFF).
 *
 * Аудит 2026-08-20: пул SHARED_LOCAL_KEYS сделан для случая «клиентской
 * идентичности нет вовсе» (ADNL через ton-прокси с петли), и владелец на VPS
 * поднимает ему ёмкость до 600. Но `clientIpKey` возвращал значение заголовка
 * как есть, а гейт доверия — «сокет пришёл с петли» — за nginx выполняется
 * ВСЕГДА. Значит запрос с `CF-Connecting-IP: 127.0.0.1` попадал ровно в этот
 * привилегированный пул: посторонний получал ёмкость, предназначенную
 * .ton-трафику, и заодно мог выпить её у самого ton-прокси.
 *
 * Утверждение «я — петля», пришедшее в заголовке, бессмысленно по построению:
 * через Cloudflare или внешний nginx адрес 127.0.0.1 прийти не может. Такие
 * запросы сводим в один отдельный ключ обычной ёмкости — он не пересекается ни
 * с общим локальным пулом, ни с чьим-то настоящим адресом.
 *
 * Это только вторая линия. Первая — vhost: `SITE_CLIENT_IP_HEADER` безопасен
 * лишь когда nginx сам перезаписывает этот заголовок (`set_real_ip_from` для
 * сетей CF + `real_ip_header`), иначе клиент подставляет любой адрес и крутит
 * ключ на каждый запрос. Проверить конфиг из кода нельзя — см. предупреждение
 * при старте.
 *
 * Сводит их сюда `claimedIpKey` ниже.
 */
export const CLAIMED_LOOPBACK_KEY = "ip:claimed-loopback";

/** Ключ для присланного клиентом адреса: «я — петля» сводится в отдельное ведро. */
function claimedIpKey(addr: string): string {
  const key = `ip:${addr}`;
  return SHARED_LOCAL_KEYS.has(key) ? CLAIMED_LOOPBACK_KEY : key;
}

/**
 * Ключ ведра лимитера — адрес клиента.
 *
 * Аудит 2026-08-12: раньше peer предпочитался безусловно. Сайт стоит за nginx
 * (vhost → Bun на 8790), то есть peer — ВСЕГДА 127.0.0.1, и ведро на 60
 * токенов в минуту было одно на всех посетителей сразу. Главная дёргает /api
 * пять раз (сводка + четыре блока данных), значит вся площадка укладывалась в
 * 12 загрузок главной в минуту, дальше — 429 всем подряд.
 *
 * Но и первому элементу X-Forwarded-For верить нельзя:
 * `proxy_add_x_forwarded_for` ДОПИСЫВАЕТ remote_addr к тому, что прислал
 * клиент, — начало списка полностью подконтрольно атакующему и лимит им
 * обходится тривиально. Доверяем ПОСЛЕДНЕМУ элементу, и только когда сокет
 * пришёл с локального адреса; при прямом обращении снаружи XFF игнорируем.
 *
 * Аудит 2026-08-13 нашёл в этом рассуждении две дыры.
 *
 * 1. `peer === null` тоже включал доверие к заголовку. null означает «не смогли
 *    определить адрес», а не «свои» — это условие снято.
 * 2. «Последний элемент — это remote_addr» верно ровно для схемы
 *    «клиент → nginx → Bun». В памяти проекта
 *    (.claude/memory/notes/delabs-content-system.md) перед nginx стоит
 *    Cloudflare, и тогда последним элементом оказывается адрес краевого узла
 *    CF, общий для тысяч посетителей: лимит снова становится общим на всех —
 *    ровно та беда, которую правка 2026-08-12 и убирала. Ни конфига nginx, ни
 *    юнита web3-puls в репозитории нет, проверить схему нечем.
 *
 * Поэтому источник адреса задаётся явно, переменной `SITE_CLIENT_IP_HEADER`.
 * За Cloudflare владелец ставит `cf-connecting-ip` (его CF перезаписывает сам,
 * подделать снаружи нельзя). Пустое значение сохраняет прежнее поведение —
 * последний элемент X-Forwarded-For.
 */
export function clientIpKey(
  xff: string | null | undefined,
  peer: string | null,
  trustedHeaderValue?: string | null,
  trustedHops: number = trustedProxyHops(),
): string {
  if (peer !== null && LOOPBACK_PEERS.has(peer)) {
    // Заданный владельцем заголовок содержит ровно один адрес — берём как есть.
    const direct = trustedHeaderValue?.trim();
    if (direct) return claimedIpKey(direct.split(",")[0]!.trim());
    if (xff) {
      const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
      // Отсчёт с конца: последний элемент дописал наш ближайший прокси, и он
      // единственный, кому мы верим по умолчанию. Если между клиентом и нами
      // стоит ещё один свой слой (CDN → nginx → сюда), в SITE_TRUSTED_PROXY_HOPS
      // ставится 2, и берётся предпоследний. Всё, что левее доверенных хопов,
      // прислал клиент — и подделать может любое значение.
      const idx = hops.length - Math.max(1, trustedHops);
      const candidate = hops[idx] ?? hops[0];
      if (candidate) return claimedIpKey(candidate);
    }
  }
  return `ip:${peer ?? "unknown"}`;
}

/**
 * Сколько прокси-хопов перед нами считаем своими.
 *
 * Аудит 2026-08-12: код брал последний элемент XFF — это верно ровно тогда,
 * когда vhost делает `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
 * (или `$remote_addr`). Конфига delabs.space в репозитории нет, а nginx чужой
 * заголовок сам не чистит: если его не переопределяют, последний элемент
 * подконтролен клиенту, и лимит обнуляется новым значением на каждый запрос.
 * Выносим число в env, чтобы разворачивание за вторым прокси не требовало
 * правки кода.
 */
function trustedProxyHops(): number {
  const n = Number(process.env.SITE_TRUSTED_PROXY_HOPS);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1;
}

/**
 * Имя заголовка с адресом клиента; пусто — прежнее поведение по X-Forwarded-For.
 *
 * Отсчёт хопов выше — угадывание формы чужого конфига, и оно ломается молча.
 * Если vhost уже кладёт адрес в собственный заголовок (`CF-Connecting-IP`,
 * `X-Real-IP`), его имя задаётся здесь, и гадать не приходится вовсе.
 */
const CLIENT_IP_HEADER = (process.env.SITE_CLIENT_IP_HEADER ?? "").trim().toLowerCase();

/**
 * Аудит 2026-09-11 (круг 15): `server` здесь необязателен намеренно. Bun
 * передаёт его вторым аргументом всегда, но `makeFetchHandler()` экспортирован
 * и вызывается тестами напрямую, одним аргументом. Пока ведро висело на
 * коротком списке путей, до `server.requestIP` такой вызов просто не доходил;
 * после расширения списка (см. `rateLimitedNonApi`) дошёл — и падал
 * `undefined is not an object`. Ронять запрос из-за неизвестного адреса
 * нельзя: `clientIpKey` и так умеет отвечать на «адреса нет».
 */
function clientIp(req: Request, server?: ServerLike): string {
  return clientIpKey(
    req.headers.get("x-forwarded-for"),
    server?.requestIP?.(req)?.address ?? null,
    CLIENT_IP_HEADER ? req.headers.get(CLIENT_IP_HEADER) : null,
  );
}

// ---- security headers ---------------------------------------------------
// Applied to every response (static/HTML/JSON). The Vite build emits only
// external module scripts (no inline <script>), so script-src 'self' is safe.
// style-src allows 'unsafe-inline' for CSS only — never for script-src.
const CSP =
  "default-src 'self'; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  // На сайте нет ни одной <form>, так что отправлять форму некуда по
  // определению; под default-src эта директива не попадает — только явно.
  "form-action 'none'; " +
  "base-uri 'none'";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Без includeSubDomains намеренно: под dobropalm.tech живут посторонние
  // поддомены, и запереть их все на HTTPS отсюда мы не вправе.
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": CSP,
};

// ---- static frontend ----------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const NOT_BUILT_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web3 Пульс</title></head>
<body style="font-family:system-ui;max-width:640px;margin:10vh auto;padding:0 1rem;line-height:1.5">
<h1>Web3 Пульс</h1>
<p>Фронтенд ещё не собран. API работает на <code>/api/*</code> (например
<a href="/api/health">/api/health</a>).</p>
<p>Соберите фронт: <code>cd site/web &amp;&amp; bun run build</code>.</p>
</body></html>`;

function serveStatic(pathname: string, spaFallback = true): Response | null {
  if (!existsSync(webDist())) {
    // No build present: only answer "/" with the placeholder.
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(NOT_BUILT_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return null;
  }

  const filePath = distFilePath(pathname);
  if (filePath) return fileResponse(filePath);

  // Отсутствующий ассет (хешированный бандл, картинка, шрифт) обязан отдавать
  // 404: index.html вместо него маскирует протухший кэш после редеплоя под
  // MIME-ошибку в консоли.
  if (hasBuildFileShape(pathname)) {
    return null;
  }

  // SPA fallback: только для путей, которые роутер фронта действительно
  // знает. Раньше сюда проваливался ЛЮБОЙ не-ассетный адрес, и `/about/x`,
  // `/unlocks/1`, `/totally-made-up` отвечали 200 оболочкой с og-тегами
  // главной — та же дыра, что закрывал аудит 2026-09-11 для статейного
  // пространства, просто снаружи него. Решает вызывающий: здесь нет и не
  // должно быть знания о таблице маршрутов.
  if (!spaFallback) return null;
  const index = join(webDist(), "index.html");
  if (existsSync(index)) return fileResponse(index, true);
  return null;
}

/**
 * Путь ВЫГЛЯДИТ файлом сборки: каталог ассетов или известное расширение.
 *
 * Это мерка формы, а не наличия. Она решает, чем отвечать на промах: тегу
 * `<img>` и тегу `<script>` оболочка не нужна — им нужен код ответа, поэтому
 * такой промах отдаёт короткий 404, а не страницу.
 */
function hasBuildFileShape(pathname: string): boolean {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  return (
    rel.startsWith(`assets${sep}`) ||
    rel.startsWith("assets/") ||
    MIME[extname(rel).toLowerCase()] !== undefined
  );
}

/**
 * Путь к СУЩЕСТВУЮЩЕМУ файлу внутри каталога сборки, иначе null.
 *
 * Здесь же защита от выхода за каталог: нормализуем, срезаем ведущие `../` и
 * требуем, чтобы результат лежал внутри `dist`.
 */
function distFilePath(pathname: string): string | null {
  const dist = webDist();
  if (!existsSync(dist)) return null;
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(dist, rel);
  if (!filePath.startsWith(dist + sep) && filePath !== dist) {
    filePath = dist;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  return filePath;
}

/**
 * Запрос, который обслуживает ядро, а не мы: его ведро не считает.
 *
 * Аудит 2026-09-11 (круг 17): здесь стояла мерка ФОРМЫ — каталог `assets/`
 * или известное расширение. Обоснование у освобождения ровно одно: страница
 * тянет файлы сборки пачкой, и общий бюджет её бы задушил. Для файла,
 * которого на диске нет, это обоснование не работает, а мерка его всё равно
 * освобождала — достаточно было приписать к адресу `.png`. `/digest/x.png`
 * подходил и под освобождение, и под `digestIdFromPath`, то есть ходил в
 * SQLite бесплатно; `/1.png` бесплатно получал целую оболочку.
 *
 * Мерка теперь — наличие файла. Оболочку по прямому адресу `/index.html`
 * исключаем отдельно: файл есть, но он стоит чтения и отдаётся с no-cache.
 */
function servedByKernel(pathname: string): boolean {
  if (extname(pathname).toLowerCase() === ".html") return false;
  return distFilePath(pathname) !== null;
}

/**
 * `/<prefix>/<id>` → id, иначе null. Хвостовой слэш допускаем, вложенность —
 * нет. Битый percent-encoding не должен ронять запрос: отдаём как есть, дальше
 * getDigest/getActivity просто не найдёт такую статью.
 */
function articleIdFromPath(prefix: string, pathname: string): string | null {
  const m = pathname.match(new RegExp(`^/${prefix}/([^/]+)/?$`));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/** `/digest/<id>` → id, иначе null. */
export function digestIdFromPath(pathname: string): string | null {
  return articleIdFromPath("digest", pathname);
}

/** `/activity/<id>` → id, иначе null. Та же форма, что и у дайджестов. */
export function activityIdFromPath(pathname: string): string | null {
  return articleIdFromPath("activity", pathname);
}

function htmlAttrEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Заменить content= у мета-тега; если тега нет — дописать перед </head>. */
function setMetaTag(
  html: string,
  kind: "property" | "name",
  key: string,
  value: string,
): string {
  const v = htmlAttrEscape(value);
  // Подставляем ТОЛЬКО функцией-заменителем: в строке замены `$1`, `$&`,
  // `` $` ``, `$'`, `$$` — управляющие последовательности, а htmlAttrEscape
  // экранирует `& < > "` и `$` не трогает. Заголовок «Биткоин пробил $100 000»
  // в строке замены превращался в текст первой группы, то есть в кусок самого
  // документа: og:title = «Биткоин пробил <meta property=», а на `$'` (хвост
  // после совпадения) оболочка размножалась восьмикратно.
  // `[^>]` матчит и перевод строки — в оболочке теги разнесены на строки.
  const keyFirst = new RegExp(
    `(<meta\\s[^>]*${kind}="${key}"[^>]*content=")[^"]*(")`,
    "i",
  );
  if (keyFirst.test(html)) return html.replace(keyFirst, (_m, a, b) => a + v + b);
  const contentFirst = new RegExp(
    `(<meta\\s[^>]*content=")[^"]*("[^>]*${kind}="${key}")`,
    "i",
  );
  if (contentFirst.test(html)) return html.replace(contentFirst, (_m, a, b) => a + v + b);
  return html.replace(
    /<\/head>/i,
    () => `    <meta ${kind}="${key}" content="${v}" />\n  </head>`,
  );
}

/**
 * Подставить в оболочку мета-данные конкретной статьи.
 *
 * Аудит 2026-08-12: `/digest/<id>` отдавался статическим index.html, то есть
 * все статьи делили один og:title («DeLabs — крипта и AI без шума») и один
 * og:url — корень сайта. Ни Telegram, ни краулер JS не исполняют, поэтому
 * подставить заголовок на клиенте нельзя в принципе. А в канал постовик
 * кладёт именно эти ссылки — подписчик видел девять одинаковых карточек.
 *
 * Всё подставляемое экранируется: title и summary пишет модель и приносит
 * ингест, то есть это недоверенный ввод в HTML-атрибуте.
 */
export function injectDigestMeta(html: string, d: Digest): string {
  const url = `${SITE_ORIGIN}/digest/${encodeURIComponent(d.id)}`;
  // Функция-заменитель, а не строка: групп тут нет, но `$&`, `` $` `` и `$'`
  // работают и без них (см. setMetaTag).
  let out = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    () => `<title>${htmlAttrEscape(d.title)} — DeLabs</title>`,
  );
  out = setMetaTag(out, "property", "og:type", "article");
  out = setMetaTag(out, "property", "og:url", url);
  out = setMetaTag(out, "property", "og:title", d.title);
  // Аудит 2026-08-27: `summary` уходил в три атрибута как есть, а ингест
  // пропускает до INGEST_MAX.summary = 2 000 символов. Гайд рядом
  // (`injectActivityMeta`) режет описание до 300 — расхождение без причины:
  // og:description длиннее ~300 не показывает ни Telegram, ни поисковик, зато
  // оболочка распухала на 6 КБ на каждый запрос статьи.
  const desc = metaDescription(d.summary);
  out = setMetaTag(out, "property", "og:description", desc);
  out = setMetaTag(out, "name", "twitter:title", d.title);
  out = setMetaTag(out, "name", "twitter:description", desc);
  out = setMetaTag(out, "name", "description", desc);
  return out;
}

/** Потолок описания в мете: `intro` у гайда допускается до 8 000 символов. */
const META_DESC_MAX = 300;

function metaDescription(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  // Аудит 2026-08-29: было `one.slice(...)` напрямую. Граница на 299-й единице
  // UTF-16 могла попасть внутрь суррогатной пары (эмодзи в сводке — не
  // экзотика), и одинокий суррогат уезжал сразу в три атрибута; в байтах
  // ответа он не кодируется, так что читатель видел U+FFFD на месте последней
  // буквы. Третий рез в файле, доведённый до общего контракта: `clipSlug`
  // починили посимвольным Array.from, `clip` — этой же проверкой хвоста,
  // XML-путь чистит через XML_FORBIDDEN. Не последний: четвёртым оказался
  // `q` в ветке `/api/digests?q=` — его этой волной пропустили ровно потому,
  // что список тут был записан закрытым.
  return one.length > META_DESC_MAX ? `${clip(one, META_DESC_MAX - 1)}…` : one;
}

/**
 * То же самое для гайда. Аудит 2026-08-20: спец-обработка была только у
 * `/digest/`, поэтому все ссылки на гайды — а постовик кладёт в канал именно
 * их — разворачивались в одинаковую карточку «DeLabs — крипта и AI без шума»
 * с og:url на корень сайта. Ровно та беда, которую 2026-08-12 починили для
 * дайджестов и не перенесли на вторую половину карты сайта.
 *
 * `intro` приходит ингестом (то есть от модели) и в атрибут попадает через
 * htmlAttrEscape; длину режем — описание на восемь килобайт не читает никто.
 */
export function injectActivityMeta(html: string, a: Activity): string {
  const url = `${SITE_ORIGIN}/activity/${encodeURIComponent(a.id)}`;
  const desc = metaDescription(a.intro || a.whatIs || a.title);
  let out = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    () => `<title>${htmlAttrEscape(a.title)} — DeLabs</title>`,
  );
  out = setMetaTag(out, "property", "og:type", "article");
  out = setMetaTag(out, "property", "og:url", url);
  out = setMetaTag(out, "property", "og:title", a.title);
  out = setMetaTag(out, "property", "og:description", desc);
  out = setMetaTag(out, "name", "twitter:title", a.title);
  out = setMetaTag(out, "name", "twitter:description", desc);
  out = setMetaTag(out, "name", "description", desc);
  return out;
}

/**
 * HTML статьи: та же собранная оболочка, но с её мета-данными. null — если
 * фронт не собран или статьи нет: тогда работает обычный SPA-фолбэк (404 от
 * клиента), поведение остаётся прежним.
 */
let shellCache: {
  path: string;
  mtimeMs: number;
  size: number;
  html: string;
} | null = null;

function shellHtml(): string | null {
  // `webDist()`, а не константа модуля: `SITE_WEB_DIST` читается на каждый
  // вызов, иначе порядок импорта решает, увидим ли мы собранный фронт.
  const index = join(webDist(), "index.html");
  let st;
  try {
    st = statSync(index);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  // Аудит 2026-09-11 (круг 15): `readFileSync` всего index.html стоял на
  // КАЖДОМ запросе оболочки — на каждой статье и на каждом 404. Это
  // синхронное чтение в потоке обработчика, то есть самый дешёвый для
  // сканера и самый дорогой для сервера адрес на сайте. Ключ кэша — путь,
  // mtime и размер: редеплой меняет файл, и оболочка перечитывается сама.
  if (
    shellCache &&
    shellCache.path === index &&
    shellCache.mtimeMs === st.mtimeMs &&
    shellCache.size === st.size
  ) {
    return shellCache.html;
  }
  try {
    const html = readFileSync(index, "utf8");
    shellCache = { path: index, mtimeMs: st.mtimeMs, size: st.size, html };
    return html;
  } catch {
    return null;
  }
}

/** Тестовый хук: сбросить кэш оболочки. */
export function _resetShellCache(): void {
  shellCache = null;
}

function articleShellResponse<T>(
  item: T | null,
  inject: (html: string, item: T) => string,
): Response | null {
  if (!item) return null;
  const html = shellHtml();
  if (html === null) return null;
  return new Response(inject(html, item), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

function digestShellResponse(id: string): Response | null {
  return articleShellResponse(getDigest(id), injectDigestMeta);
}

function activityShellResponse(id: string): Response | null {
  return articleShellResponse(getActivity(id), injectActivityMeta);
}

/**
 * Любой адрес, которого нет, — та же оболочка, но со статусом 404 и
 * `noindex`: несуществующая статья, вложенный статейный путь, выдуманный
 * адрес вроде `/about/x`.
 *
 * Аудит 2026-08-13: раньше несуществующая статья проваливалась в SPA-фолбэк и
 * отдавала index.html со статусом **200**. Для человека разница невидима —
 * клиент рисует свой «не найдено», — а для всего, что читает статус, страница
 * существует: краулер её индексирует, монитор аптайма считает живой, `curl -f`
 * не ругается.
 *
 * Это прямое продолжение T-743: восемь тестовых публикаций удалили из БД, но
 * их URL продолжали отвечать 200 — то есть оставались валидными для поисковика
 * ещё на один цикл обхода. Удаление данных обязано выражаться в статусе.
 *
 * Оболочку отдаём именно ту же (а не голый текст): клиентский роутер сам
 * покажет «статья не найдена», и переход по внутренней ссылке не ломается.
 */
function notFoundShellResponse(): Response | null {
  const html = shellHtml();
  if (html === null) return null;
  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Robots-Tag": "noindex",
    },
  });
}

function fileResponse(filePath: string, noCache = false): Response {
  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Type": type,
      "Cache-Control": noCache
        ? "no-cache"
        : ext === ".html"
          ? "no-cache"
          : "public, max-age=3600",
    },
  });
}

// ---- RSS feed -----------------------------------------------------------

const SITE_ORIGIN = "https://delabs.space";

/**
 * Символы, которых в XML 1.0 не может быть НИКАК — ни сырыми, ни числовой
 * ссылкой. Разрешены только #x9, #xA, #xD и #x20 и выше; из верхнего
 * диапазона исключены #xFFFE/#xFFFF и одиночные суррогаты.
 *
 * Аудит 2026-08-13: `xmlEscape` закрывал пять предопределённых сущностей и
 * ничего не делал с управляющими. Ингест текст не чистит — `handleIngest*`
 * зовёт только `.trim()`, а он снимает лишь пробельные. Один U+0001 в
 * заголовке одного дайджеста делает ВЕСЬ документ не well-formed, и читалки
 * теряют не строку, а всю ленту целиком: `xmllint` даёт «PCDATA invalid Char
 * value 1», ElementTree — «not well-formed». Тексты пишет модель, так что
 * атакующий для этого не нужен. То же касается `/sitemap.xml` через id.
 */
const XML_FORBIDDEN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape the five XML predefined entities. Applied to all dynamic text. */
function xmlEscape(s: string): string {
  return s
    .replace(XML_FORBIDDEN, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** RFC-822 date string (required by RSS pubDate). Falls back to now on bad input. */
function rfc822(iso: string): string {
  const d = new Date(iso);
  return (isNaN(d.getTime()) ? new Date() : d).toUTCString();
}

/**
 * Кэш готовых XML-лент.
 *
 * `/rss.xml` и `/sitemap.xml` собираются из БД синхронно, а `Cache-Control`
 * действует только на клиента: браузер уважает `max-age`, curl в цикле — нет.
 * Держим готовую строку 10 минут — столько же, сколько обещаем в заголовке.
 *
 * Аудит 2026-09-11: здесь было написано «сбрасываем сразу после ингеста». Это
 * неправда: `invalidateFeedCache` не зовёт ни один рабочий путь (только тесты,
 * см. её докстроку). Свежесть держится целиком на `contentStamp()` — ингест
 * меняет штамп, и следующий же запрос ленты строит её заново. Ленты после
 * ингеста действительно свежие, но не потому, что кэш кто-то сбрасывает.
 */
type FeedKey = "rss" | "sitemap";
const feedCache = new Map<FeedKey, { xml: string; until: number; stamp: number }>();
const FEED_TTL_MS = 10 * 60_000;

function cachedFeed(key: FeedKey, build: () => string): string {
  const hit = feedCache.get(key);
  const now = Date.now();
  const stamp = contentStamp();
  // Две проверки, а не одна: `stamp` даёт точность (свежая статья попадает в
  // ленту сразу, а не через десять минут), TTL — страховка на записи мимо
  // upsert-функций, например ручную правку базы.
  if (hit && hit.stamp === stamp && hit.until > now) return hit.xml;
  const xml = build();
  feedCache.set(key, { xml, until: now + FEED_TTL_MS, stamp });
  return xml;
}

/**
 * Сбросить кэш лент. Рабочих вызовов нет — только тесты, которым нужно
 * состояние «лента ещё не строилась» между случаями. Ингест на кэш влияет
 * через `contentStamp()`, а не через этот сброс (аудит 2026-09-11).
 */
export function invalidateFeedCache(): void {
  feedCache.clear();
}

function buildRssXml(): string {
  const items = listDigests(20, 0);
  const channel = [
    "<title>DeLabs — дайджесты</title>",
    `<link>${SITE_ORIGIN}</link>`,
    "<description>Главное по крипте и AI: дайджесты со ссылками на источники.</description>",
    "<language>ru</language>",
    `<lastBuildDate>${rfc822(new Date().toISOString())}</lastBuildDate>`,
    `<atom:link href="${SITE_ORIGIN}/rss.xml" rel="self" type="application/rss+xml" xmlns:atom="http://www.w3.org/2005/Atom"/>`,
  ].join("\n    ");

  const body = items
    .map((d) => {
      const link = `${SITE_ORIGIN}/digest/${encodeURIComponent(d.id)}`;
      return [
        "<item>",
        `  <title>${xmlEscape(d.title)}</title>`,
        `  <link>${xmlEscape(link)}</link>`,
        `  <description>${xmlEscape(d.summary)}</description>`,
        `  <pubDate>${rfc822(d.date)}</pubDate>`,
        `  <guid isPermaLink="false">${xmlEscape(d.id)}</guid>`,
        "</item>",
      ].join("\n    ");
    })
    .join("\n    ");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0">\n` +
    `  <channel>\n    ${channel}\n    ${body}\n  </channel>\n` +
    `</rss>\n`
  );
}

/**
 * GET /rss.xml — RSS 2.0 feed of the ~20 latest digests. Returned as XML (not
 * under the HTML CSP), with nosniff. Built before the SPA static fallback.
 */
function rssResponse(): Response {
  return new Response(cachedFeed("rss", buildRssXml), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ---- robots.txt + sitemap.xml -------------------------------------------

/**
 * Разделы сайта, которые мы ПУБЛИКУЕМ: отсюда строится sitemap.xml.
 * `/digest/:id` и `/activity/:id` идут отдельно — они собираются из БД.
 *
 * Это не вся таблица роутера фронта, и раньше докстрока утверждала обратное,
 * тихо теряя `/status` (web/src/App.tsx). Две сущности разведены: индексируем
 * одно, отвечаем 200 на другое.
 */
const STATIC_ROUTES = [
  "/",
  "/digests",
  "/unlocks",
  "/drops",
  "/activities",
  "/about",
] as const;

/**
 * Маршруты фронта, которые существуют, но в карту сайта не идут: служебные
 * страницы индексировать незачем.
 */
const UNLISTED_ROUTES = ["/status"] as const;

/** Полная таблица маршрутов SPA. Всё, чего в ней нет, — 404. */
const SPA_ROUTES: ReadonlySet<string> = new Set<string>([
  ...STATIC_ROUTES,
  ...UNLISTED_ROUTES,
]);

/**
 * Знает ли роутер фронта этот путь.
 *
 * Аудит 2026-09-11 (круг 15): правка, закрывшая `/digest/foo/bar`, опиралась
 * на верное наблюдение — таблица маршрутов фронта закрыта, значит неизвестный
 * путь это 404, а не «какой-то маршрут SPA», — но воспользовалась им только
 * для двух префиксов, только в точной форме и только в точном регистре. Мимо
 * проходили `/about/x`, `/unlocks/1`, `/totally-made-up` (200 с og-тегами
 * главной) и `/Digest/x` (то же самое, при том что `/digest/x` рядом честно
 * отвечал 404). Сверка со всей таблицей закрывает все три случая разом.
 *
 * Регистр снимаем: путь в URL его сохраняет, а маршруты у нас строчные.
 * Хвостовой слэш тоже: `/digests/` и `/digests` — один маршрут.
 */
export function isKnownSpaRoute(pathname: string): boolean {
  const p = pathname.toLowerCase().replace(/\/+$/, "");
  return SPA_ROUTES.has(p === "" ? "/" : p);
}

/**
 * GET /robots.txt — до статического фолбэка, иначе SPA отдаёт на этот адрес
 * `index.html` с кодом 200: robots.txt, который парсится как HTML, — мусор, и
 * объявить в нём карту сайта негде.
 *
 * `/api/` закрываем от обхода: данные и так отдаёт фронт, а служебные
 * `/api/internal/*` требуют токен — каждый заход краулера туда это лишние 401
 * в логе и съеденный слот рейт-лимита.
 */
function robotsResponse(): Response {
  const body =
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /api/",
      "",
      `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    ].join("\n") + "\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Потолок адресов на таблицу в `sitemap.xml`. Протокол разрешает 50 000 на
 * файл; берём с запасом вдвое, чтобы статические маршруты и обе таблицы вместе
 * гарантированно уложились.
 */
export const SITEMAP_MAX_PER_TABLE = 20_000;

/**
 * GET /sitemap.xml — все статьи и активности, а не двадцать последних.
 *
 * RSS (/rss.xml) — это лента: он по определению обрезан, и статья, уехавшая за
 * двадцатую позицию, не встречалась бы больше нигде. При этом именно на
 * `/digest/<id>` указывают ссылки из канала.
 *
 * `<loc>` — percent-encoded id внутри xmlEscape: id приходит через ингест от
 * модели, и амперсанд в нём не должен ломать документ.
 */
export function buildSitemapXml(limit: number = SITEMAP_MAX_PER_TABLE): string {
  const urls: { loc: string; lastmod?: string }[] = STATIC_ROUTES.map((p) => ({
    loc: `${SITE_ORIGIN}${p}`,
  }));
  // Лимит намеренно большой, но конечный: протокол sitemap разрешает 50 000
  // адресов на файл, и упереться в него молча нельзя.
  //
  // Аудит 2026-08-29: «молча нельзя» тут и было единственным, что мешало —
  // фраза в комментарии. Выборка режется `LIMIT`, счётчика нет, предупреждения
  // нет: страницы просто перестали бы попадать в карту, а узнали бы мы об этом
  // по падению индексации через недели. Насыщение — состояние, а не ошибка,
  // поэтому это warn, а не бросок: карта отдаётся, но факт назван.
  const entries = listSitemapEntries(limit);
  const saturated = [
    ...(entries.digests.length >= limit ? ["digests"] : []),
    ...(entries.activities.length >= limit ? ["activities"] : []),
  ];
  if (saturated.length > 0) {
    console.warn("[sitemap] упёрлись в потолок, часть страниц не в карте", {
      limit,
      tables: saturated,
    });
  }
  for (const d of entries.digests) {
    urls.push({
      loc: `${SITE_ORIGIN}/digest/${encodeURIComponent(d.id)}`,
      lastmod: isoDate(d.date),
    });
  }
  for (const a of entries.activities) {
    urls.push({ loc: `${SITE_ORIGIN}/activity/${encodeURIComponent(a.id)}` });
  }

  const body = urls
    .map((u) =>
      [
        "  <url>",
        `    <loc>${xmlEscape(u.loc)}</loc>`,
        ...(u.lastmod ? [`    <lastmod>${u.lastmod}</lastmod>`] : []),
        "  </url>",
      ].join("\n"),
    )
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${body}\n</urlset>\n`
  );
}

function sitemapResponse(): Response {
  return new Response(cachedFeed("sitemap", buildSitemapXml), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** YYYY-MM-DD для <lastmod>; на нераспознанной дате — без поля вовсе. */
function isoDate(value: string): string | undefined {
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

// ---- internal ingest (digest bridge) ------------------------------------

/** Верхняя граница тела ингеста, 1 МиБ. */
export const MAX_INGEST_BYTES = 1024 * 1024;

/**
 * Транспортный потолок тела запроса — внешняя сеть безопасности под
 * прикладным `MAX_INGEST_BYTES`, а не его копия.
 *
 * Аудит 2026-09-11: здесь стояло ровно `1 << 20`, то есть в точности
 * `MAX_INGEST_BYTES`. Проверено на Bun 1.3.14: при теле в CAP+1 байт Bun
 * отвечает САМ, до хендлера, — `413` с единственным заголовком
 * `connection: close`. Три следствия сразу. Ветка `size > MAX_INGEST_BYTES` в
 * `readCappedBody` и `{ error: "payload_too_large" }` в `authedJsonBody` в бою
 * недостижимы — мёртвый код (тест на них зовёт `makeFetchHandler()` напрямую,
 * минуя транспорт, и коллизию поймать не мог). Агент-клиент получает пустое
 * тело вместо контракта `{error}`, на который опирается на всех прочих
 * ошибках ингеста, и без единого заголовка из `SECURITY_HEADERS`. И отказ
 * происходит «по объявленной длине, до чтения» — ровно тем способом, от
 * которого докблок `readCappedBody` отказался сознательно и с описанием
 * симптома.
 *
 * Восьмикратный запас: прикладной потолок должен срабатывать первым на всём
 * честном диапазоне, а транспортный — оставаться защитой от тела, которое
 * незачем даже вычитывать. Дефолт Bun (128 МБ) для этого слишком высок.
 */
export const MAX_REQUEST_BODY_BYTES = MAX_INGEST_BYTES * 8;

/**
 * Секрет ингеста или null, если мост выключен.
 *
 * Аудит 2026-09-11 (круг 15): значение читалось в трёх местах тремя разными
 * мерками (`!expected || expected.length === 0` здесь, `!process.env....`
 * в `authedJsonBody` и в 404-гейте `routeApi`), и все три считали заданным
 * значение из одних пробелов. `SITE_INGEST_TOKEN=" "` — не секрет, а описка
 * в env-файле, но мост от неё включался, и ключом к нему становился пробел.
 * Мерка теперь одна и здесь. Сам токен НЕ подрезаем: подрезать значит менять
 * то, с чем сверяется запрос, — здесь решается только «задан или нет».
 */
function ingestSecret(): string | null {
  const v = process.env.SITE_INGEST_TOKEN;
  return v && v.trim().length > 0 ? v : null;
}

/**
 * Сравнение токена за постоянное время. Токен нигде не логируется.
 *
 * Сравниваем SHA-256 обеих строк, а не сами строки: хэши всегда 32 байта,
 * поэтому `timingSafeEqual` не бросает на разной длине — и, главное, из
 * времени ответа больше не вытекает длина ожидаемого токена. Прежний код
 * возвращал false сразу на `provided.length !== expected.length`, то есть
 * подбор длины стоил одного запроса на вариант (аудит 2026-08-12).
 */
function tokenMatches(provided: string | null): boolean {
  const expected = ingestSecret();
  // Bridge is OFF unless the env secret is configured.
  if (expected === null) return false;
  if (!provided) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Extract the Bearer token from an Authorization header. */
function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Запасной хвост слага, когда из текста не осталось ни буквы, ни цифры.
 *
 * Аудит 2026-08-13: в этом месте стоял `Date.now()`. Заголовок целиком из
 * эмодзи (или из одних знаков препинания) — не выдумка: тексты пишет модель, а
 * `[^\p{L}\p{N}]` выкашивает эмодзи подчистую, и от «🔥🔥🔥» остаётся пустая
 * строка. Дальше id получался разным на каждый вызов, и ломалось ровно то, что
 * `freeSlug` рядом бережёт: агент переотправляет статью после правок, upsert
 * обязан обновить её на месте. Вместо этого каждая правка плодила новую
 * страницу — и по одному и тому же адресу больше никогда не отвечал никто,
 * потому что старый id не воспроизводился даже тем же телом запроса.
 *
 * Хэш от самого текста детерминирован: тот же материал → тот же id, разный →
 * разный. А настоящее совпадение (два разных материала с одинаковым голым
 * заголовком) по-прежнему разводит `freeSlug`.
 */
function contentSuffix(...parts: string[]): string {
  // Разделитель ОБЯЗАН оставаться escape-последовательностью, а не сырым
  // байтом 0x00 в исходнике.
  //
  // Аудит 2026-08-20: до этой правки здесь стоял настоящий NUL (смещение
  // 36621), и `file` называл главный файл сервера `data`. Последствие не в
  // рантайме — семантика верна, tsc и bun test довольны, — а в том, что ЛЮБОЙ
  // обычный grep молча пропускал этот файл целиком:
  //
  //   $ grep -n "api/internal" site/server/index.ts      → пусто
  //   $ grep -n "SITE_INGEST_TOKEN" site/server/index.ts → пусто
  //
  // То есть единственный файл, где живут `tokenMatches`, `authedJsonBody` и
  // оба `/api/internal/*`, был невидим для поиска секретов, для гейта на
  // маркеры конфликта из CLAUDE.md §3.8 и для любого ручного аудита — и все
  // они возвращали «чисто».
  return createHash("sha256")
    .update(parts.join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 10);
}

/**
 * Рез основы слага по СИМВОЛАМ, а не по единицам UTF-16.
 *
 * Аудит 2026-08-28: оба слагостроителя резали `.slice(0, N)`. Символы вне BMP
 * (CJK Extension B, математические литеры, Osage) занимают две единицы и
 * проходят фильтр `[^\p{L}\p{N}]` как буквы — если граница попадала между
 * ними, в хвосте оставался одинокий суррогат. Строка переставала быть
 * валидным UTF-8: SQLite сохранял её как U+FFFD, то есть id в БД и id в
 * ответе расходились, и `GET /api/digests/<id>` отдавал 404 на статью,
 * которая при этом лежала в списке, в rss.xml и в sitemap.xml. Вдобавок
 * `encodeURIComponent` на одиноком суррогате бросает URIError — клиент не мог
 * даже собрать ссылку.
 */
function clipSlug(base: string, max: number): string {
  return Array.from(base).slice(0, max).join("");
}

/** Build a url-safe slug from a title (Cyrillic-friendly) + date prefix. */
function slugFromTitle(title: string, dateIso: string): string {
  const datePart = dateIso.slice(0, 10); // YYYY-MM-DD
  const base = clipSlug(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
    80,
  );
  return base ? `${datePart}-${base}` : `${datePart}-${contentSuffix(title)}`;
}

/**
 * Окно, внутри которого повторная присылка того же заголовка считается
 * ПРАВКОЙ уже опубликованной статьи, а не новым выпуском.
 *
 * Аудит 2026-08-20. Производный слаг начинается с даты (`slugFromTitle`), а
 * дату ингест берёт «сейчас»: мост `ingestDigestToSite` шлёт только
 * `{title, summary, items, sourceCount}`. Пока правка приходит в те же UTC-сутки,
 * слаг совпадает и статья обновляется на месте — ровно то, что обещает
 * докстринг `freeSlug`. На стыке суток префикс меняется, и та же самая статья
 * заводит вторую страницу: пост, вышедший в 23:50 и поправленный в 00:10,
 * даёт две карточки с одинаковым заголовком. Это и есть ситуация инцидента
 * T-743, только приезжающая сама.
 *
 * Двенадцать часов, а не сутки: заголовки шаблонов постоянны («Итоги недели»
 * — это буквально первая строка `buildWeeklyRecapText`), и окно обязано быть
 * заметно уже минимального интервала между выпусками. При этом оно ничего не
 * добавляет к максимальной дальности переиспользования: внутри одних суток
 * `freeSlug` и раньше отдавал тот же id на расстоянии до 24 часов. Здесь
 * добавляется только переход через полночь, и на меньшую дистанцию.
 */
const DIGEST_REUSE_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * id уже опубликованной статьи, если присланное — её правка, иначе null.
 *
 * Сравнение по абсолютной разнице: у присланной даты нет обязанности быть
 * позже сохранённой (её может задать вызывающий), а «на пять минут в будущем»
 * из-за часов — не повод плодить страницу.
 */
export function reusableDigestId(
  dateIso: string,
  latest: { id: string; date: string } | null,
): string | null {
  if (!latest) return null;
  const incoming = Date.parse(dateIso);
  const stored = Date.parse(latest.date);
  if (Number.isNaN(incoming) || Number.isNaN(stored)) return null;
  return Math.abs(incoming - stored) <= DIGEST_REUSE_WINDOW_MS ? latest.id : null;
}

/**
 * Найти свободный id для ПРОИЗВОДНОГО слага.
 *
 * Слаг режется по первым 80 (у активностей — 90) символам, а кириллица
 * выбирает этот лимит одним заголовком: у «Итогов недели» отличие живёт в
 * хвосте («— часть первая» / «— часть вторая»), а хвост отрезан. Дальше
 * upsert делает ON CONFLICT DO UPDATE, то есть вторая статья затирала первую,
 * и ingest всё равно отвечал 200 ok — команда агентов считала, что
 * опубликовала обе (замер: два дайджеста → countDigests() === 1, в БД остался
 * только заголовок второго).
 *
 * `taken` возвращает true только если id занят ДРУГИМ материалом: тот же
 * материал должен по-прежнему обновляться на месте — агент переотправляет
 * статью после правок, и плодить копии на каждую правку нельзя.
 */
function freeSlug(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; n <= 50; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  // Пятьдесят статей с одинаковым началом в один день — уже не про людей,
  // но молча затирать всё равно нельзя.
  return `${base}-${Date.now()}`;
}

/**
 * Читает тело запроса потоком, держа в памяти не больше `MAX_INGEST_BYTES`.
 * Возвращает `null`, если тело переросло потолок.
 *
 * Аудит 2026-08-13 отправил в ингест 40 МБ JSON — приняли и сохранили;
 * собственный предел Bun'а — 128 МБ. Ингест авторизован, то есть это не чужая
 * рука, а свой же агент в цикле, но `req.json()` на таком теле кладёт процесс
 * на маленьком VPS. Дайджест — это заголовок, аннотация и список ссылок,
 * мегабайта хватает с запасом.
 *
 * Отказ по `content-length`, до чтения, был бы дешевле — но тогда в сокете
 * остаётся непрочитанный хвост, который на keep-alive разбирается как начало
 * следующего запроса. В тесте это выглядело так: сам 413 приходил, а
 * следующий POST по тому же соединению не дожидался ответа за 5 секунд. Ни
 * `Connection: close`, ни `req.body.cancel()` этого не расшили, поэтому тело
 * дочитывается всегда — просто чанки после потолка выбрасываются, а не
 * копятся.
 */
async function readCappedBody(req: Request): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_INGEST_BYTES) {
      over = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(value);
  }
  if (over) return null;
  const merged = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Shared preamble for the authenticated /api/internal/* ingest endpoints:
 * enforces the env-gate (404 when unset), Bearer-token auth (401), JSON parse
 * (400) and object-shape check (400). Returns the parsed body as a record on
 * success, or a ready-to-return error Response. Keeps both ingest handlers
 * from copy-pasting identical auth/validation boilerplate.
 */
async function authedJsonBody(
  req: Request,
  origin: string | null,
): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  // If the secret is unset the endpoint does not exist at all.
  if (ingestSecret() === null) {
    return { error: json({ error: "not_found" }, { status: 404 }, origin) };
  }
  if (!tokenMatches(bearerToken(req))) {
    return { error: json({ error: "unauthorized" }, { status: 401 }, origin) };
  }
  const raw = await readCappedBody(req);
  if (raw === null) {
    return {
      error: json({ error: "payload_too_large" }, { status: 413 }, origin),
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: json({ error: "invalid_json" }, { status: 400 }, origin) };
  }
  if (typeof body !== "object" || body === null) {
    return { error: json({ error: "invalid_body" }, { status: 400 }, origin) };
  }
  return { body: body as Record<string, unknown> };
}

/**
 * POST /api/internal/digests — authenticated ingest from the agent team.
 * Disabled (404) unless SITE_INGEST_TOKEN is configured. Idempotent by id.
 */
async function handleIngestDigest(
  req: Request,
  origin: string | null,
): Promise<Response> {
  const parsed = await authedJsonBody(req, origin);
  if ("error" in parsed) return parsed.error;
  const b = parsed.body;

  const title = asString(b.title, INGEST_MAX.title);
  const summary = asString(b.summary, INGEST_MAX.summary);
  if (!title || !summary) {
    return json(
      { error: "title_and_summary_required" },
      { status: 400 },
      origin,
    );
  }

  const date = parseIngestDate(b.date);
  if ("error" in date) return json({ error: date.error }, { status: 400 }, origin);
  const dateIso = date.iso;

  // Занятость проверяется ОДНИМ предикатом для обеих веток. Аудит 2026-08-20:
  // раньше присланный id «уважался как есть», и `ON CONFLICT(id) DO UPDATE` в
  // upsertDigest молча подменял уже опубликованную страницу другим материалом —
  // тем самым, от которого производный слаг был обязан увернуться через
  // freeSlug. Ни DELETE-роута, ни версий у страниц нет, а RSS к тому моменту
  // уже ушёл, так что «перезаписали не то» не откатывается ничем.
  const taken = (cand: string): boolean => {
    const existing = getDigest(cand);
    return existing !== null && existing.title !== title;
  };
  // Аудит 2026-08-28: обработчик активностей ниже с этого же аудита называет
  // поля, которые не смог прочитать; здесь та же ветка осталась немой.
  // Направление у всех трёх полей безопасное — непонятое значение считается
  // «не прислали» и сохранённое не трогает, — но ответ при этом неотличим от
  // полного обновления. Отправитель с опечаткой в типе видит `ok:true` и
  // считает, что опубликовал тело статьи, хотя на странице осталось прежнее.
  const ignoredFields: string[] = [];

  // id — не просто поле: НЕстроковый (число из сериализатора, объект) даёт не
  // 400 и не подмену чужой страницы, а «id не прислали», то есть свежий слаг
  // и вторую страницу рядом с первой. DELETE-маршрута у дайджестов нет.
  if (b.id !== undefined && typeof b.id !== "string") ignoredFields.push("id");
  const givenId = typeof b.id === "string" ? b.id.trim() : "";
  if (givenId && !validIngestId(givenId)) {
    return json({ error: "invalid_id" }, { status: 400 }, origin);
  }
  if (givenId && taken(givenId)) {
    // 409, а не 400: тело валидно, конфликтует состояние сайта. Повторная
    // отправка ТОГО ЖЕ материала под тем же id по-прежнему проходит — это
    // обновление, а не подмена.
    return json({ error: "id_taken", id: givenId }, { status: 409 }, origin);
  }
  const id =
    givenId ||
    // Правка уже опубликованного материала обновляется на месте даже если
    // приехала на следующие UTC-сутки — иначе на стыке суток та же статья
    // заводит вторую страницу. См. DIGEST_REUSE_WINDOW_MS.
    //
    // Предикат занятости тот же `taken`: «занято» значит «под этим id лежит
    // ДРУГОЙ материал», и переиспользование страницы того же заголовка под
    // него не попадает.
    reusableDigestId(dateIso, findLatestDigestByTitle(title)) ||
    freeSlug(slugFromTitle(title, dateIso), taken);

  // Аудит 2026-08-28: `items` отсутствующие и `items: []` сводились здесь к
  // одному и тому же пустому массиву, а он ехал в БД как «стереть». Реингест
  // той же статьи отправителем, который пунктов не шлёт, обнулял источники и
  // поисковый текст, и ответ был ok. Теперь «не прислали» доезжает до
  // upsertDigest как undefined и сохранённое не трогает; `[]` осталось явной
  // очисткой.
  const sentItems = Array.isArray(b.items);
  if (b.items !== undefined && !sentItems) ignoredFields.push("items");
  const rawItems = sentItems ? (b.items as unknown[]) : [];
  const items: DigestItem[] = [];
  for (const it of rawItems) {
    if (items.length >= INGEST_MAX.items) break;
    if (typeof it !== "object" || it === null) continue;
    const r = it as Record<string, unknown>;
    const text =
      typeof r.text === "string" ? clip(r.text, INGEST_MAX.itemText) : "";
    if (!text) continue;
    const url = safeStoredUrl(r.url); // "" if not http(s)
    // Слишком длинную ссылку не сохраняем, но пункт оставляем: содержимое
    // пункта — его текст. Поле называем один раз на весь запрос.
    const stored = url.length <= INGEST_MAX.url ? url : "";
    if (url && !stored && !ignoredFields.includes("item.url")) {
      ignoredFields.push("item.url");
    }
    items.push(stored ? { text, url: stored } : { text });
  }

  const sentSourceCount =
    typeof b.sourceCount === "number" && Number.isFinite(b.sourceCount);
  if (b.sourceCount !== undefined && !sentSourceCount) {
    ignoredFields.push("sourceCount");
  }
  const sourceCount = sentSourceCount
    ? Math.min(
        INGEST_MAX.sourceCount,
        Math.max(0, Math.trunc(b.sourceCount as number)),
      )
    : sentItems
      ? items.length
      : undefined;

  // Optional full article body (markdown). Our own content, not user input —
  // we just store it; the frontend escapes HTML before rendering.
  // Аудит 2026-08-28: было `asString(b.body, …)` плюс `...(articleBody ? … : {})`
  // ниже, то есть пустая строка выбрасывалась наравне с отсутствием поля.
  // `upsertDigest` их различает с аудита 2026-08-21 (NULL — не трогать,
  // пустая строка — очистка), но до него это различие не доезжало: убрать
  // ошибочно опубликованный полный текст было нечем, DELETE-роута у
  // дайджестов нет, а перезалив с `body: ""` возвращал ok и ничего не менял.
  // Не-строка по-прежнему считается «не прислали», как и у остальных полей.
  if (b.body !== undefined && typeof b.body !== "string") {
    ignoredFields.push("body");
  }
  const articleBody =
    typeof b.body === "string" ? clip(b.body.trim(), INGEST_MAX.body) : undefined;

  const digest: DigestUpsert = {
    id,
    title,
    date: dateIso,
    keepDateOnUpdate: !date.provided,
    summary,
    ...(articleBody === undefined ? {} : { body: articleBody }),
    ...(sentItems ? { items } : {}),
    ...(sourceCount === undefined ? {} : { sourceCount }),
  };
  upsertDigest(digest);

  // Аудит 2026-08-13: ответ был `{ok:true,id}` при любом исходе. Цикл выше
  // молча выбрасывает всё, что не влезло в INGEST_MAX.items, и всё, у чего
  // пустой или нестроковый text; отправитель видел «ok» и считал, что
  // опубликовал десять пунктов, хотя доехало шесть. Ошибкой это не назвать —
  // дайджест в БД и на сайте, — поэтому лечим не статус, а немоту: сколько
  // пунктов сохранено и сколько потеряно, счётчиком, а не вычитанием.
  const droppedItems = rawItems.length - items.length;
  if (droppedItems > 0) {
    console.warn("[ingest] часть пунктов дайджеста не сохранена", {
      id,
      sent: rawItems.length,
      stored: items.length,
    });
  }
  // Аудит 2026-08-28: `items.length` — это длина локального массива, а он
  // пуст всегда, когда поле не прислали. Реингест, который сохранённые
  // пункты как раз НЕ тронул, отвечал «ноль», а `sourceCount` уезжал
  // `undefined` и пропадал из JSON целиком. Число из ответа — единственное,
  // по чему отправитель судит о результате (`droppedItems` считается от того
  // же пустого массива и тоже ноль), так что ответ сообщал потерю, которой не
  // было. Читаем фактически сохранённое — ровно как ответ ингеста
  // активностей ниже (`storedSteps`).
  if (ignoredFields.length > 0) {
    console.warn("[ingest] поле дайджеста не удалось прочитать и пропущено", {
      id,
      fields: ignoredFields,
    });
  }
  const stored = getDigest(id);
  return json(
    {
      ok: true,
      id,
      items: stored?.items.length ?? 0,
      sourceCount: stored?.sourceCount ?? 0,
      ...(droppedItems > 0 ? { droppedItems } : {}),
      ...(ignoredFields.length > 0 ? { ignoredFields } : {}),
    },
    { status: 200 },
    origin,
  );
}

/** Build a url-safe slug from project + title (Cyrillic-friendly, no date). */
function slugFromProjectTitle(project: string, title: string): string {
  const base = clipSlug(
    `${project} ${title}`
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
    90,
  );
  // Тот же `Date.now()`, что и в slugFromTitle, и с тем же следствием: у
  // активностей в слаге нет даже даты, так что воспроизвести прежний id было
  // нечем вовсе. См. contentSuffix.
  return base || `activity-${contentSuffix(project, title)}`;
}

/**
 * Потолки ингеста.
 *
 * Аутентификация идёт до чтения тела, так что «жирный body» без токена
 * невозможен. Но у обладателя токена — и у любого бага в агентской петле —
 * потолка не было вовсе: ни на длину поля, ни на число элементов, ни на
 * формат присланного id. Всё это уезжало в SQLite, откуда потом читается
 * `SELECT *` (аудит 2026-08-12). Значения выбраны с запасом от реального
 * выпуска: самый длинный дайджест за всю историю — около 6 КБ тела.
 */
const INGEST_MAX = {
  id: 120,
  title: 300,
  summary: 2_000,
  body: 200_000,
  items: 100,
  itemText: 1_000,
  steps: 50,
  stepText: 2_000,
  hashtags: 30,
  hashtag: 80,
  short: 500,
  long: 8_000,
  sourceCount: 10_000,
  // Аудит 2026-08-29: единственное поле, которого в этой таблице не было, —
  // и при этом оно едет в проекциях списков (`items_json` у дайджестов,
  // колонка `url` у активностей), то есть в анонимный `limit=100`.
  //
  // Потолок здесь работает не резом, а отказом: обрезанная ссылка — это
  // НЕВЕРНАЯ ссылка, которая всё равно отрисуется кликабельной, тогда как
  // обрезанный текст остаётся читаемым текстом. Две тысячи символов — с
  // запасом от исторического предела адресной строки (2083).
  url: 2_000,
} as const;

/**
 * Обрезать строку по потолку. Тихо: отправитель — свой, а не пользователь.
 *
 * Аудит 2026-08-28 (второй заход): `clipSlug` перевели на рез по символам, а
 * этот рез остался прежним — хотя через него идут title, summary, body,
 * тексты источников, шаги и хэштеги. Если граница попадает между единицами
 * суррогатной пары, в хвосте остаётся одинокий суррогат, и SQLite сохраняет
 * его как U+FFFD: в ответе одно, в базе другое.
 *
 * Дороже всего это обходится предикату `taken`: `existing.title !== title`
 * сравнивает `…\uFFFD` из базы с `…\uD840` из тела запроса и ВСЕГДА истинно.
 * Повторная присылка того же гайда — обычный путь обновления — вместо правки
 * заводит `-2`, `-3` и так далее; DELETE-роута у сайта нет, убрать дубли
 * нечем.
 *
 * Режем по-прежнему в единицах UTF-16, а не в символах (в отличие от
 * `clipSlug`, где потолок — про длину URL): здесь потолок сторожит размер
 * того, что уедет в БД, и `Array.from(...).slice(max)` растянул бы его вдвое.
 * Разорванную пару просто отбрасываем целиком.
 */
function clip(v: string, max: number): string {
  if (v.length <= max) return v;
  const cut = v.slice(0, max);
  const tail = cut.charCodeAt(max - 1);
  const lonelyHighSurrogate = tail >= 0xd800 && tail <= 0xdbff;
  return lonelyHighSurrogate ? cut.slice(0, max - 1) : cut;
}

/**
 * Coerce an unknown value to an array of trimmed non-empty strings.
 * `max` — сколько элементов оставить, `maxLen` — потолок длины каждого.
 */
function toStringArray(v: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (out.length >= max) break;
    if (typeof x === "string" && x.trim()) out.push(clip(x.trim(), maxLen));
  }
  return out;
}

function asString(v: unknown, max: number = INGEST_MAX.short): string {
  return typeof v === "string" ? clip(v.trim(), max) : "";
}

/**
 * Присланный id — это и первичный ключ, и сегмент URL. Форму проверяем явно:
 * буквы, цифры, дефис и подчёркивание, начиная с буквы или цифры. Всё прочее
 * (пробелы, слэши, управляющие символы, километровая строка) — 400, а не
 * тихая подмена: вызывающий — наш же мост, и он должен узнать о поломке.
 */
const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

function validIngestId(raw: string): boolean {
  return raw.length <= INGEST_MAX.id && ID_RE.test(raw);
}

/** Нижняя граница осмысленной даты — генезис-блок биткоина. */
const DATE_FLOOR_MS = Date.parse("2009-01-03T00:00:00.000Z");
/** Верхняя — год вперёд: дедлайны кампаний бывают дальними, но не такими. */
const DATE_CEIL_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Разобрать дату из тела ингеста.
 *
 * Аудит 2026-08-13: было `Date.parse(...)` без единой границы, а на неудачу —
 * молчаливая подмена на «сейчас». Отсюда два разных вреда.
 *
 * Первый: `Date.parse` глотает куда больше, чем кажется. Год 9999 и «Sat Jan
 * 01 275760» — валидные даты, и дайджест с такой датой встаёт первым в ленте
 * НАВСЕГДА: сортировка идёт по date DESC. Уронить главную страницу сайта
 * опечаткой в одном поле не должно быть возможно.
 *
 * Второй: строку, которую разобрать не удалось («вчера», «12.08.2026»),
 * прежний код заменял текущим временем и отвечал 200 ok. Отправитель — наш же
 * мост, он про подмену не узнавал никак, а дайджест уезжал не в тот день.
 *
 * Отсутствие поля — по-прежнему «сейчас»: это осмысленный дефолт. Присланное,
 * но негодное — 400: раз дату указали, она должна что-то значить.
 *
 * Форма при этом требуется ISO-8601 (`YYYY-MM-DD…`) — иначе разбор молча
 * меняет смысл: `Date.parse("12.08.2026")` в этом рантайме отвечает не
 * ошибкой, а восьмым декабря. Наш мост всегда шлёт `toISOString()`, так что
 * ограничение никого не задевает, а европейская запись перестаёт тихо
 * превращаться в американскую.
 */
const ISO_DATE_HEAD = /^\d{4}-\d{2}-\d{2}/;
function parseIngestDate(
  raw: unknown,
  now: number = Date.now(),
):
  | { iso: string; provided: boolean }
  | { error: "invalid_date" | "date_out_of_range" } {
  if (raw === undefined || raw === null || raw === "") {
    // Аудит 2026-08-29: «сейчас» — дефолт для вставки, а не приказ обновлению.
    // `provided` доносит разницу до апсерта (`keepDateOnUpdate`), иначе правка
    // без даты двигала дату публикации уже вышедшего материала.
    return { iso: new Date(now).toISOString(), provided: false };
  }
  if (typeof raw !== "string") return { error: "invalid_date" };
  if (!ISO_DATE_HEAD.test(raw)) return { error: "invalid_date" };
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return { error: "invalid_date" };
  if (t < DATE_FLOOR_MS || t > now + DATE_CEIL_AHEAD_MS) {
    return { error: "date_out_of_range" };
  }
  return { iso: new Date(t).toISOString(), provided: true };
}

/**
 * POST /api/internal/activities — authenticated ingest from the agent team.
 * Disabled (404) unless SITE_INGEST_TOKEN is configured. Idempotent by id.
 * id defaults to a slug from project+title when not provided.
 */
async function handleIngestActivity(
  req: Request,
  origin: string | null,
): Promise<Response> {
  const parsed = await authedJsonBody(req, origin);
  if ("error" in parsed) return parsed.error;
  const b = parsed.body;

  const project = asString(b.project, INGEST_MAX.title);
  const title = asString(b.title, INGEST_MAX.title);
  if (!project || !title) {
    return json(
      { error: "project_and_title_required" },
      { status: 400 },
      origin,
    );
  }

  const date = parseIngestDate(b.date);
  if ("error" in date) return json({ error: date.error }, { status: 400 }, origin);
  const dateIso = date.iso;

  // У активностей в слаге нет даты вовсе, поэтому «тот же материал» — это
  // совпадение и проекта, и заголовка. Предикат один на обе ветки — см.
  // handleIngestDigest: присланный id раньше проходил мимо этой проверки и
  // затирал чужой гайд через ON CONFLICT(id) DO UPDATE.
  const taken = (cand: string): boolean => {
    const existing = getActivity(cand);
    return (
      existing !== null &&
      (existing.title !== title || existing.project !== project)
    );
  };
  const ignoredFields: string[] = [];

  // Аудит 2026-08-28: id читался тем же `typeof … === "string" ? … : ""`, что и
  // у дайджестов, то есть НЕстроковый id — это не 400 и не подмена чужого
  // гайда, а «id не прислали»: заводится свежий слаг и появляется вторая
  // страница. У активностей в слаге нет даже даты, так что каждый повторный
  // ингест плодил бы ещё одну; DELETE-маршрута нет.
  if (b.id !== undefined && typeof b.id !== "string") ignoredFields.push("id");
  const givenId = typeof b.id === "string" ? b.id.trim() : "";
  if (givenId && !validIngestId(givenId)) {
    return json({ error: "invalid_id" }, { status: 400 }, origin);
  }
  if (givenId && taken(givenId)) {
    return json({ error: "id_taken", id: givenId }, { status: 409 }, origin);
  }
  const id = givenId || freeSlug(slugFromProjectTitle(project, title), taken);

  // Аудит 2026-08-28: условие было `b.steps === undefined`, а toStringArray на
  // любом не-массиве возвращает пустой массив. Значит строка со списком шагов,
  // `null` или объект доезжали до БД как ЯВНАЯ ОЧИСТКА и выносили шаги —
  // главное содержимое гайда. Счётчик потерь при этом оставался нулём (он
  // считается через `Array.isArray`), так что ни в лог, ни в ответ не попадало
  // ничего: отправитель видел `ok:true` над опустевшим гайдом.
  //
  // Теперь поле, которое не удалось прочитать как массив, считается НЕ
  // присланным — ровно как `items` у дайджестов. Сохранённое не трогаем, а о
  // непонятом поле сообщаем отдельным списком: 400 здесь неуместен, ингест и
  // так терпим ко входу, а валить публикацию из-за одного поля дороже, чем её
  // сохранить и назвать пропущенное.
  //
  // Аудит 2026-08-28: у скаляров правило было ровно обратным. `asStringOpt`
  // считал «не прислали» только `undefined`, а `null`, число, массив и объект
  // гнал через `asString`, который отдаёт `""` — то есть ЯВНУЮ ОЧИСТКУ, и
  // `CASE WHEN … IS NULL` в upsertActivity её пропускал. `null` в этих полях
  // не экзотика, а обычный выход сериализатора (Python `None`, JS `?? null`),
  // так что один штатный реингест выносил intro, whatIs, суммы, инвесторов и
  // ссылку — молча, с `ok:true`. Восстановить нечем: DELETE-маршрута и версий
  // у активностей нет. Скаляры читаются тем же правилом, что и массивы.
  const readArray = (
    name: "steps" | "hashtags",
    v: unknown,
    max: number,
    maxLen: number,
  ): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      ignoredFields.push(name);
      return undefined;
    }
    return toStringArray(v, max, maxLen);
  };

  const readScalar = (
    name: string,
    v: unknown,
    max: number = INGEST_MAX.short,
  ): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string") {
      ignoredFields.push(name);
      return undefined;
    }
    return asString(v, max);
  };

  // Ссылка отдельно: `safeStoredUrl` отдаёт `""` для любой строки без
  // `http(s)://`, поэтому опечатка вроде `delabs.space/guide` (забыли схему)
  // снимала сохранённую ссылку так же тихо, как `null`. Пустая строка —
  // по-прежнему осознанное «ссылки нет».
  const readUrl = (v: unknown): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string") {
      ignoredFields.push("url");
      return undefined;
    }
    if (v.trim() === "") return "";
    const safe = safeStoredUrl(v);
    // Длина — такой же повод не читать поле, как отсутствие схемы: см.
    // INGEST_MAX.url. Направление то же самое — сохранённое не трогаем.
    if (safe === "" || safe.length > INGEST_MAX.url) {
      ignoredFields.push("url");
      return undefined;
    }
    return safe;
  };

  // Шаги — главное содержимое гайда, и toStringArray режет их так же молча,
  // как цикл пунктов у дайджестов. Считаем потерю до сборки объекта.
  const steps = readArray("steps", b.steps, INGEST_MAX.steps, INGEST_MAX.stepText);
  const droppedSteps = Array.isArray(b.steps)
    ? b.steps.length - (steps?.length ?? 0)
    : 0;

  const activity: ActivityUpsert = {
    id,
    project,
    emoji: readScalar("emoji", b.emoji, 16),
    title,
    intro: readScalar("intro", b.intro, INGEST_MAX.long),
    whatIs: readScalar("whatIs", b.whatIs, INGEST_MAX.long),
    steps,
    raised: readScalar("raised", b.raised),
    investors: readScalar("investors", b.investors),
    spent: readScalar("spent", b.spent),
    time: readScalar("time", b.time),
    rewardType: readScalar("rewardType", b.rewardType),
    status: readScalar("status", b.status),
    dateReceive: readScalar("dateReceive", b.dateReceive),
    url: readUrl(b.url),
    hashtags: readArray("hashtags", b.hashtags, INGEST_MAX.hashtags, INGEST_MAX.hashtag),
    date: dateIso,
    keepDateOnUpdate: !date.provided,
  };
  upsertActivity(activity);

  if (droppedSteps > 0) {
    console.warn("[ingest] часть шагов активности не сохранена", {
      id,
      sent: (b.steps as unknown[]).length,
      stored: steps?.length ?? 0,
    });
  }
  if (ignoredFields.length > 0) {
    console.warn("[ingest] поле активности не удалось прочитать и пропущено", {
      id,
      fields: ignoredFields,
    });
  }
  // Шаги могли не приходить вовсе — тогда в БД остались прежние (см.
  // readArray выше). Отвечать нулём значило бы сообщить «гайд без шагов»
  // про гайд, у которого они есть; читаем фактическое число.
  const storedSteps = steps?.length ?? getActivity(id)?.steps.length ?? 0;
  return json(
    {
      ok: true,
      id,
      steps: storedSteps,
      ...(droppedSteps > 0 ? { droppedSteps } : {}),
      ...(ignoredFields.length > 0 ? { ignoredFields } : {}),
    },
    { status: 200 },
    origin,
  );
}

// ---- API routing --------------------------------------------------------

/**
 * Dispatch an /api/* request to its handler. Returns a plain Response; the
 * caller wraps it with security headers. Handles CORS preflight, the internal
 * ingest endpoint, the GET-only method guard and the per-IP rate limit.
 */
async function routeApi(
  req: Request,
  url: URL,
  origin: string | null,
  server?: ServerLike,
): Promise<Response> {
  // Preflight намеренно идёт мимо лимитера, и это решение, а не недосмотр.
  // Аудит 2026-08-29: OPTIONS — не самостоятельный запрос, а обязательная
  // приставка браузера к тому, который лимитер и так считает; списывать за
  // него токен значит вдвое урезать бюджет всякому кросс-доменному клиенту
  // (60/мин на IP превращаются в 30 полезных вызовов). Ответ при этом —
  // 204 без тела, без обращения к БД и без чтения запроса, то есть дешевле
  // самого TCP-приёма. Всё, что дороже, — ниже, и уже под лимитом.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // Internal ingest endpoints: authenticated POST. Успешный вызов под общий
  // лимит чтения не попадает — это свои, с петли, девять постов за выпуск.
  const ingest =
    url.pathname === "/api/internal/digests"
      ? handleIngestDigest
      : url.pathname === "/api/internal/activities"
        ? handleIngestActivity
        : null;
  if (ingest) {
    // Аудит 2026-08-29: env-гейт («If the secret is unset the endpoint does not
    // exist at all») жил внутри `authedJsonBody`, то есть срабатывал только на
    // POST — единственном методе, который до обработчика доходит. GET по этому
    // же пути отвечал 405 с `Allow: POST, OPTIONS`, тогда как любой неизвестный
    // путь отвечает 404. Разница и есть перечисление: заголовок прямо называл
    // метод ресурса, которого, по замыслу, не существует. Пока токен не задан,
    // отвечаем 404 на любой метод — тем же телом и без Allow.
    //
    // Круг 15: «на любой метод» — с одной оговоркой, которую прежний текст
    // умалчивал. OPTIONS сюда не доходит: преflight отвечает 204 выше и
    // одинаково на любой путь, существующий или нет. Перечисления в этом
    // нет ровно потому, что ответ одинаков; но написано было шире, чем есть.
    const configured = ingestSecret() !== null;
    if (!configured || req.method !== "POST") {
      // Аудит 2026-08-29: ветка стояла ДО всякого лимита — ровно та же дыра,
      // что закрыли ниже для 401, только без токена и потому дешевле для
      // сканера: `GET /api/internal/digests` отвечал 405 сколько угодно раз
      // подряд (замер: 200 запросов, 405=200, 429=0). Свой ингест ходит
      // POST'ом и этой ветки не видит вовсе, так что считаем прямо здесь, а
      // не ретроспективно.
      if (!rateLimitOk(clientIp(req, server))) {
        return json(
          { error: "rate_limited" },
          { status: 429, headers: { "Retry-After": "60" } },
          origin,
        );
      }
      if (!configured) {
        return json({ error: "not_found" }, { status: 404 }, origin);
      }
      // Allow обязателен при 405 (RFC 9110 §15.5.6) — без него клиенту неоткуда
      // узнать, каким методом сюда ходят.
      return json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST, OPTIONS" } },
        origin,
      );
    }
    const res = await ingest(req, origin);
    // Аудит 2026-08-12: «trusted machine-to-machine» — это про того, кто ТОКЕН
    // уже предъявил. Ветка стояла до `rateLimitOk`, поэтому перебор Bearer'а
    // не стоил ничего: замер — 300 попыток подряд, 401=300, 429=0.
    //
    // Считаем ретроспективно и только на неудаче (тот же приём, что в
    // agent/lib/miniapp-server.ts): заранее знать «будет 401» нельзя, а ведро
    // на то и ведро — отказывает следующему. Свой ингест приходит с VPS по
    // петле без XFF, ключ `ip:127.0.0.1`, и отвечает 200 — ведро не трогает;
    // перебор снаружи идёт через nginx, у него ключ свой.
    //
    // Аудит 2026-08-29: условие было `=== 401`, то есть при незаданном
    // `SITE_INGEST_TOKEN` бесплатным становился уже сам зонд — env-гейт
    // отвечает 404 (ветка `if (!configured)` двадцатью строками выше, а на
    // POST — та же проверка в начале `authedJsonBody`; функции
    // `requireIngestAuth`, на которую тут ссылались, в проекте нет), и он мимо
    // счёта не проходил.
    // Считаем любую неудачу: у своего ингеста их не бывает, а у чужого это
    // единственный ответ, который он и получает.
    if (res.status >= 400 && !rateLimitOk(clientIp(req, server))) {
      return json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": "60" } },
        origin,
      );
    }
    return res;
  }

  // Аудит 2026-08-13: HEAD отвечал 405 на всём /api/, хотя на `/rss.xml` и
  // `/sitemap.xml` рядом — 200. По RFC 9110 §9.3.2 HEAD обязан вести себя как
  // GET, только без тела: на нём стоят проверки живости, HTTP-клиентские
  // библиотеки перед скачиванием и агрегаторы. 405 на HEAD означает «метода
  // нет вовсе», то есть ответ прямо врал о ресурсе, который по GET отдаётся.
  //
  // Тело срезает сам HTTP-слой Bun, поэтому ниже ничего разветвлять не нужно;
  // заголовки (в т.ч. Content-Type и CORS) при этом остаются на месте.
  // Токен лимитера HEAD тратит наравне с GET — работа по сборке ответа
  // выполняется та же самая.
  //
  // Аудит 2026-09-10: лимитер стоял ПОСЛЕ проверки метода — та же дыра, что
  // 2026-08-29 закрыли двадцатью строками выше для ингеста, только здесь её
  // забыли. `POST /api/health` (и любой другой метод на любой путь под /api/)
  // отвечал 405 сколько угодно раз подряд, не тронув ведро: канал бесплатных
  // проб оставался неучтённым, а честные 60 чтений в минуту у того же адреса
  // — нетронутыми. Порядок теперь один на обе ветки: сначала считаем, потом
  // отвечаем. Preflight по-прежнему выходит выше и токена не тратит.
  if (!rateLimitOk(clientIp(req, server))) {
    return json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
      origin,
    );
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } },
      origin,
    );
  }
  return handleApi(url, origin);
}

/**
 * Декодировать сегмент пути под id.
 *
 * Аудит 2026-08-12: `decodeURIComponent` звался голым, а `/api/digests/%` —
 * вполне валидный запрос: URL разбирается, percent-encoding битый, вызов
 * кидает URIError. Бросок уходил из `routeApi` мимо `withSecurityHeaders` —
 * замер: 500 с HTML-страницей ошибки и без единого hardening-заголовка.
 * Битый id — это просто «нет такого»: отдаём сегмент как есть, дальше
 * обычный 404. Та же идиома, что у `digestIdFromPath` выше.
 */
function decodeIdSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function handleApi(url: URL, origin: string | null): Response {
  const p = url.pathname;

  if (p === "/api/health") {
    return json({ ok: true, ts: Date.now() }, {}, origin);
  }

  if (p === "/api/stats") {
    // Aggregates for the stats bar. updatedAt = last unlocks refresh, or null
    // if the feed never arrived — «обновлено» рядом с нулём было бы враньём.
    return json(
      {
        digests: countDigests(),
        unlocks: countUpcomingUnlocks(),
        drops: countDrops(),
        activities: countActivities(),
        updatedAt: lastUnlocksRefreshIso(),
      },
      {},
      origin,
    );
  }

  // /api/digests/:id
  const digestMatch = p.match(/^\/api\/digests\/([^/]+)$/);
  if (digestMatch) {
    const id = decodeIdSegment(digestMatch[1]!);
    const d = getDigest(id);
    if (!d) return json({ error: "not_found" }, { status: 404 }, origin);
    return json(d, {}, origin);
  }

  if (p === "/api/digests") {
    const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
    // Поиск — два полных прохода `LIKE` по таблице (сама выборка и счётчик для
    // пагинации), причём один из них по `items_json`, самой длинной колонке.
    // Длину запроса режем: осмысленный поиск по сайту в 120 символов
    // укладывается, а строка на десяток килобайт превращает каждый проход в
    // подстроковое сравнение с гигантским паттерном — бесплатная нагрузка на
    // синхронный SQLite.
    // Аудит 2026-08-29: рез был голым `slice`, четвёртый в файле и пропущенный,
    // когда чинили `clipSlug`, `clip` и XML-путь. 120-я единица UTF-16 могла
    // прийтись на середину суррогатной пары — эмодзи в поисковой строке не
    // экзотика, — и в `LIKE` уезжал одинокий суррогат. Через bun:sqlite он
    // становится U+FFFD, то есть символом, которого в тексте нет: запрос
    // молча возвращал ноль строк вместо совпадений по обрезанному префиксу.
    const q = clip((url.searchParams.get("q") ?? "").trim(), 120);
    if (q) {
      const items = searchDigests(q, limit, offset);
      const total = countSearchDigests(q);
      return json({ items, total }, {}, origin);
    }
    const items = listDigests(limit, offset);
    const total = countDigests();
    return json({ items, total }, {}, origin);
  }

  if (p === "/api/unlocks") {
    // offset и total — как у остальных списков. Без них календарь упирался в
    // 100 строк, а /api/stats при этом обещал 144 (аудит 2026-08-13); клиент
    // не мог даже узнать, что список обрезан.
    const limit = clampInt(url.searchParams.get("limit"), 30, 1, 100);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
    // `total`, `order` и `within` появились вместе с пагинацией: до этого
    // календарь молча обрезался на сотне (а `/api/stats` показывал полное
    // число), сортировка и окно «7/30 дней» считались по загруженному куску —
    // то есть «7 дней» показывали не все разблокировки недели, а только те из
    // первой сотни, что в неделю попали (аудит 2026-08-12, T-747).
    const q = {
      desc: url.searchParams.get("order") === "desc",
      withinDays: clampInt(url.searchParams.get("within"), 0, 0, 3650),
      // Один момент на оба обращения: иначе разблокировка, наступившая между
      // ними, попадёт в items и не попадёт в total (аудит 2026-08-28).
      now: Date.now(),
    };
    const items = listUpcomingUnlocks(limit, offset, q);
    const total = countUpcomingUnlocks(q);
    return json({ items, total, updatedAt: lastUnlocksRefreshIso() }, {}, origin);
  }

  if (p === "/api/drops") {
    const limit = clampInt(url.searchParams.get("limit"), 30, 1, 100);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
    // Фильтр по статусу считает сервер: на клиенте он фильтровал только уже
    // загруженный кусок, то есть «Закончился» показывал не завершённые дропы,
    // а те из первых тридцати, что оказались завершёнными (аудит 2026-08-12).
    const raw = url.searchParams.get("status");
    const status =
      raw === "active" || raw === "soon" || raw === "ended" ? raw : null;
    const items = listDrops(limit, offset, status);
    // total — чтобы фронт знал, что за первой страницей что-то есть: без него
    // дропы дальше тридцатого были недостижимы вовсе.
    const total = countDrops(status);
    return json({ items, total }, {}, origin);
  }

  // /api/activities/:id
  const activityMatch = p.match(/^\/api\/activities\/([^/]+)$/);
  if (activityMatch) {
    const id = decodeIdSegment(activityMatch[1]!);
    const a = getActivity(id);
    if (!a) return json({ error: "not_found" }, { status: 404 }, origin);
    return json(a, {}, origin);
  }

  if (p === "/api/activities") {
    const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
    const items = listActivities(limit, offset);
    const total = countActivities();
    return json({ items, total }, {}, origin);
  }

  return json({ error: "not_found" }, { status: 404 }, origin);
}

// ---- startup ------------------------------------------------------------

/**
 * Как часто предлагать фиду обновиться.
 *
 * Час, а не сутки, хотя TTL — сутки: тик дешёвый (`refreshUnlocks(false)`
 * сначала смотрит на отметку и при свежем кэше сразу возвращает 0), а сеть
 * ненадёжна. С суточным периодом одна неудачная попытка означала бы сутки со
 * старым календарём; с часовым — час.
 */
export const UNLOCKS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface RefreshLoop {
  stop(): void;
  /** Таймер не держит процесс живым (см. тест «таймер не держит процесс»). */
  unrefd: boolean;
}

/**
 * Периодическое обновление календаря разблокировок.
 *
 * Аудит 2026-08-12: `ensureUnlocks()` вызывался из `bootstrap()` и больше
 * нигде, а TTL проверялся только в момент вызова — то есть работал как «протух
 * ли кэш к моменту рестарта», а не как расписание. На живом delabs.space фид
 * не обновлялся с 2026-06-23T10:48Z: 50 суток при TTL в 24 часа. Блок
 * «Ближайшие разблокировки» всё это время показывал июньский снимок — 40
 * будущих событий, последнее 2027-03-24 — и молча худел: `listUpcomingUnlocks`
 * отдаёт только `date >= now`, так что прошедшие тихо выпадают, а новых взамен
 * не приходит. Суммы считались по июньским ценам.
 *
 * Два неочевидных требования, оба проверены тестами:
 *
 *  • ошибка тика не гасит расписание. `setInterval(async () => await x())` с
 *    отклонённым промисом — это необработанный reject; календарь встал бы до
 *    следующего рестарта, ровно как сейчас.
 *  • тики не накладываются. Фид — 25 МБ JSON; если ответ идёт дольше периода,
 *    параллельные загрузки конкурировали бы за одну и ту же таблицу.
 */
export function startUnlocksRefresh(
  everyMs: number = UNLOCKS_REFRESH_INTERVAL_MS,
  refresh: () => Promise<number> = () => refreshUnlocks(false),
): RefreshLoop {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // предыдущий тик ещё не закончил — пропускаем такт
    running = true;
    refresh()
      .catch((e) => console.warn("[unlocks] periodic refresh failed:", e))
      .finally(() => {
        running = false;
      });
  }, everyMs);
  const unrefd = typeof timer.unref === "function";
  timer.unref?.();
  return { stop: () => clearInterval(timer), unrefd };
}

export function bootstrap(): void {
  seedIfEmpty();
  // Fire-and-forget: never block startup on the network.
  ensureUnlocks().catch((e) =>
    console.warn("[startup] ensureUnlocks failed:", e),
  );
  // И дальше — сам, без рестарта (см. startUnlocksRefresh).
  startUnlocksRefresh();
}

// Add hardening headers to any response (idempotent — won't clobber existing).
function withSecurityHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
}

// Exported for tests.
export function makeFetchHandler() {
  const handle = async (
    req: Request,
    server?: ServerLike,
  ): Promise<Response> => {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");

    if (url.pathname.startsWith("/api/")) {
      // Every /api/* response gets the hardening headers — wrap once here.
      // И именно поэтому здесь же ловим бросок: до правки URIError из
      // handleApi уходил мимо этой обёртки, и наружу шла HTML-страница ошибки
      // рантайма без заголовков. Причину чинит decodeIdSegment, а этот catch —
      // страховка на инвариант: /api/ отвечает JSON'ом и всегда с заголовками.
      try {
        return withSecurityHeaders(await routeApi(req, url, origin, server));
      } catch (e) {
        console.error("[api] unhandled", (e as Error)?.message);
        return withSecurityHeaders(
          json({ error: "internal_error" }, { status: 500 }, origin),
        );
      }
    }

    // Аудит 2026-08-12: `rateLimitOk` звался только внутри `routeApi`, и три
    // адреса ниже плюс `/digest/<id>` шли мимо лимита вовсе. Ленты теперь ещё
    // и кэшируются, но лимит нужен сам по себе: он ограничивает и промахи
    // кэша, и regex-проход по оболочке статьи. Статику не трогаем — одна
    // страница тянет несколько файлов, и общий бюджет 60/мин её бы задушил.
    //
    // Аудит 2026-08-13 (второй проход): починки 12-го и 13-го числа легли одна
    // на другую — `/rss.xml` и `/sitemap.xml` проверялись ЗДЕСЬ и ещё раз в
    // блоке xmlRoute ниже. Два токена за один GET: ведро на 60 кончалось на
    // 30-м запросе, вдвое строже объявленного и вдвое строже, чем на
    // `/robots.txt` и `/digest/<id>` рядом. Тест «упирается в лимит» этого не
    // ловил — он проверял `ok <= 60`, а 30 ≤ 60. Ворота теперь одни, и
    // `/robots.txt` заезжает в тот же список: он и раньше лимитировался, просто
    // ниже по коду.
    const rateLimitedNonApi =
      url.pathname === "/rss.xml" ||
      url.pathname === "/sitemap.xml" ||
      url.pathname === "/robots.txt" ||
      // Аудит 2026-08-20: `/activity/` в списке не было вовсе, хотя это такая
      // же чтение-из-БД оболочка, как `/digest/`, и она тоже опубликована в
      // /sitemap.xml. Маршрут был единственным контентным адресом мимо ведра.
      //
      // Аудит 2026-09-11 (круг 15): перечисление префиксов расходилось с
      // диспетчером уже третий раз — голые `/digest` и `/activity` (без
      // слэша) ходили мимо ведра, а после правки статейного 404 стали ещё и
      // читать index.html на каждый запрос. Перечислять больше нечего:
      // лимитируем всё, что стоит оболочки, то есть всё, кроме файлов
      // сборки. Ассеты по-прежнему мимо ведра — страница тянет их пачкой.
      !servedByKernel(url.pathname);
    if (rateLimitedNonApi && !rateLimitOk(clientIp(req, server))) {
      return withSecurityHeaders(
        new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "60", "Content-Type": "text/plain; charset=utf-8" },
        }),
      );
    }

    // RSS feed — handled before the static/SPA fallback so it isn't swallowed
    // by index.html. It's an XML response, so no HTML CSP is applied.
    //
    // robots.txt и sitemap.xml — там же и по той же причине: SPA-фолбэк отдал
    // бы на оба адреса index.html с кодом 200. Обёртка заголовков нужна и им:
    // свой nosniff они ставят, но X-Frame-Options и Referrer-Policy — нет, то
    // есть оба адреса можно было фреймить.
    //
    // Аудит 2026-08-13: лимитер жил внутри routeApi, а эти три маршрута до
    // него не доходили — 200 подряд идущих GET /sitemap.xml с одного адреса
    // дали 200 ответов и ни одного 429. Дороже всех именно sitemap: он
    // перечитывает и разбирает JSON всех дайджестов и активностей на каждый
    // запрос. Заголовки безопасности к ним тоже не применялись.
    //
    // Своей проверки лимита здесь больше нет — она выше, в `rateLimitedNonApi`,
    // единственным местом. Второй экземпляр списывал по токену за тот же самый
    // запрос.
    if (req.method === "GET" || req.method === "HEAD") {
      const xmlRoute =
        url.pathname === "/rss.xml"
          ? rssResponse
          : url.pathname === "/robots.txt"
            ? robotsResponse
            : url.pathname === "/sitemap.xml"
              ? sitemapResponse
              : null;
      if (xmlRoute) return withSecurityHeaders(xmlRoute());
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      // Аудит 2026-09-10: тот же бесплатный 405, что и на /api/, только шире —
      // здесь под него подходит ЛЮБОЙ путь. Считаем только те, за которые выше
      // ещё не списали: `rateLimitedNonApi` уже прошёл своё ведро, и второй
      // экземпляр брал бы два токена за один запрос (об этом же предупреждает
      // комментарий выше).
      if (!rateLimitedNonApi && !rateLimitOk(clientIp(req, server))) {
        return withSecurityHeaders(
          new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "60", "Content-Type": "text/plain; charset=utf-8" },
          }),
        );
      }
      return withSecurityHeaders(
        new Response("Method Not Allowed", {
          status: 405,
          // Тот же RFC 9110 §15.5.6, что и на /api/: 405 без Allow не говорит
          // клиенту ничего.
          headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" },
        }),
      );
    }
    // Статья — та же оболочка, но с её мета-данными. Перед serveStatic:
    // иначе SPA-фолбэк отдал бы index.html с og-тегами главной. Если фронт не
    // собран или статьи нет — null, и дальше всё как раньше.
    const digestId = digestIdFromPath(url.pathname);
    const activityId = digestId ? null : activityIdFromPath(url.pathname);
    if (digestId || activityId) {
      const shell = digestId
        ? digestShellResponse(digestId)
        : activityShellResponse(activityId!);
      if (shell) return withSecurityHeaders(shell);
      // Статьи нет — но путь заведомо статейный, значит это 404, а не
      // «какой-то маршрут SPA». Фронт не собран → null, и дальше всё как
      // раньше: пусть отвечает заглушка «не собрано», а не выдуманный 404.
      const missing = notFoundShellResponse();
      if (missing) return withSecurityHeaders(missing);
    }

    // Реальный файл сборки отдаём всегда; оболочку — только на маршруте,
    // который роутер фронта знает. Всё прочее (вложенный статейный путь,
    // `/about/x`, `/Digest/x`, выдуманный адрес) — 404 с noindex, а не
    // главная страница со статусом 200.
    const known = isKnownSpaRoute(url.pathname);
    const res = serveStatic(url.pathname, known);
    if (res) return withSecurityHeaders(res);
    // Промах по адресу формы файла сборки: отвечаем коротко. Оболочка тут не
    // читатель, а тег — целая страница в ответ на отсутствующую картинку это
    // килобайты с `no-cache` вместо девяти байт.
    if (hasBuildFileShape(url.pathname)) {
      return withSecurityHeaders(new Response("Not Found", { status: 404 }));
    }
    const missing = known ? null : notFoundShellResponse();
    return withSecurityHeaders(missing ?? new Response("Not Found", { status: 404 }));
  };

  /**
   * Внешняя страховка. Под /api/ бросок ловится своим catch и отвечает
   * JSON'ом; всё остальное — RSS, sitemap, оболочка статьи, статика — ходит в
   * БД и в файловую систему без обёртки вовсе.
   *
   * Аудит 2026-08-13 проверил, что делает Bun 1.3.14 с непойманным броском в
   * fetch: при незаданном NODE_ENV возвращается страница на 67 КБ, в которой
   * лежит абсолютный путь к упавшему файлу и его исходный код. То есть
   * отсутствие утечки держалось на переменной окружения, которую этот репозиторий
   * не задаёт: юнита `web3-puls` в `deploy/systemd/` нет вообще.
   */
  return async (req: Request, server?: ServerLike): Promise<Response> => {
    try {
      return await handle(req, server);
    } catch (e) {
      console.error("[http] unhandled", (e as Error)?.message);
      return withSecurityHeaders(
        new Response("Internal Server Error", { status: 500 }),
      );
    }
  };
}

// Only start the server when run directly (not when imported by tests).
if (import.meta.main) {
  bootstrap();
  if (CLIENT_IP_HEADER) {
    // Код не видит vhost и проверить это не может, поэтому — громко в лог при
    // каждом старте. Если nginx не перезаписывает заголовок, любой клиент
    // задаёт ключ лимитера сам: новое значение на запрос = лимита нет.
    console.warn(
      `[web3-puls] SITE_CLIENT_IP_HEADER=${CLIENT_IP_HEADER}: заголовок берётся ` +
        `как адрес клиента. Убедитесь, что vhost его ПЕРЕЗАПИСЫВАЕТ ` +
        `(set_real_ip_from для сетей прокси + real_ip_header) — иначе значение ` +
        `подконтрольно клиенту и rate limit обходится.`,
    );
  }
  const server = Bun.serve({
    port: serverPort(),
    // Аудит 2026-08-13: `hostname` не задавали, Bun по умолчанию слушает
    // 0.0.0.0 — и сайт целиком отвечал по голому HTTP прямо на публичном
    // адресе (`curl http://203.0.113.10:8790/api/stats` → 200), в обход
    // nginx и TLS. ufw на хосте выключен, политика INPUT в iptables — ACCEPT,
    // так что снаружи не мешало ничто. Мимо nginx уходил и `/api/internal/*`:
    // подбор Bearer'а шёл бы по нешифрованному каналу и без того, что стоит
    // на vhost'е. Лимитер, впрочем, держался — `clientIpKey` доверяет
    // X-Forwarded-For только когда peer петлевой, а у прямого клиента он свой.
    //
    // Обоим потребителям публичный адрес не нужен: nginx ходит по петле, и
    // tonutils-reverse-proxy тоже (`proxy_pass: http://127.0.0.1:8790/` в
    // /opt/ton-proxy/config.json). Переменная оставлена, чтобы развернуть
    // сервер в другой схеме можно было без правки кода.
    hostname: process.env.SITE_BIND?.trim() || "127.0.0.1",
    fetch: makeFetchHandler(),
    // Под try/catch стоял только `/api/*`. Бросок из ленты, оболочки статьи
    // или statSync уходил в обработчик Bun по умолчанию, а тот при
    // NODE_ENV !== "production" отдаёт HTML со стектрейсом и куском исходника.
    // Юнита systemd для этого сервера в репозитории нет, то есть на переменную
    // окружения полагаться нельзя — фиксируем обе настройки здесь.
    development: false,
    error(e: Error) {
      console.error("[web3-puls] unhandled", e?.message);
      return withSecurityHeaders(
        new Response("Internal Server Error", {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );
    },
    // Ингест — единственный POST, и самый большой честный выпуск это десятки
    // килобайт. Дефолт Bun — 128 МБ. Почему потолок ВЫШЕ прикладного, а не
    // равен ему, — см. докблок `MAX_REQUEST_BODY_BYTES`.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });
  console.log(
    `[web3-puls] listening on http://localhost:${server.port}  ` +
      `(db=${process.env.SITE_DB_PATH ?? "data/site.db"}, web=${
        existsSync(webDist()) ? "built" : "not built"
      })`,
  );
}
