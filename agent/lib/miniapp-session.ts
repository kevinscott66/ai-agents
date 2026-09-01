import { createHash, randomBytes } from "node:crypto";
import { MINUTE_MS } from "./time-constants.ts";

export const MINIAPP_SESSION_TTL_MS = 5 * MINUTE_MS;

/**
 * Префикс имени cookie сессии.
 *
 * `__Host-` — не украшение: он запрещает браузеру принимать эту cookie с
 * атрибутом `Domain` и с `Path` кроме `/`, то есть поддомен (или тот, кто
 * получил на нём XSS) не может подсунуть свою. Условия префикса — `Secure`,
 * `Path=/`, без `Domain` — выполнены ниже.
 *
 * Полное имя ещё несёт отпечаток запуска, см. {@link MiniAppSessionStore.cookieName}.
 */
const SESSION_COOKIE_PREFIX = "__Host-miniapp_session_";

interface SessionRecord {
  userId: number;
  fingerprint: string;
  expiresAt: number;
}

export interface MiniAppSessionStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

/** Short-lived, per-server credentials for mutation requests. */
export class MiniAppSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly usedInitData = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: MiniAppSessionStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? MINIAPP_SESSION_TTL_MS;
  }

  static fingerprint(initDataRaw: string): string {
    const params = new URLSearchParams(initDataRaw);
    const queryId = params.get("query_id") ?? "";
    const hash = params.get("hash") ?? "";
    return createHash("sha256").update(`${queryId}\n${hash}`).digest("hex");
  }

  issue(userId: number, fingerprint: string): string | null {
    this.prune();
    if (this.usedInitData.has(fingerprint)) return null;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.usedInitData.set(fingerprint, expiresAt);
    this.sessions.set(token, { userId, fingerprint, expiresAt });
    return token;
  }

  validate(token: string | null, userId: number, fingerprint: string): boolean {
    this.prune();
    if (!token) return false;
    const session = this.sessions.get(token);
    return !!session && session.userId === userId && session.fingerprint === fingerprint;
  }

  /**
   * Имя cookie для конкретного запуска Mini App.
   *
   * Одно фиксированное имя на всё приложение было ошибкой: отпечаток
   * (`query_id` + `hash`) свой у КАЖДОГО запуска, а слот cookie — один. Две
   * открытые вкладки (или «открыл, закрыл, открыл снова») перезаписывали
   * cookie друг друга. Дальше первая вкладка присылала чужой токен:
   * `validate` отбивал его по несовпадению отпечатка, `issue` по её
   * собственному отпечатку уже был израсходован — и вкладка получала 401
   * «replayed initData» на любую мутацию до перезагрузки. Отпечаток в имени
   * даёт каждому запуску свой слот; лишние слоты уходят сами по Max-Age.
   */
  static cookieName(fingerprint: string): string {
    return `${SESSION_COOKIE_PREFIX}${fingerprint.slice(0, 16)}`;
  }

  /**
   * Не-бросающий вариант {@link cookie} — для места, откуда исключение уже
   * не поймать.
   *
   * Аудит 2026-08-28: единственный боевой вызов `cookie()` стоит в
   * `miniapp-server.ts` ПОСЛЕ `catch` обработчика, то есть его бросок уходит
   * прямо в `Bun.serve`, у которого в этом сервере нет опции `error`. Ответ
   * при этом уже готов и корректен: тело посчитано, gzip и ETag наложены,
   * CORS проставлен — а наружу вместо него уходит голый 500, и строка
   * access-лога (она печатается СТРОКОЙ НИЖЕ) не пишется вовсе, так что в
   * логах остаётся дырка вместо запроса.
   *
   * Попасть сюда можно: TTL сессии — пять минут, `prune()` зовётся из
   * `issue()`/`validate()` любого ПАРАЛЛЕЛЬНОГО запроса, а обработчик,
   * выдавший сессию, вполне может держать ответ дольше (мутация, ушедшая в
   * инструмент). Тогда к моменту выдачи cookie запись уже вычищена.
   *
   * Отсутствие cookie деградирует мягко: клиент просто не подтвердит сессию и
   * переоткроет Mini App. 500 вместо готового ответа — нет.
   *
   * Проверка идёт через `prune()`, а не через голый `has()`: тот закрывал
   * ровно половину описанного выше случая — ту, где параллельный запрос уже
   * вычистил запись. Без параллельного запроса протухшая запись всё ещё лежит
   * в Map, `has` отвечает true, и клиент получает cookie с Max-Age на весь TTL
   * вперёд под токен, который сервер посчитает мёртвым при первом же прунинге.
   */
  cookieFor(token: string): string | null {
    this.prune();
    return this.sessions.has(token) ? this.cookie(token) : null;
  }

  cookie(token: string): string {
    const session = this.sessions.get(token);
    if (!session) throw new Error("cookie() called for an unknown session token");
    // SameSite=None; Partitioned — обязательны, а не «послабление». Telegram
    // Web и Desktop открывают Mini App во фрейме на своём домене, то есть наш
    // origin там третья сторона: cookie с `SameSite=Strict` браузер обратно не
    // пришлёт вовсе, а без `Partitioned` (CHIPS) её отрежет блокировка
    // сторонних cookie. Итог был бы не «строже», а «мутации не работают»:
    // сессия не подтверждается, отпечаток уже израсходован — 401 на каждую
    // вторую мутацию. Изоляция при этом не теряется: partitioned-cookie видна
    // только в связке с тем же верхним сайтом.
    return (
      `${MiniAppSessionStore.cookieName(session.fingerprint)}=${token}` +
      `; Path=/; Max-Age=${Math.floor(this.ttlMs / 1000)}` +
      `; HttpOnly; Secure; SameSite=None; Partitioned`
    );
  }

  static tokenFromRequest(req: Request, fingerprint: string): string | null {
    const wanted = MiniAppSessionStore.cookieName(fingerprint);
    const cookie = req.headers.get("cookie") ?? "";
    for (const part of cookie.split(";")) {
      const [name, ...value] = part.trim().split("=");
      // Аудит 2026-08-29: `value.length > 0` истинно и для `имя=` — split даёт
      // [""], и наружу уходила пустая строка при заявленном `string | null`.
      // Сегодня это ничего не ломает (`validate` начинается с `if (!token)`),
      // но контракт возвращает «токен есть» там, где его нет: любой будущий
      // вызывающий, проверяющий `!== null`, получит пустую строку за токен.
      const token = value.join("=");
      if (name === wanted && token !== "") return token;
    }
    return null;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
    for (const [fingerprint, expiresAt] of this.usedInitData) {
      if (expiresAt <= now) this.usedInitData.delete(fingerprint);
    }
  }
}
