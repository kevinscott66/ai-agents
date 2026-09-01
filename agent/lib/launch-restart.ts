/**
 * Перезапуск поллинга: сбрасывать очередь можно только на холодном старте.
 *
 * Аудит 2026-08-13. Цикл в orchestrator-team.ts выглядел так:
 *
 *   while (true) {
 *     try { await b.bot.launch({ dropPendingUpdates: true }) } catch {...}
 *     await sleep(3000)
 *   }
 *
 * `dropPendingUpdates: true` стоял ВНУТРИ цикла, то есть применялся не только к
 * первому запуску, но и к каждому перезапуску. На холодном старте это осознанно
 * (после деплоя переигрывать вчерашние сообщения незачем), а на перезапуске —
 * потеря данных: любой обрыв поллинга (брошенный хендлер, сетевой сбой, 429 от
 * getUpdates) стирал всё, что пользователи написали за время простоя. Telegram
 * держит апдейты до 24 часов именно ради этого случая, а мы говорили ему
 * «выбрось».
 *
 * Инвариант: сбрасываем очередь ровно один раз, на самом первом launch.
 *
 * Аудит 2026-08-20: сюда же переехала остановка. В orchestrator-team.ts стояло
 * `for (const b of bots) b.bot.stop(sig)` — а telegraf БРОСАЕТ `Bot is not
 * running!`, если поллинг не поднялся (проверено на telegraf@4.16.3:
 * `bot.polling === undefined` до launch). Попасть в это окно легко: launch
 * падает на `deleteWebhook` (429/5xx/сеть) ДО startPolling, и цикл выше ходит
 * по три секунды, пока не пройдёт. Прилетевший в это окно SIGTERM ронял
 * исключение из слушателя сигнала: `process.exit(0)` не выполнялся, остальные
 * боты не останавливались, а `uncaughtException` из telegraf-patch.ts на это
 * сообщение только логирует UNCAUGHT и возвращается. Процесс переставал
 * реагировать на SIGTERM — systemd ждал TimeoutStopSec и бил SIGKILL, а старый
 * инстанс всё это время конкурировал с новым за getUpdates (тот самый 409).
 *
 * Аудит 2026-08-27: абзац выше описывает обработчик таким, каким он был ДО
 * фикса того же дня, и читается как утверждение о сегодняшнем коде. Сегодня
 * `isTelegrafNoise` (telegraf-patch.ts) считает шумом только `readonly
 * property` и стек из `telegraf/lib/core/network/client`; `Bot is not running!`
 * летит из `telegraf/lib/telegraf.js` и под шум не подходит. То есть исключение
 * из слушателя сигнала теперь логирует UNCAUGHT и ВЫХОДИТ. Зависания на
 * TimeoutStopSec больше не будет, но выход этот аварийный: остальные боты
 * `stop()` не получат, а `process.exit(0)` не выполнится. Инвариант от этого не
 * меняется — ловить обязаны здесь, а не рассчитывать на глобальный обработчик.
 */
import { log } from "./log.ts";
import { getErrorMessage } from "./errors.ts";
import { parseRetryAfterSeconds } from "./telegram-retry.ts";

/** Минимум от RunningBot, который нужен циклу. Ради тестируемости без telegraf. */
export type LaunchableBot = {
  def: { key: string };
  bot: { launch: (opts: { dropPendingUpdates: boolean }) => Promise<unknown> };
};

/** Минимум от RunningBot, который нужен остановке. */
export type StoppableBot = {
  def: { key: string };
  bot: { stop: (sig?: string) => void };
};

/**
 * Остановить всех ботов, не дав одному сорвать остановку остальных.
 *
 * Возвращает число ботов, у которых stop() бросил — вызывающему это нужно
 * только для лога: выйти надо в любом случае.
 */
export function stopAllSafely(bots: StoppableBot[], sig: string): number {
  let failed = 0;
  for (const b of bots) {
    try {
      b.bot.stop(sig);
    } catch (e) {
      failed += 1;
      // Штатный случай, а не аномалия: поллинг мог не подняться.
      log.warn(
        `[${b.def.key}] stop(${sig}) не прошёл: ${getErrorMessage(e).slice(0, 200)}`,
      );
    }
  }
  return failed;
}

export const RESTART_DELAY_MS = 3000;

/**
 * Потолок паузы между перезапусками.
 *
 * Аудит 2026-08-28: паузa была ровно 3000 мс и не росла никогда. Для сетевого
 * сбоя это верно — он проходит сам. Для отказа, который сам не пройдёт, — нет:
 * отозванный токен (401), чужой инстанс на getUpdates (409), упёршийся лимит
 * (429) дают вечный цикл с шагом в три секунды. Telegraf на 401/409 отклоняет
 * launch немедленно, то есть итерация стоит ~0 мс, и в проде таких циклов
 * двенадцать — это ~4 запроса в секунду в Bot API и ~28 800 строк лога на бота
 * в сутки, каждая одинаковая. Причём 429 мы этим же и продлевали.
 *
 * Поэтому пауза удваивается до потолка. На потолке — один запрос в минуту на
 * бота: отказ по-прежнему чинится сам, как только исчезнет причина, но не
 * оплачивается круглосуточно.
 */
export const MAX_RESTART_DELAY_MS = 60_000;

/**
 * Сколько launch должен продержаться, чтобы счёт неудач начался заново.
 *
 * Без этого один долгий обрыв через сутки работы ждал бы минуту вместо трёх
 * секунд. Порог тот же, что и потолок: продержался дольше самой длинной паузы —
 * значит поллинг был живой, а не отбивался сразу.
 */
export const HEALTHY_RUN_MS = 60_000;

/** Дольше этого не ждём даже по прямой просьбе Telegram. */
export const MAX_RETRY_AFTER_WAIT_MS = 5 * 60_000;

/**
 * Пауза перед перезапуском номер `consecutive` (первый — 1).
 *
 * Отдельной функцией, потому что арифметика с `2 **` на длинном ряде неудач
 * даёт Infinity, а не число: `Math.min(Infinity, max)` вернул бы max и это
 * работало бы случайно. Здесь это написано намеренно.
 */
export function nextRestartDelayMs(
  baseMs: number,
  consecutive: number,
  maxMs: number = MAX_RESTART_DELAY_MS,
): number {
  const grown = baseMs * 2 ** Math.max(0, consecutive - 1);
  return Number.isFinite(grown) ? Math.min(grown, maxMs) : maxMs;
}

export type LaunchRestartOpts = {
  /** Базовая пауза перед перезапуском; дальше удваивается до maxDelayMs. */
  delayMs?: number;
  /**
   * Потолок НАШЕЙ арифметики отката.
   *
   * Уточнение 2026-08-29: это не потолок паузы вообще. Когда Telegram сам
   * назвал `retry_after`, пауза берётся не меньше названного числа — ждать
   * меньше значит получить следующий 429 и раскрутить блокировку, — так что
   * `maxDelayMs: 10_000` при `retry_after: 120` даст 120 секунд, а не десять.
   * Абсолютный потолок в этом случае один и он общий: MAX_RETRY_AFTER_WAIT_MS.
   */
  maxDelayMs?: number;
  /** Сколько launch должен продержаться, чтобы счёт неудач сбросился. */
  healthyRunMs?: number;
  /**
   * Сколько перезапусков сделать. `Infinity` (прод) — вечно; конечное число
   * нужно тесту: иначе цикл не вернёт управление никогда.
   */
  maxRestarts?: number;
  /** Подменяемый sleep — тест не должен ждать три секунды на каждой итерации. */
  sleep?: (ms: number) => Promise<void>;
  /** Подменяемые часы — тестy нужно измерять длительность launch без ожидания. */
  now?: () => number;
};

/**
 * Держит поллинг бота живым. Возвращается только когда исчерпан maxRestarts,
 * поэтому в проде вызывается без await (промис живёт всю жизнь процесса).
 */
export async function launchWithRestart(
  b: LaunchableBot,
  opts: LaunchRestartOpts = {},
): Promise<void> {
  const delayMs = opts.delayMs ?? RESTART_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? MAX_RESTART_DELAY_MS;
  const healthyRunMs = opts.healthyRunMs ?? HEALTHY_RUN_MS;
  const maxRestarts = opts.maxRestarts ?? Infinity;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let restarts = 0;
  let coldStart = true;
  let consecutive = 0;
  while (true) {
    const startedAt = now();
    let reason: string;
    let retryAfterMs: number | undefined;
    try {
      await b.bot.launch({ dropPendingUpdates: coldStart });
      reason = "launch resolved (polling stopped)";
    } catch (e) {
      reason = `launch rejected: ${getErrorMessage(e).slice(0, 200)}`;
      const secs = parseRetryAfterSeconds(e);
      if (secs !== undefined) retryAfterMs = secs * 1000;
    }
    // Первый launch позади: дальше очередь не трогаем, что бы ни случилось.
    coldStart = false;
    // Продержался дольше самой длинной паузы — считаем поллинг живым и начинаем
    // счёт заново; иначе это следующая неудача подряд.
    consecutive = now() - startedAt >= healthyRunMs ? 1 : consecutive + 1;
    let waitMs = nextRestartDelayMs(delayMs, consecutive, maxDelayMs);
    if (retryAfterMs !== undefined) {
      // Telegram назвал точное число секунд — оно важнее нашей арифметики, но
      // не безгранично: блокировка на час не повод держать бота в паузе час.
      waitMs = Math.min(Math.max(waitMs, retryAfterMs), MAX_RETRY_AFTER_WAIT_MS);
    }
    log.warn(`[${b.def.key}] ${reason} — restart in ${waitMs}ms`);
    if (restarts >= maxRestarts) return;
    restarts += 1;
    await sleep(waitMs);
  }
}
