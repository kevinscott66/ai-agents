/**
 * R4 (T-112 follow-up): Payload-building helpers extracted from action-dispatch.ts.
 *
 * buildPayload — converts raw LLM input into a strict PayloadFor<T>.
 * buildPayloadCtx — minimal context subset required by buildPayload.
 * BuildResult — discriminated union returned by buildPayload.
 */
import { CHARACTERS } from "../../characters/index.ts";
import type { ActionType } from "../permissions.ts";
import type { PayloadFor } from "../action-payload.ts";
import type { TaskStatus } from "../tasks.ts";
import {
  buildGenerateImagePayload,
  buildGenerateSvgImagePayload,
  enumField,
} from "./media.ts";

const ROLE_KEYS = CHARACTERS.map((c) => c.key);
const ROLE_KEYS_SET = new Set<string>(ROLE_KEYS);

function isValidScope(s: string): boolean {
  return s === "_team" || ROLE_KEYS_SET.has(s);
}

/**
 * Ограничения опроса у Bot API: вопрос 1..300, вариантов 2..10, каждый 1..100.
 * Ни одно из них не проверялось — а CREATE_POLL требует апрува, поэтому 400
 * прилетал уже ПОСЛЕ того, как человек нажал «подтвердить», и с текстом вида
 * «Bad Request: POLL_QUESTION_INVALID», по которому не понять, что чинить.
 *
 * Проверяем здесь, в buildPayload: он отрабатывает до гейта апрува, так что
 * отказ приходит модели сразу и она переделывает опрос в том же ходу, не тратя
 * внимание владельца. Ровно логика validatePhotoUrl ниже.
 *
 * Пустые варианты не отбрасываем молча: `["Да", ""]` после отбрасывания стал бы
 * опросом с одним вариантом, и модель бы не узнала, что потеряла строку.
 * Вопрос и варианты идут в Telegram без parse_mode, поэтому меряем сырую длину.
 */
const POLL_QUESTION_MAX = 300;
const POLL_OPTION_MAX = 100;
const POLL_OPTIONS_MAX = 10;

export function validatePoll(question: string, options: string[]): string | null {
  if (!question) return "question: пустой вопрос";
  if (question.length > POLL_QUESTION_MAX) {
    return `question: ${question.length} символов, лимит Telegram — ${POLL_QUESTION_MAX}`;
  }
  if (options.length < 2) return "options: нужно минимум 2 варианта";
  if (options.length > POLL_OPTIONS_MAX) {
    return `options: ${options.length} вариантов, лимит Telegram — ${POLL_OPTIONS_MAX}`;
  }
  for (let idx = 0; idx < options.length; idx++) {
    const o = options[idx]!;
    if (!o.trim()) return `options[${idx}]: пустой вариант`;
    if (o.length > POLL_OPTION_MAX) {
      return `options[${idx}]: ${o.length} символов, лимит Telegram — ${POLL_OPTION_MAX}`;
    }
  }
  return null;
}

/**
 * Bot API берёт фото по URL только по http(s) и качает его сам. Всё остальное
 * (`file:`, `data:`, `ftp:`, голый путь) — гарантированный 400 уже после
 * апрува. Схему проверяем здесь, чтобы отказ пришёл агенту сразу.
 */
export function validatePhotoUrl(url: string, field = "photoUrl"): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${field}: не URL (${url.slice(0, 60)})`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `${field}: поддерживается только http/https, получено ${u.protocol}`;
  }
  return null;
}

/** Bot API: загружаемое фото — не больше 10 МБ. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const DATA_URI_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/i;
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Нормализует photoBase64: снимает `data:`-префикс (схема просит без него, но
 * модели ставят его постоянно), проверяет алфавит и размер.
 *
 * Без этой проверки Buffer.from(x, "base64") молча выкидывает недопустимые
 * символы: из `data:image/png;base64,iVBOR...` получался обрезанный мусор, а
 * из полностью кривой строки — пустой буфер, который уходил в Telegram как
 * «фото».
 */
export function normalizePhotoBase64(
  raw: string,
  field = "photoBase64",
): { value: string } | { error: string } {
  let s = raw.trim();
  const m = s.match(DATA_URI_PREFIX);
  if (m) s = s.slice(m[0].length);
  s = s.replace(/\s+/g, "");
  if (!s) return { error: `${field}: пустая строка` };
  if (!BASE64_ONLY.test(s)) {
    return { error: `${field}: не base64 (лишние символы)` };
  }
  const bytes = Math.floor((s.length * 3) / 4);
  if (bytes === 0) return { error: `${field}: пустая картинка` };
  if (bytes > MAX_PHOTO_BYTES) {
    return {
      error: `${field}: ${Math.round(bytes / 1024 / 1024)} МБ — лимит Telegram 10 МБ`,
    };
  }
  return { value: s };
}

/**
 * Жёсткая граница на СЫРОЙ текст поста — только чтобы payload и строка апрува
 * не распухали. Под лимит Telegram пост подгоняет одно место, `fitToLimit` в
 * action-dispatch: после подстановки канонического футера и по PLAIN-длине.
 *
 * Аудит 2026-08-12: здесь стояла вторая обрезка, `text.slice(0, 4096)` по
 * сырому markdown. Сырая длина всегда больше plain (`**жирный**`,
 * `[текст](url)` до читателя не доезжают), так что пост, влезавший в одно
 * сообщение с запасом, обрезался, не дойдя до того, кто умеет резать. Замер:
 * сырых 4860 → plain 2504 при лимите 4096; после slice — plain 2160, футер
 * пропал целиком, текст оборвался ВНУТРИ `[текст](https://…`, и незакрытая
 * ссылка ломала разметку всего поста. `fitToLimit` при этом не срабатывал
 * (2160 ≤ 4096), а buildPayload возвращал ok — модель об урезанном посте не
 * узнавала.
 *
 * Правило то же, что вывел аудит 2026-08-04 про футер: лимит проверяется на
 * тексте, который реально уходит в Telegram, а не на промежуточном. Здесь —
 * либо целиком дальше, либо явный отказ.
 */
export const PUBLISH_TEXT_MAX_RAW = 20_000;

/**
 * Лимиты Telegram на создаваемый канал: название 128, описание 255.
 *
 * Числа были и раньше — но литералами внутри `slice`, то есть как молчаливая
 * обрезка. Аудит 2026-08-28: это ровно то, что шапка PUBLISH_TEXT_MAX_RAW выше
 * запрещает, и то, от чего аудит 2026-08-20 увёл соседние coverTitle /
 * coverSubtitle. Здесь цена ошибки выше: создание канала необратимо (см.
 * комментарий в самом case), и обрубленное имя чинится только руками владельца
 * — а повторная попытка оставляет в аккаунте второй канал.
 */
const CHANNEL_TITLE_MAX = 128;
const CHANNEL_ABOUT_MAX = 255;

/**
 * Поле обложки: либо целиком, либо отказ. Пустая строка и не-строка — «поля
 * нет» (прежнее поведение, `.trim()` в условии). Превышение лимита — ошибка, а
 * не тихая обрезка: то, что уезжает на картинку в публичном канале, чинить
 * постфактум нечем.
 */
function coverField(
  i: Record<string, unknown>,
  field: "coverPrompt" | "coverTitle" | "coverSubtitle",
  max: number,
): { value: string | undefined } | { error: string } {
  const v = i[field];
  if (typeof v !== "string" || !v.trim()) return { value: undefined };
  if (v.length > max) {
    return { error: `${field}: ${v.length} символов — лимит ${max}` };
  }
  return { value: v };
}

/**
 * Minimal context needed for payload building (subset of ExecCtx in
 * tools-schema.ts).
 */
export interface BuildPayloadCtx {
  agentKey: string;
  triggerMessageId?: number;
}

export type BuildResult<T extends ActionType> =
  | { ok: true; payload: PayloadFor<T> }
  | { ok: false; error: string };

/**
 * Аудит 2026-08-29: свободный текст брался через `String(v)`, а единственной
 * проверкой была непустота — и `String({})` даёт непустое `"[object Object]"`.
 *
 * Модель ошибается в форме поля дёшево и часто: `{"text": {"ru": "…", "en":
 * "…"}}` — обычная осечка структурированного вывода. Дальше эта строка
 * доезжала до места назначения как есть: в чат уходило литеральное
 * `[object Object]`, в вики ложилось то же самое (а `READ_WIKI` потом
 * подмешивал это в промпты), и всё это с `ok:true` в аудите. Настоящий текст
 * восстановить уже неоткуда.
 *
 * SDK-путь такое отбивает сам (`propToZod` даёт `z.string()`), сырой путь —
 * нет: `executeTool` кастует `input` без проверки. Поэтому два пути на одном
 * и том же инпуте вели себя по-разному, и в проде (`USE_AGENT_SDK=true`)
 * дыры не было видно. Отказ приводит их к одному поведению и попадает в
 * доктрину файла: либо целиком дальше, либо явный отказ.
 *
 * Только проза, идущая наружу или в долгое хранение. Скаляры (`taskId`,
 * `role`, `scope`, `status`) намеренно оставлены снисходительными: у них есть
 * свои проверки ниже по течению, которые дают внятный отказ сами.
 */
function proseField(
  v: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: "" };
  if (typeof v !== "string")
    return { ok: false, error: `${field} must be a string, got ${typeof v}` };
  return { ok: true, value: v };
}

/**
 * Превратить сырой LLM-инпут в строгий PayloadFor<T>. Валидация обязательных
 * полей и нормализация типов (number/string/boolean).
 */
export function buildPayload<T extends ActionType>(
  name: T,
  i: Record<string, unknown>,
  ctx: BuildPayloadCtx,
): BuildResult<T> {
  const chatId =
    typeof i.chatId === "number" ? (i.chatId as number) : undefined;
  // Аудит 2026-08-29: подстановка срабатывала не только на отсутствующем
  // поле, но и на поле НЕВЕРНОГО ТИПА. `{"messageId": "8231"}` — строка вместо
  // числа, рядовая осечка модели на числовых полях — молча превращалась в
  // `ctx.triggerMessageId`, то есть в сообщение, которым пользователь и вызвал
  // этот ход. `DELETE_MESSAGE` необратим, и модель получала `ok:true` за то,
  // что удалила чужое сообщение вместо названного; с `via_userbot: true` — от
  // лица владельца.
  //
  // Умолчание задокументировано ровно у одного действия (SET_REACTION: «по
  // умолчанию — то, на которое отвечаем») и ровно для ОТСУТСТВУЮЩЕГО поля.
  // У EDIT/PIN/DELETE/FORWARD схема объявляет messageId обязательным и никакого
  // умолчания не обещает. Названное поле неверного типа — не «не назвали»,
  // это ошибка вызова, и ответ на неё отказ, а не догадка.
  //
  // Дробное и NaN отсекаются здесь же: `typeof NaN === "number"` пропускал их
  // дальше, до самого Bot API. `null` — тоже отказ, а не «как не указано»:
  // z.number() на SDK-пути его отвергает, и два пути должны отвечать на один
  // и тот же инпут одинаково. За умолчанием поле просто не называют.
  const messageIdError =
    i.messageId !== undefined && !Number.isInteger(i.messageId)
      ? `messageId must be an integer (got ${String(i.messageId).slice(0, 40)})`
      : undefined;
  const messageIdRaw =
    typeof i.messageId === "number" && Number.isInteger(i.messageId)
      ? (i.messageId as number)
      : ctx.triggerMessageId;

  switch (name) {
    case "SEND_MESSAGE": {
      const textField = proseField(i.text, "text");
      if (!textField.ok) return textField;
      const text = textField.value.trim();
      if (!text) return { ok: false, error: "text is required" };
      const payload: PayloadFor<"SEND_MESSAGE"> = {
        chatId,
        text,
        replyToMessageId:
          typeof i.replyToMessageId === "number"
            ? (i.replyToMessageId as number)
            : undefined,
        // Аудит 2026-08-08: этого поля здесь не было. Схема его объявляет,
        // описание инструмента прямо предлагает оркестратору «опубликовать от
        // реального аккаунта владельца», хендлер такой путь реализует, гейт его
        // сторожит — а до payload'а флаг не доезжал и молча терялся. То есть
        // «объявление от лица владельца» всегда уходило от роль-бота, и модель
        // об этом не узнавала: ответ приходил успешный. Отказ безопасный
        // (никогда не отправит как владелец непрошено), но результат — не тот,
        // который просили. Сравнение строгое, как у SET_REACTION/DELETE_MESSAGE.
        via_userbot: i.via_userbot === true ? true : undefined,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "SET_REACTION": {
      const emoji = String(i.emoji ?? "");
      if (!emoji) return { ok: false, error: "emoji is required" };
      if (messageIdError) return { ok: false, error: messageIdError };
      if (messageIdRaw === undefined)
        return { ok: false, error: "messageId is required" };
      const payload: PayloadFor<"SET_REACTION"> = {
        chatId,
        messageId: messageIdRaw,
        emoji,
        via_userbot: i.via_userbot === true ? true : undefined,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "EDIT_MESSAGE": {
      const textField = proseField(i.text, "text");
      if (!textField.ok) return textField;
      const text = textField.value;
      if (!text) return { ok: false, error: "text is required" };
      if (messageIdError) return { ok: false, error: messageIdError };
      if (messageIdRaw === undefined)
        return { ok: false, error: "messageId is required" };
      const payload: PayloadFor<"EDIT_MESSAGE"> = {
        chatId,
        messageId: messageIdRaw,
        text,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "PIN_MESSAGE": {
      if (messageIdError) return { ok: false, error: messageIdError };
      if (messageIdRaw === undefined)
        return { ok: false, error: "messageId is required" };
      const payload: PayloadFor<"PIN_MESSAGE"> = {
        chatId,
        messageId: messageIdRaw,
        disableNotification:
          typeof i.disableNotification === "boolean"
            ? (i.disableNotification as boolean)
            : undefined,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "DELETE_MESSAGE": {
      if (messageIdError) return { ok: false, error: messageIdError };
      if (messageIdRaw === undefined)
        return { ok: false, error: "messageId is required" };
      const payload: PayloadFor<"DELETE_MESSAGE"> = {
        chatId,
        messageId: messageIdRaw,
        via_userbot: i.via_userbot === true ? true : undefined,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "FORWARD_MESSAGE": {
      if (messageIdError) return { ok: false, error: messageIdError };
      if (messageIdRaw === undefined)
        return { ok: false, error: "messageId is required" };
      // Аудит 2026-08-28: `fromChatId` был обязательным — и выбрасывался.
      // Хендлер пиннит источник к чату-триггеру (telegram.ts, «pin BOTH»), то
      // есть модель обязана была назвать число, которое ни на что не влияет, и
      // без него получала отказ. Схема его больше не объявляет, значит и
      // требовать нельзя. Пришедшее значение всё равно передаём дальше: на нём
      // держится security-лог о попытке кросс-чат обращения.
      const payload: PayloadFor<"FORWARD_MESSAGE"> = {
        chatId,
        fromChatId: typeof i.fromChatId === "number" ? (i.fromChatId as number) : undefined,
        messageId: messageIdRaw,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "CREATE_POLL": {
      const question = String(i.question ?? "").trim();
      const options = Array.isArray(i.options)
        ? (i.options as unknown[]).map((x) => String(x).trim())
        : [];
      const pollError = validatePoll(question, options);
      if (pollError) return { ok: false, error: pollError };
      const payload: PayloadFor<"CREATE_POLL"> = {
        chatId,
        question,
        options,
        isAnonymous:
          typeof i.isAnonymous === "boolean"
            ? (i.isAnonymous as boolean)
            : true,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "CREATE_TASK": {
      const title = String(i.title ?? "").trim();
      if (!title) return { ok: false, error: "title is required" };
      // Аудит 2026-08-27: было `typeof i.priority === "number" ? … : 0`. Схема
      // объявляет `integer 0..100` (tools-schema.ts:69), а строка `"90"` —
      // ровно тот класс мусора, ради которого в этом же файле чинили
      // `SCHEDULE_POST.scheduledAt` и `CREATE_TEAM_CHANNEL.roles`. Молчаливая
      // подмена на 0 уводила срочную задачу в самый низ очереди роли
      // (сборка `ORDER BY priority DESC, created_at ASC` в `listTasks`) — при
      // `ok:true` с готовым `taskId`. Верхней границы тоже не было:
      // `priority: 100000` намертво прибивал задачу к первой строке.
      if (
        i.priority != null &&
        (typeof i.priority !== "number" ||
          !Number.isInteger(i.priority) ||
          i.priority < 0 ||
          i.priority > 100)
      ) {
        return {
          ok: false,
          error: `priority: ожидается целое 0..100, получено ${JSON.stringify(i.priority)}`,
        };
      }
      const payload: PayloadFor<"CREATE_TASK"> = {
        chatId,
        createdBy: ctx.agentKey,
        title,
        description: i.description == null ? null : String(i.description),
        assignedTo: i.assignedTo == null ? null : String(i.assignedTo),
        priority: typeof i.priority === "number" ? (i.priority as number) : 0,
        parentId: i.parentTaskId == null ? null : String(i.parentTaskId),
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "ASSIGN_TASK": {
      const taskId = String(i.taskId ?? "");
      const assignedTo = String(i.assignedTo ?? "");
      if (!taskId || !assignedTo)
        return { ok: false, error: "taskId+assignedTo required" };
      const payload: PayloadFor<"ASSIGN_TASK"> = { taskId, assignedTo };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "UPDATE_TASK_STATUS": {
      const taskId = String(i.taskId ?? "");
      const status = String(i.status ?? "") as TaskStatus;
      if (!taskId || !status)
        return { ok: false, error: "taskId+status required" };
      // Аудит 2026-08-28: `error` собирался с `?? null`, то есть поле было в
      // пейлоаде всегда — и `updateTaskStatus` на каждой смене статуса писал
      // NULL в колонку. Её охранная ветка («не передано — не затираем»)
      // отличает «не дали» от «дали пусто» ровно по `undefined` и на этом пути
      // не срабатывала ни разу. Соседнее `output` собрано правильно, второй
      // потребитель (miniapp-server) тоже — расхождение, а не решение.
      const payload: PayloadFor<"UPDATE_TASK_STATUS"> = {
        taskId,
        status,
        output: i.output,
        error: i.error == null ? undefined : String(i.error),
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "REQUEST_REVIEW": {
      const taskId = String(i.taskId ?? "");
      if (!taskId) return { ok: false, error: "taskId required" };
      const payload: PayloadFor<"REQUEST_REVIEW"> = {
        taskId,
        comment: i.comment == null ? undefined : String(i.comment),
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "SEND_PHOTO": {
      const url = typeof i.url === "string" ? i.url.trim() : "";
      const base64 = typeof i.base64 === "string" ? i.base64.trim() : "";
      if (!url && !base64)
        return { ok: false, error: "url or base64 is required" };
      if (url && base64)
        return { ok: false, error: "specify exactly one of url/base64" };
      // Аудит 2026-08-11: те же два поля, что у PUBLISH_TO_CHANNEL (см. выше),
      // и ровно те же две проверки — только здесь их не звали. Разница не в
      // строгости, а в том, что SEND_PHOTO идёт БЕЗ апрува: единственной
      // обратной связью о «data:image/png;base64,…» (модели ставят префикс
      // постоянно) был смещённый буфер, уехавший в чат битой картинкой.
      let source: { url: string } | { base64: string };
      if (url) {
        const urlError = validatePhotoUrl(url, "url");
        if (urlError) return { ok: false, error: urlError };
        source = { url };
      } else {
        const r = normalizePhotoBase64(base64, "base64");
        if ("error" in r) return { ok: false, error: r.error };
        source = { base64: r.value };
      }
      const payload: PayloadFor<"SEND_PHOTO"> = {
        chatId,
        source,
        caption: i.caption == null ? undefined : String(i.caption),
        replyToMessageId:
          typeof i.replyToMessageId === "number"
            ? (i.replyToMessageId as number)
            : undefined,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "SEND_DOCUMENT": {
      const content = typeof i.content === "string" ? i.content : "";
      const filename =
        typeof i.filename === "string" ? i.filename.trim() : "";
      if (!content) return { ok: false, error: "content is required" };
      if (!filename) return { ok: false, error: "filename is required" };
      // Telegram document limit is 50MB; cap agent-generated text well below.
      const MAX = 2_000_000;
      if (Buffer.byteLength(content, "utf8") > MAX)
        return { ok: false, error: "content too large (>2MB)" };
      // Разделители пути убирали, а кавычку и перевод строки — нет. Имя идёт
      // отсюда в `tgSendDocument` нетронутым, telegraf подставляет его в
      // заголовок части СЫРЫМ (`filename="${fileName}"`), а addPart пишет
      // заголовки с CRLF и без экранирования. Имя приходит от модели, то есть
      // его форму задаёт текст чата: `a.txt"<CRLF>Content-Type: text/html`
      // объявлял части чужой тип, одна кавычка обрывала имя у строгих парсеров.
      // Границу части подделать нельзя (32 случайных байта), поэтому дальше
      // заголовков одной части это не уходило — но и того хватало.
      const safeName = filename
        .replace(/[/\\]/g, "_")
        .replace(/["\u0000-\u001f\u007f]/g, "_")
        .slice(0, 200);
      const payload: PayloadFor<"SEND_DOCUMENT"> = {
        chatId,
        content,
        filename: safeName,
        caption: i.caption == null ? undefined : String(i.caption),
        replyToMessageId:
          typeof i.replyToMessageId === "number"
            ? (i.replyToMessageId as number)
            : undefined,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "CREATE_TEAM_CHANNEL": {
      const title = typeof i.title === "string" ? i.title.trim() : "";
      if (!title) return { ok: false, error: "title is required" };
      // Аудит 2026-08-12: здесь стояло `.map(String).filter(Boolean)` — любая
      // строка проходила как роль. Дальше action-dispatch резолвит роль в
      // @username бота через resolveAgent; неопознанная даёт undefined и молча
      // выпадает, а orchestrator добавляется всегда — значит usernames никогда
      // не пуст, отказа нет, и канал создаётся без запрошенной команды.
      // Соседние SPLIT_TASK/DELEGATE_TO_ROLE на том же входе отказывают
      // текстом `unknown role`. Создание канала необратимо, повтор плодит
      // второй — тем более незачем угадывать.
      const roles: string[] = [];
      // Аудит 2026-08-20: проверка ниже пряталась под Array.isArray, поэтому
      // `roles` неверного типа не отвергался, а молча становился пустым — и
      // весь разбор выше («создание канала необратимо, повтор плодит второй»)
      // не выполнялся. `roles: "smm,design"` — обычная ошибка формата у модели
      // — давала реальный публичный канал с одним админом-оркестратором, без
      // smm и design, и ok:true. Отсутствующий roles по-прежнему легален.
      if (i.roles != null && !Array.isArray(i.roles)) {
        return {
          ok: false,
          error: `roles: ожидается массив ролей, получено ${typeof i.roles}`,
        };
      }
      if (Array.isArray(i.roles)) {
        for (const r of i.roles as unknown[]) {
          if (typeof r !== "string" || !(ROLE_KEYS as readonly string[]).includes(r))
            return { ok: false, error: `unknown role: ${String(r)}` };
          roles.push(r);
        }
      }
      // Аудит 2026-08-28: здесь стояли `title.slice(0, 128)` и
      // `.slice(0, 255)` — обрезка без единого следа наружу. Отказ, а не рез:
      // название канала модель сократит сама, а обрубок в необратимо созданном
      // канале не откатить.
      if (title.length > CHANNEL_TITLE_MAX) {
        return {
          ok: false,
          error: `title: ${title.length} символов — лимит Telegram ${CHANNEL_TITLE_MAX}`,
        };
      }
      const about = i.about == null ? "" : String(i.about);
      if (about.length > CHANNEL_ABOUT_MAX) {
        return {
          ok: false,
          error: `about: ${about.length} символов — лимит Telegram ${CHANNEL_ABOUT_MAX}`,
        };
      }
      const payload: PayloadFor<"CREATE_TEAM_CHANNEL"> = {
        title,
        about,
        roles,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "PUBLISH_TO_CHANNEL": {
      const channelId =
        typeof i.channelId === "number" ? (i.channelId as number) : Number(i.channelId);
      const text = typeof i.text === "string" ? i.text : "";
      if (!Number.isFinite(channelId)) return { ok: false, error: "channelId required" };
      if (!text.trim() && !i.photoUrl && !i.photoBase64 && !i.coverPrompt)
        return { ok: false, error: "text или фото/coverPrompt обязательны" };
      // Под лимит текст подгонит fitToLimit — здесь только абсурдная граница,
      // и она отказ, а не молчаливая обрезка. См. PUBLISH_TEXT_MAX_RAW.
      if (text.length > PUBLISH_TEXT_MAX_RAW) {
        return {
          ok: false,
          error: `text: ${text.length} символов при пределе ${PUBLISH_TEXT_MAX_RAW} — в сообщение Telegram влезет ~4096 после разметки, сократите пост`,
        };
      }
      // Аудит 2026-08-07: обложка не проверялась ничем. photoUrl уходил в
      // Telegram любой строкой, photoBase64 — в Buffer.from(x,"base64"), а он
      // молча выбрасывает мусорные символы и на кривом входе отдаёт пустой
      // буфер. Оба случая ловились только 400-й от Telegram — то есть УЖЕ
      // после того, как человек одобрил публикацию. Проверяем здесь, чтобы
      // агент получил отказ сразу и переделал, не тратя апрув.
      const photoUrl = typeof i.photoUrl === "string" ? i.photoUrl.trim() : undefined;
      if (photoUrl) {
        const err = validatePhotoUrl(photoUrl);
        if (err) return { ok: false, error: err };
      }
      let photoBase64: string | undefined;
      if (typeof i.photoBase64 === "string" && i.photoBase64.trim()) {
        const r = normalizePhotoBase64(i.photoBase64);
        if ("error" in r) return { ok: false, error: r.error };
        photoBase64 = r.value;
      }
      // Аудит 2026-08-20: эти три поля резались `slice` молча — в прямом
      // противоречии с доктриной, выведенной на 300 строк выше (см. шапку
      // PUBLISH_TEXT_MAX_RAW): «либо целиком дальше, либо явный отказ».
      // coverTitle в 190 символов уезжал в генерацию обложки обрезанным на
      // полуслове, пост уходил в публичный канал с покалеченным заголовком на
      // картинке, а действие рапортовало успех. Отказ модель чинит сама.
      const cover = coverField(i, "coverPrompt", 4000);
      if ("error" in cover) return { ok: false, error: cover.error };
      const covTitle = coverField(i, "coverTitle", 160);
      if ("error" in covTitle) return { ok: false, error: covTitle.error };
      const covSub = coverField(i, "coverSubtitle", 160);
      if ("error" in covSub) return { ok: false, error: covSub.error };
      // Аудит 2026-08-27: было `i.coverStyle === "clean" ? "clean" : "illustrated"`
      // при `enum: ["illustrated","clean"]` в схеме — то есть `"minimal"`,
      // `"Clean"`, `"clean "` и `"строгий"` молча становились `illustrated`.
      // В публичный канал уходил яркий иллюстрированный баннер там, где агент
      // просил строгий; действие рапортовало `ok:true`, и узнать об этом
      // модель не могла — публикация approval-gated, переделывать поздно.
      // `GENERATE_IMAGE` на том же классе входа отказывает (`enumField`,
      // аудит 2026-08-21) — `coverStyle` из той правки просто выпал.
      const covStyle = enumField(i, "coverStyle", ["illustrated", "clean"] as const);
      if ("error" in covStyle) return { ok: false, error: covStyle.error };

      const payload: PayloadFor<"PUBLISH_TO_CHANNEL"> = {
        channelId,
        text,
        photoUrl,
        photoBase64,
        coverPrompt: cover.value,
        coverTitle: covTitle.value,
        coverSubtitle: covSub.value,
        coverStyle: covStyle.value ?? "illustrated",
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "GENERATE_SVG_IMAGE": {
      return buildGenerateSvgImagePayload(i, chatId) as
        | { ok: true; payload: PayloadFor<T> }
        | { ok: false; error: string };
    }
    case "GENERATE_IMAGE": {
      return buildGenerateImagePayload(i, chatId) as
        | { ok: true; payload: PayloadFor<T> }
        | { ok: false; error: string };
    }
    case "COMMENT_TASK": {
      const taskId = String(i.taskId ?? "");
      const textField = proseField(i.text, "text");
      if (!textField.ok) return textField;
      const text = textField.value;
      if (!taskId || !text)
        return { ok: false, error: "taskId+text required" };
      const payload: PayloadFor<"COMMENT_TASK"> = { taskId, text };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "WRITE_WIKI": {
      const scope = String(i.scope ?? "");
      const slug = String(i.slug ?? "").trim();
      const title = String(i.title ?? "").trim();
      const contentField = proseField(i.content, "content");
      if (!contentField.ok) return contentField;
      const content = contentField.value;
      if (!scope) return { ok: false, error: "scope is required" };
      if (!isValidScope(scope))
        return { ok: false, error: `unknown scope: ${scope}` };
      if (!slug) return { ok: false, error: "slug is required" };
      if (!title) return { ok: false, error: "title is required" };
      if (!content) return { ok: false, error: "content is required" };
      if (scope !== "_team" && scope !== ctx.agentKey) {
        return {
          ok: false,
          error: `forbidden: cannot write to scope '${scope}' (allowed: '_team' or own '${ctx.agentKey}')`,
        };
      }
      const payload: PayloadFor<"WRITE_WIKI"> = { scope, slug, title, content };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "SPLIT_TASK": {
      const title = String(i.title ?? "").trim();
      const rolesRaw = Array.isArray(i.roles) ? (i.roles as unknown[]).map((x) => String(x)) : [];
      if (!title) return { ok: false, error: "title is required" };
      if (rolesRaw.length === 0) return { ok: false, error: "roles must be non-empty" };
      for (const r of rolesRaw) {
        if (!(ROLE_KEYS as readonly string[]).includes(r))
          return { ok: false, error: `unknown role: ${r}` };
      }
      const payload: PayloadFor<"SPLIT_TASK"> = {
        title,
        description: i.description == null ? undefined : String(i.description),
        roles: rolesRaw,
        context: i.context == null ? undefined : String(i.context),
        chatId,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "DELEGATE_TO_ROLE": {
      const role = String(i.role ?? "");
      const task = String(i.task ?? "").trim();
      if (!role || !(ROLE_KEYS as readonly string[]).includes(role))
        return { ok: false, error: `unknown role: ${role}` };
      if (!task) return { ok: false, error: "task is required" };
      const payload: PayloadFor<"DELEGATE_TO_ROLE"> = {
        role,
        task,
        context: i.context == null ? undefined : String(i.context),
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "SPAWN_ROLE": {
      const name = String(i.name ?? "").trim();
      const promptField = proseField(i.system_prompt, "system_prompt");
      if (!promptField.ok) return promptField;
      const systemPrompt = promptField.value;
      if (!name) return { ok: false, error: "name is required" };
      if (!systemPrompt.trim()) return { ok: false, error: "system_prompt is required" };
      const provider = i.provider == null ? undefined : String(i.provider).trim().toLowerCase();
      if (provider !== undefined && !["internal", "claude", "codex"].includes(provider)) {
        return { ok: false, error: `unknown role provider: ${provider}` };
      }
      const payload: PayloadFor<"SPAWN_ROLE"> = {
        name,
        system_prompt: systemPrompt,
        task_hint: i.task_hint == null ? undefined : String(i.task_hint),
        provider: provider as PayloadFor<"SPAWN_ROLE">["provider"],
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "LIST_RECENT_MESSAGES": {
      const chat_id =
        typeof i.chat_id === "number"
          ? (i.chat_id as number)
          : typeof i.chatId === "number"
            ? (i.chatId as number)
            : undefined;
      const since = typeof i.since === "number" ? (i.since as number) : undefined;
      const limit = typeof i.limit === "number" ? (i.limit as number) : undefined;
      const kindsRaw = Array.isArray(i.kinds)
        ? (i.kinds as unknown[]).map((x) => String(x))
        : undefined;
      const allowedKinds = new Set(["text", "service", "all"]);
      // Аудит 2026-08-20: фильтр молча выбрасывал нераспознанные значения, а
      // список целиком из неизвестных схлопывался в undefined — и ниже по
      // стеку подставлялся дефолт ["service"] (dispatch/misc.ts:78). Модель,
      // запросившая kinds: ["user","agent"], получала служебные сообщения,
      // ok:true и ни одного намёка, что фильтр подменён; пустоту она читает
      // как «в чате ничего не было». Отказ дешевле молчаливой подмены.
      const badKinds = kindsRaw?.filter((k) => !allowedKinds.has(k)) ?? [];
      if (badKinds.length) {
        return {
          ok: false,
          error: `kinds: неизвестные значения ${badKinds.join(", ")} (допустимы: text, service, all)`,
        };
      }
      const kinds = kindsRaw as
        | Array<"text" | "service" | "all">
        | undefined;
      const payload: PayloadFor<"LIST_RECENT_MESSAGES"> = {
        chat_id,
        since,
        kinds: kinds && kinds.length > 0 ? kinds : undefined,
        limit,
      };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "MAC_RUN_CLAUDE": {
      const project = String(i.project ?? "").trim();
      const promptField = proseField(i.prompt, "prompt");
      if (!promptField.ok) return promptField;
      const prompt = promptField.value;
      const mode = String(i.mode ?? "") as "ask" | "accept_edits" | "plan" | "auto" | "bypass";
      if (!project) return { ok: false, error: "project is required" };
      if (!prompt.trim()) return { ok: false, error: "prompt is required" };
      const validModes = ["ask", "accept_edits", "plan", "auto", "bypass"];
      if (!validModes.includes(mode))
        return { ok: false, error: `mode must be one of: ${validModes.join(", ")}` };
      const payload: PayloadFor<"MAC_RUN_CLAUDE"> = { project, prompt, mode };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "SCHEDULE_POST": {
      const channel = String(i.channel ?? "").trim();
      const contentField = proseField(i.content, "content");
      if (!contentField.ok) return contentField;
      const content = contentField.value.trim();
      // Схема говорила «Unix timestamp», а это по общему соглашению СЕКУНДЫ —
      // и модели их и присылали. Сравнение же шло с Date.now(), то есть с
      // миллисекундами: честное «через час» (≈1.79e9) всегда меньше 1.78e12 и
      // получало отказ «timestamp в прошлом» для будущего времени. Единицы не
      // пересекаются: меньше 1e11 в миллисекундах — это 1973 год, будущим оно
      // быть не может, значит это секунды.
      const raw =
        typeof i.scheduledAt === "number" && Number.isFinite(i.scheduledAt)
          ? (i.scheduledAt as number)
          : 0;
      const scheduledAt = raw > 0 && raw < 1e11 ? Math.round(raw * 1000) : raw;

      if (!channel) return { ok: false, error: "channel is required" };
      if (!content) return { ok: false, error: "content is required" };
      // Аудит 2026-09-11: у отложенного поста границы длины не было вовсе,
      // хотя публикуется он тем же PUBLISH_TO_CHANNEL и упрётся в тот же
      // предел — только через неделю и уже после одобрения владельцем.
      // Отказ здесь стоит одной строки в чате, отказ там — сорванной
      // публикации, о которой никто не узнает. Предел тот же и по той же
      // причине, см. PUBLISH_TEXT_MAX_RAW.
      if (content.length > PUBLISH_TEXT_MAX_RAW) {
        return {
          ok: false,
          error: `content: ${content.length} символов при пределе ${PUBLISH_TEXT_MAX_RAW} — в сообщение Telegram влезет ~4096 после разметки, сократите пост`,
        };
      }
      if (!scheduledAt || scheduledAt <= Date.now()) {
        return { ok: false, error: "scheduledAt must be a future timestamp" };
      }

      const payload: PayloadFor<"SCHEDULE_POST"> = { channel, content, scheduledAt };
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    case "MAC_STOP": {
      // MAC_STOP has no parameters
      const payload: PayloadFor<"MAC_STOP"> = {};
      return { ok: true, payload: payload as PayloadFor<T> };
    }
    default:
      return { ok: false, error: `unknown tool: ${String(name)}` };
  }
}
