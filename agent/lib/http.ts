/**
 * Shared JSON-fetch helper for external API clients (figma, tgstat, …).
 * Centralizes the security-critical bits so every caller gets them for free:
 *   - request timeout (AbortSignal) — no hung upstream stalls the agent loop
 *   - response size cap (content-length) — no memory blowup before parse
 *   - uniform transport-error messages (label-prefixed, body-truncated)
 * App-level errors (e.g. TGStat's 200 + {status:"error"}) stay with the caller.
 */
import { getErrorMessage } from "./errors.ts";
import { scrubSecretString } from "./log.ts";

export interface FetchJsonOpts {
  /** Label for error messages, e.g. "figma" / "tgstat". */
  label: string;
  headers?: Record<string, string>;
  /** Request timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Reject responses whose Content-Length exceeds this (default 5 MB). */
  maxBytes?: number;
}

/**
 * Тело превысило потолок. Отдельный тип, а не текст сообщения: обёртка вокруг
 * чтения должна отличать «сработал наш же лимит» (сообщение уже осмысленное и
 * уже с label) от «поток оборвался» — иначе она припишет второй префикс.
 */
class ResponseTooLargeError extends Error {}

/**
 * Тело ответа, но не больше `maxBytes`.
 *
 * Заголовку Content-Length верить нельзя: при chunked-кодировании, gzip или
 * любом прокси посередине его просто нет, и старая проверка `Number(null ?? 0)`
 * всегда проходила — лимит не работал ровно там, где он и нужен (замер: 20 MB
 * прошли при лимите 1 MB). Считаем сами и обрываем чтение, а не узнаём размер
 * постфактум, когда всё уже в памяти.
 *
 * `overflow: "cut"` — для тела ошибки: там нужны первые полтораста символов, а
 * не отказ.
 *
 * `abort` — снять сам запрос, когда читать дальше мы не собираемся. Аудит
 * 2026-08-28: `reader.cancel()` отпускает НАШ reader, но передачу не
 * прекращает — bun дочитывает тело, чтобы переиспользовать соединение. Замер
 * на локальном сервере, отдающем ответ на 500 МБ, через 400 мс после отказа:
 * без ничего 20.2 МБ, после `cancel()` 18.6 МБ, после `abort()` — 0 байт и
 * закрытый сокет. То есть потолки ниже ограничивали только память процесса,
 * а трафик тёк дальше до истечения таймаута.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
  overflow: "throw" | "cut",
  label: string,
  abort: () => void = () => {},
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  // Декодируем на лету: копить Uint8Array-ы значило бы держать тело в памяти
  // дважды. `stream: true` сам склеивает многобайтовый символ, разрезанный
  // границей чанка.
  const dec = new TextDecoder();
  let text = "";
  let total = 0;
  // Дочитали до конца — соединение цело и годится для keep-alive; бросили на
  // середине — рвём, иначе апстрим продолжит слать в никуда.
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (!value) continue;
      total += value.byteLength;
      const over = total > maxBytes;
      if (over && overflow === "throw") {
        throw new ResponseTooLargeError(
          `${label} response too large (> ${maxBytes} bytes)`,
        );
      }
      text += dec.decode(value, { stream: true });
      if (over) break;
    }
  } finally {
    if (!drained) abort();
    await reader.cancel().catch(() => {});
  }
  return text + dec.decode();
}

export async function fetchJson<T = unknown>(
  url: string,
  opts: FetchJsonOpts,
): Promise<T> {
  const { label, headers, timeoutMs = 10_000, maxBytes = 5_000_000 } = opts;
  // Свой контроллер поверх таймаута: любой наш отказ по размеру обязан снять
  // запрос, а не только перестать его читать (см. докблок `readCapped`).
  const ac = new AbortController();
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (e) {
    throw new Error(`${label} request failed: ${getErrorMessage(e)}`);
  }
  if (!res.ok) {
    // Из тела ошибки берём 160 символов — читать ради них мегабайты незачем.
    const body = await readCapped(res, 4_096, "cut", label, () => ac.abort()).catch(
      () => "",
    );
    // Аудит 2026-08-27: три остальные ветки ошибок здесь чистятся скраббером
    // (через `getErrorMessage` → `scrubSecretString`), а эта — нет. Разница
    // не теоретическая: tgstat.ts:74 кладёт токен прямо в query-строку, и
    // шлюз, повторяющий запрошенный URI в теле 4xx/5xx («The requested URL
    // /channels/stat?token=… was not found» — типовой ответ Apache и WAF),
    // отдал бы его первыми же 160 символами. Строка отсюда уезжает в
    // `agent_actions.error` (в SQLite на диск, без обрезки при вставке),
    // админам через /api/actions и в контекст модели.
    throw new Error(
      scrubSecretString(`${label} ${res.status}: ${body.slice(0, 160)}`),
    );
  }
  // Заявленный размер отсекает заведомо большие ответы до чтения; отсутствие
  // заголовка больше не означает «лимита нет» — дальше считаем байты сами.
  const clen = Number(res.headers.get("content-length") ?? 0);
  if (clen > maxBytes) {
    // Отказ по заголовку — тела мы не касались вовсе, поэтому снимаем запрос
    // явно: иначе тот же замер, что в докблоке `readCapped`, — апстрим качает
    // отвергнутый ответ в фоне до конца таймаута.
    ac.abort();
    throw new Error(`${label} response too large (${clen} bytes)`);
  }
  let text: string;
  try {
    text = await readCapped(res, maxBytes, "throw", label, () => ac.abort());
  } catch (e) {
    if (e instanceof ResponseTooLargeError) throw e;
    // Единственная дыра в обещании докблока про label-prefixed: таймаут
    // (`AbortSignal.timeout`) снимает не только установку соединения, но и
    // чтение тела. Апстрим, отдавший заголовки и замолчавший на середине,
    // ронял голый `TimeoutError: The operation timed out.` наружу — без
    // единого следа, чей это апстрим. Через этот хелпер ходят figma, github
    // и tgstat, так что оператор по такому сообщению не выбирал вообще ничего.
    throw new Error(`${label} response read failed: ${getErrorMessage(e)}`);
  }
  if (!text) {
    // Аудит 2026-08-29: пустое тело уходило в JSON.parse и возвращалось как
    // `<label> invalid JSON: Unexpected end of JSON input` — сообщение про
    // сломанный payload там, где payload'а не было вовсе. `readCapped` отдаёт
    // "" при `res.body === null`, то есть на штатных 204/205; GitHub так
    // отвечает на части эндпоинтов. Оператор по такому тексту искал бы
    // несуществующую поломку разбора — ровно то, ради чего весь остальной
    // файл и приписывает label к каждому отказу.
    throw new Error(`${label} empty body (HTTP ${res.status})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    // Голый SyntaxError не говорит, чей апстрим сломался.
    throw new Error(`${label} invalid JSON: ${getErrorMessage(e)}`);
  }
}
