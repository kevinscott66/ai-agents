/**
 * Один брошенный хендлер не должен останавливать поллинг всех ботов.
 *
 * Аудит 2026-08-13. `bot.catch(...)` не был зарегистрирован НИ на одном из 12
 * инстансов. Дефолтный обработчик telegraf (`telegraf.js:84-91`) делает ровно
 * две вещи: ставит `process.exitCode = 1` и **перебрасывает** ошибку дальше.
 * Цепочка на проде:
 *
 *   throw в хендлере
 *     → reject в `Promise.all` внутри `Polling.loop`
 *     → reject самого `bot.launch()`
 *     → `launchWithRestart` ловит и перезапускает через 3 секунды
 *
 * Перезапуск сам по себе не беда — беда в том, что до этой правки он шёл с
 * `dropPendingUpdates: true`, то есть ВСЁ, что пользователи написали за время
 * простоя, Telegram выбрасывал молча. Одна `/audit 100` в чате — и полтора
 * десятка сообщений соседей исчезали без следа: ни ответа, ни ошибки.
 *
 * Входов, где хендлер может бросить мимо собственного try/catch, минимум три:
 *  - admin-команды (`lib/admin-commands.ts`) — своего catch не имели вовсе;
 *  - `handlerTimeout` (5 минут, см. orchestrator-team.ts) — таймаут срабатывает
 *    СНАРУЖИ хендлера, поэтому внутренний try/catch message-handler'а его не
 *    видит; и по той же причине хендлер после таймаута НЕ останавливается —
 *    отсюда отдельный текст ответа, см. GUARD_TIMEOUT_REPLY;
 *  - сам catch message-handler'а: он извиняется через `ctx.reply`, и если
 *    падает Telegram, то падает и извинение.
 *
 * Поэтому глушим здесь: логируем и НЕ пробрасываем. Ответ пользователю —
 * best-effort и только в разрешённых чатах: обещание «бот не разговаривает вне
 * allowlist» важнее, чем сообщить об ошибке тому, кто затащил бота к себе.
 */
import type { Telegraf, Context } from "telegraf";
import { isAllowlisted } from "./allowlist.ts";
import { getErrorMessage } from "./errors.ts";
import { log } from "./log.ts";

/** Текст извинения. Без деталей ошибки: они уходят в лог, а не в чат. */
export const GUARD_REPLY = "⚠️ Не смог обработать это сообщение. Ошибка записана в лог.";

/**
 * Текст для сработавшего `handlerTimeout`.
 *
 * Аудит 2026-08-20: на таймауте guard отвечал GUARD_REPLY — то есть «не смог»,
 * хотя хендлер в этот момент жив и работает дальше. `p-timeout` отменять
 * ничего не умеет: он reject'ит СНАРУЖИ, а `promise.cancel` у обычного промиса
 * нет (см. node_modules/p-timeout/index.js). Тяжёлый ход smm (web_search +
 * обложка + PUBLISH_TO_CHANNEL) переваливает HANDLER_TIMEOUT_MS, пользователь
 * читает «не смог» — и через полминуты получает пост в канале и настоящий
 * ответ бота. Два противоречащих сообщения, причём в историю чата (а значит и
 * в контекст модели) попадают оба.
 */
export const GUARD_TIMEOUT_REPLY =
  "⏳ Не успел за отведённое время. Часть работы могла всё же выполниться — проверь результат, прежде чем повторять.";

/** Таймаут телеграфа приходит как TimeoutError из p-timeout. */
export function isHandlerTimeout(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}

/**
 * Апдейты, по которым `handlerTimeout` уже отстрелялся.
 *
 * Аудит 2026-08-28: после таймаута хендлер продолжает работать (p-timeout
 * отменять не умеет — см. GUARD_TIMEOUT_REPLY), и если он потом ПАДАЕТ, об
 * этом не узнаёт никто. Разбор по p-timeout@4 (node_modules/p-timeout/index.js):
 *
 *   (async () => { try { resolve(await promise) } catch (e) { reject(e) } })()
 *
 * Внутренний промис отреван — значит `unhandledRejection` не будет; но
 * `reject(e)` зовётся у промиса, который таймер уже отклонил, то есть это
 * no-op. Телеграф свой `catch` отработал минуту назад и второй раз не придёт.
 * Ошибка исчезает целиком: ни `[bot-catch]`, ни UNCAUGHT, ни строчки в логе.
 *
 * Пять минут HANDLER_TIMEOUT_MS перебирает тяжёлый ход smm (web_search +
 * обложка + публикация) — то есть ровно тот, где падение дороже всего и где
 * пользователю уже сказано «часть работы могла выполниться, проверь». Проверять
 * при этом нечего: следов нет.
 *
 * WeakSet, а не поле в ctx.state: телеграф создаёт ctx на апдейт и больше на
 * него не ссылается, так что запись уходит вместе с апдейтом сама.
 */
const TIMED_OUT_UPDATES = new WeakSet<object>();

/**
 * Потолок ожидания извинения в чат.
 *
 * Аудит 2026-08-29: `await ctx.reply(...)` стоял без всякого потолка. Телеграф
 * зовёт `handleError` изнутри `await Promise.all(updates.map(handleUpdate))`
 * своего `Polling.loop` (telegraf.js:236) — то есть цикл поллинга ЭТОГО бота
 * стоит ровно столько, сколько стоит наш `reply`. У `fetch` в bun дефолтного
 * таймаута нет, а телеграф свой `signal` принимает только в конструкторе
 * клиента, не на вызов. Соединение, ушедшее в чёрную дыру (сеть встала, а FIN
 * не пришёл), вешает бота НАВСЕГДА: `launchWithRestart` перезапускает по
 * отказу `launch()`, а тут отказа нет — есть висящий await. Молча: ни лога,
 * ни алерта, бот просто перестаёт отвечать.
 *
 * Отменить сам запрос отсюда нечем, поэтому гонка с таймером: перестаём ЖДАТЬ,
 * и управление возвращается телеграфу. Само извинение доедет или не доедет —
 * это уже не наша забота, оно необязательное.
 */
export const GUARD_REPLY_TIMEOUT_MS = 10_000;

/**
 * `p` с потолком ожидания. Отказ, приехавший после проигранной гонки, ловить
 * будет некому — вешаем `catch` сразу, иначе это unhandledRejection процесса.
 */
async function withDeadline(p: Promise<unknown>, ms: number): Promise<void> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Telegram не ответил за ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Middleware, которая ловит падение хендлера, наступившее уже после таймаута.
 *
 * Всё, что случилось ДО таймаута, пробрасывается дальше без изменений — его
 * поймает `bot.catch` ровно как раньше, вместе с извинением пользователю.
 * Поздние падения не пробрасываем: наверху их уже некому поймать (промис
 * отклонён таймером), а второе сообщение в чат после GUARD_TIMEOUT_REPLY
 * противоречило бы первому. Пишем в лог и на этом всё.
 *
 * Гонка возможна: если хендлер падает ровно в момент таймаута и метка ещё не
 * поставлена, мы пробросим — и поведение будет прежним, то есть молчаливым.
 * Это не хуже, чем было, и лечится только отменяемым хендлером.
 */
export function buildLateErrorCatcher(
  agentKey: string,
): (ctx: Context, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    try {
      await next();
    } catch (e) {
      if (!ctx || !TIMED_OUT_UPDATES.has(ctx)) throw e;
      log.error(`[bot-catch][${agentKey}] хендлер бросил уже после таймаута`, {
        error: getErrorMessage(e),
        updateId: (ctx as any)?.update?.update_id,
        chatId: ctx?.chat?.id,
        afterTimeout: true,
      });
    }
  };
}

/**
 * Строит обработчик для `bot.catch`. Вынесен отдельно от регистрации, чтобы
 * тест мог позвать его напрямую с фейковым ctx.
 */
export function buildErrorGuard(
  agentKey: string,
  allowed: readonly string[],
  // Потолок вынесен параметром ради теста: держать в гейте настоящие десять
  // секунд нельзя, а проверять надо именно то, что ожидание конечно.
  replyTimeoutMs: number = GUARD_REPLY_TIMEOUT_MS,
): (err: unknown, ctx: Context) => Promise<void> {
  return async (err, ctx) => {
    // update_id полезнее текста: по нему видно, один апдейт зациклился или
    // сыплется поток разных.
    const timedOut = isHandlerTimeout(err);
    // Метку ставим до всего остального: хендлер в этот момент уже работает
    // дальше и упасть может раньше, чем мы допишем лог и извинение.
    if (timedOut && ctx) TIMED_OUT_UPDATES.add(ctx);
    log.error(`[bot-catch][${agentKey}] хендлер бросил`, {
      error: getErrorMessage(err),
      updateId: (ctx as any)?.update?.update_id,
      chatId: ctx?.chat?.id,
      // Таймаут — не то же, что падение: хендлер жив и доведёт побочный
      // эффект до конца. По логу это должно быть видно сразу.
      ...(timedOut ? { timedOut: true } : {}),
    });
    const chatIdStr = String(ctx?.chat?.id ?? "");
    if (!chatIdStr || !isAllowlisted(chatIdStr, allowed)) return;
    try {
      await withDeadline(
        ctx.reply(timedOut ? GUARD_TIMEOUT_REPLY : GUARD_REPLY),
        replyTimeoutMs,
      );
    } catch (e) {
      // Сбой мог быть и в самом Telegram — тогда извиниться не выйдет. Здесь
      // бросать нельзя тем более: телеграф зовёт нас уже из своего catch, и
      // исключение отсюда уедет ровно туда, откуда мы его убирали.
      log.warn(`[bot-catch][${agentKey}] не смог сообщить об ошибке`, {
        error: getErrorMessage(e),
      });
    }
  };
}

export function registerErrorGuard(
  bot: Telegraf,
  agentKey: string,
  allowed: readonly string[],
): void {
  bot.catch(buildErrorGuard(agentKey, allowed));
  // Строго до регистрации хендлеров: middleware ловит только то, что стоит
  // ниже по цепочке. Здесь же, чтобы два куска одной защиты не разъезжались.
  bot.use(buildLateErrorCatcher(agentKey));
}
