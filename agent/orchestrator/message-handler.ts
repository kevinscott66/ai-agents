/**
 * T-320: Main `bot.on("message")` handler extracted from
 * orchestrator-team.ts::buildBot.
 *
 * Порядок ступеней (аудит 2026-08-28: прежний список расходился с кодом —
 * запись в короткую память стояла в нём ПОСЛЕ маршрутизации и дедупа, хотя
 * идёт до обеих, а стоп-гейт и rate-limit не были названы вовсе):
 *
 *   allowlist → распознавание вложений → запись в короткую память →
 *   маршрутизация (упомянули / handoff / оркестратор по умолчанию) →
 *   стоп-гейт роли → T-545 дедуп триггера → ingest rate-limit →
 *   сборка контекста из вики → скачивание вложений → runWithTools →
 *   ответ частями → afterSend (запись ответа, компактор, каскад по
 *   упоминаниям).
 *
 * Порядок здесь не декоративный: в память пишем до маршрутизации, чтобы
 * реплика попала в историю чата даже когда отвечать эта роль не будет, а
 * стоп-гейт стоит до дедупа и лимитов, чтобы поставленный на паузу агент не
 * жёг ни токены, ни чужие счётчики.
 *
 * Behaviour is unchanged from the inline version. Everything the handler
 * closed over at module scope is now passed explicitly via {@link MessageHandlerDeps}
 * (mutable `bots` array, the chat allowlist, the history limit, the Anthropic
 * client, the model id, and the shared HandoffDeps). The two pure helpers
 * (`isMentioned`/`tailLines`) come from ./helpers.ts to avoid a circular import.
 */
import { Telegraf } from "telegraf";
import Anthropic from "@anthropic-ai/sdk";
import type { CharacterDef } from "../characters/index.ts";
import type { RunningBot } from "../lib/types.ts";
import {
  recordMessage,
  getRecentMessages,
  wikiSearch,
} from "../lib/memory.ts";
import {
  wikiIndexAsync,
  wikiLogAsync,
  wikiReadAsync,
} from "../lib/memory-async.ts";
import { runCompactor } from "../lib/compactor.ts";
import { runWithTools } from "../lib/tool-loop.ts";
import { genRequestId } from "../lib/request-id.ts";
import {
  sendChunked,
  messagePlainFits,
  HTML_MESSAGE_FITS,
  PartialSendError,
} from "../lib/telegram-chunking.ts";
import { sendWithHtml } from "../lib/telegram-format.ts";
import {
  respondAs,
  findHandoffTargets,
  MAX_HANDOFF_DEPTH,
  HANDOFF_MAX_INVOCATIONS,
  type HandoffDeps,
} from "../lib/handoff.ts";
import { getDiscussionMode } from "../lib/chat-settings.ts";
import {
  NARRATIVE_DISCIPLINE_BLOCK,
  ORCHESTRATION_MANDATE,
  buildMemorySystemText,
  buildWikiPagesSystemText,
  speakerLabel,
  defuseSpeakerLabels,
} from "../lib/agent-prompts.ts";

// P2 discussion-mode: предел глубины handoff-цепочки, когда режим включён.
// Парсится один раз (рефактор-аудит: раньше IIFE гонялся на каждое сообщение).
const DISCUSSION_MAX_DEPTH = (() => {
  const n = Number.parseInt(process.env.DISCUSSION_MAX_DEPTH ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
})();
// S1 (security-аудит 2026-06-10): жёсткий потолок ОБЩЕГО числа handoff-вызовов
// за один user-turn. `visited` ограничивает только линейный путь (≤12), но при
// ветвлении (несколько @-mention) дерево вызовов растёт — каждый узел это LLM-вызов
// ($0.5–1.5). Общий счётчик режет fan-out независимо от глубины/ветвления.
// Аудит 2026-08-08: константа переехала в lib/handoff.ts — здесь она была
// приватной, и второй вход в respondAs (DELEGATE_TO_ROLE) оставался без потолка.
import { shouldAllowTools } from "../lib/anti-dup.ts";
import { shouldProcessTrigger } from "../lib/trigger-anti-dup.ts";
import { checkAndConsumeIngestLimit } from "../lib/rate-limits.ts";
import { isAllowlisted } from "../lib/allowlist.ts";
import { isTriggerDelivered } from "../lib/trigger-delivery.ts";
import { agentStopReason } from "../lib/permissions.ts";
import { log, redactText, redactSender, redactUserId } from "../lib/log.ts";
import { BudgetExceededError } from "../lib/token-budget.ts";
import { getErrorMessage } from "../lib/errors.ts";
import { isMentioned, mentionedHandles, tailLines } from "./helpers.ts";
import { mediaNote } from "../lib/media-markers.ts";

/**
 * Что сказать в чат, когда ход упал. Текст ошибки НЕ пересказываем: в нём
 * бывают URL с токенами и куски запроса. Пользователю нужно другое — понять,
 * ждать ли, повторять ли, звать ли человека.
 */
/**
 * Сколько текста агента показываем вместе с отказом. Ход мог написать длинный
 * ответ; в чат он попадает вместе с объяснением, почему обрыв, — и не должен
 * это объяснение утопить.
 */
const PARTIAL_TEXT_MAX = 700;

/**
 * Пост-отправочная работа: ответ уже ушёл в чат, отсюда наружу бросать нельзя.
 *
 * Всё, что делается после успешной отправки — запись в `messages`, компактор,
 * каскад по упоминаниям — это бухгалтерия. Её сбой не отменяет того, что
 * человек уже прочитал ответ, поэтому подавать его как «не смог обработать
 * сообщение, повтори запрос» неверно дважды: работа сделана, а повтор её
 * продублирует. Пишем в лог и идём дальше.
 */
export async function afterSend(
  agentKey: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn(`[after-send][${agentKey}] бухгалтерия после отправки не удалась`, {
      error: String(err),
    });
  }
}

/**
 * Что сказать модели, когда вложение было, а до неё не доехало.
 *
 * Аудит 2026-08-28: маркер хода (`[image]` / `[файл: имя]`) ставится по
 * НАЛИЧИЮ вложения в апдейте — то есть до того, как выяснится, доехало ли оно.
 * А доехать оно может не всегда: mime не в аллоулисте, заявленный или
 * фактический размер выше потолка, любой сбой скачивания. Все эти ветки пишут
 * только в log.info.
 *
 * Итог для пустой подписи: модели сказано «файл: report.log», документов ноль,
 * и она отвечает про файл, которого не видела. Человеку при этом не сказано
 * ничего — он видит осмысленный ответ про своё вложение. Молчаливая подмена
 * входа хуже отказа: отказ виден.
 *
 * Возвращает `null`, когда всё доехало или вложения не было вовсе.
 */
export function attachmentLossNote(args: {
  hasImage: boolean;
  hasTextDoc: boolean;
  imagesAttached: number;
  documentsAttached: number;
  fileName?: string;
}): string | null {
  const lost: string[] = [];
  if (args.hasImage && args.imagesAttached === 0) lost.push("картинка");
  if (args.hasTextDoc && args.documentsAttached === 0) {
    const name = args.fileName?.trim();
    lost.push(name ? `файл «${name}»` : "файл");
  }
  if (!lost.length) return null;
  return (
    `[вложение НЕ приложено: ${lost.join(" и ")} до тебя не доехало — ` +
    "не отвечай так, будто видишь содержимое; скажи об этом и попроси прислать заново]"
  );
}

export function replyForTurnError(err: unknown): string {
  if (err instanceof BudgetExceededError) {
    const tail = "вернусь после сброса (00:00 UTC).";
    // Аудит 2026-08-21: раньше здесь была одна строка на все случаи. Но
    // потолок ловится и ПОСЛЕ хода, который уже отправил сообщение, создал
    // задачу или выложил пост. «Вернусь после сброса» на такой ход читается
    // как «я ничего не сделал» — и человек идёт повторять то, что уже сделано.
    if (!err.sideEffects && !err.partialText) {
      return `Дневной лимит токенов у этой роли исчерпан — ${tail}`;
    }
    const parts: string[] = [];
    if (err.partialText) {
      const t = err.partialText.trim();
      parts.push(t.length > PARTIAL_TEXT_MAX ? t.slice(0, PARTIAL_TEXT_MAX - 1).trimEnd() + "…" : t);
    }
    parts.push(
      err.sideEffects
        ? `Дневной лимит токенов исчерпан, дальше не пошёл. Часть действий уже выполнена — повторять их не стал, ${tail}`
        : `Дневной лимит токенов исчерпан, дописать не успел — ${tail}`,
    );
    return parts.join("\n\n");
  }
  // Аудит 2026-08-28: эта ветка обязана стоять ДО разбора текста ниже.
  // `PartialSendError.message` кончается сообщением причины, а причина обрыва
  // многочастной отправки — чаще всего флуд-контроль: у юзербота FLOOD_WAIT
  // висит на каждой части отдельно (dispatch/telegram.ts). То есть половина
  // ответа, уже лежащая в чате, попадала под /429/ и подавалась человеку как
  // «повтори запрос через минуту». Повтор здесь — худшее, что можно сделать:
  // идемпотентности в Telegram нет, уже доставленные части придут вторым
  // экземпляром, плюс лишний ход модели. Тот же случай, что и у бюджета выше:
  // половина side-effect'а состоялась, и это надо сказать словами.
  if (err instanceof PartialSendError) {
    return (
      `Ответ ушёл в чат не целиком: доставлено ${err.partsSent} из ${err.partsTotal} частей, ` +
      "дальше отправка сорвалась. Повторять запрос не надо — уже пришедшее придёт вторым " +
      "экземпляром. Напиши «продолжи», и допишу остаток."
    );
  }
  const msg = getErrorMessage(err);
  if (/\b429\b|rate.?limit|overloaded/i.test(msg)) {
    return "Модель сейчас перегружена — повтори запрос через минуту.";
  }
  return "Не смог обработать сообщение: внутренняя ошибка, она записана в лог. Повтори запрос или позови человека.";
}

/**
 * READ_FILE (P1): распознать текстовый документ-вложение по mime ИЛИ расширению
 * имени файла (Telegram часто шлёт application/octet-stream для .md/.csv/.log).
 */
const TEXT_DOC_EXT =
  /\.(md|markdown|txt|text|json|jsonl|csv|tsv|log|ya?ml|xml|ts|tsx|js|jsx|py|sh|sql|html?|css|ini|toml|env|conf|cfg)$/i;
const TEXT_DOC_MIME = new Set<string>([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/csv",
]);
/**
 * Тип из `mime_type` в сравнимом виде: без параметров, без регистра, без
 * пробелов.
 *
 * Аудит 2026-08-28: аллоулист проверялся точным `TEXT_DOC_MIME.has(mime)`,
 * тогда как соседняя проверка `text/*` рядом стоит с флагом `i`. Асимметрия
 * стоила файлов: RFC 9110 разрешает параметры, и `application/json;
 * charset=utf-8` — обычная строка от почтового клиента или архиватора — в Set
 * не попадает вовсе. Регистр там же: `APPLICATION/JSON` тип валидный.
 *
 * Промах не заметен ни человеку, ни модели. Расширение спасает только когда
 * оно есть и знакомо: `dump`, `payload`, `export` без точки — обычные имена
 * выгрузок. При промахе документ не скачивается, маркер хода не ставится, и
 * `attachmentLossNote` тоже молчит — она сверяет `hasTextDoc`, посчитанный
 * этой же функцией. То есть человек прислал файл, а в контекст не попало
 * ничего и никто об этом не сказал.
 */
function normalizeMime(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const semi = raw.indexOf(";");
  return (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
}

/**
 * Картинка, присланная документом.
 *
 * Аудит 2026-08-29: здесь стояла инлайновая `/^image\//.test(mime_type)` —
 * без флага `i` и без допуска на параметры, тогда как соседняя
 * `isTextDocument` получила `normalizeMime` ещё 2026-08-28. Половина одной
 * проверки была починена, половина осталась.
 *
 * Цена промаха та же, что у текстовой ветки, только тише: `IMAGE/PNG` не
 * поднимает ни `hasImage`, ни `hasTextDoc` (второе — потому что `image/*` не
 * текстовый тип), а `attachmentLossNote` сверяет ровно эти два флага. С
 * подписью модель отвечает про файл, которого не видела; без подписи ход
 * отбрасывается целиком, и человеку не говорят ничего.
 *
 * RFC 9110 не запрещает ни регистр, ни параметры: `IMAGE/PNG` и
 * `image/png; name=x.png` — законные значения заголовка, и Telegram передаёт
 * то, что объявил отправитель.
 */
export function isImageDocument(d: unknown): boolean {
  if (!d || typeof d !== "object") return false;
  return normalizeMime((d as { mime_type?: unknown }).mime_type).startsWith("image/");
}

export function isTextDocument(d: unknown): boolean {
  if (!d || typeof d !== "object") return false;
  const doc = d as { mime_type?: unknown; file_name?: unknown };
  const mime = normalizeMime(doc.mime_type);
  if (mime.startsWith("text/")) return true;
  if (TEXT_DOC_MIME.has(mime)) return true;
  const name = typeof doc.file_name === "string" ? doc.file_name : "";
  return TEXT_DOC_EXT.test(name);
}

/** Максимум текста файла, подмешиваемого в контекст (символов). */
const MAX_DOC_CHARS = 200_000;

/**
 * Потолок на скачивание вложения из Telegram.
 *
 * Аудит 2026-08-12: оба `await fetch(link.toString())` — картинка и текстовый
 * документ — стояли без сигнала. Оба вызываются ПОСЛЕ
 * `sendChatAction("typing")`, так что зависший сокет на CDN Telegram — это
 * «печатает…» навсегда: catch рядом не сработает, runWithTools не позовётся,
 * ответа не будет и в логе не появится ни строки. Пользователь переспросит и
 * запустит второй такой же вечный хендлер.
 *
 * Тот же отказ починили в тот же день в orchestrator/voice-handler.ts
 * (VOICE_FILE_TIMEOUT_MS), но соседние два вызова в этом файле не тронули:
 * grep по AbortSignal в orchestrator/ находил только голосовое. 30 секунд —
 * по той же причине, что и там: вложение это мегабайты с CDN, а не выгрузка.
 */
export const ATTACHMENT_FILE_TIMEOUT_MS = 30_000;

/**
 * Потолки размера вложений. Раньше жили литералами в двух местах каждый
 * (заявленный размер и фактический), причём у картинки заявленного не
 * проверяли вовсе — см. комментарий у ветки картинки ниже.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_DOC_BYTES = 1024 * 1024;

/**
 * Скачать вложение Telegram по ссылке из `getFileLink`.
 *
 * Аудит 2026-08-20: оба места (картинка и текстовый документ) звали
 * `fetch` → `arrayBuffer()`, ни разу не посмотрев на код ответа. `fetch` не
 * бросает на 4xx/5xx, поэтому тело ошибки Telegram
 * (`{"ok":false,"error_code":404,"description":"Not Found"}`, ~60 байт)
 * проходило проверку размера и шло дальше как содержимое файла:
 *
 *  - картинка: уезжала в Anthropic как base64 с заявленным mediaType image/*,
 *    API отвечал 400, ход пользователя падал целиком — а в логе ни строки про
 *    404, потому что исключения не было и catch не сработал;
 *  - документ: тело ошибки — валидный UTF-8, оно подмешивалось в контекст как
 *    СОДЕРЖИМОЕ присланного файла, и модель разбирала JSON ошибки под именем
 *    report.md. Не падает ничего, не логируется ничего.
 *
 * Соседний путь голосового (проверка `!response.ok` после fetch в
 * orchestrator/voice-handler.ts) этот код проверяет с самого
 * начала — два способа скачать файл Telegram разошлись в одном репозитории.
 * Поэтому проверка живёт в одной функции на оба вызова, а не копией в каждом:
 * разъехалось ровно потому, что копий было две.
 *
 * Бросает при не-2xx; вызывающие оба стоят в try с логированием.
 */
export async function fetchTelegramAttachment(
  url: string,
  what: string,
  timeoutMs: number = ATTACHMENT_FILE_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) {
    throw new Error(`не скачалось вложение (${what}): HTTP ${resp.status}`);
  }
  return await resp.arrayBuffer();
}

/**
 * Module-scope state the message handler closes over, passed explicitly so the
 * env-derived source of truth stays in orchestrator-team.ts.
 */
export interface MessageHandlerDeps {
  /** Mutable list of running bots (shared reference — grows as bots boot). */
  bots: RunningBot[];
  /** Chat-id allowlist (empty = allow all). */
  allowed: string[];
  /** Short-memory history window size. */
  historyLimit: number;
  /** Raw Anthropic client, null in subscription-only mode. */
  anthropic: Anthropic | null;
  /** Large model id. */
  model: string;
  /** Shared handoff dependencies (anthropic/model/historyLimit/bots). */
  handoffDeps: HandoffDeps;
  /**
   * Подменяемый каскад по @-упоминаниям. По умолчанию — настоящий `respondAs`.
   * Тот же шов, что `DispatchCtx.respondAsImpl` у пути DELEGATE_TO_ROLE: без
   * него единственный способ проверить, ЧТО именно уходит в делегата с этой
   * ветки, — читать исходник глазами.
   */
  respondAsImpl?: typeof respondAs;
}

/**
 * Register the main message handler on a bot. Mirrors registerVoiceHandler:
 * the bot, its CharacterDef, the resolved RunningBot, and the closed-over
 * module state (via {@link MessageHandlerDeps}) are passed in; everything else
 * is a module import.
 */
export function registerMessageHandler(
  bot: Telegraf,
  def: CharacterDef,
  running: RunningBot,
  deps: MessageHandlerDeps,
): void {
  const { bots, allowed, historyLimit, anthropic, model, handoffDeps } = deps;

  bot.on("message", async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      // C7: отметка «апдейт получен» переехала в middleware на входе бота —
      // здесь она не видела админ-команды. См. registerSeenProbe (lib/watchdog.ts).
      // Аудит 2026-08-12: здесь стояли сырой username и первые 80 символов
      // КАЖДОГО сообщения — на уровне info, то есть в journalctl на проде, и
      // до проверки allowlist. lib/log.ts для ровно этого случая экспортирует
      // redactUserId/redactText («before it lands in log.info»), но ни одного
      // производственного вызова у них не было. Строка отвечает на вопрос
      // «апдейт дошёл?» — на него отвечают и редакторы: uid:<last4> держит
      // корреляцию внутри сессии, <len=…> показывает, что текст непустой.
      log.info(
        `[raw][${def.key}] chat=${chatId} from=${redactSender(ctx.from?.id, ctx.from?.username)} text=${redactText(
          (ctx.message as any).text ?? (ctx.message as any).caption ?? null,
        )}`,
      );
      if (!isAllowlisted(chatId, allowed)) {
        // Аудит 2026-08-20: здесь печатался ВЕСЬ allowlist. Триггер
        // недоверенный — строка пишется как раз для чата, которого в
        // списке нет, то есть любой посторонний чат заставлял бота
        // выписать в journalctl полный список рабочих чатов команды.
        // Образец правильного отказа — lib/admin-commands.ts. Размер
        // списка оставлен: он отличает «чата нет» от «список пуст».
        log.info(
          `[raw][${def.key}] chat ${chatId} not in allowlist (${allowed.length} chats)`,
        );
        return;
      }
      const msg: any = ctx.message;
      const rawText: string = msg.text ?? msg.caption ?? "";
      // C8: детектим вложенную картинку (photo[] либо document с image/* mime).
      const photos: any[] | undefined = Array.isArray(msg.photo) ? msg.photo : undefined;
      const largestPhoto = photos && photos.length ? photos[photos.length - 1] : undefined;
      const doc: any | undefined = isImageDocument(msg.document)
        ? msg.document
        : undefined;
      // READ_FILE (P1): текстовый документ-вложение (не картинка).
      const textDoc: any | undefined =
        msg.document && !doc && isTextDocument(msg.document)
          ? msg.document
          : undefined;
      const hasImage = !!largestPhoto || !!doc;
      const hasTextDoc = !!textDoc;
      // Аудит 2026-09-11: ход без подписи вообще не доходил до короткой
      // памяти — `return` стоял до записи. Картинку и текстовый документ
      // спасали ветки выше, а кружок, видео, стикер, гифка, аудиофайл и
      // любой другой документ исчезали бесследно: в истории оставался
      // разрыв, и следующий ход модели читал «человек промолчал». Теперь
      // такой ход кладётся пометкой носителя (`lib/media-markers.ts`) и
      // только после записи мы выходим — маршрутизация не меняется, немой
      // стикер по-прежнему не поднимает платный ход.
      const silentMedia =
        rawText.trim() || hasImage || hasTextDoc ? null : mediaNote(msg);
      const text: string = rawText.trim()
        ? rawText
        : hasImage
          ? "[image]"
          : hasTextDoc
            ? `[файл: ${typeof textDoc.file_name === "string" ? textDoc.file_name : "document"}]`
            : (silentMedia ?? "");
      if (!text) return;

      if (ctx.from?.id === running.id) return;
      const senderBot = ctx.from?.is_bot
        ? bots.find((b) => b.id === ctx.from?.id)
        : undefined;
      const fromOurBot = !!senderBot;
      const fromLead = senderBot?.def.key === "orchestrator";

      const mentioned = isMentioned(ctx, running.username);
      const anyOurMention = bots.some((b) => isMentioned(ctx, b.username));
      const isOrchestrator = def.key === "orchestrator";

      // Запишем входящее сообщение в короткую память один раз — от Дирижёра-роутера,
      // чтобы не дублировать. Остальные пропускают запись.
      if (isOrchestrator && !fromOurBot) {
        recordMessage({
          chatId,
          agentKey: null,
          isBot: !!ctx.from?.is_bot,
          fromUserId: ctx.from?.id.toString() ?? "0",
          fromName: ctx.from?.username ?? ctx.from?.first_name ?? null,
          text,
          tgMessageId: ctx.message?.message_id, // T-543: Add Telegram message ID for deduplication
          transport: 'bot_api', // T-543: Track transport source
        });
      }
      // Немой носитель записан — дальше идти незачем: отвечать не на что,
      // а `shouldReply` ниже на такой ход всё равно поднял бы платный вызов
      // модели, если бы Дирижёр был в чате один.
      if (silentMedia) return;

      // Routing:
      //   - человек упомянул нас → отвечаем;
      //   - Lead упомянул нас (handoff) → отвечаем, если мы не Lead;
      //   - другой наш бот упомянул нас → игнор (loops prevention);
      //   - никого не упомянули и мы Lead → отвечаем.
      let shouldReply = false;
      if (mentioned) {
        if (!fromOurBot) shouldReply = true;
        else if (fromLead && !isOrchestrator) shouldReply = true;
      } else if (!anyOurMention && isOrchestrator && !fromOurBot) {
        shouldReply = true;
      }
      if (!shouldReply) return;

      // Аудит 2026-08-09: пауза (и выключение) не затыкали главное — речь.
      // Гейт действий её уважает, инлайновые инструменты — теперь тоже, но
      // текстовый ответ уходит прямым ctx.reply мимо гейта, а именно этим
      // агент в чате и занят. Проверка стоит до shouldProcessTrigger и до
      // rate-limit: поставленный на паузу агент не должен ни говорить, ни
      // жечь на это токены, ни расходовать чужие счётчики.
      const stopReason = agentStopReason(def.key);
      if (stopReason) {
        log.info(
          `[stopped][${def.key}] агент ${stopReason} — ответ пропущен chat=${chatId}`,
        );
        return;
      }

      // T-545: Prevent duplicate processing of the same trigger message.
      //
      // Аудит 2026-09-11: условие было `isOrchestrator && …`, и держалось оно
      // не на замысле, а на ключе дедупа: `UNIQUE(chat_id, tg_message_id)` без
      // роли означал «этот апдейт уже кто-то отработал», а ботов двенадцать и
      // упомянуть в одном сообщении можно двоих — включённый для всех, он
      // заглушил бы второго. Ключ теперь несёт роль (миграция 053), и
      // утверждение стало правильным: «этот апдейт уже отработала ЭТА роль».
      //
      // Ролям защита нужна ровно та же, что оркестратору: Telegram
      // передоставляет неподтверждённый апдейт после рестарта, и без дедупа
      // это второй платный ход LLM и повторное исполнение инструментов с
      // побочными эффектами. Тот же довод уже принят для голосового пути
      // (voice-handler.ts, аудит 2026-08-28).
      if (!shouldProcessTrigger(chatId, ctx.message?.message_id, def.key)) {
        log.info(`[anti-dup][${def.key}] skipping duplicate trigger chat=${chatId} msg_id=${ctx.message?.message_id}`);
        return;
      }

      // SEC-3 / T-601: throttle agent-triggering messages per (chat, user) so a
      // group member can't drive unbounded LLM spend by flooding messages.
      // Silent drop on over-limit (no reply — avoids an amplifiable bounce).
      const ingest = checkAndConsumeIngestLimit(chatId, ctx.from?.id);
      if (!ingest.ok) {
        log.warn(
          // Аудит 2026-08-28: здесь стоял сырой ctx.from?.id — на уровне warn,
          // то есть в journalctl. Ровно то, что запрещает соседний докблок про
          // [raw] и что соблюдают обе строки рядом.
          `[ingest-rate][${def.key}] dropped over-limit trigger chat=${chatId} user=${redactUserId(ctx.from?.id)} (${ingest.reason})`
        );
        return;
      }

      log.info(
        `[in][${def.key}] chat=${chatId} from=${redactSender(ctx.from?.id, ctx.from?.username)} text=${redactText(text)}`
      );

      await ctx.sendChatAction("typing");

      const recent = getRecentMessages(chatId, historyLimit);
      // T-303: run all wiki I/O concurrently (async) to avoid blocking the
      // event loop with sequential readFileSync calls on the hot path.
      const hits = wikiSearch(text, ["_team", def.key], 4);
      const [teamIdx, teamLogRaw, privIdx, ...hitBodies] = await Promise.all([
        wikiIndexAsync("_team"),
        wikiLogAsync("_team"),
        wikiIndexAsync(def.key),
        ...hits.map((h) => wikiReadAsync(h.scope, h.slug)),
      ]);
      const teamLog = tailLines(teamLogRaw, 30);
      // Аудит 2026-08-10: содержимое вики уходило в system голым текстом.
      // Пишет туда компактор (из реплик чата) и агенты через WRITE_WIKI —
      // см. WIKI_TRUST_BOUNDARY в lib/agent-prompts.ts.
      const hitPages = buildWikiPagesSystemText(
        hits.map((h, i) => ({
          scope: h.scope,
          slug: h.slug,
          body: hitBodies[i] ?? "",
        })),
      );

      const system: Anthropic.TextBlockParam[] = [
        { type: "text", text: def.system, cache_control: { type: "ephemeral" } },
        {
          // P1 дисциплина нарратива (анти-«симуляция»). Единый источник —
          // lib/agent-prompts.ts (раньше копия здесь и в handoff разошлись).
          type: "text",
          text: NARRATIVE_DISCIPLINE_BLOCK,
          cache_control: { type: "ephemeral" },
        },
        // Шаг 2 автономности: только оркестратор ведёт весь пайплайн до результата
        // в одном turn (designer→frontend→qa…), а не «1-2 хопа и стоп».
        ...(def.key === "orchestrator"
          ? [{ type: "text" as const, text: ORCHESTRATION_MANDATE, cache_control: { type: "ephemeral" as const } }]
          : []),
        {
          type: "text",
          text: buildMemorySystemText({
            agentKey: def.key,
            teamIndex: teamIdx,
            privateIndex: privIdx,
            teamLog,
          }),
          cache_control: { type: "ephemeral" },
        },
        ...(hitPages ? [{ type: "text" as const, text: hitPages }] : []),
      ];

      const messages: Anthropic.MessageParam[] = recent.map((r) => {
        // `agent_key` — наш собственный ключ роли, он не из чата. Имя
        // человека — из чата, и метку из него собирает `speakerLabel`.
        const speaker = r.agent_key ? `[${r.agent_key}]` : speakerLabel(r.from_name);
        // Тело реплики — тоже канал подделки метки, см. defuseSpeakerLabels.
        return {
          role: r.is_bot && r.agent_key === def.key ? "assistant" : "user",
          content: r.is_bot && r.agent_key === def.key
            ? r.text
            : `${speaker} ${defuseSpeakerLabels(r.text)}`,
        };
      });
      // Аудит 2026-08-12: условие было про РОЛЬ последнего сообщения. Триггер в
      // короткую память пишет только хендлер оркестратора (см. выше), а ботов
      // двенадцать и у каждого свой polling-цикл — упомянутая роль запросто
      // читает историю раньше, чем запись случилась. Последней там лежит чужая
      // реплика, то есть role "user", проверка молчала, и агент отвечал на
      // предыдущую строку чата, ни разу не увидев вопроса, на который позван.
      // Признак — факт доставки; правило общее с buildDelegateMessages.
      // Обезвреживаем ДО сравнения: собственная копия триггера в истории уже
      // прошла ту же чистку, и сырой текст разошёлся бы с ней на пустом месте.
      const triggerLine = defuseSpeakerLabels(text);
      if (!isTriggerDelivered(messages, triggerLine)) {
        messages.push({
          role: "user",
          content: `${speakerLabel(ctx.from?.username ?? ctx.from?.first_name)} ${triggerLine}`,
        });
      }

      // C8: скачиваем картинку (если есть) и передаём в runWithTools.
      const inputImages: { mediaType: string; base64: string }[] = [];
      if (hasImage) {
        try {
          const fileId: string = largestPhoto?.file_id ?? doc?.file_id;
          // Канон, а не то, что объявил отправитель: ниже строка сверяется с
          // ALLOWED_MIME точным совпадением и уезжает в модель как mediaType.
          const declaredMime: string = normalizeMime(doc?.mime_type) || "image/jpeg";
          const declaredSize: number =
            typeof largestPhoto?.file_size === "number"
              ? largestPhoto.file_size
              : typeof doc?.file_size === "number"
                ? doc.file_size
                : 0;
          const ALLOWED_MIME = new Set([
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
          ]);
          if (!ALLOWED_MIME.has(declaredMime)) {
            log.info(
              `[image][${def.key}] skip mime=${declaredMime} (not allowed)`,
            );
          } else if (declaredSize && declaredSize > MAX_IMAGE_BYTES) {
            // Проверка заявленного размера ДО сети. У документа двумя блоками
            // ниже она была с самого начала, у картинки — нет: file_size
            // приходит прямо в апдейте и игнорировался. 19-мегабайтный png,
            // присланный документом (см. hasImage: любой document с image/*),
            // тянулся по сети целиком и целиком становился ArrayBuffer, чтобы
            // затем быть отвергнутым проверкой ниже. Повторяемо кем угодно из
            // аллоулиста.
            log.info(
              `[image][${def.key}] skip declared size=${declaredSize} (>4MB)`,
            );
          } else if (fileId) {
            const link = await bot.telegram.getFileLink(fileId);
            const ab = await fetchTelegramAttachment(link.toString(), "картинка");
            if (ab.byteLength > MAX_IMAGE_BYTES) {
              log.info(
                `[image][${def.key}] skip size=${ab.byteLength} (>4MB)`,
              );
            } else {
              const buf = Buffer.from(ab);
              inputImages.push({
                mediaType: declaredMime,
                base64: buf.toString("base64"),
              });
              log.info(
                `[image][${def.key}] attached mime=${declaredMime} bytes=${buf.length}`,
              );
            }
          }
        } catch (e) {
          log.error(`[image][${def.key}] download failed`, { error: String(e) });
        }
      }

      // READ_FILE (P1): скачать текстовый файл-вложение и подмешать в контекст.
      const inputDocuments: { filename: string; text: string }[] = [];
      if (hasTextDoc) {
        try {
          const fileId: string = textDoc.file_id;
          const declaredSize: number =
            typeof textDoc.file_size === "number" ? textDoc.file_size : 0;
          if (declaredSize && declaredSize > MAX_DOC_BYTES) {
            log.info(
              `[file][${def.key}] skip size=${declaredSize} (>1MB)`,
            );
          } else if (fileId) {
            const link = await bot.telegram.getFileLink(fileId);
            const ab = await fetchTelegramAttachment(link.toString(), "документ");
            if (ab.byteLength > MAX_DOC_BYTES) {
              log.info(`[file][${def.key}] skip size=${ab.byteLength} (>1MB)`);
            } else {
              let content = Buffer.from(ab).toString("utf8");
              if (content.length > MAX_DOC_CHARS) {
                content =
                  content.slice(0, MAX_DOC_CHARS) +
                  "\n…[файл обрезан по лимиту контекста]";
              }
              const filename =
                typeof textDoc.file_name === "string"
                  ? textDoc.file_name
                  : "document.txt";
              inputDocuments.push({ filename, text: content });
              log.info(
                `[file][${def.key}] attached name=${filename} chars=${content.length}`,
              );
            }
          }
        } catch (e) {
          log.error(`[file][${def.key}] download failed`, { error: String(e) });
        }
      }

      // Маркер хода ставился по наличию вложения, а не по тому, что доехало:
      // выше пять веток, каждая из которых молча роняет вложение в log.info.
      // Если после них ничего не приложено — говорим об этом модели словами,
      // иначе она отвечает про содержимое, которого не видела.
      const lossNote = attachmentLossNote({
        hasImage,
        hasTextDoc,
        imagesAttached: inputImages.length,
        documentsAttached: inputDocuments.length,
        fileName: typeof textDoc?.file_name === "string" ? textDoc.file_name : undefined,
      });
      if (lossNote) {
        log.info(`[attach][${def.key}] ${lossNote}`);
        const last = messages[messages.length - 1];
        // Обычный случай — сообщение, только что добавленное выше. Если его не
        // добавляли (триггер уже был доставлен) и хвост не пользовательский,
        // кладём отдельной репликой: чередование ролей от этого не ломается.
        if (last && last.role === "user" && typeof last.content === "string") {
          last.content = `${last.content} ${lossNote}`;
        } else {
          messages.push({ role: "user", content: lossNote });
        }
      }

      // C7: anti-duplication для Lead — если разговор адресован другому
      // нашему боту, Lead отвечает только текстом, без tool'ов.
      // Аудит 2026-08-28: разметку упоминаний передаём явно — по ней же
      // решается доставка сообщения роли, и расходиться с ней нельзя.
      const allowTools = shouldAllowTools(def, recent, text, bots, mentionedHandles(ctx));
      // T-410 (T-303 HIGH #2): generate a request-id at the earliest ingress
      // (Telegram update) so every downstream tool dispatch + audit row +
      // structured log line is correlatable to this single user turn.
      const requestId = genRequestId();
      // S1: один счётчик handoff-вызовов на весь ход пользователя. Заводится
      // ДО runWithTools: делегирования оркестратора — такие же LLM-вызовы, как
      // и каскад по @-упоминаниям ниже, и раньше в потолок не попадали вовсе
      // (счётчик рождался строкой после, уже когда оркестратор отработал).
      const handoffBudget = { n: 0, max: HANDOFF_MAX_INVOCATIONS };
      const reply = await runWithTools({
        anthropic,
        model,
        system,
        messages,
        agentKey: def.key,
        chatId: Number(chatId),
        botId: running.id, // T-240: Add bot ID for per-bot-per-chat rate limiting
        telegram: bot.telegram,
        triggerMessageId: ctx.message.message_id,
        // C10: preferred handoff path via DELEGATE_TO_ROLE tool.
        // findHandoffTargets / @-mention path below stays as legacy fallback.
        resolveAgent: (key) => bots.find((b) => b.def.key === key),
        handoffDeps,
        // C13 anti-pingpong: seed the delegation chain with this agent's key
        // so any DELEGATE_TO_ROLE inside this turn carries the full ancestry.
        delegationChain: [def.key],
        handoffBudget,
        triggerUserId: ctx.from?.id != null ? String(ctx.from.id) : undefined,
        requestId,
        ...(allowTools ? {} : { allowedTools: [] as string[] }),
        ...(inputImages.length ? { inputImages } : {}),
        ...(inputDocuments.length ? { inputDocuments } : {}),
      });
      if (!allowTools) {
        log.info(`[anti-dup][${def.key}] tools disabled for this turn`);
      }
      if (!reply) return;

      /**
       * Что уже доставлено пользователю на случай сбоя на середине.
       *
       * Аудит 2026-08-13: длинный ответ уходит несколькими сообщениями, и
       * падение на k-м (429 после ретраев, сетевой сбой, бот выкинут из чата)
       * бросало наружу — до `recordMessage` дело не доходило. У пользователя
       * при этом на экране k сообщений, а в короткой памяти ответа нет вовсе:
       * следующим ходом агент не видит, что уже ответил, и делает работу
       * заново — тем же дорогим ходом, с теми же инструментами. Пишем то, что
       * дошло, и только потом отдаём ошибку выше.
       */
      const delivered: string[] = [];
      let lastSent: any;
      const sender = (t: string) =>
        // T-fmt: each chunk goes out as Telegram HTML (Markdown-converted), with
        // a plain-text fallback on a parse error so delivery never breaks.
        sendWithHtml(
          (text, pm) =>
            ctx.reply(text, {
              reply_parameters: { message_id: ctx.message.message_id },
              ...(pm ? { parse_mode: pm } : {}),
            }),
          t,
          // Аудит 2026-08-21: мерка плейн-фолбэка. Раньше её тут не было, и
          // единственным, что держало сырой текст под жёстким лимитом, была
          // сырая мерка резки — из-за неё же ответ со ссылками дробился на три
          // сообщения. Мерка переехала на видимую длину (HTML_MESSAGE_FITS
          // ниже), значит фолбэк надо прикрыть явно — как в handoff.ts и
          // tgSendMessage.
          messagePlainFits,
        );
      let sent: any;
      try {
        sent = await sendChunked(
          sender,
          reply,
          (s, part) => {
            delivered.push(part);
            lastSent = s;
          },
          HTML_MESSAGE_FITS,
        );
      } catch (sendErr) {
        if (delivered.length) {
          log.warn(`[out][${def.key}] ответ доставлен частично`, {
            chatId,
            parts: delivered.length,
            error: getErrorMessage(sendErr),
          });
          recordMessage({
            chatId,
            agentKey: def.key,
            isBot: true,
            fromUserId: running.id.toString(),
            fromName: running.username,
            text: delivered.join("\n\n"),
            ts: (lastSent?.date ?? Math.floor(Date.now() / 1000)) * 1000,
            tgMessageId: lastSent?.message_id,
            transport: "bot_api",
          });
        }
        throw sendErr;
      }
      // Аудит 2026-08-28: отсюда и до конца блока ответ УЖЕ в чате, и всё
      // ниже — бухгалтерия: запись в messages, компактор, каскад по
      // упоминаниям. Она сидела в том же try, что и сам ход, поэтому
      // SQLITE_BUSY на recordMessage или на getDiscussionMode (chat-settings
      // читает БД без try, в отличие от permissions.ts) уводил выполнение во
      // внешний catch — и человек получал полный ответ, а следом «Не смог
      // обработать сообщение… Повтори запрос». Второй процесс на той же базе
      // назван штатным риском в memory.ts. Повторять тут нечего, а вот записи
      // ответа в messages не будет, и следующий ход переделает работу — это в
      // лог, не в чат.
      await afterSend(def.key, async () => {
        // Ответ агента — это пересказ переписки: тот же приватный контент, что
        // и вход, только уже собранный. Симметрично со строкой [in].
        log.info(`[out][${def.key}] chat=${chatId} text=${redactText(reply)}`);

        recordMessage({
          chatId,
          agentKey: def.key,
          isBot: true,
          fromUserId: running.id.toString(),
          fromName: running.username,
          text: reply,
          ts: (sent?.date ?? Math.floor(Date.now() / 1000)) * 1000,
          tgMessageId: sent?.message_id, // T-543: Add Telegram message ID for outgoing messages
          transport: 'bot_api', // T-543: Track transport source
        });

        const recentSummary = recent.slice(-10).map((r) => {
          const who = r.agent_key ? `[${r.agent_key}]` : speakerLabel(r.from_name);
          return `${who} ${defuseSpeakerLabels(r.text).slice(0, 200)}`;
        }).join("\n");
        runCompactor(anthropic, {
          agentKey: def.key,
          chatId,
          userText: text,
          agentReply: reply,
          recentContext: recentSummary,
        });

        // Внутрипроцессный multi-hop handoff: ЛЮБОЙ агент может делегировать.
        // P2 discussion-mode: когда включён для чата — поднимаем предел глубины
        // цепочки, чтобы высказалось больше ролей. Глубина пути ограничена visited,
        // а ОБЩЕЕ число вызовов — общим budget (S1), чтобы ветвление не размножало
        // LLM-вызовы. По умолчанию — обычный MAX_HANDOFF_DEPTH.
        const handoffDepth = getDiscussionMode(Number(chatId))
          ? DISCUSSION_MAX_DEPTH
          : MAX_HANDOFF_DEPTH;
        // Счётчик тот же, что ушёл в runWithTools выше: делегирования оркестратора
        // уже израсходовали часть запаса, и каскад по упоминаниям продолжает с
        // того же места, а не с нуля.
        const targets = findHandoffTargets(reply, def.key, bots);
        for (const t of targets) {
          void (deps.respondAsImpl ?? respondAs)(
            {
              target: t,
              chatId,
              triggerText: reply,
              triggerAgentKey: def.key,
              depth: 1,
              visited: new Set([def.key, t.def.key]),
              triggerMessageId: ctx.message.message_id,
              maxDepth: handoffDepth,
              budget: handoffBudget,
              // Аудит 2026-08-12: этой строки тут не было. Ровно тот же дефект
              // чинили 2026-08-08 на хоп ниже (handoff.ts, рекурсивный вызов), а
              // ПЕРВЫЙ хоп каскада остался с прежним поведением: делегат заводил
              // себе новый request_id, и одно сообщение пользователя разваливалось
              // в audit_logs на несвязанные ходы. Правило записано в RespondAsOpts
              // — но выполнялось в одной из двух точек вызова.
              requestId,
              // Аудит 2026-08-13: и пользователь хода — по нему считается
              // whitelist MAC_USER_IDS. Обе точки вызова respondAs теряли его.
              triggerUserId: ctx.from?.id != null ? String(ctx.from.id) : undefined,
              // Вложения хода: у делегата по @-упоминанию их не было по той же
              // причине — вторая точка вызова о них не знала.
              ...(inputImages.length ? { inputImages } : {}),
              ...(inputDocuments.length ? { inputDocuments } : {}),
            },
            handoffDeps,
          );
        }
        if (targets.length) {
          log.info(
            `[handoff][${def.key}] d=0→1 → ${targets.map((t) => t.def.key).join(", ")}`
          );
        }
      });
    } catch (err) {
      log.error(`[err][${def.key}]`, { error: String(err) });
      // Раньше здесь всё и заканчивалось: любой сбой хода — исчерпанный
      // дневной бюджет, 429 после ретраев, 400 от API — превращался в молчание.
      // Пользователь видел не ошибку, а бота, который просто не ответил, и
      // повторял вопрос, запуская тот же сбой заново. Одна честная строка в
      // ответ на конкретное сообщение (а не в чат вообще) стоит дешевле.
      try {
        await ctx.reply(replyForTurnError(err), {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      } catch (e) {
        // Сбой мог быть и в самом Telegram — тогда извиниться тоже не выйдет.
        log.warn(`[err][${def.key}] не смог сообщить об ошибке`, {
          error: String(e),
        });
      }
    }
  });
}
