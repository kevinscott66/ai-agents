/**
 * Граница MTProto-ингеста: во что превращается увиденное userbot'ом сообщение.
 *
 * Общая точка для обоих путей — синглтонного userbot'а и per-character сессий
 * роутера (см. `orchestrator/services.ts`). Вынесено из services.ts сюда,
 * потому что решение «что считать сообщением пользователя» — это правило, а не
 * деталь запуска процесса, и его надо уметь проверить тестом.
 */
import { log, redactText, redactSender } from "./log.ts";
import { recordMessage } from "./memory.ts";
import {
  consumeSelfSendMeta,
  isSelfAccount,
  normalizeChatId,
} from "./userbot-self-sends.ts";

export interface UserbotIngestMessage {
  chatId: string;
  messageId: number;
  fromUserId: string | null;
  fromName: string | null;
  text: string;
  isService: boolean;
  /** Отправлено с аккаунта владельца (нами или им самим). См. ниже. */
  isOutgoing?: boolean;
}

/** Сколько помним id, уже опознанные своими. Эхо приходит за секунды. */
const DROPPED_TTL_MS = 120_000;
/** Потолок реестра опознанных id — на случай молчащих сессий. */
const MAX_DROPPED = 500;

export interface UserbotRecorderOpts {
  /**
   * Telegram-id наших собственных ботов (RunningBot.id). Userbot работает от
   * аккаунта владельца и видит в группе всё, включая ответы нашей же команды.
   */
  ownBotIds: Iterable<string | number>;
  /** Подменяемая запись в память — для тестов. */
  record?: typeof recordMessage;
}

/**
 * Возвращает рекордер входящих MTProto-сообщений.
 *
 * Аудит 2026-08-12: своих ботов эта граница не отличала от людей — любое
 * сообщение писалось с `isBot: false, agentKey: null`. Пока Bot API успевал
 * записать тот же tg_message_id первым, дедуп это прятал; прятал ровно одно
 * сообщение из N, потому что длинный ответ уходит частями, а `sendChunked`
 * возвращает только ПОСЛЕДНЮЮ. Замер на ответе в три части: в истории три
 * строки, две из них — слова бота design от «пользователя» design_bot, и они
 * же уезжают в промпт следующего хода как чужая реплика.
 *
 * Свои сообщения не записываем вовсе: Bot API-путь уже кладёт весь ответ одной
 * строкой с правильным agent_key. Список id — единственный надёжный признак:
 * по имени или по флагу в апдейте своего бота от чужого не отличить.
 *
 * Аудит 2026-08-20: та же дыра с другой стороны — отправки самого userbot'а.
 * Они уходят от ЛИЧНОГО аккаунта владельца, которого в `ownBotIds` нет, и
 * возвращались сюда эхом как реплики владельца (`isBot:false, agentKey:null`),
 * по строке на каждый кусок `sendChunked`. В промпт следующего хода они
 * приезжают как указания от владельца. Дропать всё исходящее нельзя: набранные
 * руками сообщения владельца в группе идут ровно этим же путём и другого
 * источника у них нет (роль-боты в privacy mode). Отличаем по реестру
 * собственных отправок — `userbot-self-sends.ts`.
 */
export function makeUserbotRecorder(
  opts: UserbotRecorderOpts,
): (m: UserbotIngestMessage) => void {
  const own = new Set(Array.from(opts.ownBotIds, (id) => String(id)));
  const record = opts.record ?? recordMessage;
  // Аудит 2026-08-28: одно и то же сообщение приезжает сюда СТОЛЬКО раз,
  // сколько наших MTProto-сессий сидит в чате — рекордер у синглтона и у
  // per-character сессий роутера один (orchestrator/services.ts). Регистрация
  // в `userbot-self-sends.ts` при этом одна: её тратит первая пришедшая копия,
  // а остальные записываются как реплики человека. Обычный дедуп
  // `recordMessage` по (chat_id, tg_message_id) тут не спасает — строки-то нет,
  // мы её сознательно не пишем. Поэтому помним, какие id уже опознаны своими,
  // и глушим по id независимо от направления и от сессии.
  const dropped = new Map<string, number>();

  function forget(now: number): void {
    for (const [k, exp] of dropped) if (exp <= now) dropped.delete(k);
    // Потолок на случай, если чистка по TTL не поспевает за потоком.
    while (dropped.size > MAX_DROPPED) {
      const oldest = dropped.keys().next();
      if (oldest.done) break;
      dropped.delete(oldest.value);
    }
  }

  function dropKey(m: UserbotIngestMessage): string {
    return `${normalizeChatId(m.chatId)}\n${m.messageId}`;
  }

  function markDropped(m: UserbotIngestMessage): void {
    const now = Date.now();
    dropped.set(dropKey(m), now + DROPPED_TTL_MS);
    forget(now);
  }

  return (m: UserbotIngestMessage): void => {
    try {
      forget(Date.now());
      if (dropped.has(dropKey(m))) {
        log.info(
          `[userbot-echo] chat=${m.chatId} id=${m.messageId} — уже опознано своим в другой сессии, пропуск`,
        );
        return;
      }
      if (m.fromUserId && own.has(String(m.fromUserId))) {
        // Факт прихода апдейта видеть надо, содержимое — нет: это наш же ответ,
        // он уже записан Bot API-путём.
        log.info(`[userbot-echo] chat=${m.chatId} id=${m.messageId} — своё сообщение, пропуск`);
        markDropped(m);
        return;
      }
      // `isOutgoing` верен только для сессии-отправителя; для соседней сессии
      // та же отправка — обычное входящее от чужого аккаунта. Третий признак —
      // реестр наших собственных MTProto-аккаунтов. Текстовую проверку он НЕ
      // заменяет: владелец пишет в те же группы руками с того же аккаунта.
      const self =
        m.isOutgoing || isSelfAccount(m.fromUserId)
          ? consumeSelfSendMeta(m.chatId, m.text)
          : null;
      if (self) {
        // Аудит 2026-08-28: здесь стоял безусловный дроп, и это была потеря, а
        // не дедупликация. Соседний путь по Bot API пишет ответ агента сам
        // (message-handler.ts), а у MTProto-отправки второго писателя нет:
        // dispatch/telegram.ts зовёт только `ub.sendMessage`. То есть всё, что
        // роль сказала от лица владельца, исчезало из `messages` — и не
        // приезжало в промпт следующего хода. Агент спрашивает «сносим прод?»,
        // человек отвечает «да», а вопроса в истории нет.
        //
        // Пишем с атрибуцией отправителя, а не как реплику владельца: иначе
        // вернётся ровно дыра 2026-08-20 (свои слова как указания человека).
        // Без известной роли (публикация в канал) — прежний дроп.
        markDropped(m);
        if (!self.agentKey) {
          log.info(
            `[userbot-echo] chat=${m.chatId} id=${m.messageId} — эхо своей отправки, пропуск`,
          );
          return;
        }
        log.info(
          `[userbot-echo] chat=${m.chatId} id=${m.messageId} — эхо своей отправки, пишем как ${self.agentKey}`,
        );
        record({
          chatId: m.chatId,
          agentKey: self.agentKey,
          isBot: true,
          fromUserId: m.fromUserId ?? "0",
          fromName: m.fromName,
          text: m.text,
          tgMessageId: m.messageId,
          transport: "userbot",
        });
        return;
      }
      const tag = m.isService ? "[userbot-service]" : "[userbot-msg]";
      // Аудит 2026-08-12: строка писала настоящее имя отправителя и первые
      // 80 символов КАЖДОГО сообщения на уровне info, то есть в проде — прямо
      // в journalctl. Авто-скраб в lib/log.ts снимает токены и ключи, но не
      // имена и не текст. Хуже соседнего пути по Bot API, который в тот же
      // день отредактировали (message-handler.ts): у сессии MTProto нет
      // privacy mode, она видит все сообщения чата, а не только обращения.
      // Строка нужна — она отвечает на «дошёл ли апдейт»; нужен факт, а не
      // содержимое.
      // Аудит 2026-08-27: `redactUserId(m.fromUserId ?? m.fromName)` — примитив
      // не для этого. Он спроектирован под числовой id: до 4 символов отдаёт
      // значение ЦЕЛИКОМ, дальше — последние 4. На имени это не редакция, а
      // публикация: `redactUserId("Аня")` даёт `uid:Аня` в journalctl на уровне
      // info. Ветка `?? fromName` живая — у постов канала и анонимных админов
      // senderId пуст, а username есть. Для произвольного текста в этом же
      // модуле есть `redactText`, им и режем.
      log.info(
        `${tag} chat=${m.chatId} id=${m.messageId} from=${redactSender(m.fromUserId, m.fromName)} text=${redactText(m.text)}`,
      );
      record({
        chatId: m.chatId,
        agentKey: null,
        isBot: false,
        fromUserId: m.fromUserId ?? "0",
        fromName: m.fromName,
        text: m.isService ? `[service] ${m.text || "<no-text>"}` : m.text,
        tgMessageId: m.messageId,
        transport: "userbot",
      });
    } catch (e) {
      log.error("[userbot] onMessage record error", { error: String(e) });
    }
  };
}
