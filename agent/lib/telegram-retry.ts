/**
 * Ожидание по 429 от Telegram Bot API. Листовой модуль — только `log`.
 *
 * Аудит 2026-08-20: `retry_after` в проекте уважал ровно один клиент —
 * `lib/anthropic-client.ts`. У Telegram при 429 ответ приходит с точным числом
 * секунд (`parameters.retry_after`), и никто его не читал: отправка просто
 * падала, действие репортилось провалившимся, а модель решала, повторять ли
 * его, — иногда через секунду, то есть в тот же самый лимит.
 *
 * Почему по 429 повторять МОЖНО, хотя по таймауту нельзя (см. докстроку
 * `sendWithHtml`): 429 — это отказ ДО обработки, сообщение не доставлено, и
 * Telegram сам называет, сколько ждать. Таймаут же не говорит ничего:
 * запрос мог дойти, потеряться мог только ответ, и повтор доставляет второй
 * экземпляр. Поэтому здесь повтор строго и только на распознанном 429.
 *
 * Границы намеренно узкие. `retry_after` больше минуты — это не пауза, а
 * блокировка (у каналов бывает и на час): столько держать действие в воздухе
 * нельзя, отдаём ошибку наверх, там она станет видимым отказом. Попыток три,
 * а не «пока не пустят», — чтобы зацикленный лимит не превращался в вечно
 * висящий вызов.
 */
import { log } from "./log.ts";

/** Дольше этого не ждём: это уже не пауза, а блокировка. */
export const MAX_RETRY_AFTER_SECONDS = 60;
const MAX_ATTEMPTS = 3;

/**
 * Пол ожидания перед повтором 429.
 *
 * Аудит 2026-09-10: спали ровно `secs * 1000`, а `secs` приходит снаружи и
 * законно бывает нулём — `parseRetryAfterSeconds` принимает любое `>= 0`, и
 * текстовая форма `retry after 0` разбирается так же. Ноль означал повтор
 * МГНОВЕННО, то есть ровно то, что этот модуль и заведён устранять: шапка
 * `sendWithHtml` (telegram-format.ts) называет мгновенный повтор
 * недопустимым и обосновывает всю конструкцию тем, что пауза настоящая.
 * Получалось до трёх запросов подряд без единой паузы в тот самый эндпойнт,
 * который только что ответил «слишком часто», — не катастрофа (попытки
 * ограничены `MAX_ATTEMPTS`), но приглашение углубить флуд-окно вместо того,
 * чтобы его переждать.
 *
 * Тот же довод уже записан в `anthropic-client.ts` (`MIN_RETRY_AFTER_MS`):
 * «ноль информации не несёт, сервер только что отказал по лимиту». Там нулевой
 * заголовок игнорируется в пользу СОБСТВЕННОГО экспоненциального отступа; здесь
 * своего отступа нет — `secs === undefined` означает «пробросить ошибку», — так
 * что игнорировать нельзя, иначе потеряем законный повтор. Поэтому не отбрасываем,
 * а поднимаем до секунды.
 *
 * `launch-restart.ts:193` в поле не нуждается: там `retry_after` только
 * поднимает собственную задержку (`Math.max(waitMs, retryAfterMs)`), и ноль там
 * не значит ничего.
 */
export const MIN_RETRY_AFTER_SECONDS = 1;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/**
 * Сколько секунд просит подождать Telegram, если это именно 429.
 *
 * Формы, в которых telegraf отдаёт ошибку, отличаются между версиями и между
 * методами: `err.parameters`, `err.response.parameters`, а в самом бедном
 * случае — только текст описания. Разбираем все три, но код 429 требуем
 * обязательно: без него «retry after» в тексте могло бы прилететь из чужого
 * сообщения об ошибке и превратить обычный отказ в молчаливое ожидание.
 *
 * Аудит 2026-08-28: это и было написано, но не сделано — условие читалось
 * `code === 429 || /too many requests/i.test(desc)`, то есть кода не требовало
 * вовсе. Текстовая ветка нужна только самой бедной форме, где кода нет ВООБЩЕ;
 * если код есть и он не 429, слова в описании его не отменяют. Иначе 5xx со
 * страницы промежуточного прокси (там бывают и «Too Many Requests», и «retry
 * after N») проходил бы за лимит — а такой запрос до Telegram дойти мог, и
 * повтор доставил бы второй экземпляр сообщения. Весь довод модуля в пользу
 * повтора держится ровно на том, что 429 — отказ ДО обработки.
 *
 * Цена узости: если telegraf когда-нибудь положит в `code` нечисловое рядом с
 * настоящим 429-описанием, мы просто не станем ждать и отдадим ошибку наверх —
 * поведение до аудита 2026-08-20, без дублей.
 */
export function parseRetryAfterSeconds(err: unknown): number | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  const resp = asRecord(e.response);
  const code = e.code ?? e.error_code ?? resp?.error_code;
  const desc = String(e.description ?? resp?.description ?? e.message ?? "");
  const is429 = code === 429 || (code === undefined && /too many requests/i.test(desc));
  if (!is429) return undefined;

  for (const p of [asRecord(e.parameters), asRecord(resp?.parameters)]) {
    const secs = p?.retry_after;
    if (typeof secs === "number" && secs >= 0) return secs;
  }
  const m = desc.match(/retry after (\d+)/i);
  return m ? Number(m[1]) : undefined;
}

/** Ошибка — это лимит частоты Telegram (а не любой другой отказ). */
export function isRateLimitError(err: unknown): boolean {
  return parseRetryAfterSeconds(err) !== undefined;
}

export interface RetryOptions {
  /** Подмена сна в тестах. По умолчанию — setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  maxWaitSeconds?: number;
  /** Что писать в лог: чей это вызов. */
  label?: string;
}

/**
 * Выполнить вызов к Telegram, переждав 429 столько, сколько он просит.
 *
 * Всё, что не 429, пробрасывается немедленно и без изменений — разбор ошибок у
 * вызывающих (isCaptionTooLong, isPhotoRejected, isHtmlParseError) не меняется.
 */
export async function withTelegramRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const maxWait = opts.maxWaitSeconds ?? MAX_RETRY_AFTER_SECONDS;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const secs = parseRetryAfterSeconds(e);
      if (secs === undefined || attempt >= maxAttempts || secs > maxWait) {
        if (secs !== undefined && secs > maxWait) {
          log.warn("[tg] 429 просит ждать дольше лимита — отдаём ошибку наверх", {
            label: opts.label,
            retryAfter: secs,
            maxWaitSeconds: maxWait,
          });
        }
        throw e;
      }
      // Пол — только на сон. Сравнение с `maxWait` выше идёт по названному
      // Telegram числу: поднимать до секунды то, что и так меньше потолка,
      // решение о «ждать или отдать наверх» не меняет.
      const waitSecs = Math.max(secs, MIN_RETRY_AFTER_SECONDS);
      log.warn("[tg] 429 — ждём столько, сколько просит Telegram", {
        label: opts.label,
        retryAfter: secs,
        waitSeconds: waitSecs,
        attempt,
        maxAttempts,
      });
      await sleep(waitSecs * 1_000);
    }
  }
}
