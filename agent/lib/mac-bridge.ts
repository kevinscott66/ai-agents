/**
 * Stage A: WebSocket bridge between backend and a single Mac daemon.
 *
 * Protocol (JSON over text frames):
 *   client → server:  { type: "auth", secret: string }
 *   server → client:  { type: "auth_ok" } | { type: "auth_fail", error }
 *   server → client:  { type: "run", id, project, prompt, mode }
 *   client → server:  { type: "chunk", id, stream: "stdout"|"stderr", data }
 *   client → server:  { type: "result", id, ok, code, error? }
 *   server → client:  { type: "ping" }
 *   client → server:  { type: "pong" }
 *   server → client:  { type: "cancel", id }   (cancelOnMac — snuff one run)
 *   server → client:  { type: "stop" }         (stopMac — snuff every run)
 *
 * The last two are not optional extras: a daemon written to this list without
 * `cancel` leaves an orphaned `claude --permission-mode bypassPermissions`
 * running on the owner's machine after `mac_timeout` — the exact defect
 * `cancelOnMac` was added to close. Both are parsed in mac-daemon/protocol.ts.
 *
 * Only one active Mac client is held; a new authenticated connection replaces
 * the previous one, and every run still pending on the replaced socket is
 * rejected with `mac_replaced` — nobody is left waiting on a closed client.
 *
 * sendToMac() resolves on the daemon's final `result`. Два уточнения, которых
 * тут когда-то не было и которые меняют контракт вызывающего:
 *
 *  - потоки НЕ накапливаются целиком. В памяти живёт хвост в
 *    MAC_STREAM_TAIL_BYTES, полные длины считаются отдельно (аудит 2026-08-08,
 *    см. докстроку константы ниже). Если читателю нужен весь вывод, брать его
 *    из моста нельзя — его тут больше нет;
 *  - до таймаута прогон может вообще не начаться: при `pending.size >= max`
 *    (_readMaxConcurrentRuns) вызывающий получает `mac_busy` сразу. А сам
 *    таймаут — не константные пять минут, а _readRunTimeoutMs():
 *    MAC_RUN_TIMEOUT_MS с пятью минутами по умолчанию.
 */

/**
 * Сколько хвоста каждого потока держим в памяти.
 *
 * Аудит 2026-08-08: `p.stdout += data` копило поток БЕЗ ЛИМИТА, до пяти минут
 * (RUN_TIMEOUT_MS), в том самом процессе, где живут 12 ботов, HTTP Mini App и
 * планировщики. Демон на маке режет только свой собственный `stderrTail` (600
 * символов «для диагностики»), а по сокет отдаёт КАЖДЫЙ чанк как есть — то есть
 * `bun test`, сборка или вывод большого файла внутри прогона приезжают на VPS
 * целиком. Потребитель при этом всё равно берёт только хвост в 3500 символов
 * (TELEGRAM_MESSAGE_TAIL_LIMIT) и длину, так что накопленное отбрасывалось —
 * оплатив собой риск OOM-kill юнита.
 *
 * 64 КБ — с большим запасом над видимым хвостом, так что в чате ничего не
 * меняется. Полные длины считаются отдельно и остаются честными.
 */
export const MAC_STREAM_TAIL_BYTES = 64_000;

/**
 * Обрезать строку до хвоста в `maxBytes` БАЙТ UTF-8.
 *
 * Аудит 2026-08-28: было `(p.stdout + data).slice(-MAC_STREAM_TAIL_BYTES)`.
 * `String.prototype.slice` считает единицы UTF-16, а не байты — константа с
 * суффиксом `_BYTES` и докблок «хвост режется по байтам» описывали не то, что
 * делал код. На ASCII разницы нет, а вывод здесь русскоязычный: кириллица —
 * два байта на символ, эмодзи и часть символов CJK — четыре. То есть реальный
 * потолок памяти был не 64 КБ, а до 256 КБ на КАЖДЫЙ из двух потоков каждого
 * из MAC_MAX_CONCURRENT_RUNS прогонов — в том самом процессе, ради которого
 * лимит и вводился (12 ботов + Mini App + планировщики, риск OOM-kill юнита).
 *
 * Второй дефект того же `slice`: он режет по индексу UTF-16 и может разрубить
 * суррогатную пару пополам. Одиночный суррогат доживал до `JSON.stringify` и
 * уезжал в чат и в `agent_actions.error` как «\uFFFD»-мусор. Здесь срез идёт по
 * байтам с доводкой до начала UTF-8-последовательности, так что граница всегда
 * попадает между символами.
 */
export function tailWithinBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8");
  let start = buf.length - maxBytes;
  // 0b10xxxxxx — продолжение последовательности; сдвигаемся вперёд до её начала.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

export interface MacStreamSnapshot {
  /** Хвост потока (не более MAC_STREAM_TAIL_BYTES). */
  stdout: string;
  stderr: string;
  /** Сколько пришло ВСЕГО — до обрезки. */
  stdoutLen: number;
  stderrLen: number;
}

interface PendingRun {
  id: string;
  stdout: string;
  stderr: string;
  stdoutLen: number;
  stderrLen: number;
  resolve: (r: MacRunResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onProgress?: (snapshot: MacStreamSnapshot) => void;
}

export interface MacRunResult {
  ok: boolean;
  code?: number;
  /** Хвост потока; полную длину смотри в stdoutLen/stderrLen. */
  stdout: string;
  stderr: string;
  stdoutLen?: number;
  stderrLen?: number;
  /** true, если хоть один поток не поместился в MAC_STREAM_TAIL_BYTES. */
  truncated?: boolean;
  error?: string;
}

export interface MacRunRequest {
  project: string;
  prompt: string;
  mode: "ask" | "accept_edits" | "plan" | "auto" | "bypass";
  onProgress?: (snap: MacStreamSnapshot) => void;
}

interface ClientState {
  authed: boolean;
  peerKey: string;
  authTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 16;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 4;
const connectionCounts = new Map<string, number>();

/**
 * Целое из env в заданных границах, иначе дефолт с записью в лог.
 *
 * Аудит 2026-08-28: пять настроек моста читались `Number.parseInt`, а шестая —
 * порт — строгим `Number()` (`_resolveBridgePort` ниже). Разница не
 * стилистическая. `parseInt` берёт ЛИДИРУЮЩИЙ префикс и молча выбрасывает
 * хвост: `1e4` → 1, `600_000` → 600, `10m` → 10, `0x20` → 0 (проверено на
 * рантайме проекта). Верхней границы не было ни у одной.
 *
 * Цена, в порядке заметности:
 *  - `MAC_RUN_TIMEOUT_MS=600_000` — привычная запись пяти минут — давала
 *    600 мс: каждый прогон рвался по таймауту почти сразу, а MAC_RUN_CLAUDE
 *    это единственный способ команды из 12 ролей дотянуться до Mac и скиллов
 *    на нём.
 *  - `MAC_BRIDGE_AUTH_TIMEOUT_MS=1e4` давала 1 мс: демон не успевал
 *    аутентифицироваться никогда, мост выглядел поднятым и пустым.
 *  - Любое значение ≥ 2^31 у обоих таймеров переполняет 32-битный счётчик, и
 *    setTimeout срабатывает через 1 мс (bun печатает TimeoutOverflowWarning в
 *    stderr, куда никто не смотрит).
 *  - `MAC_MAX_CONCURRENT_RUNS` — это число процессов `claude` на машине
 *    владельца, каждый в режиме bypass; потолка не было вовсе.
 *
 * Ни один случай не давал ошибки при старте: значение принималось, лог
 * оставался бодрым, ломалось поведение. Поэтому отказ теперь ещё и пишется.
 */
export function _envIntInRange(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  log.warn(`[mac-bridge] некорректный ${name} — берём дефолт`, {
    got: raw,
    min,
    max,
    fallback,
  });
  return fallback;
}

/** Соединений столько не бывает; число за этим — опечатка, а не намерение. */
const MAX_BRIDGE_CONNECTIONS = 1024;
/** Каждый прогон — процесс `claude` на маке владельца. */
const MAX_CONCURRENT_RUNS = 32;

export function bridgePathAllowed(pathname: string): boolean {
  return pathname === (process.env.MAC_BRIDGE_PATH?.trim() || "/");
}

export function bridgeOriginAllowed(origin: string | null): boolean {
  if (!origin) return true;
  const allowed = (process.env.MAC_BRIDGE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

export function bridgeConnectionLimits(): {
  total: number;
  perIp: number;
  authTimeoutMs: number;
} {
  return {
    total: _envIntInRange(
      "MAC_BRIDGE_MAX_CONNECTIONS",
      DEFAULT_MAX_CONNECTIONS,
      1,
      MAX_BRIDGE_CONNECTIONS,
    ),
    perIp: _envIntInRange(
      "MAC_BRIDGE_MAX_CONNECTIONS_PER_IP",
      DEFAULT_MAX_CONNECTIONS_PER_IP,
      1,
      MAX_BRIDGE_CONNECTIONS,
    ),
    authTimeoutMs: _envIntInRange(
      "MAC_BRIDGE_AUTH_TIMEOUT_MS",
      DEFAULT_AUTH_TIMEOUT_MS,
      1,
      MAX_TIMER_MS,
    ),
  };
}

function reserveConnection(peerKey: string): boolean {
  const limits = bridgeConnectionLimits();
  const total = [...connectionCounts.values()].reduce((sum, n) => sum + n, 0);
  if (total >= limits.total) return false;
  const current = connectionCounts.get(peerKey) ?? 0;
  if (current >= limits.perIp) return false;
  connectionCounts.set(peerKey, current + 1);
  return true;
}

function releaseConnection(peerKey: string): void {
  const next = (connectionCounts.get(peerKey) ?? 1) - 1;
  if (next > 0) connectionCounts.set(peerKey, next);
  else connectionCounts.delete(peerKey);
}

/**
 * Служебные таймеры моста (ping-интервал, окно на аутентификацию) не должны
 * сами по себе держать event loop: это чистая гигиена процесса, а в тестах —
 * ещё и защита от протечки между файлами (bun гоняет весь каталог одним
 * процессом). Прогонный таймаут в sendToMac НЕ трогаем: он единственный, кто
 * зовёт cancelOnMac, и терять его нельзя.
 */
function unrefTimer(t: { unref?: () => void } | null | undefined): void {
  if (t && typeof t.unref === "function") t.unref();
}

function clearAuthTimer(state: ClientState): void {
  if (state.authTimer) {
    clearTimeout(state.authTimer);
    state.authTimer = undefined;
  }
}

/**
 * T-305 MED-3: never log the full client-supplied secret. Returns length and
 * last-4 fingerprint for correlation across attempts.
 */
export function redactSecret(value: unknown): string {
  if (value === null || value === undefined) return "<empty>";
  const s = String(value);
  if (!s) return "<empty>";
  if (s.length <= 4) return `<len=${s.length}>`;
  return `<len=${s.length} last4=${s.slice(-4)}>`;
}

/**
 * Соль живёт ровно один процесс: связать тег из утёкшего лога с адресом
 * нельзя даже нам — словарь всего IPv4 строится за секунды, и постоянная
 * соль вернула бы тегу обратимость.
 */
const PEER_SALT = randomBytes(16);

/**
 * T-305 MED-3: метка пира для лога — IP это PII, но без сигнала не поймать
 * перебор.
 *
 * Аудит 2026-08-28: было `extractPortOnly` — хвост `ws.remoteAddress` после
 * последнего двоеточия. Bun кладёт туда голый адрес БЕЗ порта, то есть для
 * IPv4 двоеточия там нет вовсе и функция возвращала `"?"` на любом пире: сто
 * попыток с одного адреса и сто с разных выглядели в логе одинаково. Для IPv6
 * (`::1`) было хуже, чем ничего: возвращался кусок адреса, выданный за порт.
 *
 * Порта в этом месте нет, поэтому корреляцию даёт `peerKey` — адрес, который
 * сокет и так носит в `ws.data` для учёта лимита соединений. В лог он идёт
 * солёным хэшем: одинаковые пиры — одинаковый тег, а сам адрес из тега не
 * достаётся.
 */
export function peerTag(ws: unknown): string {
  try {
    const key = (ws as { data?: { peerKey?: unknown } })?.data?.peerKey;
    // "unknown" пишет сам мост, когда requestIP ничего не дал: тег от этой
    // заглушки был бы один на всех и выглядел бы как настоящий пир.
    if (typeof key !== "string" || !key || key === "unknown") return "?";
    const digest = createHash("sha256").update(PEER_SALT).update(key, "utf8").digest("hex");
    return `p_${digest.slice(0, 8)}`;
  } catch {
    return "?";
  }
}

interface ServerHandle {
  stop: () => void;
  port: number;
}

import { getErrorMessage } from "./errors.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SECOND_MS, MINUTE_MS } from "./time-constants.ts";
import { log, scrubSecretString } from "./log.ts";
import { safeTick } from "./safe-timer.ts";
import {
  DEFAULT_MAC_BRIDGE_HOST,
  DEFAULT_MAC_BRIDGE_PORT,
  MAX_TIMER_MS,
} from "./constants.ts";

/**
 * Constant-time string comparison for secrets. Prevents timing side-channel
 * attacks on the WS auth path (T-310, T-300 HIGH #2). NEVER replace with `===`
 * or `!==` for any value derived from untrusted input.
 */
export function secretsEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // Compare against a fixed-length zero buffer so length-mismatch path
    // also performs a timingSafeEqual call (keeps work roughly constant).
    timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

const RUN_TIMEOUT_MS = 5 * MINUTE_MS;

/**
 * Потолок ожидания одного прогона. Вынесен в env, чтобы поведение по таймауту
 * (а это теперь ещё и отмена на маке) можно было проверить тестом, не ожидая
 * пяти минут; заодно оператор может поднять его для заведомо долгой задачи.
 */
export function _readRunTimeoutMs(): number {
  return _envIntInRange("MAC_RUN_TIMEOUT_MS", RUN_TIMEOUT_MS, 1, MAX_TIMER_MS);
}

/**
 * Сколько прогонов на маке мост держит одновременно.
 *
 * Аудит 2026-08-13: не было никакого предела. Каждый `run` — это отдельный
 * процесс `claude` на машине владельца, и в режиме `bypass` он выполняет
 * команды без спроса. Прогон, не уложившийся в RUN_TIMEOUT_MS, до сих пор
 * никем не останавливался (см. cancelOnMac ниже), так что повторные попытки
 * складывались: пять минут спустя мост звал ещё один, а предыдущий продолжал
 * работать. Двух хватает на «идёт длинная задача + короткая проверка».
 */
export function _readMaxConcurrentRuns(): number {
  return _envIntInRange("MAC_MAX_CONCURRENT_RUNS", 2, 1, MAX_CONCURRENT_RUNS);
}

/**
 * Попросить демон убить конкретный прогон.
 *
 * Аудит 2026-08-13: по таймауту мост просто выбрасывал запись из `pending` и
 * отвечал вызывающему `mac_timeout`. На маке при этом НИЧЕГО не менялось:
 * `claude` продолжал работать, писать в проект и слать чанки под id, который
 * больше никто не ждёт. Существующий кадр `stop` не годится — он убивает все
 * прогоны разом, включая чужой живой.
 *
 * Демон старой версии просто не знает такого типа и молча его игнорирует, так
 * что обновлять оба конца одновременно не обязательно.
 */
function cancelOnMac(id: string): void {
  if (!activeSocket) return;
  try {
    activeSocket.send(JSON.stringify({ type: "cancel", id }));
  } catch (e) {
    log.debug("mac-bridge: cancel send failed", { e: String(e), id });
  }
}
const PING_INTERVAL_MS = 30 * SECOND_MS; // 30 seconds
const PING_TIMEOUT_MS = 60 * SECOND_MS; // consider dead after 60 seconds

let activeSocket: any = null;
let pending: Map<string, PendingRun> = new Map();
let serverHandle: ServerHandle | null = null;
let lastPongTime: number | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;

export function isMacConnected(): boolean {
  return !!activeSocket;
}

export function isMacOnline(): boolean {
  if (!activeSocket) return false;
  if (!lastPongTime) return true; // just connected, assume online until first ping
  return Date.now() - lastPongTime < PING_TIMEOUT_MS;
}

/**
 * Приняла ли отправка кадр.
 *
 * Аудит 2026-08-28: возврат `ServerWebSocket.send()` не смотрел никто, а он
 * несёт единственный признак доставки. Bun отдаёт число байт при успехе, `-1`
 * при backpressure (кадр принят и уйдёт) и `0`, когда кадр отброшен — и при
 * этом НЕ бросает, так что try/catch вокруг send ловил только совсем другие
 * поломки. Фейки в тестах и не-Bun рантаймы возвращают undefined: это не
 * отказ, поэтому проверяем ровно ноль.
 */
function frameAccepted(ret: unknown): boolean {
  return ret !== 0;
}

/**
 * Send a run request to the Mac daemon. Resolves on daemon's final "result"
 * message, or rejects on timeout / disconnect / no client.
 */
export function sendToMac(req: MacRunRequest): Promise<MacRunResult> {
  return new Promise<MacRunResult>((resolve, reject) => {
    if (!activeSocket) {
      reject(new Error("mac_offline"));
      return;
    }
    const max = _readMaxConcurrentRuns();
    if (pending.size >= max) {
      reject(new Error(`mac_busy: уже выполняется ${pending.size} из ${max}`));
      return;
    }
    const id = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      const p = pending.get(id);
      if (p) {
        pending.delete(id);
        // Сначала остановить процесс на маке, потом отвечать вызывающему:
        // иначе он уйдёт на повторную попытку, а брошенный прогон продолжит
        // работать в том же проекте.
        cancelOnMac(id);
        p.reject(new Error("mac_timeout"));
      }
    }, _readRunTimeoutMs());
    pending.set(id, {
      id,
      stdout: "",
      stderr: "",
      stdoutLen: 0,
      stderrLen: 0,
      resolve,
      reject,
      timer,
      onProgress: req.onProgress,
    });
    const dropRun = (err: Error): void => {
      const p = pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(id);
      }
      reject(err);
    };
    try {
      const accepted = frameAccepted(
        activeSocket.send(
          JSON.stringify({
            type: "run",
            id,
            project: req.project,
            prompt: req.prompt,
            mode: req.mode,
          }),
        ),
      );
      if (!accepted) {
        // Кадр отброшен: прогон не начнётся никогда. Держать запись до
        // RUN_TIMEOUT_MS значит занимать слот и заставлять вызывающего ждать
        // пять минут результата, которого не будет.
        dropRun(new Error("mac_send_dropped"));
        return;
      }
    } catch (e) {
      dropRun(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Send a stop signal to the Mac daemon to kill all running processes.
 */
export function stopMac(): Promise<{ ok: boolean; error?: string }> {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    if (!activeSocket) {
      resolve({ ok: false, error: "mac_offline" });
      return;
    }
    try {
      if (!frameAccepted(activeSocket.send(JSON.stringify({ type: "stop" })))) {
        // Кадр не ушёл — на маке ничего не остановилось. Записи о прогонах
        // здесь трогать нельзя: в них лежат id, по которым прогон ещё можно
        // отменить, и это единственный способ до него достучаться.
        resolve({ ok: false, error: "stop_not_delivered" });
        return;
      }
      // Immediately fail all pending operations since we're stopping everything
      failAllPending("mac_stopped");
      resolve({ ok: true });
    } catch (e) {
      resolve({ ok: false, error: getErrorMessage(e) });
    }
  });
}

/**
 * Единственная точка, где содержимое потоков с мака выходит наружу: и в
 * onProgress, и в итоговый MacRunResult. Поэтому чистим секреты здесь.
 *
 * Аудит 2026-08-13: это вывод произвольной программы, запущенной `claude` на
 * машине владельца. `git push` по HTTPS печатает в stderr URL вида
 * `https://x-access-token:ghp_…@github.com/…`, curl и npm — свои токены, любой
 * упавший скрипт — свой кусок окружения. Дальше этот текст шёл двумя дорогами:
 * в чат (хвост 3500 символов) и, через `error` у неуспешного прогона, в
 * `agent_actions.error` — то есть на диск в SQLite и наружу админам через
 * /api/actions. Ни одна из дорог скруббер не звала: `getErrorMessage` в
 * lib/errors.ts чистит только ИСКЛЮЧЕНИЯ, а здесь ошибка приезжает готовой
 * строкой в кадре `result`.
 *
 * Цена — двенадцать правил `scrubSecretString` по каждому из двух хвостов
 * (≤64 КБ), то есть 24 прохода регэкспом на чанк. Считать лениво
 * нельзя: тип отдаёт текст наружу, и «сейчас потребитель берёт только длину»
 * — ровно то допущение, на котором такие дыры и держатся.
 *
 * Чего это не чинит: хвост режется по байтам, и секрет, разрезанный границей
 * MAC_STREAM_TAIL_BYTES (или 300-символьной обрезкой в самом демоне), под
 * шаблон уже не подойдёт — уцелевший огрызок останется виден. Полностью это
 * лечится только на стороне демона, до обрезки.
 */
function snapshotOf(p: PendingRun): MacStreamSnapshot {
  return {
    stdout: scrubSecretString(p.stdout),
    stderr: scrubSecretString(p.stderr),
    stdoutLen: p.stdoutLen,
    stderrLen: p.stderrLen,
  };
}

function failAllPending(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    try {
      p.reject(new Error(reason));
    } catch (e) {
      log.debug("mac-bridge: pending.reject threw", { e: String(e), reason });
    }
  }
  pending.clear();
}

function handleClientMessage(ws: any, raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const state = (ws.data as ClientState) ?? { authed: false, peerKey: "unknown" };

  if (msg?.type === "auth") {
    const expected = process.env.MAC_BRIDGE_SECRET ?? "";
    const provided = typeof msg.secret === "string" ? msg.secret : "";
    if (!expected || !secretsEqual(provided, expected)) {
      const tokenSummary = redactSecret(msg?.secret);
      log.warn(`[mac-bridge] auth_fail token=${tokenSummary} peer=${peerTag(ws)}`);
      try {
        ws.send(JSON.stringify({ type: "auth_fail", error: "bad_secret" }));
      } catch (e) {
        log.debug("mac-bridge: ws.send(auth_fail) failed", { e: String(e) });
      }
      ws.close();
      return;
    }
    clearAuthTimer(state);
    state.authed = true;
    ws.data = state;
    // Replace any existing client.
    if (activeSocket && activeSocket !== ws) {
      try {
        activeSocket.close();
      } catch (e) {
        log.debug("mac-bridge: previous activeSocket.close() threw", { e: String(e) });
      }
    }
    activeSocket = ws;
    // Отсчёт тишины начинается с аутентификации, а не с первого pong: иначе
    // демон, который вообще не отвечает на ping, оставался бы «онлайн» вечно —
    // lastPongTime так и не выставился бы, и ни health, ни жнец его не увидели.
    lastPongTime = Date.now();
    failAllPending("mac_replaced");
    try {
      ws.send(JSON.stringify({ type: "auth_ok" }));
    } catch (e) {
      log.debug("mac-bridge: ws.send(auth_ok) failed", { e: String(e) });
    }
    log.info("[mac-bridge] client authenticated");
    startPinging();
    return;
  }

  if (!state.authed) {
    ws.close();
    return;
  }

  // Аудит 2026-08-28: дальше шла работа с общим состоянием моста по одному лишь
  // `state.authed` — то есть ЛЮБОЙ аутентифицированный сокет, а не только
  // текущий активный. Замена клиента (второй демон с тем же секретом) просит
  // старый сокет закрыться, но `close()` асинхронен, а его отказ логируется
  // только в debug — то есть окно, в котором живы два authed-сокета,
  // существует всегда.
  //
  // Дороже всего это стоило кадру `pong`: он двигает модульный `lastPongTime`,
  // а тот — ЕДИНСТВЕННЫЙ вход `isMacOnline()`, на котором висят /api/health,
  // /readyz (checks.mac_bridge), прометеевский gauge и гейт в dispatch/mac.ts.
  // Пришлый сокет своими pong'ами держал мост «живым», пока настоящий активный
  // демон молчал (закрытая крышка) — то есть ровно возвращал баг, который жнец
  // молчащего сокета закрыл 2026-08-08: run уходил в пустоту, вызывающий висел
  // весь MAC_RUN_TIMEOUT_MS и получал mac_timeout вместо мгновенного
  // mac_offline. Кадры `chunk`/`result` от чужого сокета тем же путём могли
  // завершить или испортить чужой прогон.
  if (activeSocket && ws !== activeSocket) {
    log.debug("mac-bridge: кадр от неактивного сокета проигнорирован", {
      type: typeof msg?.type === "string" ? msg.type : "unknown",
    });
    return;
  }

  if (msg?.type === "chunk") {
    const p = pending.get(String(msg.id ?? ""));
    if (!p) return;
    const data = typeof msg.data === "string" ? msg.data : "";
    // Держим только хвост: полный поток может быть в сотни мегабайт, а нужен
    // он только хвостом и длиной — см. MAC_STREAM_TAIL_BYTES.
    if (msg.stream === "stderr") {
      p.stderrLen += data.length;
      p.stderr = tailWithinBytes(p.stderr + data, MAC_STREAM_TAIL_BYTES);
    } else {
      p.stdoutLen += data.length;
      p.stdout = tailWithinBytes(p.stdout + data, MAC_STREAM_TAIL_BYTES);
    }
    if (p.onProgress) {
      try {
        p.onProgress(snapshotOf(p));
      } catch (e) {
        log.debug("mac-bridge: onProgress callback threw", { e: String(e) });
      }
    }
    return;
  }

  if (msg?.type === "result") {
    const id = String(msg.id ?? "");
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve({
      ok: !!msg.ok,
      code: typeof msg.code === "number" ? msg.code : undefined,
      ...snapshotOf(p),
      truncated:
        p.stdoutLen > p.stdout.length || p.stderrLen > p.stderr.length,
      // Демон кладёт сюда хвост stderr («exit 1: …»), а отсюда строка уходит в
      // agent_actions.error и в чат. См. комментарий у snapshotOf.
      error:
        typeof msg.error === "string" ? scrubSecretString(msg.error) : undefined,
    });
    return;
  }

  if (msg?.type === "pong") {
    lastPongTime = Date.now();
    return;
  }
}

function startPinging(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
  }
  pingInterval = setInterval(safeTick("mac-bridge.ping", () => {
    if (!activeSocket) return;
    // Аудит 2026-08-08: молчащий мак раньше не закрывался. isMacOnline() честно
    // показывал offline в /api/health, но activeSocket оставался, dispatch
    // проверял только «сокет не null» и отправлял run в пустоту — вызывающий
    // висел все пять минут RUN_TIMEOUT_MS и получал mac_timeout вместо
    // немедленного mac_offline. Самый частый случай — закрытая крышка ноутбука,
    // то есть не сбой, а норма. Демон отвечает на ping синхронно в обработчике
    // сообщений (прогон крутится отдельной async-задачей), так что молчание
    // дольше PING_TIMEOUT_MS означает именно мёртвое соединение.
    // Один и тот же предикат, что у /api/health: иначе «мост считает мак
    // мёртвым» и «health показывает offline» разъедутся при первой же правке.
    if (!isMacOnline()) {
      log.warn("[mac-bridge] нет pong дольше таймаута — закрываем соединение", {
        silentMs: lastPongTime === null ? null : Date.now() - lastPongTime,
        timeoutMs: PING_TIMEOUT_MS,
      });
      const dead = activeSocket;
      activeSocket = null;
      lastPongTime = null;
      stopPinging();
      failAllPending("mac_disconnected");
      try {
        dead.close();
      } catch (e) {
        log.debug("mac-bridge: close() of dead socket threw", { e: String(e) });
      }
      return;
    }
    try {
      activeSocket.send(JSON.stringify({ type: "ping" }));
    } catch (e) {
      log.warn("[mac-bridge] ping failed", { error: (e as Error)?.message });
    }
  }), PING_INTERVAL_MS);
  unrefTimer(pingInterval);
}

function stopPinging(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

/**
 * Порт моста из env: целое 1..65535, иначе дефолт.
 *
 * Аудит 2026-08-08: было `Number(process.env.MAC_BRIDGE_PORT ?? DEFAULT)`.
 * Опечатка даёт NaN, а Bun.serve трактует NaN как «порт 0» — то есть поднимает
 * мост на СЛУЧАЙНОМ эфемерном порту (проверено на рантайме проекта: 62257).
 * Стартует при этом всё успешно, в логе бодрое «listening», а ssh-туннель с Mac
 * стучится в фиксированный порт и не находит никого. MAC_RUN_CLAUDE просто
 * перестаёт работать — без единой ошибки в тот момент, когда причину ещё видно.
 */
export function _resolveBridgePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MAC_BRIDGE_PORT;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  log.warn("[mac-bridge] некорректный MAC_BRIDGE_PORT — берём дефолт", {
    got: raw,
    fallback: DEFAULT_MAC_BRIDGE_PORT,
  });
  return DEFAULT_MAC_BRIDGE_PORT;
}

/**
 * Интерфейс, на котором слушает мост. Пустая строка — это НЕ «не задано».
 *
 * Аудит 2026-08-28: было `process.env.MAC_BRIDGE_HOST ?? "127.0.0.1"`. `??`
 * ловит только отсутствие имени, а systemd для строки вида `KEY=` отдаёт
 * пустую строку — и `agent/.env.example` отгружает переменную ровно так,
 * строкой `MAC_BRIDGE_HOST=` без значения, с инструкцией «Copy to .env». То
 * есть пустая строка здесь не экзотика, а
 * поставляемое по умолчанию значение.
 *
 * Что делает с ней Bun (замер на рантайме проекта, `lsof` по собственному
 * PID): `hostname: ""` поднимает сокет на `*:PORT` — IPv6-wildcard, то есть
 * ВСЕ интерфейсы, — тогда как `"127.0.0.1"` даёт `127.0.0.1:PORT`. Причём
 * `server.hostname` при пустой строке возвращает бодрое `"localhost"`, так
 * что ни по логу, ни по самодиагностике подмена не видна.
 *
 * Цена ошибки — не «неудобство»: комментарий у вызова обещает loopback именно
 * потому, что транспортное шифрование даёт ssh-туннель, а не сам мост. На
 * wildcard тот же мост слушает публичный интерфейс по нешифрованному `ws://`,
 * и общий секрет уходит первым же кадром открытым текстом. За мостом — запуск
 * `claude` на машине владельца.
 *
 * `?.trim() ||` (а не `??`) — тот же приём, что у соседнего
 * `_resolveBridgePort`, который этот случай обрабатывает явно с 2026-08-08.
 */
export function _resolveBridgeHost(raw: string | undefined): string {
  return raw?.trim() || DEFAULT_MAC_BRIDGE_HOST;
}

/**
 * Start the WebSocket bridge. Refuses to start if MAC_BRIDGE_SECRET is shorter
 * than 32 chars. Returns null if MAC_BRIDGE_SECRET is unset (no-op mode).
 */
export function startMacBridge(): ServerHandle | null {
  const secret = process.env.MAC_BRIDGE_SECRET;
  if (!secret) return null;
  if (secret.length < 32) {
    throw new Error(
      "MAC_BRIDGE_SECRET must be at least 32 characters long (refusing to start)",
    );
  }
  const port = _resolveBridgePort(process.env.MAC_BRIDGE_PORT);
  // T-116: bind to loopback by default so the bridge is NOT exposed on the
  // public interface — the Mac daemon reaches it over an ssh tunnel (which
  // also provides the transport encryption). Override with MAC_BRIDGE_HOST
  // only for a deliberately different topology (e.g. nginx wss in front).
  const hostname = _resolveBridgeHost(process.env.MAC_BRIDGE_HOST);
  const server = Bun.serve<ClientState>({
    port,
    hostname,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (!bridgePathAllowed(url.pathname) || !bridgeOriginAllowed(req.headers.get("origin"))) {
        return new Response("forbidden", { status: 403 });
      }
      const peerKey = srv.requestIP?.(req)?.address ?? "unknown";
      if (!reserveConnection(peerKey)) {
        return new Response("too many connections", { status: 429 });
      }
      const upgraded = srv.upgrade(req, {
        data: { authed: false, peerKey } as ClientState,
      });
      if (upgraded) {
        return;
      }
      releaseConnection(peerKey);
      return new Response("mac-bridge", { status: 200 });
    },
    websocket: {
      open(ws) {
        const state = (ws.data as ClientState) ?? {
          authed: false,
          peerKey: "unknown",
        };
        state.authTimer = setTimeout(() => {
          if (!state.authed) {
            log.info("[mac-bridge] closing unauthenticated socket");
            try {
              ws.close(1008, "authentication timeout");
            } catch (e) {
              log.debug("mac-bridge: auth timeout close failed", { e: String(e) });
            }
          }
        }, bridgeConnectionLimits().authTimeoutMs);
        unrefTimer(state.authTimer);
        ws.data = state;
      },
      message(ws, message) {
        const raw =
          typeof message === "string"
            ? message
            : Buffer.from(message as unknown as ArrayBuffer).toString("utf8");
        handleClientMessage(ws, raw);
      },
      close(ws) {
        const state = ws.data as ClientState | undefined;
        if (state) {
          clearAuthTimer(state);
          releaseConnection(state.peerKey);
        }
        if (activeSocket === ws) {
          log.info("[mac-bridge] active client disconnected");
          activeSocket = null;
          lastPongTime = null;
          stopPinging();
          failAllPending("mac_disconnected");
        }
      },
    },
  });
  log.info(`[mac-bridge] listening on :${port}`);
  serverHandle = {
    port,
    stop: () => {
      try {
        server.stop(true);
      } catch (e) {
        log.debug("mac-bridge: server.stop() threw", { e: String(e) });
      }
      activeSocket = null;
      lastPongTime = null;
      stopPinging();
      failAllPending("mac_bridge_stopped");
      connectionCounts.clear();
      serverHandle = null;
    },
  };
  return serverHandle;
}

/**
 * Test seam: доставить входящий кадр тем же путём, каким его доставляет
 * websocket.message(). Без него обработка chunk/result недостижима из тестов —
 * а именно там живёт бюджет памяти на поток. NOT for production use.
 */
export function _handleClientMessageForTests(ws: any, raw: string): void {
  handleClientMessage(ws, raw);
}

/**
 * Test seam: forcibly inject a fake socket (or null) and clear state.
 * NOT for production use.
 */
export function _setActiveSocketForTests(sock: any | null): void {
  activeSocket = sock;
  lastPongTime = null;
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  failAllPending("test_reset");
}

/** Whitelist check from env CSV. */
export function isUserAllowed(userId: string | undefined | null): boolean {
  const csv = process.env.MAC_USER_IDS ?? "";
  if (!csv.trim()) return false;
  const allowed = new Set(
    csv
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  if (!userId) return false;
  return allowed.has(String(userId));
}
