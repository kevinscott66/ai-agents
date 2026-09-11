/**
 * T-545: Anti-duplication for trigger messages.
 *
 * Prevents the same trigger message from being processed twice when delivered
 * by multiple transports (Bot API + MTProto userbot) or redelivered by
 * Telegram after a restart. Uses a time window to deduplicate by
 * (chat_id, tg_message_id, agent_key).
 */

import { getErrorMessage } from "./errors.ts";
import { db } from "./db.ts";
import { log } from "./log.ts";

const DEDUP_WINDOW_SECONDS = 60; // 1-minute window for deduplication

/**
 * Checks if a trigger message has already been processed recently.
 * Returns true if this is the first time processing this message,
 * false if it's a duplicate within the dedup window.
 *
 * Аудит 2026-09-11: `agentKey` появился в ключе и в сигнатуре, потому что без
 * него дедуп был пригоден только оркестратору. Строку занимал тот бот, кто
 * успел первым, а «дубль» получали остальные одиннадцать — поэтому вызов в
 * message-handler.ts и стоял под `isOrchestrator`, то есть у ролей повтора не
 * ловил никто. А повтор у них тот же самый: Telegram передоставляет
 * неподтверждённый апдейт после рестарта, и роль второй раз платит за ход LLM
 * и второй раз исполняет инструменты с побочными эффектами.
 *
 * Параметр обязательный намеренно: значение по умолчанию вернуло бы ровно ту
 * общую строку, из-за которой дедуп и был выключен.
 *
 * Заявка берётся ДО работы, а не после: строка в processed_triggers пишется
 * здесь, а ход (лимитер приёма, вызов модели, инструменты) идёт следом. Значит
 * ход, упавший на середине, повтора в окне 60 секунд не получит — Telegram
 * передоставит апдейт, а мы сочтём его дублем. Это выбрано сознательно и
 * менять порядок не надо: цена потерянного хода — одно молчание, цена второго
 * хода — второй платный вызов модели и повторное исполнение инструментов с
 * необратимыми побочными эффектами (публикация, создание канала, удаление
 * сообщения). Гарантия здесь не «хотя бы раз», а «не больше раза».
 *
 * @param chatId - The chat ID
 * @param tgMessageId - The Telegram message ID (from ctx.message.message_id)
 * @param agentKey - роль, которая собирается отрабатывать этот апдейт
 * @returns true if should process, false if duplicate
 */
export function shouldProcessTrigger(
  chatId: string,
  tgMessageId: number | undefined,
  agentKey: string,
): boolean {
  if (!tgMessageId) {
    // If no tgMessageId, we can't deduplicate, so process it
    return true;
  }

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - DEDUP_WINDOW_SECONDS;

  // Clean up old entries first to keep table size manageable.
  //
  // Аудит 2026-08-27: уборка и поиск ниже стояли ВНЕ try/catch, а catch у
  // INSERT'а объявляет политику модуля: «пропуск триггера — это молчание бота,
  // которое пользователь не отличит от поломки, обрабатываем». На сбое БД
  // политика не выполнялась: исключение улетало из shouldProcessTrigger в
  // вызывающий telegraf-хендлер (`bot.on("message")` в
  // orchestrator/message-handler.ts и `bot.on("voice")` в
  // orchestrator/voice-handler.ts — вызывающих два, и молчание отсюда гасит
  // оба пути), тот роняет обработку апдейта, и
  // сообщение исчезает молча — ровно тот исход, который catch внизу и запрещал.
  // Уборка вообще не влияет на ответ: её провал — это рост таблицы, не дубль.
  try {
    db.prepare(`DELETE FROM processed_triggers WHERE processed_at < ?`).run(cutoff);
  } catch (error) {
    log.error("[trigger-anti-dup] не смог подмести таблицу", {
      cutoff,
      error: getErrorMessage(error),
    });
  }

  // Check if this trigger was already processed recently.
  //
  // Аудит 2026-08-12: тут стояло `processed_at > ?`, а уборка выше — строгое
  // `< cutoff`. Значение ровно на `cutoff` не попадало ни под один предикат:
  // не удалялось и не находилось. Ответ «дубль» такая строка всё равно давала,
  // но приходил он снизу — INSERT OR IGNORE упирался в UNIQUE, changes был
  // нулём, и срабатывала ветка, предназначенная для гонки двух процессов.
  // Наблюдаемое поведение верное, объяснение в логе ложное: каждая граница
  // окна засчитывалась за гонку Bot API против юзербота.
  //
  // `>=` делает предикаты дополняющими: границу окна включает поиск, уборка
  // остаётся строгой.
  let existing: unknown;
  try {
    existing = db.prepare(`
      SELECT 1 FROM processed_triggers
      WHERE chat_id = ? AND tg_message_id = ? AND agent_key = ? AND processed_at >= ?
    `).get(chatId, tgMessageId, agentKey, cutoff);
  } catch (error) {
    // Та же политика, что и у INSERT'а ниже: без ответа БД дедуп невозможен,
    // и выбор стоит между «лишний повтор, который виден и редок» и «молчание,
    // неотличимое от поломки». Берём первое.
    log.error("[trigger-anti-dup] не смог проверить дубль — обрабатываем", {
      chatId,
      tgMessageId,
      agentKey,
      error: getErrorMessage(error),
    });
    return true;
  }

  if (existing) {
    // Duplicate trigger, don't process
    return false;
  }

  // First time seeing this trigger, mark as processed.
  //
  // Гонку ловит именно результат вставки, а не исключение: `INSERT OR IGNORE`
  // на конфликте UNIQUE(chat_id, tg_message_id, agent_key) НЕ бросает — он молча ничего не
  // делает. Прежняя ветка catch была мертва, и вся защита держалась на
  // SELECT выше, который с INSERT'ом не атомарен. Внутри одного процесса это не
  // стреляло (между SELECT и INSERT нет await), но два процесса на одной БД —
  // ровно тот случай, ради которого дедуп и писался: Bot API и userbot.
  try {
    const res = db.prepare(`
      INSERT OR IGNORE INTO processed_triggers (chat_id, tg_message_id, agent_key, processed_at)
      VALUES (?, ?, ?, ?)
    `).run(chatId, tgMessageId, agentKey, now);
    if (Number(res.changes ?? 0) === 0) {
      log.debug("[trigger-anti-dup] строку уже вставил кто-то другой", {
        chatId,
        tgMessageId,
        agentKey,
      });
      return false;
    }
  } catch (error) {
    // Настоящий сбой БД (не конфликт). Обрабатываем: пропуск триггера — это
    // молчание бота, которое пользователь не отличит от поломки, а лишний
    // повтор хотя бы виден и редок.
    log.error("[trigger-anti-dup] не смог отметить триггер — обрабатываем", {
      chatId,
      tgMessageId,
      agentKey,
      error: getErrorMessage(error),
    });
  }

  return true;
}

/**
 * Сколько триггеров лежит в таблице дедупа прямо сейчас.
 *
 * Аудит 2026-08-20: функция возвращала `lastHour` / `lastDay` / `total` и
 * считала их запросами с окнами 3600 и 86400 секунд. Ни одно из этих окон
 * не наблюдаемо: `shouldProcessTrigger` при КАЖДОМ вызове делает
 * `DELETE FROM processed_triggers WHERE processed_at < now - 60`. В живом
 * чате все три числа поэтому одинаковы и все три покрывают одну минуту.
 *
 * Собственный тест этого не ловил, потому что вставлял строки в таблицу
 * напрямую, минуя `shouldProcessTrigger` — то есть проверял арифметику SQL в
 * мире, которого в проде не бывает. Прод-вызовов у функции нет, так что
 * наблюдаемого ущерба не было; ущерб был бы у первого, кто повесит её на
 * `/metrics` или на админ-команду и прочитает «23 триггера за сутки».
 *
 * Возвращаем то, что таблица действительно знает: счёт внутри окна дедупа и
 * длину этого окна, чтобы читатель не гадал. `total` оставлен отдельно — он
 * может быть БОЛЬШЕ `inWindow`, потому что уборка ленивая: она случается
 * только на вызове `shouldProcessTrigger`, и в тихом чате старые строки
 * доживают до следующего триггера.
 */
export function getTriggerStats(): {
  inWindow: number;
  windowSeconds: number;
  total: number;
} {
  const cutoff = Math.floor(Date.now() / 1000) - DEDUP_WINDOW_SECONDS;

  // Аудит 2026-08-29: единственная функция модуля без try/catch — у уборки, у
  // SELECT'а и у INSERT'а он есть, и политика «сбой БД глотаем» сформулирована
  // в докблоке `shouldProcessTrigger`. Экспортируемая функция со ВТОРЫМ
  // контрактом отказа — ловушка для первого, кто повесит её на /metrics или на
  // админ-команду: сбой БД уронил бы весь ответ ради трёх счётчиков. Нули
  // отличаются от честного нуля записью в логе — выдумывать вместо них ничего
  // не надо, читателю нужен факт «посчитать не удалось».
  try {
    // `>=`, как в shouldProcessTrigger: границу окна включает поиск, уборка
    // остаётся строгой (`<`). Иначе строка ровно на границе не попадала бы ни
    // под один предикат — ровно та рассинхронизация, что чинилась 2026-08-12.
    const inWindow = db.prepare(`
      SELECT COUNT(*) as count FROM processed_triggers WHERE processed_at >= ?
    `).get(cutoff) as { count: number };

    const totalCount = db.prepare(`
      SELECT COUNT(*) as count FROM processed_triggers
    `).get() as { count: number };

    return {
      inWindow: inWindow.count,
      windowSeconds: DEDUP_WINDOW_SECONDS,
      total: totalCount.count,
    };
  } catch (error) {
    log.error("[trigger-anti-dup] не смог посчитать статистику", {
      cutoff,
      error: getErrorMessage(error),
    });
    return { inWindow: 0, windowSeconds: DEDUP_WINDOW_SECONDS, total: 0 };
  }
}
