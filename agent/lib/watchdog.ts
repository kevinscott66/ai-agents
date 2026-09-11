/**
 * C7: watchdog для детекции «молчащих» ботов.
 *
 * Каждый бот должен периодически получать Telegram-апдейты. Отметку ставит
 * middleware на входе бота (`registerSeenProbe`) — на ЛЮБОЙ тип апдейта, а не
 * только на сообщения; в шапке значилось «[raw] апдейта», хотя такого хендлера
 * тут нет со времён аудита 2026-08-28.
 *
 * Если от бота не было ни одного апдейта дольше `silenceMs`, реакция зависит
 * от того, чья это тишина. Ключам из `chatAlertKeys` (по умолчанию один
 * `orchestrator`) уходит алёрт в чат; остальным — только debug-лог, потому что
 * у роль-ботов privacy mode ON и тишина для них норма. Шапка обещала чат-алёрт
 * «какому-то боту» без оговорок — то есть ровно то поведение, от которого
 * увели код, чтобы не спамить владельца 11 ложными тревогами в час.
 *
 * Чтобы не повторяться, после срабатывания — любого из двух — key суппрессится
 * на 1 час.
 */
import { getErrorMessage } from "./errors.ts";
import type { RunningBot } from "./types.ts";
import { HOUR_MS, MINUTE_MS } from "./time-constants.ts";
import { log } from "./log.ts";
import { safeTick } from "./safe-timer.ts";

const SUPPRESS_MS = HOUR_MS; // 1 час

const lastRawSeen = new Map<string, number>();

/** Обновляет timestamp последнего апдейта от агента. */
export function markSeen(agentKey: string, ts: number = Date.now()): void {
  lastRawSeen.set(agentKey, ts);
}

/**
 * Минимальная форма telegraf-бота, нужная пробе. Структурный тип вместо
 * импорта Telegraf: watchdog не должен тащить за собой telegram-слой, иначе
 * его нельзя проверить без токена.
 */
interface SeenProbeTarget {
  use(middleware: (ctx: unknown, next: () => Promise<void>) => Promise<void>): unknown;
}

/**
 * Вешает отметку «апдейт получен» на ВХОД бота, а не на отдельные хендлеры.
 *
 * Аудит 2026-08-28: шапка этого файла обещает «каждый бот должен периодически
 * получать Telegram-апдейты», но отметка стояла ровно в двух местах —
 * `bot.on("message")` и `bot.on("voice")`. Всё, что до них не доходит, для
 * watchdog'а не существовало. Главный такой путь — админ-команды: telegraf
 * отдаёт `/команду` обработчику `bot.command(...)` и дальше в `bot.on("message")`
 * апдейт НЕ пускает (это прямо описано в lib/admin-commands.ts).
 *
 * Совпадение адресов делало дефект точечным: админ-команды регистрируются
 * только на `orchestrator` (orchestrator-team.ts), и `orchestrator` —
 * единственный ключ в дефолтном `chatAlertKeys` ниже. Слепое пятно оказалось
 * ровно на том боте, который единственный умеет алертить в чат.
 *
 * Отказ: оператор 4+ часа работает через `/tasks`, `/approvals`, `/approve`,
 * `/autonomy`, `/audit` и не пишет ни одной обычной реплики. Бот отвечает на
 * каждую команду — а счётчик тишины не двигается, и в journalctl (а при
 * `WATCHDOG_TG_ALERTS=true` ещё и в каждый чат из allowlist) ежечасно уходит
 * «бот orchestrator молчит 245 мин, проверь токен/поллинг» про бота, который
 * прямо сейчас работает. Реплики 11 роль-ботов счётчик тоже не двигают:
 * Telegram не доставляет боту сообщения других ботов.
 *
 * Одна middleware накрывает все типы апдейтов — команды, `callback_query`,
 * отредактированные сообщения, `my_chat_member` — и приводит код в соответствие
 * с тем, что заявляет шапка. Фильтра allowlist тут нет намеренно: пробе важно
 * «поллинг жив», а не «чат разрешён».
 */
export function registerSeenProbe(bot: SeenProbeTarget, agentKey: string): void {
  bot.use((_ctx, next) => {
    markSeen(agentKey);
    return next();
  });
}

/**
 * Только для тестов: чистит `lastRawSeen`. Suppress-состояние отсюда
 * недостижимо — `suppressUntil` живёт внутри `startWatchdog`, у каждого
 * экземпляра своё, и сбрасывается вместе с ним. В доке значилось, что чистится
 * и оно: тест, рассчитывающий на это, молча получил бы не тот сброс.
 */
export function _resetWatchdogState(): void {
  lastRawSeen.clear();
}

export interface WatchdogDeps {
  bots: RunningBot[];
  /** Куда отправлять алерт (например, в orchestrator-чат). */
  alert: (msg: string) => Promise<void>;
  /** Период проверки. Default 5 минут. */
  intervalMs?: number;
  /**
   * Порог тишины. Default 4 часа (тут было написано «30 минут» — расхождение
   * с кодом). Порог высокий намеренно: роль-боты в группах живут с Telegram
   * privacy mode ON и получают апдейты только при @-упоминании, так что
   * получасовая тишина у них — норма, а не смерть поллинга.
   */
  silenceMs?: number;
  /**
   * Ключи ботов, для которых тишина → CHAT-алёрт. По умолчанию только
   * `orchestrator`: он privacy-off и ловит ВСЕ сообщения чата, поэтому его
   * тишина = реальная смерть поллинга. Роль-боты (smm/copy/design/perm/…) в
   * группах имеют Telegram privacy mode ON → получают апдейты только когда их
   * @-упоминают, поэтому их «тишина» — норма, а не сбой. Для них — только
   * debug-лог, без паники «проверь токен» в чат.
   */
  chatAlertKeys?: Set<string>;
  /** Только для тестов: оверрайд «текущего времени». */
  now?: () => number;
}

export function startWatchdog(deps: WatchdogDeps): { stop: () => void } {
  const {
    bots,
    alert,
    intervalMs = 5 * MINUTE_MS,
    silenceMs = 4 * HOUR_MS,
    chatAlertKeys = new Set(["orchestrator"]),
    now = () => Date.now(),
  } = deps;

  // Инициализируем «видели сейчас» для всех ботов, чтобы первый тик не
  // алертил всех подряд просто потому, что мы только что стартовали.
  for (const b of bots) {
    if (!lastRawSeen.has(b.def.key)) lastRawSeen.set(b.def.key, now());
  }

  const suppressUntil = new Map<string, number>();

  const tick = () => {
    const t = now();
    for (const b of bots) {
      const key = b.def.key;
      const last = lastRawSeen.get(key) ?? 0;
      const suppressed = (suppressUntil.get(key) ?? 0) > t;
      if (suppressed) continue;
      if (t - last > silenceMs) {
        const minutes = Math.round((t - last) / 60000);
        const threshold = Math.round(silenceMs / 60000);
        if (chatAlertKeys.has(key)) {
          // Реальный сигнал смерти поллинга (privacy-off бот ловит всё).
          const msg = `[watchdog] бот ${key} (@${b.username}) молчит ${minutes} мин (порог ${threshold}). Проверь токен/поллинг.`;
          log.warn(msg);
          alert(msg).catch((e) =>
            log.error("[watchdog] alert err", {
              error: getErrorMessage(e),
            }),
          );
        } else {
          // Роль-бот с privacy mode: тишина ожидаема — только debug, без чат-спама.
          log.debug(
            `[watchdog] role-бот ${key} (@${b.username}) тих ${minutes} мин (privacy mode — норма)`,
          );
        }
        suppressUntil.set(key, t + SUPPRESS_MS);
      }
    }
  };

  // `alert` приходит снаружи и типизирован как async, но синхронный throw до
  // возврата промиса `.catch` в чат-ветке `tick` (он ВЫШЕ, а не ниже, как тут
  // было написано) не поймает — исключение вылетит из колбэка целиком. Ловит
  // его `safeTick`: молчащий бот не повод ронять сервис.
  const timer = setInterval(safeTick("watchdog", tick), intervalMs);
  // Не держим event loop ради watchdog'а.
  if (typeof (timer as any).unref === "function") (timer as any).unref();

  return {
    stop: () => clearInterval(timer),
  };
}
