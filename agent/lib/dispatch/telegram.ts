/**
 * Telegram handlers for message actions.
 * Extracted from action-dispatch.ts for T-112 modularization.
 */
import type { Telegram } from "telegraf";
import {
  ALLOWED_REACTIONS,
  isAllowedReaction,
  normalizeReaction,
  tgSendMessage,
  tgSetReaction,
  tgEditMessage,
  tgPinMessage,
  tgDeleteMessage,
  tgForwardMessage,
  tgCreatePoll,
  tgSendPhoto,
  tgSendDocument,
} from "../telegram-actions.ts";
import { getCurrentUserbot, type UserbotHandle } from "../userbot.ts";
import { getUserbotHandle } from "../userbot-router.ts";
import type { PayloadByType } from "../action-payload.ts";
// resolveChatId здесь больше не используется намеренно: любое исходящее
// действие Bot API пиннится к чату-источнику. Аудит 2026-08-02 показал, что
// пиннинг был асимметричным — SEND_MESSAGE/SEND_PHOTO/SEND_DOCUMENT/
// FORWARD_MESSAGE закрыли раньше, а SET_REACTION/EDIT_MESSAGE/PIN_MESSAGE/
// DELETE_MESSAGE/CREATE_POLL продолжали брать chatId из payload. Канал утечки
// оставался открытым: CREATE_POLL несёт свободный текст в question/options,
// EDIT_MESSAGE — в text, то есть промпт-инъекция могла вынести содержимое
// приватного чата в чужой. DELETE_MESSAGE был асимметричен даже внутри себя:
// userbot-ветка пиннилась, а Bot API-ветка — нет.
import { pinnedChatId, type HandlerResult } from "./helpers.ts";
import {
  sendChunked,
  splitForTelegram,
  PartialSendError,
  HTML_MESSAGE_FITS,
} from "../telegram-chunking.ts";
import { reserveUserbotFloodSlots } from "../rate-limits.ts";
// Аудит 2026-08-07: гвард существовал с T-402, но не импортировался нигде,
// кроме собственного теста — юзербот ходил в Telegram без лимита и бэкоффа.
import { guardedUserbotCall } from "../userbot-flood.ts";

export type TelegramHandlerContext = {
  telegram?: Telegram;
  agentKey: string;
  chatId: number;
  userbot?: UserbotHandle | null;
};

export type TelegramHandlerResult = HandlerResult;

/**
 * T-541: Get userbot handle with optional router support.
 * When USERBOT_ROUTER_ENABLED=true, attempts to use agent-specific session first.
 */
async function resolveUserbotHandle(ctx: TelegramHandlerContext): Promise<UserbotHandle | null> {
  // Test seam override
  if (ctx.userbot !== undefined) {
    return ctx.userbot;
  }
  // T-541: Try router first, fallback to global.
  //
  // Аудит 2026-08-28: откат делался ДВАЖДЫ — `getUserbotHandle` уже отдаёт
  // синглтон агенту без объявленной сессии, а строка ниже повторяла это для
  // агента, чья ОБЪЯВЛЕННАЯ сессия не поднялась. Второй случай — подмена
  // личности: действие уходило с личного аккаунта владельца под видом
  // «userbot». Решение об откате принимается ровно в одном месте, здесь его
  // результат берётся как есть.
  const routerEnabled = process.env.USERBOT_ROUTER_ENABLED === "true";
  if (routerEnabled) {
    const uh = await getUserbotHandle(ctx.agentKey);
    return uh && !uh.isNoop ? uh : null;
  }
  // Fallback: global userbot handle.
  return getCurrentUserbot();
}

/**
 * Аудит 2026-08-06: длина не ограничивалась НИГДЕ на этом пути — ни в
 * build-payload, ни здесь, ни в tgSendMessage. Ответ агента длиннее 4096
 * детерминированно падал с 400 «message is too long», то есть терялся целиком.
 *
 * Режем не по лимиту, а бьём на части: у публикации в канал пост обязан быть
 * одним сообщением, а здесь это разговор, и вывод у технического ответа стоит
 * в конце — молчаливая обрезка съела бы именно его. splitForTelegram рвёт по
 * абзацам, sendWithHtml при битой разметке откатывается на plain text, так что
 * разрез в худшем случае стоит форматирования, а не сообщения.
 */
export async function handleSendMessage(
  payload: PayloadByType["SEND_MESSAGE"],
  ctx: TelegramHandlerContext
): Promise<TelegramHandlerResult> {
  // 2026-08-02: раньше здесь был resolveChatId, то есть payload.chatId от
  // модели уходил в sendMessage как есть. Это та же дыра exfil, что S4 закрыл
  // для SEND_PHOTO/SEND_DOCUMENT и SEC-4 для via_userbot ниже: те же 12 ботов
  // состоят в нескольких командных чатах, и prompt-injection в чате A даёт
  // «перескажи контекст в чат B». Гейт прав считается по ctx.chatId и адресат
  // в решение не входит. Пиним, попытка уезжает в warn.
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "SEND_MESSAGE");

  // T-410: via_userbot path — owner-voice messaging from real account.
  if (payload.via_userbot === true) {
    // Orchestrator-only enforcement. The gate cannot inspect payload flags,
    // so we enforce the caller restriction here in the handler.
    if (ctx.agentKey !== "orchestrator") {
      return {
        ok: false,
        error: `forbidden: SEND_MESSAGE via_userbot is restricted to orchestrator (caller: ${ctx.agentKey})`,
      };
    }
    const ub = await resolveUserbotHandle(ctx);
    if (!ub || ub.isNoop) {
      return { ok: false, error: "userbot not available" };
    }
    // SEC-4 / T-602: owner-voice sends are pinned to the ORIGINATING chat —
    // never an attacker-supplied payload.chatId — so a prompt-injected
    // orchestrator can't post as the owner into an arbitrary chat.
    let ubFirst = true;
    // Гвард на КАЖДУЮ часть, а не на sendChunked целиком: длинный ответ — это
    // N отправок в аккаунт владельца, и Telegram считает их по отдельности.
    //
    // Аудит 2026-08-20: из-за этого же ведро могло кончиться НА СЕРЕДИНЕ. При
    // 20/60s ответ на семь частей после трёх предыдущих сообщений уходил до
    // части (18/20), а дальше guardedUserbotCall отказывал — в чате оставалось
    // оборванное сообщение от лица владельца, и дописать его нельзя: повтор
    // дублирует уже доставленное (см. partialSendFailure). Считаем части
    // заранее и, если ёмкости на все не хватает, отказываемся ЦЕЛИКОМ — до
    // первой отправки. Разбиение здесь и внутри sendChunked детерминировано и
    // идёт из одной функции, так что счёт совпадает.
    //
    // Вторая итерация того же аудита: ёмкость мало ПОСМОТРЕТЬ, её надо ЗАНЯТЬ.
    // `userbotFloodCapacity` намеренно ничего не занимал, а коммит идёт только
    // после успешной отправки — между ними лежит сетевой round-trip, и соседний
    // ход (telegraf разбирает пачку апдейтов через Promise.all) успевал
    // прочитать ту же свободную ёмкость и пройти гейт вторым. Дальше части шли
    // вперемешку и ведро всё равно кончалось на середине. Резерв делает
    // проверку и занятие одной синхронной операцией; части идут со
    // skipBucket, чтобы не расходовать ведро дважды.
    const partCount = splitForTelegram(payload.text).length;
    const slots = reserveUserbotFloodSlots(ctx.agentKey, ctx.chatId, partCount);
    if (!slots.ok) {
      // Аудит 2026-08-27: срок повтора всегда печатался как есть, а при
      // `partCount > max` он равен нулю — отказ звал повторить «через ~0s»,
      // и повтор давал ровно то же самое. Случай «ждать бесполезно» надо
      // называть словами, иначе это приглашение крутить цикл.
      const tail = slots.impossible
        ? `а всё ведро — ${slots.max} за окно. Ожидание не поможет: сократи ответ.`
        : `а лимит пропустит ещё ${slots.free} из ${slots.max} ` +
          `(повтор через ~${Math.ceil(slots.retryInMs / 1000)}s).`;
      return {
        ok: false,
        error:
          `userbot rate limit: ответ занимает ${partCount} сообщений, ` +
          `${tail} Не отправлено ничего.`,
      };
    }
    let last: any;
    // Считаем ПОПЫТКИ, а не успехи.
    //
    // Аудит 2026-09-11: счётчик увеличивался после возврата
    // `guardedUserbotCall`, и `release(partCount - sentParts)` в finally
    // возвращал в ведро слот той части, ради которой мы к аккаунту владельца
    // уже постучались (при `skipBucket` первую попытку каждой части оплачивает
    // именно резерв). Таймаут и RPC-ошибка приходят и тогда, когда запрос до
    // Telegram дошёл, — ровно тот случай, из-за которого коммит слота в
    // `userbot-flood.ts` переехал ДО обращения к серверу: «ведро считает
    // обращения к аккаунту, а не успехи». Возвращаем только те части, к
    // которым не притрагивались.
    let attemptedParts = 0;
    try {
      last = await sendChunked(async (text) => {
        attemptedParts++;
        const r = await guardedUserbotCall(
          ctx.agentKey,
          ctx.chatId,
          () =>
            ub.sendMessage(ctx.chatId, text, {
              replyToMessageId: ubFirst ? payload.replyToMessageId : undefined,
              // Атрибуция для эха: без неё отправка роли не попадала в историю
              // чата вовсе — см. userbot-self-sends.ts, аудит 2026-08-28.
              agentKey: ctx.agentKey,
            }),
          { skipBucket: true },
        );
        ubFirst = false;
        return r;
      }, payload.text);
    } catch (e) {
      return partialSendFailure(e);
    } finally {
      // Нетронутое возвращаем в ведро: заняли под план, платим по попыткам.
      slots.release(partCount - attemptedParts);
    }
    return {
      ok: true,
      result: { via: "userbot", message_id: last.message_id },
    };
  }

  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  const tg = ctx.telegram;
  let first = true;
  let result: any;
  try {
    result = await sendChunked(async (text) => {
      const r = await tgSendMessage(tg, {
        chatId,
        text,
        // Reply-to вешаем только на первую часть: остальные — продолжение,
        // и цитата в каждой из них засоряет тред.
        replyToMessageId: first ? payload.replyToMessageId : undefined,
      });
      first = false;
      return r;
    }, payload.text, undefined, HTML_MESSAGE_FITS);
  } catch (e) {
    return partialSendFailure(e);
  }
  return { ok: true, result };
}

/**
 * Отказ на середине многочастной отправки — в результат, а не в общий catch.
 *
 * Аудит 2026-08-13: исключение со второй части уходило наверх как обычная
 * ошибка, и действие репортилось провалившимся целиком — хотя часть (1/3) уже
 * висела в чате. Модель по такому результату повторяет отправку, а Telegram
 * транзакций не знает: доставленные части дублируются. У длинного ответа от
 * лица владельца это особенно вероятно — на каждую часть свой FLOOD_WAIT-гвард.
 *
 * Не компенсируем удалением: снести уже отправленное от аккаунта владельца —
 * действие необратимое и не наше (соседний DELETE_MESSAGE такой неявной двери
 * лишили аудитом 2026-08-11). Поэтому только называем состояние словами, и
 * прямо запрещаем слепой повтор — остаток дописывает человек.
 *
 * Первая часть сюда не попадает: если не ушло ничего, `sendChunked` бросает
 * исходное исключение, и разбор ошибок у вызывающих не меняется. Отсюда же и
 * `throw e` ниже: всё, что не частичная доставка, обязано лететь дальше нетронутым.
 *
 * Разбираем именно тип исключения, а не форму результата: `tgSendMessage`
 * возвращает `{ok: true, messageId}`, то есть проверка «есть ли поле ok»
 * поймала бы и успешную отправку.
 */
function partialSendFailure(e: unknown): TelegramHandlerResult {
  if (!(e instanceof PartialSendError)) throw e;
  return {
    ok: false,
    // Аудит 2026-08-21: доставленные части — это состоявшийся побочный эффект,
    // и платить за него слотом rate-limit надо так же, как за успех. Без метки
    // gateOrDispatch рефандил слот на каждом таком ходе, то есть длинные
    // ответы, рвущиеся под флуд-гвардом, не считались лимитом вообще.
    sideEffect: true,
    error:
      `${e.message}. Части 1..${e.partsSent} уже доставлены — повтор их ` +
      `продублирует. Дошли остаток отдельным сообщением или сообщи человеку.`,
  };
}

export async function handleSetReaction(
  payload: PayloadByType["SET_REACTION"],
  ctx: TelegramHandlerContext
): Promise<TelegramHandlerResult> {
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "SET_REACTION");
  // Аудит 2026-08-28: резолв стоял здесь, безусловно. А `resolveUserbotHandle`
  // — не геттер: у роутера это `getAgentHandle` → `startSession` →
  // `startUserbot`, то есть живой gramjs-коннект, поднимаемый лениво при первом
  // обращении. Нужен он ровно в трёх ветках ниже, и все три — только для
  // оркестратора; основной путь (реакция ботом на whitelist-эмодзи) платил за
  // соединение, которым не пользовался, и оставлял его жить.
  //
  // Мемоизируем, а не зовём трижды: ветки взаимоисключающие сейчас, но
  // повторный резолв не должен становиться вопросом порядка строк. Соседний
  // `handleDeleteMessage` резолвит внутри ветки с самого начала — приводим к
  // тому же правилу.
  let ubPromise: Promise<UserbotHandle | null> | undefined;
  const resolveUb = () => (ubPromise ??= resolveUserbotHandle(ctx));
  const wantUserbot = payload.via_userbot === true;
  // Explicit via_userbot: route directly through MTProto (any emoji).
  if (wantUserbot) {
    // SEC-4 (re-audit): owner-account reactions are orchestrator-only and pinned
    // to the originating chat (never an attacker-supplied payload.chatId).
    if (ctx.agentKey !== "orchestrator") {
      return {
        ok: false,
        error: `forbidden: SET_REACTION via_userbot is restricted to orchestrator (caller: ${ctx.agentKey})`,
      };
    }
    const ub = await resolveUb();
    if (!ub || ub.isNoop) {
      return { ok: false, error: "userbot not available" };
    }
    await guardedUserbotCall(ctx.agentKey, ctx.chatId, () =>
      ub.setReaction(ctx.chatId, payload.messageId, payload.emoji),
    );
    return { ok: true, result: { via: "userbot" } };
  }
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  if (!isAllowedReaction(payload.emoji)) {
    // Bot API path: enforce whitelist. SEC-4 (re-audit): the userbot fallback
    // for a non-whitelisted emoji reacts from the OWNER's account — gate it to
    // the orchestrator and pin to ctx.chatId, so a non-orchestrator agent can't
    // react as the owner in an attacker-supplied chat.
    if (ctx.agentKey === "orchestrator") {
      const ub = await resolveUb();
      if (ub && !ub.isNoop) {
        try {
          await guardedUserbotCall(ctx.agentKey, ctx.chatId, () =>
            ub.setReaction(ctx.chatId, payload.messageId, payload.emoji),
          );
          return { ok: true, result: { via: "userbot" } };
        } catch (e) {
          return {
            ok: false,
            error: `userbot SET_REACTION failed: ${(e as Error).message}`,
          };
        }
      }
    }
    const preview = ALLOWED_REACTIONS.slice(0, 12).join("");
    return {
      ok: false,
      error: `REACTION_NOT_ALLOWED: ${payload.emoji}. Allowed: ${preview}...`,
    };
  }
  try {
    const result = await tgSetReaction(ctx.telegram, {
      chatId,
      messageId: payload.messageId,
      // Аудит 2026-08-20: в Telegram уходит каноническая форма из whitelist'а,
      // а не то, что прислала модель. «❤️» и «❤» — одна реакция, но Bot API
      // документирует базовую.
      emoji: normalizeReaction(payload.emoji) ?? payload.emoji,
    });
    return { ok: true, result };
  } catch (e) {
    // Bot API error — fall back to the userbot ONLY for the orchestrator (owner
    // account), pinned to ctx.chatId. SEC-4 (re-audit): no silent owner-account
    // escalation for other callers.
    if (ctx.agentKey === "orchestrator") {
      const ub = await resolveUb();
      if (ub && !ub.isNoop) {
        try {
          await guardedUserbotCall(ctx.agentKey, ctx.chatId, () =>
            ub.setReaction(ctx.chatId, payload.messageId, payload.emoji),
          );
          return { ok: true, result: { via: "userbot" } };
        } catch {
          // fall through to original error
        }
      }
    }
    throw e;
  }
}

export async function handleEditMessage(
  payload: PayloadByType["EDIT_MESSAGE"],
  ctx: TelegramHandlerContext
): Promise<TelegramHandlerResult> {
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "EDIT_MESSAGE");
  const result = await tgEditMessage(ctx.telegram, {
    chatId,
    messageId: payload.messageId,
    text: payload.text,
  });
  return { ok: true, result };
}

export async function handlePinMessage(
  payload: PayloadByType["PIN_MESSAGE"],
  ctx: TelegramHandlerContext
): Promise<TelegramHandlerResult> {
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "PIN_MESSAGE");
  const result = await tgPinMessage(ctx.telegram, {
    chatId,
    messageId: payload.messageId,
    disableNotification: payload.disableNotification,
  });
  return { ok: true, result };
}

export async function handleDeleteMessage(
  payload: PayloadByType["DELETE_MESSAGE"],
  ctx: TelegramHandlerContext
): Promise<TelegramHandlerResult> {
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "DELETE_MESSAGE");
  if (payload.via_userbot === true) {
    // SEC-4 (re-audit): owner-account deletes are orchestrator-only and pinned
    // to the originating chat (never an attacker-supplied payload.chatId).
    if (ctx.agentKey !== "orchestrator") {
      return {
        ok: false,
        error: `forbidden: DELETE_MESSAGE via_userbot is restricted to orchestrator (caller: ${ctx.agentKey})`,
      };
    }
    const ub = await resolveUserbotHandle(ctx);
    if (!ub || ub.isNoop) {
      return { ok: false, error: "userbot not available" };
    }
    await guardedUserbotCall(ctx.agentKey, ctx.chatId, () =>
      ub.deleteMessage(ctx.chatId, payload.messageId),
    );
    return { ok: true, result: { via: "userbot" } };
  }
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  try {
    const result = await tgDeleteMessage(ctx.telegram, {
      chatId,
      messageId: payload.messageId,
    });
    return { ok: true, result };
  } catch (e) {
    // Аудит 2026-08-11: здесь стоял молчаливый фолбэк на аккаунт владельца —
    // `catch` → тот же `ub.deleteMessage`, без проверки роли и без апрува.
    // То есть у DELETE_MESSAGE было две двери к одной возможности: явная
    // (`via_userbot: true`) — orchestrator-only и всегда через человека
    // (USERBOT_FORCE_APPROVAL), и неявная — открытая всем 12 ролям в auto.
    //
    // Причём неявная срабатывала в обычном случае, а не в редком: Bot API не
    // даёт боту удалять чужие сообщения старше 48 часов, а без прав админа —
    // никакие. Гейт при этом одобрял удаление ботом, а исполнялось удаление
    // от лица владельца. Необратимо.
    //
    // Соседний SET_REACTION свой фолбэк уже сузил до orchestrator («no silent
    // owner-account escalation for other callers»); реакция обратима и нужна
    // ради премиум-эмодзи. У удаления такого оправдания нет: то же самое
    // делает явная ветка — но под апрувом. Поэтому здесь фолбэка нет вовсе,
    // и отказ прямо называет легальный путь.
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error:
        `bot delete failed: ${reason}. ` +
        `Повторите с via_userbot: true — удаление от лица владельца доступно ` +
        `только orchestrator и требует подтверждения человека.`,
    };
  }
}

export async function handleForwardMessage(
  payload: PayloadByType["FORWARD_MESSAGE"],
  ctx: TelegramHandlerContext
): Promise<TelegramHandlerResult> {
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  // SEC re-audit 2026-06-10 (HIGH): FORWARD_MESSAGE was the one outbound action
  // not pinned like SEND_PHOTO/SEND_DOCUMENT — a prompt-injected agent could
  // forward a message FROM any chat TO an attacker chat (exfil). Pin BOTH the
  // destination and the source to the originating chat.
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "FORWARD_MESSAGE");
  const fromChatId = pinnedChatId(payload.fromChatId, ctx.chatId, "FORWARD_MESSAGE.from");
  const result = await tgForwardMessage(ctx.telegram, {
    chatId,
    fromChatId,
    messageId: payload.messageId,
  });
  return { ok: true, result };
}

export async function handleCreatePoll(
  payload: PayloadByType["CREATE_POLL"],
  ctx: TelegramHandlerContext
): Promise<TelegramHandlerResult> {
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "CREATE_POLL");
  const result = await tgCreatePoll(ctx.telegram, {
    chatId,
    question: payload.question,
    options: payload.options,
    isAnonymous: payload.isAnonymous,
  });
  return { ok: true, result };
}

export async function handleSendPhoto(
  payload: PayloadByType["SEND_PHOTO"],
  ctx: TelegramHandlerContext
): Promise<TelegramHandlerResult> {
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  // S4: media exfil-guard — целевой чат запинен к исходному.
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "SEND_PHOTO");
  const photo =
    "url" in payload.source
      ? { url: payload.source.url }
      : { buffer: Buffer.from(payload.source.base64, "base64"), filename: "image" };
  const result = await tgSendPhoto(ctx.telegram, {
    chatId,
    photo,
    caption: payload.caption,
    replyToMessageId: payload.replyToMessageId,
  });
  return { ok: true, result };
}

export async function handleSendDocument(
  payload: PayloadByType["SEND_DOCUMENT"],
  ctx: TelegramHandlerContext
): Promise<TelegramHandlerResult> {
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  // S4: media exfil-guard — целевой чат запинен к исходному.
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "SEND_DOCUMENT");
  const result = await tgSendDocument(ctx.telegram, {
    chatId,
    content: payload.content,
    filename: payload.filename,
    caption: payload.caption,
    replyToMessageId: payload.replyToMessageId,
  });
  return { ok: true, result };
}