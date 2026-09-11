/**
 * Media handlers for GENERATE_IMAGE and GENERATE_SVG_IMAGE actions.
 * Extracted from action-dispatch.ts for T-112 modularization.
 */
import { getErrorMessage } from "../errors.ts";
import type { Telegram } from "telegraf";
import { tgSendPhoto } from "../telegram-actions.ts";
import { renderSvgToPng } from "../svg-render.ts";
import { generateImage } from "../openai-image.ts";
import { generateSvgFromPrompt, isOpenAIQuotaError } from "../svg-fallback.ts";
import { log } from "../log.ts";
import type { PayloadByType } from "../action-payload.ts";
import { pinnedChatId, type HandlerResult } from "./helpers.ts";
import { checkAndConsumeRateLimit } from "../rate-limits.ts";
import { isToolExposedToRole } from "../permissions.ts";

export type MediaHandlerContext = {
  telegram?: Telegram;
  agentKey: string;
  chatId: number;
};

export type MediaHandlerResult = HandlerResult;


export async function handleGenerateSvgImage(
  payload: PayloadByType["GENERATE_SVG_IMAGE"],
  ctx: MediaHandlerContext
): Promise<MediaHandlerResult> {
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "GENERATE_SVG_IMAGE");
  log.info(`[svg][${ctx.agentKey}] rendering ${payload.svg.length}B svg…`);
  const buffer = await renderSvgToPng(payload.svg);
  log.info(`[svg][${ctx.agentKey}] rendered → ${buffer.length}B png, sending…`);
  const result = await tgSendPhoto(ctx.telegram, {
    chatId,
    photo: { buffer, filename: "image.png" },
    caption: payload.caption,
    replyToMessageId: payload.replyToMessageId,
  });
  log.info(`[svg][${ctx.agentKey}] sent`);
  return { ok: true, result };
}

/** Подменяемые звенья обложки — чтобы тест не ходил ни в OpenAI, ни в Anthropic. */
export interface CoverDeps {
  generate?: (prompt: string) => Promise<Buffer>;
  fallbackSvg?: (prompt: string, agentKey: string) => Promise<string>;
}

/**
 * Сгенерировать PNG-обложку из текстового промпта и ВЕРНУТЬ буфер (не шлёт в чат).
 * Тот же путь, что у GENERATE_IMAGE: OpenAI растр → SVG-фолбэк при quota/billing.
 * Используется PUBLISH_TO_CHANNEL, чтобы «пост + превью» делался одним вызовом.
 *
 * Аудит 2026-08-12: «тот же путь» касалось и денег, а вот счётчика — нет.
 * Лимит «6/час на агента, 30/час суммарно» подписан ценой прямо в комментарии
 * к RULES, но висит он на действии GENERATE_IMAGE, а сюда ведёт
 * PUBLISH_TO_CHANNEL, которого в RULES нет вовсе. Замер:
 *
 *   GENERATE_IMAGE через гейт: прошло 6 → rate limit: 6/3600s
 *   PUBLISH_TO_CHANNEL через гейт: прошло 50 (упёрлось в общий 60/мин)
 *   бакет картинок после этого: {"ok":true}
 *
 * То есть второй маршрут к тому же $0.04 не видел ни один из двух бакетов.
 * Считаем здесь — в единственном месте, где деньги и тратятся. Исчерпанный
 * бюджет не роняет публикацию: это ровно тот случай, для которого уже написан
 * SVG-фолбэк (OpenAI недоступен — рисуем дёшево). Слот не возвращаем:
 * GENERATE_IMAGE в NO_REFUND_ACTIONS по той же причине, что и всегда.
 *
 * Аудит 2026-08-13: тот же второй маршрут обходил не только счётчик, но и
 * ролевую выдачу. `ROLE_EXPOSED_TOOLS.GENERATE_IMAGE = ["design","orchestrator"]`
 * (permissions.ts) — растровую генерацию намеренно держат за двумя ролями. Но
 * `PUBLISH_TO_CHANNEL` открыт ещё и `smm` с `copy`, а поле `coverPrompt` в его
 * payload ведёт сюда, то есть в тот же `generateImage`. Роль, которой инструмент
 * не выдан, дотягивалась до него через payload соседнего действия.
 *
 * Деньги и адресат к этому моменту уже закрыты (лимит считается строкой ниже,
 * публикация в ALWAYS_APPROVE_ACTIONS, назначение сужено `isTeamChannel`), так
 * что находка низкая — но ровно этим и опасна ролевая модель, у которой есть
 * дырка «через payload». Проверяем там же, где и бюджет: в единственном месте,
 * куда сходятся оба маршрута. Публикацию не роняем — это тот же случай «растр
 * недоступен», для которого написан SVG-фолбэк.
 */
export async function generateCoverPng(
  prompt: string,
  agentKey: string,
  deps: CoverDeps = {},
): Promise<Buffer> {
  const generate = deps.generate ?? ((p: string) => generateImage(p, {}));
  const fallbackSvg = deps.fallbackSvg ?? generateSvgFromPrompt;
  const cheapCover = async (why: string): Promise<Buffer> => {
    // Аудит 2026-08-20: фолбэк сам был ролевым инструментом, и никто этого не
    // проверял. `ROLE_EXPOSED_TOOLS.GENERATE_SVG_IMAGE = ["design",
    // "orchestrator"]` — ровно тот же список, что у GENERATE_IMAGE. То есть
    // гейт строкой ниже уводил роль, которой не выдан растр, во ВТОРОЙ
    // инструмент, которого ей тоже не выдали: `smm` и `copy` через coverPrompt
    // получали ИМЕННО ТО, что фикс 2026-08-13 закрывал, только нарисованное
    // Claude вместо OpenAI. Гейт был декоративным.
    //
    // Отказ здесь не роняет публикацию: вызывающий — `handlePublishToChannel`
    // в dispatch/publish.ts, единственное место, зовущее `generateCoverPng` —
    // ловит исключение обложки, логирует роль и постит текстом — см. разбор
    // аудита 2026-08-11 там же.
    if (!isToolExposedToRole("GENERATE_SVG_IMAGE", agentKey)) {
      throw new Error(
        `роли ${agentKey} не выдан ни GENERATE_IMAGE, ни GENERATE_SVG_IMAGE — обложку рисовать нечем`,
      );
    }
    log.warn(`[cover][${agentKey}] ${why} — SVG-фолбэк`);
    return await renderSvgToPng(await fallbackSvg(prompt, agentKey));
  };

  if (!isToolExposedToRole("GENERATE_IMAGE", agentKey)) {
    // Аудит 2026-08-27: ниже стоял `cheapCover`, который для такой роли ВСЕГДА
    // бросает. `ROLE_EXPOSED_TOOLS.GENERATE_IMAGE` и `.GENERATE_SVG_IMAGE` —
    // один и тот же список `["design","orchestrator"]` (permissions.ts),
    // а `isToolExposedToRole` читает статическую карту без БД-оверрайдов; значит
    // «нет растра» ⟹ «нет и SVG», и `cheapCover` упирается в собственный гейт.
    // То есть каждый заведомо безнадёжный вызов сначала СПИСЫВАЛ слот
    // (`agent:<role>:GENERATE_IMAGE`, общий `global:GENERATE_IMAGE` 30/час и
    // `agent-all:<role>`), а потом бросал. После шестой попытки за час
    // сообщение подменялось на «бюджет картинок исчерпан» — чинимый диагноз
    // («роли не выдан GENERATE_IMAGE», лечится /grant) превращался в
    // нечинимый, и вместе с ним выгорал общий часовой бюджет дизайнера.
    // `audit-2026-08-20-cover-svg-role-gate.test.ts:91` утверждает «отказ это
    // не расход», но делает ОДИН вызов при лимите 6 и проходил вхолостую.
    if (!isToolExposedToRole("GENERATE_SVG_IMAGE", agentKey)) {
      throw new Error(
        `роли ${agentKey} не выдан ни GENERATE_IMAGE, ни GENERATE_SVG_IMAGE — обложку рисовать нечем`,
      );
    }
    // Аудит 2026-08-20: этот `return` стоял ДО счётчика, поэтому роль без
    // растра проходила к генерации обложки бесплатно — `design` платил 6/час,
    // а обходной маршрут не платил ничего. SVG-фолбэк стоит запроса к Claude,
    // то есть тех же денег, ради которых бакет и заведён строкой ниже.
    // Исчерпанный бюджет здесь — отказ, а не ещё один фолбэк: дешевле SVG
    // маршрута уже нет.
    const svgSlot = checkAndConsumeRateLimit(agentKey, "GENERATE_IMAGE");
    if (!svgSlot.ok) {
      throw new Error(`бюджет картинок исчерпан (${svgSlot.reason})`);
    }
    return await cheapCover("роли не выдан GENERATE_IMAGE");
  }

  const slot = checkAndConsumeRateLimit(agentKey, "GENERATE_IMAGE");
  if (!slot.ok) {
    // Аудит 2026-08-28: этот рукав не считался вообще ни в один бакет.
    // Растровый по определению пуст (мы в его отказе), а SVG-бакет —
    // `GENERATE_SVG_IMAGE: 20/мин на агента` (rate-limits.ts:41) — никто не
    // трогал. То есть после шестой картинки за час начинался ровно тот обход,
    // который чинили 2026-08-12, только движком Claude вместо OpenAI: сколько
    // публикаций пропустит общий гейт (60/мин), столько и запросов к Claude.
    // Замер до правки: 25 обложек подряд → 25 вызовов.
    //
    // Решение 2026-08-12 («исчерпанный бюджет не роняет публикацию») в силе:
    // дешёвый рукав остаётся, но платит своим бакетом — как соседняя ветка
    // с 2026-08-20.
    const svgSlot = checkAndConsumeRateLimit(agentKey, "GENERATE_SVG_IMAGE");
    if (!svgSlot.ok) {
      throw new Error(
        `бюджет картинок исчерпан (${slot.reason}), SVG-фолбэк тоже (${svgSlot.reason})`,
      );
    }
    return await cheapCover(`бюджет картинок исчерпан (${slot.reason})`);
  }

  try {
    return await generate(prompt);
  } catch (e) {
    if (isOpenAIQuotaError(e)) return await cheapCover(`OpenAI quota: ${getErrorMessage(e)}`);
    throw e;
  }
}

/** Подменяемые звенья GENERATE_IMAGE — тот же приём, что CoverDeps выше. */
export interface ImageDeps {
  generate?: (prompt: string, opts: Record<string, unknown>) => Promise<Buffer>;
  fallbackSvg?: (prompt: string, agentKey: string) => Promise<string>;
  send?: (buffer: Buffer) => Promise<Record<string, unknown>>;
}

export async function handleGenerateImage(
  payload: PayloadByType["GENERATE_IMAGE"],
  ctx: MediaHandlerContext,
  deps: ImageDeps = {},
): Promise<MediaHandlerResult> {
  if (!ctx.telegram) return { ok: false, error: "no telegram context" };
  const chatId = pinnedChatId(payload.chatId, ctx.chatId, "GENERATE_IMAGE");
  const generate = deps.generate ?? generateImage;
  const fallbackSvg = deps.fallbackSvg ?? generateSvgFromPrompt;
  const send =
    deps.send ??
    ((buffer: Buffer) =>
      tgSendPhoto(ctx.telegram!, {
        chatId,
        photo: { buffer, filename: "image.png" },
        caption: payload.caption,
        replyToMessageId: payload.replyToMessageId,
      }));
  log.info(`[img][${ctx.agentKey}] generating ${payload.prompt.length}-char prompt (${payload.size ?? 'auto'}, q=${payload.quality ?? 'auto'})…`);
  // Аудит 2026-08-28: этот try накрывал и отправку тоже, а `catch` ниже
  // классифицирует ошибку подстрокой — `isOpenAIQuotaError` ловит `"429"` в
  // тексте. Ошибка telegraf выглядит как `"429: Too Many Requests: retry after
  // 40"` (TelegramError: `super(`${error_code}: ${description}`)`), то есть
  // подходит буквально. Флуд-контроль чата — состояние штатное, и на нём
  // купленная картинка выбрасывалась, тратился второй вызов Claude на SVG, тот
  // слался в тот же залимиченный чат, а если доезжал — действие писалось
  // `ok:true` с `fallback_reason` от Telegram. Плюс сгоравший слот:
  // GENERATE_IMAGE лежит в NO_REFUND_ACTIONS.
  //
  // Классификатор осмыслен только над ответом вендора, поэтому try обнимает
  // ровно вызов вендора — как у generateCoverPng выше.
  let buffer: Buffer;
  try {
    buffer = await generate(payload.prompt, {
      size: payload.size,
      quality: payload.quality,
      background: payload.background,
    });
  } catch (e) {
    const error = getErrorMessage(e);
    // T-514: SVG fallback when OpenAI billing/quota hits the wall.
    // Иначе картинка пропадает молча (designer падал тихо после
    // billing_hard_limit_reached). Тут просим Claude нарисовать SVG
    // на тот же prompt и переиспользуем GENERATE_SVG_IMAGE pipeline.
    if (isOpenAIQuotaError(e)) {
      log.warn(
        `[img][${ctx.agentKey}] OpenAI quota/billing error — falling back to SVG: ${error}`,
      );
      try {
        const svg = await fallbackSvg(payload.prompt, ctx.agentKey);
        log.info(
          `[img][${ctx.agentKey}] svg-fallback got ${svg.length}B svg, rendering…`,
        );
        const buffer = await renderSvgToPng(svg);
        log.info(
          `[img][${ctx.agentKey}] svg-fallback rendered → ${buffer.length}B png, sending…`,
        );
        const result = await send(buffer);
        log.info(`[img][${ctx.agentKey}] svg-fallback sent`);
        return {
          ok: true,
          // audit-flag: эта запись пришла из fallback'а, не из OpenAI.
          result: { ...result, fallback_from: "GENERATE_IMAGE" as const, fallback_reason: error },
        };
      } catch (fbErr) {
        const fbError = getErrorMessage(fbErr);
        log.warn(
          `[img][${ctx.agentKey}] svg-fallback also failed: ${fbError}`,
        );
        return {
          ok: false,
          error: `GENERATE_IMAGE failed (${error}); svg-fallback also failed: ${fbError}`,
        };
      }
    }
    log.warn(`[img][${ctx.agentKey}] generation failed: ${error}`);
    return { ok: false, error };
  }

  log.info(`[img][${ctx.agentKey}] generated → ${buffer.length}B png, sending…`);
  try {
    const result = await send(buffer);
    log.info(`[img][${ctx.agentKey}] sent`);
    return { ok: true, result };
  } catch (e) {
    // Отправка — не вендор: повторять её нечем и незачем, второй фолбэк ушёл
    // бы в тот же чат с тем же исходом. Отказ называем своим именем.
    const error = getErrorMessage(e);
    log.warn(`[img][${ctx.agentKey}] send failed: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Перечислимое поле: либо законное значение, либо отказ. Отсутствие (`undefined`
 * и `null`) — легально, поле необязательное.
 *
 * Аудит 2026-08-21: все три поля проверялись на членство в списке и при промахе
 * молча становились `undefined`, то есть «поля нет». Дальше в OpenAI уходил
 * дефолт, картинка возвращалась, действие рапортовало успех. Модель, попросившая
 * `size: "1792x1024"` (законный размер у DALL·E-3, у gpt-image-1 такого нет),
 * получала КВАДРАТ и не узнавала об этом ниоткуда — подписывала его как широкий
 * баннер и отправляла в чат. Та же доктрина, что в `build-payload.ts`: либо
 * целиком дальше, либо явный отказ. Отказ модель чинит сама, подмену — нечем.
 */
export function enumField<T extends readonly string[]>(
  input: any,
  field: string,
  allowed: T,
): { value: T[number] | undefined } | { error: string } {
  const v = input[field];
  if (v == null) return { value: undefined };
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    return {
      error: `${field}: недопустимое значение ${JSON.stringify(v)} (допустимы: ${allowed.join(", ")})`,
    };
  }
  return { value: v as T[number] };
}

export function buildGenerateImagePayload(input: any, chatId: number | undefined): 
  | { ok: true; payload: PayloadByType["GENERATE_IMAGE"] }
  | { ok: false; error: string } {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!prompt.trim()) return { ok: false, error: "prompt is required" };
  if (prompt.length > 4000)
    return { ok: false, error: "prompt too long (>4000 chars)" };
  
  const sizeAllowed = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const;
  const qualityAllowed = ["low", "medium", "high", "auto"] as const;
  const backgroundAllowed = ["transparent", "opaque", "auto"] as const;

  const size = enumField(input, "size", sizeAllowed);
  if ("error" in size) return { ok: false, error: size.error };
  const quality = enumField(input, "quality", qualityAllowed);
  if ("error" in quality) return { ok: false, error: quality.error };
  const background = enumField(input, "background", backgroundAllowed);
  if ("error" in background) return { ok: false, error: background.error };
  
  const payload: PayloadByType["GENERATE_IMAGE"] = {
    // Аудит 2026-08-12: было `chatId ?? 0`. Ноль — это не «не указан», а
    // «указан чат 0», и он никогда не равен исходному, поэтому pinnedChatId
    // кричал `[security] cross-chat target ignored` на КАЖДОЙ генерации.
    // Настоящая попытка увести файл в чужой чат тонула в этом фоне.
    chatId,
    prompt,
    caption: input.caption == null ? undefined : String(input.caption),
    replyToMessageId:
      typeof input.replyToMessageId === "number"
        ? (input.replyToMessageId as number)
        : undefined,
    size: size.value,
    quality: quality.value,
    background: background.value,
  };
  return { ok: true, payload };
}

export function buildGenerateSvgImagePayload(input: any, chatId: number | undefined):
  | { ok: true; payload: PayloadByType["GENERATE_SVG_IMAGE"] }
  | { ok: false; error: string } {
  const svg = typeof input.svg === "string" ? input.svg : "";
  if (!svg.trim()) return { ok: false, error: "svg is required" };
  
  const payload: PayloadByType["GENERATE_SVG_IMAGE"] = {
    // См. buildGenerateImagePayload: тот же `?? 0`, тот же ложный [security].
    chatId,
    svg,
    caption: input.caption == null ? undefined : String(input.caption),
    replyToMessageId:
      typeof input.replyToMessageId === "number"
        ? (input.replyToMessageId as number)
        : undefined,
  };
  return { ok: true, payload };
}