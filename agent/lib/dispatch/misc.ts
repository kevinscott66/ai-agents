/**
 * Miscellaneous action handlers (wiki write, recent-messages listing,
 * content-calendar scheduling). Extracted from action-dispatch.ts for
 * T-112 modularization.
 *
 * Mirrors the tasks.ts / mac.ts pattern: only the runtime dispatch handlers
 * live here; the buildPayload validators intentionally remain inline in
 * action-dispatch.ts (they share the buildPayload closure context).
 */
import { db } from "../db.ts";
import { wikiWriteAsync } from "../memory-async.ts";
import { InvalidSlugError, ReservedSlugError } from "../memory.ts";
import type { UserbotHandle } from "../userbot.ts";
import type { PayloadByType } from "../action-payload.ts";
import { pinnedChatId, pinnedChatNote, type HandlerResult } from "./helpers.ts";

export type MiscHandlerResult = HandlerResult;

export interface MiscHandlerContext {
  agentKey: string;
  chatId: number;
  /**
   * Resolve the userbot handle for this agent (T-541 router-aware). Injected by
   * the caller so userbot resolution logic stays centralized in action-dispatch.
   *
   * Аудит 2026-08-28: ни один обработчик ЭТОГО модуля больше её не зовёт —
   * единственный вызов был в мёртвой ветке `LIST_RECENT_MESSAGES` (см. ниже).
   * Поле оставлено ради единой формы контекста с `dispatch/publish.ts` и
   * `dispatch/channel.ts`, где резолв настоящий; расхождение формы стоило бы
   * дороже, чем одно неиспользуемое поле.
   */
  resolveUserbot: () => Promise<UserbotHandle | null>;
}


export async function handleWriteWiki(
  payload: PayloadByType["WRITE_WIKI"],
  ctx: MiscHandlerContext,
): Promise<MiscHandlerResult> {
  const scope = String(payload.scope ?? "");
  const slug = String(payload.slug ?? "").trim();
  const title = String(payload.title ?? "").trim();
  const content = String(payload.content ?? "");
  if (!slug) return { ok: false, error: "slug is required" };
  if (!title) return { ok: false, error: "title is required" };
  if (!content) return { ok: false, error: "content is required" };
  // Scope guard: only own scope or "_team".
  if (scope !== "_team" && scope !== ctx.agentKey) {
    return {
      ok: false,
      error: `forbidden: cannot write to scope '${scope}' (allowed: '_team' or own '${ctx.agentKey}')`,
    };
  }
  try {
    await wikiWriteAsync({ scope, slug, title, content });
  } catch (e) {
    // Причина отдаётся текстом только здесь: на голое `invalid_slug` модель
    // повторяет ровно тот же slug — а системный промпт ей этот самый `index`
    // и показывает как раздел памяти.
    if (e instanceof ReservedSlugError) {
      return { ok: false, error: `reserved_slug: ${e.message}` };
    }
    if (e instanceof InvalidSlugError) {
      return { ok: false, error: "invalid_slug" };
    }
    throw e;
  }
  return { ok: true, result: { scope, slug, title } };
}

export async function handleListRecentMessages(
  payload: PayloadByType["LIST_RECENT_MESSAGES"],
  ctx: MiscHandlerContext,
): Promise<MiscHandlerResult> {
  // Пиннинг, а не resolveChatId: `chat_id` объявлен в схеме инструмента и
  // доходил сюда как есть, так что «покажи последние сообщения из чата -100…»
  // возвращало модели чужую переписку — включая ветку userbot'а ниже, которая
  // тянет живую историю Telegram по тому же id. Ровно та же дыра, что закрыли
  // у исходящих действий, только направленная внутрь.
  const chatId = pinnedChatId(payload.chat_id, ctx.chatId, "LIST_RECENT_MESSAGES");
  // Аудит 2026-08-28: пиннинг выше молчалив — он пишет в лог и возвращает свой
  // chatId, но наружу уходило `ok:true` с историей ДРУГОГО чата и без единого
  // признака подмены. У исходящих действий такая подмена хотя бы безобидна
  // («ушло не туда, куда просили»), а здесь модель получает текст, который
  // считает чужим, и делает по нему выводы о чате, которого не читала.
  const note = pinnedChatNote(payload.chat_id, ctx.chatId);
  // Аудит 2026-08-20: `since` из payload брали по одному `typeof === "number"`,
  // а NaN и Infinity — тоже числа. `JSON.parse('{"since":1e999}')` даёт ровно
  // Infinity, и `ts >= Infinity` возвращает ноль строк без единого признака,
  // что фильтр был бессмысленным.
  if (payload.since !== undefined && !Number.isFinite(payload.since)) {
    return {
      ok: false,
      error: `since must be a finite unix-timestamp (ms), got '${String(payload.since)}'`,
    };
  }
  const since = typeof payload.since === "number" ? payload.since : 0;
  const kindsRaw =
    Array.isArray(payload.kinds) && payload.kinds.length > 0 ? payload.kinds : ["service"];
  // Аудит 2026-08-20: нераспознанный вид уезжал в ветку `AND 0` ниже, то есть в
  // SQL, который заведомо не вернёт ни строки, и наружу шло `ok:true, count:0`.
  // Валидатора у этого payload нет (в action-dispatch он кастится напрямую),
  // так что до сюда доезжает что угодно, что написала модель.
  //
  // Для модели пустая выдача неотличима от «таких сообщений в чате нет» — а
  // инструмент нужен ровно затем, чтобы найти message_id системных сообщений
  // перед DELETE_MESSAGE. `kinds:['system']` (описание инструмента само зовёт их
  // «системные») или `['SERVICE']` (сравнение регистрозависимое) давали
  // уверенный вывод «удалять нечего».
  //
  // Частично распознанный список — тоже отказ: молча выполнить половину запроса
  // хуже, чем не выполнить его вовсе, потому что о потере никто не узнает.
  const KNOWN_KINDS = ["service", "text", "all"];
  const unknownKinds = kindsRaw.filter((k) => !KNOWN_KINDS.includes(k as string));
  if (unknownKinds.length > 0) {
    return {
      ok: false,
      error:
        `unknown kinds: ${unknownKinds.map((k) => JSON.stringify(k)).join(", ")}` +
        ` — допустимы только 'service', 'text', 'all'`,
    };
  }
  const wantAll = kindsRaw.includes("all");
  const wantService = wantAll || kindsRaw.includes("service");
  const wantText = wantAll || kindsRaw.includes("text");
  const rawLimit = typeof payload.limit === "number" ? payload.limit : 50;
  const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)));

  interface MsgRow {
    id: number;
    chat_id: string;
    agent_key: string | null;
    is_bot: number;
    from_name: string | null;
    text: string;
    ts: number;
    tg_message_id: number | null;
  }
  // Аудит 2026-08-09: `limit` применялся ДО отбора по kinds, а не после.
  // Порядок был «взять limit*2 строк → обрезать до limit → отфильтровать по
  // kinds», и фильтр мог только уменьшить выдачу. В живом чате свежий хвост —
  // это болтовня, а kinds по умолчанию ['service']: запросив 50 строк, модель
  // получала две (или ноль) и делала вывод, что сервисных сообщений нет — при
  // том что они лежали в уже вытащенных, но отброшенных строках. Схема
  // инструмента обещает «сколько строк вернуть», так что limit должен считать
  // ПОДХОДЯЩИЕ строки. Отбор по виду уезжает в SQL — тогда LIMIT их и считает.
  //
  // `substr(...) = '[service]'` вместо LIKE намеренно: LIKE в SQLite
  // нечувствителен к регистру для ASCII, а код ниже сравнивал через
  // startsWith — расхождение дало бы разный ответ на «[SERVICE] …».
  const kindClause = wantService && wantText
    ? ""
    : wantService
      ? " AND substr(text, 1, 9) = '[service]'"
      : " AND substr(text, 1, 9) <> '[service]'";
  // Ветки «ни один вид не распознан» здесь больше нет: непонятый kinds
  // отбивается выше отказом. Раньше он приезжал сюда как ` AND 0`.
  // Аудит 2026-08-28: здесь брали `LIMIT limit * 2` («Fetch more to account for
  // deduplication») и дальше выкидывали повторы по tg_message_id вручную.
  // Придумано это в T-544, ДО миграции 030, которая создала
  // `CREATE UNIQUE INDEX idx_messages_dedup ON messages(chat_id, tg_message_id)
  // WHERE tg_message_id IS NOT NULL`. Запрос фильтрует по одному chat_id —
  // значит ненулевые tg_message_id в его выдаче уникальны структурно, и цикл не
  // мог пропустить ни строки ни разу; строки с NULL он и так не трогал.
  // Половина вытащенного из SQLite выбрасывалась гарантированно, а код рядом
  // утверждал, что дубли бывают. Индекс проверен на живой БД, дублей ноль;
  // предпосылка держится тестом audit-2026-08-28-list-recent-dedup-dead.
  const rows = db
    .prepare(
      `SELECT id, chat_id, agent_key, is_bot, from_name, text, ts, tg_message_id
       FROM messages WHERE chat_id = ? AND ts >= ?${kindClause}
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
    )
    .all(String(chatId), since, limit) as MsgRow[];

  const messages = rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    from_name: r.from_name,
    is_bot: !!r.is_bot,
    text_preview: (r.text ?? "").slice(0, 200),
    agent_key: r.agent_key ?? undefined,
    tg_message_id: r.tg_message_id,
  }));
  // Аудит 2026-08-28: здесь стояло «примешивание» истории через userbot —
  // `await ctx.resolveUserbot()`, а следом условие `typeof ubIter === "function"`.
  // Условие всегда ложно: ни `buildHandle`, ни `NOOP_HANDLE` не объявляют
  // `iterMessages`, и во всём репозитории этого имени больше нет. Соседний
  // комментарий сам это признавал («current built-in handle does not — kept as
  // a hook for future extension»).
  //
  // Цена мёртвого хука была не нулевой: `resolveUserbot` у роутера — это
  // `startSession` → `startUserbot`, то есть настоящий gramjs-коннект по сети,
  // поднимаемый лениво при первом обращении. Read-only чтение собственной
  // SQLite открывало MTProto-сессию, ничего из неё не читало и оставляло жить.
  //
  // Внутри блока был ещё и дедупликатор на разных пространствах номеров:
  // `seen` наполнялся из `messages.id` (autoincrement SQLite), а сверялся с
  // `m.id` из Telegram. Совпадение там было бы случайным — ушло вместе с
  // блоком.
  return {
    ok: true,
    // chat_id отдаём всегда, а не только при подмене: выдача обязана называть
    // свой источник сама, иначе «заметки нет» и «заметку забыли добавить»
    // выглядят одинаково.
    result: {
      chat_id: chatId,
      messages,
      count: messages.length,
      ...(note ? { note } : {}),
    },
  };
}

/**
 * SCHEDULE_POST кладёт СТРОКУ В КАЛЕНДАРЬ. Он ничего не отправляет — публикатора
 * в проекте нет: `content_calendar.sent_at` и статус 'sent' встречаются только
 * в миграции 022, ни один планировщик таблицу не читает (аудит 2026-08-04).
 * Читатели у неё ровно два — LIST_SCHEDULED_POSTS и CANCEL_SCHEDULED_POST.
 *
 * Это меняет не реализацию, а формулировки: описание инструмента обещало
 * «запланировать отправку», и модель по ok:true честно рапортовала в чат, что
 * пост уйдёт в 10:00. Он не уходил никогда. Публикация остаётся за
 * PUBLISH_TO_CHANNEL под апрувом — автономный публикатор здесь заводить нельзя
 * (постинг без человека в контуре), поэтому чинится обещание, а не поведение.
 */
export function handleSchedulePost(
  payload: PayloadByType["SCHEDULE_POST"],
  ctx: MiscHandlerContext,
): MiscHandlerResult {
  // Владелец календаря — smm (и лид как контролёр). Ровно та же пара, что у
  // CANCEL_SCHEDULED_POST, комментарий которого прямо ссылается на «SCHEDULE_POST
  // ownership: only smm/orchestrator» — при том, что у самого SCHEDULE_POST
  // проверки не было ни в коде, ни в ROLE_EXPOSED_TOOLS. Асимметрия была
  // рабочей: любая из 12 ролей заводила запись, а увидеть и отменить её могли
  // только двое.
  if (ctx.agentKey !== "smm" && ctx.agentKey !== "orchestrator") {
    return {
      ok: false,
      error: "forbidden: SCHEDULE_POST restricted to smm/orchestrator",
    };
  }
  const id = crypto.randomUUID();
  const now = Date.now();

  // Validate scheduled time is in future
  if (payload.scheduledAt <= now) {
    return { ok: false, error: "scheduled time must be in the future" };
  }

  // Store the scheduled post. T-722: stamp chat_id so LIST/CANCEL can scope to
  // the creating chat (no cross-tenant enumerate/cancel).
  db.prepare(`
    INSERT INTO content_calendar (id, channel, scheduled_at, payload, status, created_at, chat_id)
    VALUES (?, ?, ?, ?, 'scheduled', ?, ?)
  `).run(id, payload.channel, payload.scheduledAt, JSON.stringify({ content: payload.content }), now, ctx.chatId);

  return {
    ok: true,
    result: {
      id,
      channel: payload.channel,
      scheduledAt: payload.scheduledAt,
      // Статус — тот же, что в строке и в выдаче LIST_SCHEDULED_POSTS;
      // расхождение меток запутало бы модель сильнее, чем помогло.
      status: "scheduled",
      autoPublish: false,
      note: "запись в календаре: автопубликации нет, в назначенное время пост нужно отправить через PUBLISH_TO_CHANNEL",
    },
  };
}
