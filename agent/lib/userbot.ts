/**
 * C30: MTProto userbot — passive observer + occasional actor.
 *
 * Listens to messages in allowed chats (including service messages), can react
 * with any emoji and delete any message via SET_REACTION/DELETE_MESSAGE
 * fallback path. T-410: can also send messages as the owner via sendMessage.
 *
 * Non-fatal: if session is missing or env not set, returns a no-op handle so
 * the orchestrator keeps running with just the Bot API.
 */
import { existsSync, readFileSync } from "node:fs";
import { decryptEncryptedSession } from "../tools/userbot-login.ts";
import { warnIfEmptyAllowlist } from "./allowlist.ts";
import { log } from "./log.ts";
// Листовой модуль без импортов — сознательно НЕ userbot-flood.ts: тот через
// rate-limits тянет lib/db.ts, который создаёт БД на уровне модуля.
import { isFloodWaitError, parseFloodWaitSeconds } from "./flood-wait-error.ts";
import {
  markSelfSend,
  unmarkSelfSend,
  normalizeChatId,
  markSelfAccount,
} from "./userbot-self-sends.ts";

export interface UserbotMessageEvent {
  chatId: string;
  messageId: number;
  fromUserId: string | null;
  fromName: string | null;
  text: string;
  isService: boolean;
  /**
   * Сообщение отправлено с ЭТОГО аккаунта: либо нами через `sendMessage`, либо
   * владельцем руками. Различает эти два случая только `consumeSelfSend`.
   */
  isOutgoing: boolean;
  raw: unknown;
  via: "userbot";
}

export interface UserbotHandle {
  setReaction(chatId: number | string, msgId: number, emoji: string): Promise<void>;
  deleteMessage(chatId: number | string, msgId: number): Promise<void>;
  /**
   * T-410: Send a message from the owner's real account via MTProto.
   * Returns the message_id assigned by Telegram (0 for the no-op handle).
   */
  sendMessage(
    chatId: number | string,
    text: string,
    opts?: {
      replyToMessageId?: number;
      /**
       * Роль, от имени которой уходит сообщение. Нужна не отправке, а эху:
       * `userbot-ingest.ts` пишет по ней строку в историю с правильной
       * атрибуцией (аудит 2026-08-28). Без неё эхо только глушится.
       */
      agentKey?: string | null;
    },
  ): Promise<{ message_id: number }>;
  /**
   * Создать broadcast-канал от имени владельца и сразу добавить указанных ботов
   * админами (право постинга). Возвращает chat_id в bot-API форме (-100…).
   */
  createTeamChannel(
    title: string,
    about: string,
    botUsernames: string[],
  ): Promise<{
    channelId: number;
    title: string;
    added: string[];
    failed: string[];
    /**
     * Telegram потребовал паузу посреди добавления админов. Канал при этом уже
     * создан, поэтому вызов не бросает — но вызывающий обязан взвести кулдаун
     * (noteFloodWait), иначе следующее действие юзербота ударит в тот же бан.
     */
    floodWaitSeconds?: number;
  }>;
  /**
   * Опубликовать пост в канал от имени аккаунта-владельца (MTProto). Markdown
   * рендерится в Telegram-entities, эмодзи из словаря DeLabs становятся
   * анимированными кастом-эмодзи (Premium). photo (если есть) идёт обложкой —
   * одно сообщение «картинка + подпись» (лимит подписи 1024).
   */
  publishPost(
    channelId: number | string,
    text: string,
    opts?: { photo?: Buffer; animateEmoji?: boolean },
  ): Promise<{ message_id: number }>;
  stop(): Promise<void>;
  isNoop: boolean;
}

export interface StartUserbotOpts {
  onMessage: (msg: UserbotMessageEvent) => void;
  allowedChatIds: Array<string | number>;
  /** Optional override for the session path. */
  sessionPath?: string;
  /** Optional override for the API id/hash (defaults to env). */
  apiId?: number;
  apiHash?: string;
  /** Optional override for the session passphrase. */
  passphrase?: string;
  /**
   * Test seam: inject a pre-built client factory. When provided, replaces the
   * real gramjs TelegramClient construction.
   */
  _clientFactory?: (sessionStr: string, apiId: number, apiHash: string) => Promise<UserbotClientLike>;
}

/** Internal — minimal client surface the module relies on, for testability. */
export interface UserbotClientLike {
  /**
   * У gramjs это `Promise<boolean>`: провал подключения приходит возвратом
   * `false`, а не исключением (см. `_startRealClient`). Фабрики из тестов
   * ничего не возвращают — отказом считается ровно `false`.
   */
  connect(): Promise<boolean | void>;
  disconnect(): Promise<void>;
  addEventHandler(handler: (event: any) => void | Promise<void>, ev: any): void;
  invoke(req: any): Promise<any>;
  deleteMessages(peer: any, ids: number[], opts: { revoke: boolean }): Promise<any>;
  getInputEntity(peer: any): Promise<any>;
  /** T-410: send a message as the owner account. */
  sendMessage(peer: any, params: { message: string; replyTo?: number }): Promise<any>;
  /** Высокоуровневая отправка файла (фото) с подписью и явными entities. */
  sendFile?(peer: any, params: any): Promise<any>;
  /**
   * Свой аккаунт. Необязателен: фабрики в тестах его не реализуют, а без него
   * поведение ровно прежнее (см. `registerSelfAccount`).
   */
  getMe?(): Promise<any>;
}

/**
 * Записать id собственного аккаунта в реестр `userbot-self-sends.ts`.
 *
 * Нужен ингесту, чтобы отличить входящую копию НАШЕЙ отправки (её видит
 * соседняя сессия роутера) от сообщения человека с тем же текстом. Подробности
 * — в шапке `markSelfAccount`.
 *
 * Никогда не роняет запуск: `getMe` — сетевой запрос, а без реестра всё
 * работает как до 2026-08-28. Зовём ДО `addEventHandler`, чтобы id уже лежал в
 * реестре к приходу первого апдейта.
 */
export async function registerSelfAccount(client: UserbotClientLike): Promise<void> {
  if (typeof client.getMe !== "function") return;
  try {
    const me = await client.getMe();
    const id = me?.id;
    if (id !== undefined && id !== null) markSelfAccount(String(id));
  } catch (e) {
    log.warn(`[userbot] getMe failed: ${(e as Error).message} — эхо-реестр аккаунтов пуст`);
  }
}

const NOOP_HANDLE: UserbotHandle = {
  async setReaction() {
    throw new Error("userbot not available");
  },
  async deleteMessage() {
    throw new Error("userbot not available");
  },
  async sendMessage() {
    return { message_id: 0 };
  },
  async createTeamChannel() {
    throw new Error("userbot not available");
  },
  async publishPost() {
    throw new Error("userbot not available");
  },
  async stop() {},
  isNoop: true,
};

/**
 * Запись из allowlist, которой соответствует пир апдейта, — или null.
 *
 * Аудит 2026-08-12: `makeHandler` писал в историю `msg.chatId` как есть, а
 * сверял по «ободранному» виду. Обе формы («9305555» и «-1009305555») штатно
 * проходили границу и уезжали в `messages` как РАЗНЫЕ чаты, хотя чат один.
 * Читатели истории знают только форму Bot API (`String(ctx.chat.id)`), так что
 * половина ингеста была невидима, а дедуп по (chat_id, tg_message_id) не
 * срабатывал. Канон берём из allowlist: владелец задал его в том же виде, что
 * читает Bot API-путь, — вычислить префикс из голого id невозможно (см. шапку
 * normalizeChatId про личку с совпадающим номером).
 *
 * Аудит 2026-08-09: последний fail-open allowlist в проекте.
 *
 * Было `if (!allowed.length) return true` — ровно тот паттерн, ради удаления
 * которого написан lib/allowlist.ts (T-603/SEC-5). Все остальные границы уже
 * переведены на fail-closed: auth-middleware, miniapp-server, message-handler,
 * voice-handler, orchestrator-bot. Эта осталась — и она опаснее прочих, потому
 * что userbot работает от ЛИЧНОГО аккаунта владельца: незаданный или криво
 * распарсенный TELEGRAM_ALLOWED_GROUP_IDS (лишняя кавычка → всё выпадает на
 * .filter(Boolean)) означал, что в общую память агентов утекает переписка из
 * всех чатов владельца, включая личные. Bot API-путь в той же ситуации молча
 * ничего не принимает; здесь было наоборот.
 *
 * Сравнение по-прежнему идёт по «ободранному» id: gramjs отдаёт peer то с
 * префиксом -100, то без, поэтому строгое равенство порвало бы ингест на проде,
 * проверить который отсюда нечем. Побочный эффект известен и оставлен
 * сознательно: allowlist супергруппы -1001234567890 формально пропустит и
 * личку с юзером 1234567890. Совпадение id разных типов пиров — случай
 * теоретический, а цена ошибки в другую сторону — молчащий прод.
 */
export function canonicalChatId(
  allowed: Array<string | number>,
  eventChatId: string,
): string | null {
  if (!allowed.length) return null;
  const norm = normalizeChatId(eventChatId);
  const hit = allowed.find((id) => normalizeChatId(id) === norm);
  return hit === undefined ? null : String(hit);
}

/**
 * Start the userbot. Always resolves — on any failure returns a no-op handle.
 */
export async function startUserbot(opts: StartUserbotOpts): Promise<UserbotHandle> {
  // Аудит 2026-08-28: `??` здесь выбран под undefined, а systemd для строки
  // `USERBOT_SESSION_PATH=` в EnvironmentFile отдаёт "". Пустая строка
  // проходила насквозь, `existsSync("")` давала false — и в журнале был
  // «no session at  — running no-op»: путь пропал, дефолт не проверялся.
  const sessionPath =
    opts.sessionPath?.trim() || process.env.USERBOT_SESSION_PATH?.trim() || "data/userbot.session";
  // Пробельный ключ (`USERBOT_SESSION_KEY= `) — это забытый ключ, а не
  // неверный: " " истинна, поэтому decryptSession выводила из пробела
  // AES-ключ и падала на теге, а оператор читал про сломанную сессию.
  // Сам ключ не обрезаем — это сменило бы производный ключ и обесценило
  // уже записанные сессии; пустым считаем только целиком пробельный.
  const passphraseRaw = opts.passphrase ?? process.env.USERBOT_SESSION_KEY;
  const passphrase = passphraseRaw?.trim() ? passphraseRaw : undefined;
  const apiIdRaw = opts.apiId ?? Number(process.env.TELEGRAM_API_ID);
  const apiHash = opts.apiHash ?? process.env.TELEGRAM_API_HASH;
  // Fail-closed ингест теперь молчит вместо того, чтобы тащить всё подряд —
  // но молчащий ингест ничем не отличается от «в чатах никто не пишет».
  // Один громкий warn на запуск, как у остальных границ.
  warnIfEmptyAllowlist("TELEGRAM_ALLOWED_GROUP_IDS (userbot ingest)", opts.allowedChatIds);

  if (!existsSync(sessionPath)) {
    log.warn(`[userbot] no session at ${sessionPath} — running no-op`);
    return NOOP_HANDLE;
  }
  if (!passphrase) {
    log.warn("[userbot] USERBOT_SESSION_KEY is required — running no-op");
    return NOOP_HANDLE;
  }
  if (!apiIdRaw || !Number.isFinite(Number(apiIdRaw)) || !apiHash) {
    log.warn("[userbot] TELEGRAM_API_ID / TELEGRAM_API_HASH missing — running no-op");
    return NOOP_HANDLE;
  }

  let sessionStr: string;
  try {
    const blob = readFileSync(sessionPath, "utf8").trim();
    // Аудит 2026-08-28: `v1:`/`v2:` — префиксы шифротекста
    // (tools/userbot-login.ts). Без ключа расшифровка просто пропускалась, и в
    // StringSession уезжал
    // литерал `v1:iv:tag:enc`; gramjs отвечал отказом подключения, а оператор
    // читал в логе про сеть и сессию. Причина же — одна забытая переменная, и
    // она известна до первого байта в сеть. Пустая строка сюда приходит
    // штатно: `USERBOT_SESSION_KEY=` в EnvironmentFile даёт "" , а не undefined.
    if (!blob.startsWith("v1:") && !blob.startsWith("v2:")) {
      log.warn(
        `[userbot] plaintext session at ${sessionPath} is not accepted — running no-op`,
      );
      return NOOP_HANDLE;
    }
    sessionStr = decryptEncryptedSession(blob, passphrase);
  } catch (e) {
    log.warn(`[userbot] failed to read/decrypt session: ${(e as Error).message} — running no-op`);
    return NOOP_HANDLE;
  }

  let client: UserbotClientLike;
  let Api: any;
  try {
    if (opts._clientFactory) {
      client = await opts._clientFactory(sessionStr, Number(apiIdRaw), apiHash);
      // Api still needed for SendReaction request; lazy-load.
      const tg = await import("telegram");
      Api = tg.Api;
    } else {
      const tg = await import("telegram");
      const { StringSession } = await import("telegram/sessions/index.js");
      Api = tg.Api;
      const session = new StringSession(sessionStr);
      const real = new tg.TelegramClient(session, Number(apiIdRaw), apiHash, {
        connectionRetries: 5,
      });
      // NewMessage подтягивает _startRealClient — он же решает, вешать ли
      // обработчик вообще.
      return await _startRealClient(real as unknown as UserbotClientLike, Api, opts);
    }
  } catch (e) {
    log.warn(`[userbot] start failed: ${(e as Error).message} — running no-op`);
    return NOOP_HANDLE;
  }

  // _clientFactory path: caller already provided a connected client.
  try {
    await client.connect();
  } catch {
    // ignore — factory may auto-connect
  }
  try {
    // For factory clients we still try to wire a handler; factories may stub.
    const { NewMessage } = await import("telegram/events/index.js");
    await registerSelfAccount(client);
    client.addEventHandler(makeHandler(opts), new NewMessage({}));
  } catch {
    // factories may not need this
  }
  return buildHandle(client, Api);
}

/** Экспортируется для тестов: границу ингеста надо проверять напрямую. */
export function makeHandler(opts: StartUserbotOpts) {
  return async (event: any) => {
    try {
      const msg = event?.message;
      if (!msg) return;
      const rawChatId = msg.chatId?.toString?.() ?? String(msg.chatId ?? "");
      if (!rawChatId) return;
      const chatId = canonicalChatId(opts.allowedChatIds, rawChatId);
      if (chatId === null) return;
      const isService = Boolean(msg.action) || msg.className === "MessageService";
      opts.onMessage({
        chatId,
        messageId: Number(msg.id ?? 0),
        fromUserId: msg.senderId ? String(msg.senderId) : null,
        fromName: msg.sender?.firstName ?? msg.sender?.username ?? null,
        text: typeof msg.message === "string" ? msg.message : "",
        isService,
        // `new NewMessage({})` — без `outgoing:false`, значит исходящие тоже
        // приезжают сюда. Кто именно их послал, решает граница ингеста.
        isOutgoing: Boolean(msg.out),
        raw: msg,
        via: "userbot",
      });
    } catch (e) {
      log.error("[userbot] onMessage handler error", { error: (e as Error)?.message });
    }
  };
}

/**
 * Достаёт message_id из ответа MTProto.
 *
 * Аудит 2026-08-07: текстовая публикация возвращала message_id 0 ВСЕГДА.
 * client.sendMessage/sendFile отдают готовый Message с `.id`, а
 * client.invoke(messages.SendMessage) — объект Updates, у которого `.id` нет
 * вовсе: настоящий id лежит в updates[] (UpdateMessageID.id либо
 * UpdateNewChannelMessage.message.id). `?? 0` это молча проглатывал, и в
 * agent_actions уезжал несуществующий id — то есть у агента не оставалось
 * ручки, чтобы потом закрепить или отредактировать собственный пост.
 */
export function extractMessageId(res: unknown): number {
  const r = res as any;
  if (!r) return 0;
  const direct = Number(r.id);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const updates: any[] = Array.isArray(r.updates) ? r.updates : [];
  for (const u of updates) {
    const own = Number(u?.id);
    if (Number.isFinite(own) && own > 0) return own;
    const nested = Number(u?.message?.id);
    if (Number.isFinite(nested) && nested > 0) return nested;
  }
  return 0;
}

/**
 * Подключение реального gramjs-клиента и обвязка вокруг него.
 *
 * Аудит 2026-08-28: здесь стояло `await real.connect();` — и результат
 * выбрасывался. У gramjs провал подключения это не исключение:
 * `MTProtoSender.connect` ловит каждую из пяти попыток внутри себя и
 * возвращает `this._finishedConnecting`, а `TelegramClient.connect` на
 * неудаче возвращает `false` (`TelegramClient.js:1088-1093`). Дальше всё шло
 * по счастливому пути: `registerSelfAccount` штатно глотает свой `getMe`,
 * обработчик вешался на мёртвого клиента, `buildHandle` отдавал хендл с
 * `isNoop: false`, а `startBackgroundServices` (orchestrator/services.ts)
 * печатал «[userbot] connected, listening». Команда получала живой на вид
 * юзербот, ломающийся на
 * первом же вызове, вместо честного no-op, у которого методы говорят «userbot
 * not available».
 *
 * Отказом считается ровно `false`: клиенты из `_clientFactory` ничего не
 * возвращают, и `!result` превратило бы их в no-op на ровном месте.
 *
 * `disconnect()` в ветке отказа обязателен, а не вежлив: gramjs успевает
 * запустить `_updateLoop` ДО того, как вернуть `false`
 * (`TelegramClient.js:1089-1092`), то есть брошенный клиент остаётся с живым
 * циклом переподключения. Его собственная ошибка при этом ничего не меняет —
 * хендл всё равно no-op.
 *
 * Ветку `_clientFactory` это не трогает: туда приходит уже подключённый
 * клиент, и её `connect()` там best-effort по построению (см. комментарий на
 * месте вызова).
 *
 * Экспортируется как шов: реальная ветка требует файла сессии и живого
 * `import("telegram")`, а проверять надо решение по результату connect.
 */
export async function _startRealClient(
  client: UserbotClientLike,
  Api: any,
  opts: StartUserbotOpts,
): Promise<UserbotHandle> {
  const connected = await client.connect();
  if (connected === false) {
    log.warn("[userbot] connect() вернул false (сеть/сессия) — running no-op");
    try {
      await client.disconnect();
    } catch (e) {
      log.warn(`[userbot] disconnect after failed connect: ${(e as Error).message}`);
    }
    return NOOP_HANDLE;
  }
  // Аудит 2026-08-28: дальше три вещи, каждая из которых может бросить —
  // импорт событий, `registerSelfAccount`, `addEventHandler`. Ошибку ловит
  // общий catch в `startUserbot` и отдаёт no-op, а подключённый клиент
  // оставался жить с `_updateLoop` — тем самым циклом, который выше гасим
  // явно, — и ссылки на него не оставалось ни у кого. Гасим и здесь; причину
  // наружу пробрасываем прежнюю, чтобы в логе остался тот же `start failed`.
  try {
    const { NewMessage } = await import("telegram/events/index.js");
    await registerSelfAccount(client);
    client.addEventHandler(makeHandler(opts), new NewMessage({}));
  } catch (e) {
    try {
      await client.disconnect();
    } catch (e2) {
      log.warn(`[userbot] disconnect after failed wiring: ${(e2 as Error).message}`);
    }
    throw e;
  }
  return buildHandle(client, Api);
}

/**
 * Экспортируется для тестов: `startUserbot` требует файл сессии и реальный
 * `import("telegram")`, а проверять надо поведение самих методов хендла.
 */
export function buildHandle(client: UserbotClientLike, Api: any): UserbotHandle {
  return {
    isNoop: false,
    async setReaction(chatId, msgId, emoji) {
      const peer = await client.getInputEntity(chatId as any);
      await client.invoke(
        new Api.messages.SendReaction({
          peer,
          msgId,
          reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
        }),
      );
    },
    async deleteMessage(chatId, msgId) {
      const peer = await client.getInputEntity(chatId as any);
      await client.deleteMessages(peer, [msgId], { revoke: true });
    },
    async sendMessage(chatId, text, opts) {
      // Аудит 2026-08-28: регистрировали СЫРОЙ текст, а Telegram сохранял
      // разобранный. `client.sendMessage` ниже не получает ни `parseMode`, ни
      // `formattingEntities`, а у gramjs это значит «применить парс-мод
      // клиента», и он задан безусловно в базовом конструкторе
      // (`telegramBaseClient.js`: `this._parseMode = MarkdownParser`). То есть
      // разметка снималась, эхо приезжало снятым, ключ реестра не совпадал —
      // и собственный ответ роли писался в историю как реплика владельца
      // (`userbot-ingest.ts`: `self === null` → `agentKey: null`,
      // `isBot: false`). Регистрируем то, что реально уедет.
      //
      // Соседний `publishPost` так и делал всегда: разбирает сам, регистрирует
      // `plain`, передаёт явные entities. Расходился только этот метод.
      let registered = text;
      try {
        const { MarkdownParser } = await import("telegram/extensions/markdown.js");
        [registered] = MarkdownParser.parse(text) as [string, unknown];
      } catch {
        // Разбор упал — gramjs упадёт на том же входе секундой позже. Режим
        // отказа не подменяем: регистрируем как есть и идём отправлять.
      }
      // ДО отправки: эхо этой отправки вернётся в makeHandler, и к тому
      // моменту регистрация уже должна лежать в реестре (userbot-self-sends).
      markSelfSend(chatId, registered, opts?.agentKey);
      try {
        const peer = await client.getInputEntity(chatId as any);
        const sent = await client.sendMessage(peer, {
          message: text,
          replyTo: opts?.replyToMessageId,
        });
        return { message_id: extractMessageId(sent) };
      } catch (e) {
        // Аудит 2026-08-27: отката не было, и после неудачной отправки
        // регистрация висела две минуты — съедая первое совпадающее сообщение
        // владельца, набранное руками. Эха не будет, снимаем.
        unmarkSelfSend(chatId, registered, opts?.agentKey);
        throw e;
      }
    },
    async createTeamChannel(title, about, botUsernames) {
      const res: any = await client.invoke(
        new Api.channels.CreateChannel({ title, about: about ?? "", broadcast: true }),
      );
      const chat = res.chats?.[0];
      if (!chat) throw new Error("createTeamChannel: канал не создан");
      // chat.id / accessHash — свежие gramjs-Integer из CreateChannel, используем
      // напрямую (без реконструкции из строк).
      const inputChannel = new Api.InputChannel({
        channelId: chat.id,
        accessHash: chat.accessHash,
      });
      const added: string[] = [];
      const failed: string[] = [];
      let floodWaitSeconds: number | undefined;
      for (const u of botUsernames) {
        // Аудит 2026-08-13: цикл складывал В ЛЮБУЮ ошибку в `failed` и шёл
        // дальше. На FLOOD_WAIT это означало, что после отказа сервера мы
        // делали ещё до 2×(N−1) запросов ВНУТРИ окна, которое он попросил
        // переждать, — и это аккаунт владельца, а не бот. Дальше приглашать
        // всё равно нечем: оставшиеся боты пойдут в `failed` с той же
        // ошибкой, только ценой бана. Останавливаемся на первом же.
        if (floodWaitSeconds !== undefined) {
          failed.push(u);
          continue;
        }
        try {
          const ent = await client.getInputEntity(u);
          await client.invoke(
            new Api.channels.EditAdmin({
              channel: inputChannel,
              userId: ent,
              adminRights: new Api.ChatAdminRights({
                postMessages: true,
                editMessages: true,
                deleteMessages: true,
                inviteUsers: true,
                changeInfo: true,
              }),
              rank: "agent",
            }),
          );
          added.push(u);
        } catch (e) {
          if (isFloodWaitError(e)) {
            // Секунды могут не приехать (gramjs бросает и без .seconds) —
            // тогда берём минимальную осмысленную паузу: важно взвести
            // кулдаун вообще, а не угадать его длину.
            floodWaitSeconds = parseFloodWaitSeconds(e) ?? 1;
            log.error("[userbot] FLOOD_WAIT при добавлении админов — цикл остановлен", {
              bot: u,
              seconds: floodWaitSeconds,
              added: added.length,
              remaining: botUsernames.length - added.length,
            });
          } else {
            log.warn("[userbot] add admin failed", { bot: u, error: (e as Error)?.message });
          }
          failed.push(u);
        }
      }
      const channelId = Number("-100" + chat.id.toString());
      return { channelId, title: chat.title ?? title, added, failed, floodWaitSeconds };
    },
    async publishPost(channelId, text, opts) {
      const peer = await client.getInputEntity(channelId as any);
      const { HTMLParser } = await import("telegram/extensions/html.js");
      const { mdToUserbotHtml } = await import("./telegram-format.ts");
      const { buildCustomEmojiEntities } = await import("./custom-emoji-map.ts");
      // mdToUserbotHtml, а не mdToTelegramHtml: у gramjs свой разбор HTML и
      // свой тег спойлера (аудит 2026-08-13, обоснование в telegram-format.ts).
      const [plain, fmtEntities] = HTMLParser.parse(mdToUserbotHtml(text));
      // Канал обычно не в allowedChatIds, но если владелец его туда добавит —
      // эхо публикации не должно приехать в историю как его собственная реплика.
      markSelfSend(channelId, plain);
      try {
        const entities =
          opts?.animateEmoji === false
            ? fmtEntities
            : [...fmtEntities, ...buildCustomEmojiEntities(plain, fmtEntities)];

        // Баннер — настоящим загруженным фото с подписью (как делает @delabsru).
        // У Premium-аккаунта лимит подписи 2048 (не 1024). Картинка сверху, текст
        // под ней — одно сообщение, и стороннее автопревью ссылки не появляется.
        if (opts?.photo && client.sendFile) {
          const { CustomFile } = await import("telegram/client/uploads.js");
          const file = new CustomFile("cover.png", opts.photo.length, "", opts.photo);
          const sent = await client.sendFile(peer, {
            file,
            caption: plain,
            formattingEntities: entities,
          });
          return { message_id: extractMessageId(sent) };
        }
        // Без фото — обычный текст, без автопревью ссылок.
        const sent = await client.invoke(
          new Api.messages.SendMessage({ peer, message: plain, entities, noWebpage: true }),
        );
        return { message_id: extractMessageId(sent) };
      } catch (e) {
        // См. sendMessage выше: публикация не состоялась — эха не будет.
        unmarkSelfSend(channelId, plain);
        throw e;
      }
    },
    async stop() {
      try {
        await client.disconnect();
      } catch (e) {
        log.error("[userbot] disconnect error", { error: (e as Error)?.message });
      }
    },
  };
}

/* ────── module-level singleton (for orchestrator + dispatch) ────── */

let _current: UserbotHandle | null = null;

export function setCurrentUserbot(h: UserbotHandle | null): void {
  _current = h;
}

export function getCurrentUserbot(): UserbotHandle | null {
  return _current;
}
