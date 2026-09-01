/**
 * C6A: тонкие обёртки над telegraf Telegram API.
 *
 * Каждая функция выполняет ровно один Telegram-вызов и возвращает компактный
 * JSON-совместимый объект `{ ok: true, ... }` либо бросает Error.
 *
 * Здесь нет проверки прав — их проверяет gateOrDispatch() в
 * lib/action-dispatch.ts (rate-limit → payloadForcesApproval → evaluateGate →
 * валидация payload → строка approval). Именно gateOrDispatch, а не
 * dispatchAction: последняя — исполнитель, она вызывается уже ПОСЛЕ гейта и
 * прав не смотрит вовсе, так что комментарий указывал на функцию, в которой
 * описанной цепочки нет. Комментарий до 2026-08-11 отправлял
 * читателя к `gatedAction()` в tools-schema.ts: такой функции там не было
 * никогда, а одноимённая в lib/actions.ts была мёртвой и заведомо более
 * слабой копией гейта — см. tests/single-gate-invariant.test.ts.
 */
import type { Telegram } from "telegraf";
import { sendWithHtml, plainTelegramLength, cutBlock } from "./telegram-format.ts";
import { withTelegramRateLimitRetry } from "./telegram-retry.ts";
import {
  splitForTelegram,
  htmlPartFits,
  messagePlainFits,
} from "./telegram-chunking.ts";
import { log } from "./log.ts";

/**
 * Аудит 2026-08-08: подпись к медиа нигде не ограничивалась по длине.
 *
 * У Telegram лимит подписи — 1024 символа, а не 4096 как у сообщения. При
 * превышении вызов падает целиком: sendPhoto возвращает 400, картинки в чате
 * не появляется. Для GENERATE_IMAGE это прямые деньги — растр у OpenAI уже
 * куплен ($0.04) ДО отправки, и слот лимита за него намеренно не возвращается
 * (см. NO_REFUND_ACTIONS в lib/rate-limits.ts). Модель, увидев ошибку, пробует
 * снова с той же длинной подписью — и так до упора в часовой лимит.
 *
 * buildGenerateImagePayload режет prompt на 4000 символов, но caption
 * пропускает через `String(input.caption)` без единой проверки.
 *
 * Лечим как соседние случаи (SEND_MESSAGE, публикация в канал): не роняем и не
 * обрезаем молча, а отдаём хвост следующими сообщениями.
 *
 * Мерить длину надо по PLAIN-тексту (plainTelegramLength), а не по сырому
 * markdown: Telegram считает подпись после разбора сущностей, `[текст](url)`
 * весит только «текст». По сырой длине дайджест из полутора десятков ссылок
 * выглядит как 1100+ символов при видимых 700 — и мы бы зря разрывали пост,
 * который обязан остаться одним сообщением (см. tests/publish-to-channel).
 *
 * 1000, а не 1024, — просто чтобы не стоять вплотную к границе; тот же приём,
 * что у TG_LIMIT=4000 в lib/telegram-chunking.ts.
 */
export const TELEGRAM_CAPTION_LIMIT = 1000;

/** Жёсткий лимит подписи у самого Telegram; 1000 выше — запас под него. */
export const TELEGRAM_CAPTION_HARD_LIMIT = 1024;

/**
 * Мерка части подписи: только видимая длина.
 *
 * Аудит 2026-08-12: решение «резать ли» принималось по plainTelegramLength, а
 * резал splitForTelegram по сырой длине. Замер на 18 строках
 * `• Пункт N [Подробнее →](https://delabs.space/digest/…)`: raw 1295 против
 * plain 404 — подпись дробилась там, где целиком влезала одним сообщением.
 *
 * Аудит 2026-08-19: та починка оставила вторую границу — сырую, 1024 — и стоило
 * резке начаться, как правила уже она. Замер на 30 строках того же вида (raw
 * 3099 / plain 1609): четыре части по видимой длине 529/485/485/107 вместо
 * двух, то есть фото и ТРИ реплая под ним вместо одного. Ссылка весит в сыром
 * тексте весь URL, поэтому у постов дайджеста raw ≈ 2×plain всегда — граница
 * срабатывала на каждом.
 *
 * Сырую границу убираем осознанно, с ценой. Она стояла ради плейн-фолбэка
 * `sendWithHtml`, который шлёт СЫРОЙ текст: часть с plain 1000 / raw 1600 в
 * фолбэке не влезет. Но фолбэк уже прикрыт отдельно — `CAPTION_PLAIN_FITS`
 * идёт третьим аргументом (ниже по файлу), и `cutBlock` обрежет с записью в
 * лог. То есть выбор такой: гарантированное дробление каждого длинного поста
 * против обрезки в ветке, которая срабатывает только когда наш же конвертер
 * выдал невалидный HTML и Telegram вернул 400. Первое видит каждый читатель,
 * второе — баг-путь с предупреждением в логе.
 */
const CAPTION_FITS = htmlPartFits(TELEGRAM_CAPTION_LIMIT);

/**
 * Мерка плейн-фолбэка: только сырая длина, под жёсткий лимит Telegram.
 *
 * Аудит 2026-08-14: ветка «подпись влезает целиком» отдавала сырой текст
 * дальше без единой границы, а `sendWithHtml` при ошибке разметки шлёт именно
 * его. Подпись с plain 566 / raw 1663 (22 ссылки + перекрёстное выделение)
 * роняла sendDocument дважды подряд и уносила с собой файл. Видимую длину
 * здесь мерить нельзя: на плейн-пути Telegram считает символы как есть.
 */
const CAPTION_PLAIN_FITS = (t: string): boolean =>
  t.length <= TELEGRAM_CAPTION_HARD_LIMIT;

/**
 * Дослать хвост подписи отдельными сообщениями, ответом на само медиа.
 *
 * Ошибку хвоста не превращаем в ошибку действия: медиа уже в чате, и объявить
 * отправку неудачной — значит спровоцировать повторную генерацию за деньги.
 * Но и молчать нельзя, поэтому пишем в лог и сообщаем счётчик в результате.
 *
 * Аудит 2026-08-13: счётчик сообщался БЕЗ знаменателя — `captionTailParts: 1`
 * при четырёх частях выглядит ровно так же, как `1` при одной. А цикл на первой
 * же неудаче делает `break`, то есть половина текста просто не доходит. Итог
 * для модели: действие `ok: true`, результат с положительным числом — повода
 * дослать остаток нет, и она идёт дальше. Пост в чате при этом обрывается
 * посреди списка.
 *
 * Поэтому наверх едет пара (отправлено, сколько было) и явный флаг обрыва.
 * Возвращать `ok: false` по-прежнему нельзя — см. абзац выше, — но «неполно»
 * должно читаться без арифметики.
 */
export interface CaptionTailResult {
  /** Сколько частей хвоста реально ушло в чат. */
  sent: number;
  /** Сколько их было. Без этого числа `sent` ничего не значит. */
  expected: number;
}

/**
 * `reply_parameters` в форме, которую переживёт выбранный транспорт.
 *
 * Аудит 2026-08-28: на multipart-путях (Buffer-источник у sendPhoto и любой
 * sendDocument) объект `{ message_id }` терялся целиком. Сериализатор telegraf
 * знает список полей, которые надо превратить в JSON-строку
 * (`FORM_DATA_JSON_FIELDS` = results, reply_markup, mask_position,
 * shipping_options, errors); `reply_parameters` появился в Bot API 7.0 позже и
 * в него не попал. Незнакомый объект уезжает в `attachFormMedia`, тот ищет в
 * нём `url` или `source`, не находит ни того ни другого и возвращается, НЕ
 * вызвав `form.addPart`, — поле не попадает в тело запроса вовсе.
 *
 * Ответ при этом `ok:true`: отправка считается успешной, а сообщение уходит
 * самостоятельным, вне ветки. Заметнее всего на SEND_DOCUMENT с длинной
 * подписью — документ вне ветки, а хвост подписи (он идёт через sendMessage,
 * то есть JSON) аккуратным ответом на него.
 *
 * multipart ждёт JSON-сериализованные объекты именно строками, так что строка
 * здесь не обход, а нужная форма. На JSON-пути наоборот: строка доехала бы
 * строкой (`"reply_parameters":"{\"message_id\":42}"`), поэтому там остаётся
 * объект. Отсюда параметр — форма зависит не от вызова, а от того, каким телом
 * он уйдёт.
 *
 * Проверяется на живом сериализаторе telegraf, а не на заглушке:
 * tests/audit-2026-08-28-reply-parameters-multipart.test.ts поднимает
 * локальный apiRoot и читает ушедшие байты.
 */
export function replyParametersFor(messageId: number, transport: "json"): { message_id: number };
export function replyParametersFor(messageId: number, transport: "multipart"): string;
export function replyParametersFor(
  messageId: number,
  transport: "multipart" | "json",
): string | { message_id: number };
export function replyParametersFor(
  messageId: number,
  transport: "multipart" | "json",
): string | { message_id: number } {
  const value = { message_id: messageId };
  return transport === "multipart" ? JSON.stringify(value) : value;
}

async function sendCaptionTail(
  tg: Telegram,
  chatId: number,
  replyToMessageId: number,
  parts: string[],
): Promise<CaptionTailResult> {
  let sent = 0;
  for (const part of parts) {
    try {
      await sendWithHtml(
        (text, pm) =>
          tg.sendMessage(
            chatId,
            text,
            pm
              ? {
                  parse_mode: pm,
                  reply_parameters: replyParametersFor(replyToMessageId, "json"),
                }
              : { reply_parameters: replyParametersFor(replyToMessageId, "json") },
          ),
        part,
        messagePlainFits,
      );
      sent++;
    } catch (e) {
      log.warn("[tg] хвост подписи не доставлен", {
        chatId,
        replyToMessageId,
        sent,
        expected: parts.length,
        error: String(e),
      });
      break;
    }
  }
  return { sent, expected: parts.length };
}

/**
 * Свернуть результат хвоста в поля ответа действия.
 *
 * `captionTailParts` остаётся прежним (его читают существующие тесты и он же
 * уехал в историю agent_actions), но рядом всегда едет знаменатель, а на обрыве
 * — ещё и флаг: модель не должна выводить неполноту вычитанием.
 */
function captionTailFields(r: CaptionTailResult): {
  captionTailParts: number;
  captionTailExpected: number;
  captionTailIncomplete?: true;
} {
  return r.sent < r.expected
    ? { captionTailParts: r.sent, captionTailExpected: r.expected, captionTailIncomplete: true }
    : { captionTailParts: r.sent, captionTailExpected: r.expected };
}

export interface TgSendMessageArgs {
  chatId: number;
  text: string;
  replyToMessageId?: number;
}

export async function tgSendMessage(
  tg: Telegram,
  args: TgSendMessageArgs,
): Promise<{ ok: true; messageId: number }> {
  const extra: Record<string, unknown> = {};
  if (args.replyToMessageId !== undefined) {
    extra.reply_parameters = replyParametersFor(args.replyToMessageId, "json");
  }
  // T-fmt: render Markdown → Telegram HTML, with plain-text fallback on a
  // parse error so a formatting glitch never blocks the message.
  const m = await sendWithHtml(
    (text, pm) =>
      tg.sendMessage(args.chatId, text, pm ? { ...extra, parse_mode: pm } : extra),
    args.text,
    messagePlainFits,
  );
  return { ok: true, messageId: (m as { message_id: number }).message_id };
}

/**
 * Официальный whitelist emoji-реакций Telegram Bot API (≈ 60 эмодзи).
 * Все остальные значения отклоняются ДО вызова Telegram, чтобы не получать
 * REACTION_INVALID. Аккуратно: некоторые состоят из нескольких code points
 * (ZWJ-последовательности типа `❤‍🔥`).
 */
export const ALLOWED_REACTIONS: readonly string[] = [
  "\u{1F44D}", // 👍
  "\u{1F44E}", // 👎
  "❤", // ❤
  "\u{1F525}", // 🔥
  "\u{1F970}", // 🥰
  "\u{1F44F}", // 👏
  "\u{1F601}", // 😁
  "\u{1F914}", // 🤔
  "\u{1F92F}", // 🤯
  "\u{1F631}", // 😱
  "\u{1F92C}", // 🤬
  "\u{1F622}", // 😢
  "\u{1F389}", // 🎉
  "\u{1F929}", // 🤩
  "\u{1F92E}", // 🤮
  "\u{1F4A9}", // 💩
  "\u{1F64F}", // 🙏
  "\u{1F44C}", // 👌
  "\u{1F54A}", // 🕊
  "\u{1F921}", // 🤡
  "\u{1F971}", // 🥱
  "\u{1F974}", // 🥴
  "\u{1F60D}", // 😍
  "\u{1F433}", // 🐳
  "❤‍\u{1F525}", // ❤‍🔥
  "\u{1F31A}", // 🌚
  "\u{1F32D}", // 🌭
  "\u{1F4AF}", // 💯
  "\u{1F923}", // 🤣
  "⚡", // ⚡
  "\u{1F34C}", // 🍌
  "\u{1F3C6}", // 🏆
  "\u{1F494}", // 💔
  "\u{1F928}", // 🤨
  "\u{1F610}", // 😐
  "\u{1F353}", // 🍓
  "\u{1F37E}", // 🍾
  "\u{1F48B}", // 💋
  "\u{1F595}", // 🖕
  "\u{1F608}", // 😈
  "\u{1F634}", // 😴
  "\u{1F62D}", // 😭
  "\u{1F913}", // 🤓
  "\u{1F47B}", // 👻
  "\u{1F468}‍\u{1F4BB}", // 👨‍💻
  "\u{1F440}", // 👀
  "\u{1F383}", // 🎃
  "\u{1F648}", // 🙈
  "\u{1F607}", // 😇
  "\u{1F628}", // 😨
  "\u{1F91D}", // 🤝
  "✍", // ✍
  "\u{1F917}", // 🤗
  "\u{1FAE1}", // 🫡
  "\u{1F385}", // 🎅
  "\u{1F384}", // 🎄
  "☃", // ☃
  "\u{1F485}", // 💅
  "\u{1F92A}", // 🤪
  "\u{1F5FF}", // 🗿
  "\u{1F192}", // 🆒
  "\u{1F498}", // 💘
  "\u{1F649}", // 🙉
  "\u{1F984}", // 🦄
  "\u{1F618}", // 😘
  "\u{1F48A}", // 💊
  "\u{1F64A}", // 🙊
  "\u{1F60E}", // 😎
  "\u{1F47E}", // 👾
  "\u{1F937}‍♂", // 🤷‍♂
  "\u{1F937}", // 🤷
  "\u{1F937}‍♀", // 🤷‍♀
  "\u{1F621}", // 😡
];

const ALLOWED_REACTION_SET = new Set(ALLOWED_REACTIONS);

/** Variation Selector-16: невидимый суффикс «рисуй как эмодзи, не как текст». */
const VS16 = "\uFE0F";

/**
 * Каноническая форма реакции из whitelist'а, либо null.
 *
 * Аудит 2026-08-20: сравнение было точным (`Set.has`), а список выше записан
 * СТРОГО в базовой форме — во всём файле ноль символов U+FE0F. При этом
 * клавиатура и любой копипаст дают форму С селектором: «❤️», «🕊️», «✍️»,
 * «⚡️», «☃️», «🤷‍♂️», «❤️‍🔥». Селектор невидим, поэтому дефект выглядел так:
 *
 *   - роль просит «❤️» → whitelist не находит → ошибка
 *     `REACTION_NOT_ALLOWED: ❤️. Allowed: 👍👎❤🔥…` — где предложенное «❤»
 *     визуально НЕОТЛИЧИМО от отвергнутого. Модель чинить нечего, она шлёт то
 *     же самое снова;
 *   - у оркестратора промах по whitelist'у уводит в фолбэк через userbot, то
 *     есть реакция ставится от аккаунта ВЛАДЕЛЬЦА — из-за невидимого символа.
 *
 * Тот же урок уже был выведен аудитом 2026-08-12 для словаря кастомных эмодзи
 * (см. BASE_EMOJI в custom-emoji-map.ts) — здесь он просто не был применён.
 * Возвращаем именно каноническую строку, а не входную: в Telegram уходит ровно
 * то, что перечислено в документации Bot API.
 */
export function normalizeReaction(emoji: string): string | null {
  const raw = emoji.trim();
  if (ALLOWED_REACTION_SET.has(raw)) return raw;
  const base = raw.replaceAll(VS16, "");
  return ALLOWED_REACTION_SET.has(base) ? base : null;
}

export function isAllowedReaction(emoji: string): boolean {
  return normalizeReaction(emoji) !== null;
}

/**
 * Аудит 2026-08-21: повтор по 429 (аудит 2026-08-20) достался только отправке
 * текста — он живёт внутри sendWithHtml. Каждый одиночный вызов Bot API в этом
 * модуле шёл мимо него, то есть 429 означал «действие провалилось», хотя
 * Telegram прислал точное число секунд ожидания. Замер на заглушке с одним
 * 429: текст — «доставлено, попыток 2», всё остальное — «потеряно, попыток 1».
 *
 * Правило теперь без исключений: любой одиночный вызов отсюда идёт через
 * повтор. Границу не двигаем — повторяется строго распознанный 429 (отказ ДО
 * обработки), таймаут и прочие ошибки летят наверх с первой попытки.
 */
function tgRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return withTelegramRateLimitRetry(fn, { label });
}

export interface TgSetReactionArgs {
  chatId: number;
  messageId: number;
  emoji: string;
}

export async function tgSetReaction(
  tg: Telegram,
  args: TgSetReactionArgs,
): Promise<{ ok: true }> {
  // Повтор по 429 — см. докстроку у tgRetry ниже.
  await tgRetry("tgSetReaction", () =>
    tg.callApi("setMessageReaction" as never, {
      chat_id: args.chatId,
      message_id: args.messageId,
      reaction: [{ type: "emoji", emoji: args.emoji }],
    } as never),
  );
  return { ok: true };
}

export interface TgEditMessageArgs {
  chatId: number;
  messageId: number;
  text: string;
}

/**
 * Аудит 2026-08-08: правка не знала ни про лимит длины, ни про разметку.
 *
 * Лимит сообщения — 4096; текст длиннее ронял вызов целиком, и правка
 * пропадала. Разбить её, как SEND_MESSAGE, нельзя: сообщение одно. Поэтому
 * режем, но видимым маркером и с честным `truncated` в результате — молчаливая
 * обрезка неотличима от полной правки и в чате, и в аудите.
 *
 * Заодно правка идёт через тот же Markdown→HTML, что и отправка: раньше агент
 * писал `**жирный**`, а после EDIT_MESSAGE в чате появлялись звёздочки. У
 * sendWithHtml есть плейн-текст-фолбэк, так что битая разметка стоит
 * форматирования, а не сообщения.
 */
const TELEGRAM_EDIT_LIMIT = 4000;

export async function tgEditMessage(
  tg: Telegram,
  args: TgEditMessageArgs,
): Promise<{ ok: true; truncated?: true }> {
  // Аудит 2026-08-12: мерили сырую длину вопреки правилу шапки этого же файла.
  // Замер (60 строк `Пункт N: [подробности](https://github.com/…/pull/…)`):
  // raw 4550 против plain 1310 — текст, влезающий втрое, резался, теряя 119
  // видимых символов, а срез попадал внутрь ссылки (`…](https://github.com/kev`
  // + «…»). Разметка при этом оставалась валидной, значит и плейн-фолбэк не
  // срабатывал: в чате просто висел обрубленный URL. `slice` вдобавок рвал
  // суррогатную пару. Обе беды уже решены в cutBlock — берём его.
  const tooLong = plainTelegramLength(args.text) > TELEGRAM_EDIT_LIMIT;
  const cut = tooLong
    ? cutBlock(args.text, (c) => plainTelegramLength(c) <= TELEGRAM_EDIT_LIMIT)
    : args.text;
  // cutBlock отдаёт "" только если не влезает даже многоточие — на лимите 4000
  // недостижимо, но пустая правка это 400, поэтому подстраховываемся.
  const text = tooLong ? cut || "…" : args.text;
  await sendWithHtml(
    (t, pm) =>
      tg.editMessageText(
        args.chatId,
        args.messageId,
        undefined,
        t,
        pm ? { parse_mode: pm } : undefined,
      ),
    text,
    messagePlainFits,
  );
  return tooLong ? { ok: true, truncated: true } : { ok: true };
}

export interface TgPinMessageArgs {
  chatId: number;
  messageId: number;
  disableNotification?: boolean;
}

export async function tgPinMessage(
  tg: Telegram,
  args: TgPinMessageArgs,
): Promise<{ ok: true }> {
  await tgRetry("tgPinMessage", () =>
    tg.pinChatMessage(args.chatId, args.messageId, {
      disable_notification: args.disableNotification ?? false,
    }),
  );
  return { ok: true };
}

export interface TgDeleteMessageArgs {
  chatId: number;
  messageId: number;
}

export async function tgDeleteMessage(
  tg: Telegram,
  args: TgDeleteMessageArgs,
): Promise<{ ok: true }> {
  await tgRetry("tgDeleteMessage", () => tg.deleteMessage(args.chatId, args.messageId));
  return { ok: true };
}

export interface TgForwardMessageArgs {
  chatId: number;
  fromChatId: number;
  messageId: number;
}

export async function tgForwardMessage(
  tg: Telegram,
  args: TgForwardMessageArgs,
): Promise<{ ok: true; messageId: number }> {
  const m = await tgRetry("tgForwardMessage", () =>
    tg.forwardMessage(args.chatId, args.fromChatId, args.messageId),
  );
  return { ok: true, messageId: (m as { message_id: number }).message_id };
}

/**
 * Отказ Bot API ИМЕННО по картинке — и только он. Telegram отвечает 400 с
 * описанием вида «failed to get HTTP URL content», «wrong type of the web page
 * content», «IMAGE_PROCESS_FAILED». Такой отказ детерминирован и происходит ДО
 * доставки: в чате не появилось ничего, поэтому повтор без картинки безопасен.
 *
 * Всё остальное сюда попадать не должно. Таймаут и 429 значат «ответ потерян»,
 * а не «не доставлено» — запрос мог дойти, и повтор дал бы второй экземпляр
 * сообщения (тот же класс, что чинили в sendWithHtml, аудит 2026-08-04). 400
 * про сам чат («chat not found», «bot was kicked») тоже не наш случай: текстом
 * туда не уйдёт ничего, и молчаливый фолбэк только спрячет настоящую причину.
 */
export function isPhotoRejected(e: unknown): boolean {
  const err = e as {
    response?: { error_code?: number; description?: string };
    error_code?: number;
    description?: string;
    message?: string;
  } | null;
  const code = err?.response?.error_code ?? err?.error_code;
  if (code !== 400) return false;
  const desc = String(
    err?.response?.description ?? err?.description ?? err?.message ?? "",
  );
  return /failed to get http url content|wrong file identifier|wrong type of the web page content|image_process_failed|photo_invalid|webpage_curl_failed|file must be non-empty|photo_ext_invalid|failed to get url content/i.test(
    desc,
  );
}

/**
 * «Подпись к медиа длиннее допустимого» — и Bot API, и MTProto (gramjs) говорят
 * это одинаково узнаваемо: MEDIA_CAPTION_TOO_LONG / «message caption is too
 * long». Отказ детерминированный и приходит до создания сообщения, поэтому
 * повтор с более короткой подписью безопасен.
 *
 * Нужен потому, что лимит подписи зависит от Telegram Premium (2048 против
 * 1024), а статус подписки — внешнее состояние, которое код не видит.
 */
export function isCaptionTooLong(e: unknown): boolean {
  const err = e as {
    response?: { description?: string };
    errorMessage?: string;
    description?: string;
    message?: string;
  } | null;
  const desc = String(
    err?.response?.description ??
      err?.errorMessage ??
      err?.description ??
      err?.message ??
      "",
  );
  return /media_caption_too_long|caption is too long|caption_too_long/i.test(desc);
}

export interface TgSendPhotoArgs {
  chatId: number;
  photo: { url: string } | { buffer: Buffer; filename?: string };
  caption?: string;
  replyToMessageId?: number;
}

export async function tgSendPhoto(
  tg: Telegram,
  args: TgSendPhotoArgs,
): Promise<{
  ok: true;
  messageId: number;
  captionTailParts?: number;
  captionTailExpected?: number;
  captionTailIncomplete?: true;
}> {
  const extra: Record<string, unknown> = {};
  if (args.replyToMessageId !== undefined) {
    // URL уходит JSON-телом, буфер — multipart: у одной и той же функции два
    // разных транспорта, и форма поля обязана следовать за источником.
    extra.reply_parameters = replyParametersFor(
      args.replyToMessageId,
      "url" in args.photo ? "json" : "multipart",
    );
  }
  const photoArg =
    "url" in args.photo
      ? args.photo.url
      : {
          source: args.photo.buffer,
          filename: args.photo.filename ?? "image.png",
        };
  // T-fmt: подпись к фото тоже рендерим Markdown→HTML (жирный, ссылки), с
  // плейн-текст-фолбэком при ошибке парсинга — как в tgSendMessage.
  if (args.caption) {
    const [head, ...tail] =
      plainTelegramLength(args.caption) > TELEGRAM_CAPTION_LIMIT
        ? splitForTelegram(args.caption, TELEGRAM_CAPTION_LIMIT, CAPTION_FITS)
        : [args.caption];
    const m = await sendWithHtml(
      (caption, pm) =>
        tg.sendPhoto(
          args.chatId,
          photoArg as never,
          pm ? { ...extra, caption, parse_mode: pm } : { ...extra, caption },
        ),
      head!,
      CAPTION_PLAIN_FITS,
    );
    const messageId = (m as { message_id: number }).message_id;
    if (tail.length === 0) return { ok: true, messageId };
    const tailRes = await sendCaptionTail(tg, args.chatId, messageId, tail);
    return { ok: true, messageId, ...captionTailFields(tailRes) };
  }
  // Аудит 2026-08-21: без подписи звался голый tg.sendPhoto — мимо повтора по
  // 429, который у ветки С подписью есть (sendWithHtml обёрнут в него внутри).
  // Замер на заглушке, отдающей один 429 с retry_after: с подписью —
  // «доставлено, попыток 2», без подписи — «потеряно, попыток 1». Цена выше,
  // чем у текста: картинка к этому моменту уже сгенерирована и оплачена, а
  // неудачная попытка вдобавок съедает слот того же лимита. 429 — отказ ДО
  // обработки, повтор безопасен; всё остальное telegram-retry пробрасывает
  // немедленно и без изменений.
  const m = await withTelegramRateLimitRetry(
    () => tg.sendPhoto(args.chatId, photoArg as never, extra),
    { label: "tgSendPhoto" },
  );
  return { ok: true, messageId: (m as { message_id: number }).message_id };
}

export interface TgSendDocumentArgs {
  chatId: number;
  /** Файл собирается из текстового содержимого в памяти. */
  content: string;
  filename: string;
  caption?: string;
  replyToMessageId?: number;
}

export async function tgSendDocument(
  tg: Telegram,
  args: TgSendDocumentArgs,
): Promise<{
  ok: true;
  messageId: number;
  captionTailParts?: number;
  captionTailExpected?: number;
  captionTailIncomplete?: true;
}> {
  const extra: Record<string, unknown> = {};
  // Тот же лимит 1024, что у фото: слишком длинная подпись роняет весь вызов,
  // и документ до чата не доезжает.
  //
  // Аудит 2026-08-12: мерка и отправка разошлись. Резать или нет решали по
  // `plainTelegramLength` (длина ПОСЛЕ Markdown→HTML), а подпись клали в extra
  // сырой и без parse_mode — значит Telegram считал против 1024 весь markdown
  // вместе с URL'ами. Замер на 22 строках `• Новость N [Подробнее →](https://…)`:
  // raw 1631 против plain 540 — условие ложно, ничего не режется, 400 «caption
  // is too long», и документ не доезжает вовсе. Теперь подпись идёт тем же
  // sendWithHtml, что и у tgSendPhoto: мерка становится верной, разметка
  // перестаёт расходиться с хвостом (sendCaptionTail всегда рендерил её), а
  // битая разметка стоит форматирования, а не документа.
  const parts = !args.caption
    ? []
    : plainTelegramLength(args.caption) > TELEGRAM_CAPTION_LIMIT
      ? splitForTelegram(args.caption, TELEGRAM_CAPTION_LIMIT, CAPTION_FITS)
      : [args.caption];
  if (args.replyToMessageId !== undefined) {
    // Источник тут всегда Buffer, то есть транспорт всегда multipart.
    extra.reply_parameters = replyParametersFor(args.replyToMessageId, "multipart");
  }
  const doc = {
    source: Buffer.from(args.content, "utf8"),
    filename: args.filename,
  };
  const m =
    parts.length === 0
      ? // Тот же разрыв, что у tgSendPhoto (аудит 2026-08-21): ветка без
        // подписи шла мимо повтора по 429, ветка с подписью — через него.
        await withTelegramRateLimitRetry(
          () => tg.sendDocument(args.chatId, doc as never, extra),
          { label: "tgSendDocument" },
        )
      : await sendWithHtml(
          (caption, pm) =>
            tg.sendDocument(
              args.chatId,
              doc as never,
              pm ? { ...extra, caption, parse_mode: pm } : { ...extra, caption },
            ),
          parts[0]!,
          CAPTION_PLAIN_FITS,
        );
  const messageId = (m as { message_id: number }).message_id;
  if (parts.length <= 1) return { ok: true, messageId };
  const tailRes = await sendCaptionTail(tg, args.chatId, messageId, parts.slice(1));
  return { ok: true, messageId, ...captionTailFields(tailRes) };
}

export interface TgCreatePollArgs {
  chatId: number;
  question: string;
  options: string[];
  isAnonymous?: boolean;
}

export async function tgCreatePoll(
  tg: Telegram,
  args: TgCreatePollArgs,
): Promise<{ ok: true; messageId: number }> {
  const m = await tgRetry("tgCreatePoll", () =>
    tg.sendPoll(args.chatId, args.question, args.options, {
      is_anonymous: args.isAnonymous ?? true,
    }),
  );
  return { ok: true, messageId: (m as { message_id: number }).message_id };
}
