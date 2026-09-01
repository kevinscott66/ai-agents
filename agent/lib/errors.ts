import { scrubSecretString } from "./log.ts";

/** Extract a human-readable message from any thrown value.
 *  Consolidates the `e instanceof Error ? e.message : String(e)` idiom that was
 *  repeated ~38× across the codebase (T-610 refactor).
 *
 *  Аудит 2026-08-11: результат обязан быть безопасным для показа и хранения.
 *  Часть из 75 вызовов оборачивает Bot API (PUBLISH_TO_CHANNEL и соседи), а
 *  telegraf ходит через node-fetch@2 — тот на сетевой ошибке пишет
 *  `request to https://api.telegram.org/bot<ТОКЕН>/... failed`. Дальше строка
 *  ложится в `agent_actions.error`, то есть токен оседает в SQLite на диске и
 *  отдаётся админам через /api/actions. Чистим здесь, а не в 75 местах: точка
 *  ровно одна, и будущие вызовы закрыты по построению.
 *
 *  Скруббер трогает только сам секрет (`123456:***`), поэтому разбор текста по
 *  коду ошибки — `/\b429\b/` в replyForTurnError и подобное — продолжает
 *  работать. */
export function getErrorMessage(e: unknown): string {
  return scrubSecretString(e instanceof Error ? e.message : String(e));
}

/** Потолок для куска вендорского тела ответа в тексте ошибки. */
export const MAX_VENDOR_DETAIL = 300;

/**
 * Потолок на ЧТЕНИЕ тела вендорской ошибки — 64 КБ.
 *
 * Аудит 2026-08-27: тело читалось целиком (`res.text()`) и только потом
 * резалось до 300 символов. Соседний хелпер `readCapped` (lib/http.ts)
 * написан ровно против этого — «не узнаём размер постфактум, когда всё уже
 * в памяти», — но занести его сюда нельзя: http.ts импортирует
 * `getErrorMessage` из этого файла, и обратный импорт замкнул бы цикл
 * модулей на уровне их top-level `const`. Поэтому здесь свой, короткий.
 *
 * 64 КБ с запасом перекрывают и JSON вендора, и HTML-страницу шлюза (замер в
 * докблоке ниже — 18 КБ). Важно, что именно перестаёт происходить: апстрим,
 * отдающий гигабайт или не закрывающий поток, больше не буферизуется целиком
 * в однопоточном процессе, которому принадлежит SQLite, — до истечения
 * 60-секундного AbortSignal у вызывающих (openai-image.ts, openai-whisper.ts).
 */
export const MAX_VENDOR_BODY_BYTES = 64_000;

export async function _readVendorBodyCapped(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return await res.text().catch(() => "");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    // Тело уже потрачено или залочено кем-то до нас: `getReader()` бросает
    // «ReadableStream is locked» СИНХРОННО, мимо try ниже. Пояснения не
    // будет, но и броска тоже — контракт функции: «пусто, а не исключение».
    return "";
  }
  const dec = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (total < MAX_VENDOR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      // Аудит 2026-08-28: раньше кусок дописывался целиком, а потолок
      // проверялся уже следующим витком — фактический предел был «64 КБ плюс
      // один кусок», а размер куска назначает апстрим. Режем по остатку:
      // `stream: true` придержит многобайтовый символ, разрезанный по границе,
      // и финальный flush отдаст его как U+FFFD.
      const room = MAX_VENDOR_BODY_BYTES - total;
      total += value.byteLength;
      text += dec.decode(value.byteLength > room ? value.subarray(0, room) : value, {
        stream: true,
      });
    }
  } catch {
    // Оборванное тело: отдаём то, что успели прочитать. Пояснение вендора —
    // не тот случай, ради которого стоит ронять вызывающего.
  } finally {
    // Без cancel сокет висит до срабатывания AbortSignal у вызывающего.
    await reader.cancel().catch(() => {});
  }
  return text + dec.decode();
}

/**
 * Ключи, под которыми вендоры кладут человекочитаемое пояснение. Порядок — от
 * самого явного к самому общему: `message` у OpenAI и Anthropic, `description`
 * у Telegram Bot API, `detail` у FastAPI-совместимых прокси,
 * `error_description` у OAuth-шлюзов. `code` и `type` в конце: это не фраза, но
 * это всё, что вендор сказал, и «rate_limit_exceeded» оператору полезнее
 * пустой строки.
 */
const DETAIL_KEYS = [
  "message",
  "description",
  "detail",
  "error_description",
  "reason",
  "code",
  "type",
] as const;

/** Первое непустое строковое пояснение из объекта; сама строка — как есть. */
function pickDetail(o: unknown): string {
  if (typeof o === "string") return o.trim();
  if (!o || typeof o !== "object") return "";
  for (const k of DETAIL_KEYS) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Достать пояснение из НЕуспешного ответа вендорского HTTP API.
 *
 * Аудит 2026-08-21: у openai-image.ts и openai-whisper.ts стояла одна и та же
 * связка — `try { await res.json() } catch { try { await res.text() } catch {} }`.
 * Запасная ветка мёртвая: `res.json()` на не-JSON теле его уже ПОТРАТИЛ, и
 * `res.text()` бросает «Body already used». Замер на 18KB HTML-странице шлюза:
 * `detail` оставался пустым, и оператору доставалось голое
 * «OpenAI image API error 502» — ровно в том случае, когда пояснение и нужно
 * (ответил не вендор, а прокси/шлюз, и по коду статуса причину не отличить).
 *
 * Здесь тело читается ОДИН раз текстом, разбор JSON идёт уже по строке.
 * Хвост режется: не-JSON телом бывает целая HTML-страница, а строка уезжает и
 * в `agent_actions.error` (без обрезки при вставке), и в контекст модели.
 * Переводы строк схлопываются — иначе одна ошибка распадается на сотни строк
 * лога.
 */
export async function vendorErrorDetail(
  res: Response,
  max: number = MAX_VENDOR_DETAIL,
): Promise<string> {
  const raw = await _readVendorBodyCapped(res);
  let detail = raw;
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === "object") {
      // Аудит 2026-08-27: было `j.error?.message ?? ""`, и форма
      // `{"error":"invalid_api_key"}` давала ПУСТУЮ строку — у строки нет
      // `.message`, а `?? ""` превращал undefined в «вендор не пояснил».
      // Так отвечают OpenAI-совместимые прокси и шлюзы Azure, и оператору
      // доставалось голое «OpenAI image API error 401» — ровно та потеря
      // пояснения, против которой функция и написана.
      const e = (j as { error?: unknown }).error;
      // Аудит 2026-08-28: разбор знал ровно две формы — строку и объект с
      // `.message`. На всём остальном `?? ""` отдавал ПУСТУЮ строку, причём
      // затирая уже прочитанное тело. Замерено на реальных формах:
      //
      //   {"error":true,"message":"…"}        → "" (пояснение рядом, не внутри)
      //   {"error":429,"description":"…"}     → "" (форма Telegram Bot API)
      //   {"error":["a","b"],"message":"…"}   → "" (у массива нет .message)
      //   {"error":{"code":"rate_limit"}}     → "" (код и есть всё пояснение)
      //
      // Оператору при этом доставалось голое «OpenAI image API error 429» —
      // ровно та потеря пояснения, против которой функция написана.
      const picked = pickDetail(e) || pickDetail(j);
      // Нечего достать: при структурном ответе (`error` есть) сырой JSON не
      // подставляем — он шумит и ничего не добавляет; при незнакомой форме
      // тело и есть всё, что известно.
      detail = picked || ("error" in j ? "" : raw);
    }
  } catch {
    // Не JSON — отдаём тело как есть, оно и есть всё пояснение.
  }
  const flat = scrubSecretString(detail).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "\u2026";
}
