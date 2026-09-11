/**
 * Внутрипроцессный multi-hop handoff между ботами.
 *
 * Telegram не доставляет сообщения от бота к боту, поэтому если агент в своём
 * ответе упомянул @другого_бота — мы сами вызываем его LLM и публикуем ответ
 * от его токена. Глубина ограничена `MAX_HANDOFF_DEPTH`, повторные заходы в
 * того же агента в цепочке отсекаются через `visited`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { runWithTools } from "./tool-loop.ts";
import { runCompactor } from "./compactor.ts";
import {
  recordMessage,
  getRecentMessages,
  wikiIndex,
  wikiLog,
  wikiSearch,
  wikiRead,
} from "./memory.ts";
import { agentStopReason } from "./permissions.ts";
import { isTriggerDelivered } from "./trigger-delivery.ts";
import type { RunningBot, InputImage, InputDocument } from "./types.ts";
import { log, redactText } from "./log.ts";
import {
  sendChunked,
  messagePlainFits,
  HTML_MESSAGE_FITS,
} from "./telegram-chunking.ts";
import { sendWithHtml } from "./telegram-format.ts";
import {
  NARRATIVE_DISCIPLINE_BLOCK,
  DELEGATED_EXECUTION_MANDATE,
  buildMemorySystemText,
  buildWikiPagesSystemText,
  speakerLabel,
  defuseSpeakerLabels,
  defuseTriggerText,
} from "./agent-prompts.ts";

export const MAX_HANDOFF_DEPTH = 3;

/**
 * S1: потолок общего числа handoff-вызовов в одном ходе пользователя.
 *
 * Аудит 2026-08-08: константа жила приватно в orchestrator/message-handler.ts,
 * поэтому счётчик заводился ровно на одном пути — @-упоминании.
 *
 * Аудит 2026-08-12: этого оказалось мало. Сам счётчик до DELEGATE_TO_ROLE не
 * доходил, и handoff.ts заводил новый на каждое делегирование. Теперь его
 * заводит tool-loop (один на ход, любой вход), поэтому определение переехало в
 * constants.ts — ниже по графу импортов. Реэкспорт, чтобы не трогать
 * call-site'ы, которые берут потолок отсюда.
 */
import { HANDOFF_MAX_INVOCATIONS } from "./constants.ts";
export { HANDOFF_MAX_INVOCATIONS };

/**
 * Автономность Step 3: «производящие» роли, у которых результат делегированной
 * задачи — это артефакт через инструмент (картинка/код/спека/тест/пост). Им на
 * первой итерации форсим tool_choice:any, чтобы не отвечали «генерирую сейчас:»
 * без вызова. Текст/координация-роли (orchestrator, pm, product, copy, perm) —
 * НЕ форсим (их результат — это сам текст ответа).
 */
const MAKER_ROLES = new Set([
  "design",
  "frontend",
  "backend",
  "tgdev",
  "aieng",
  "qa",
  "smm",
]);

/**
 * «Производящие» роли эмитят артефакт ВНУТРИ tool-инпута (design — весь SVG
 * инлайн, frontend — HTML, backend — код). Это тысячи output-токенов; дефолтный
 * потолок 1500 обрывал tool_use → пустой ответ → делегат возвращал null
 * («дизайн завис»). Даём им крупный ceiling. Env MAKER_MAX_TOKENS.
 */
const MAKER_MAX_TOKENS = (() => {
  const n = Number.parseInt(process.env.MAKER_MAX_TOKENS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
})();

/** Парсит @username из текста и возвращает совпавших ботов (без `currentKey`). */
export function findHandoffTargets(
  text: string,
  currentKey: string,
  allBots: RunningBot[],
): RunningBot[] {
  const out: RunningBot[] = [];
  const seen = new Set<string>();
  const re = /@([A-Za-z0-9_]{3,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const handle = m[1].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    const target = allBots.find(
      (b) => b.username.toLowerCase() === handle && b.def.key !== currentKey,
    );
    if (target) out.push(target);
  }
  return out;
}

export interface HandoffDeps {
  anthropic: Anthropic | null;
  model: string;
  historyLimit: number;
  bots: RunningBot[];
}

export interface RespondAsOpts {
  target: RunningBot;
  chatId: string;
  triggerText: string;
  triggerAgentKey: string;
  depth: number;
  visited: Set<string>;
  triggerMessageId?: number;
  /**
   * C13 anti-pingpong: full ordered chain of agent keys that already participated
   * in this user-turn delegation (root first, ..., immediate parent last). The
   * dispatcher uses it to reject A→B→A loops with a clear error in tool_result.
   * When propagated into runWithTools, the target's own DELEGATE_TO_ROLE call
   * will see [...chain, target.def.key].
   */
  delegationChain?: string[];
  /**
   * Stage-A: triggering Telegram user_id исходного хода.
   *
   * Аудит 2026-08-13: этого поля тут не было, и делегат получал undefined.
   * Единственный потребитель — whitelist MAC_USER_IDS у MAC_RUN_CLAUDE/MAC_STOP,
   * а `isUserAllowed(undefined)` — тихий false. То есть делегированный запуск
   * на маке всегда отказывал, и вместе с ним отказывал аварийный MAC_STOP. Тот
   * же дефект уже чинили на хоп выше (SEC-audit LOW-2): поле дописывали, но
   * значения на этом пути не было.
   *
   * Прокидывание не расширяет круг людей: whitelist считается по исходному
   * пользователю. Расширяет оно круг ПОВОДОВ — поэтому делегированный ход
   * отдельно форсит approval, см. isDelegatedMacAction.
   */
  triggerUserId?: string;
  /**
   * P2 discussion-mode: max chain depth for this handoff. Defaults to
   * MAX_HANDOFF_DEPTH. When discussion mode is ON the message-handler passes a
   * higher value so more roles can weigh in. Still bounded by `visited` (each
   * role at most once → finite chain) regardless of this number.
   */
  maxDepth?: number;
  /**
   * S1 (security 2026-06-10): общий на весь user-turn счётчик handoff-вызовов,
   * разделяемый ВСЕМИ ветками рекурсии (одна ссылка). `visited` ограничивает
   * только линейный путь; budget режет суммарный fan-out при ветвлении.
   */
  budget?: { n: number; max: number };
  /**
   * Вложения хода пользователя (картинки, текстовые документы). Делегат должен
   * видеть их так же, как видел агент, которого позвали первым: в истории от
   * картинки остаётся строка «[image]», от документа — «[файл: имя]».
   * См. подробный замер в DispatchCtx.inputImages.
   */
  inputImages?: InputImage[];
  inputDocuments?: InputDocument[];
  /**
   * T-410 correlation id исходного хода.
   *
   * Аудит 2026-08-08: делегированный ход его не получал, и action-dispatch
   * заводил новый. Одно сообщение пользователя разваливалось в audit_logs на
   * несколько несвязанных request_id — сшить «оркестратор попросил backend,
   * backend опубликовал» можно было только по времени.
   */
  requestId?: string;
}

function tailLines(s: string, n: number): string {
  const lines = s.split("\n");
  return lines.slice(-n).join("\n");
}

/** Минимум полей истории чата, нужный сборке messages (см. memory.ChatRow). */
type HistoryRow = {
  text: string;
  is_bot?: number | boolean | null;
  agent_key?: string | null;
  from_name?: string | null;
};

/**
 * Собирает messages для хода делегата: история чата + гарантия, что сам текст
 * задачи до модели дошёл.
 *
 * Аудит 2026-08-08. Раньше триггер дописывался по условию «последним в истории
 * говорил сам делегат». На пути @-упоминания это работало случайно: триггером
 * там служит реплика соседней роли, а она уже лежит в истории (respondAs
 * пишет её через recordMessage), так что пропуск лишь убирал дубль.
 *
 * На пути DELEGATE_TO_ROLE текста задачи в истории нет вовсе: анонс
 * «🔀 orchestrator → backend: …» уходит сырым telegram.sendMessage без
 * recordMessage, а свой ответ делегирующий агент запишет только после конца
 * хода — то есть уже после возврата из делегата. Последней в истории лежала
 * реплика пользователя (role "user"), условие не срабатывало, и делегат
 * получал мандат «выполни делегированную задачу», ни разу эту задачу не
 * увидев, — то есть импровизировал по обрывку чата.
 *
 * Поэтому решаем не по роли последнего сообщения, а по факту доставки: нет
 * триггера в хвосте — дописываем; есть — молчим, чтобы не задваивать реплику
 * соседа на mention-пути.
 */
export function buildDelegateMessages(
  recent: HistoryRow[],
  targetKey: string,
  triggerAgentKey: string,
  triggerText: string,
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = recent.map((r) => {
    const own = !!r.is_bot && r.agent_key === targetKey;
    const speaker = r.agent_key ? `[${r.agent_key}]` : speakerLabel(r.from_name);
    // Тело реплики — тоже канал подделки метки, см. defuseSpeakerLabels.
    // Собственный текст (own) метки не несёт и в разметке не участвует.
    return {
      role: own ? "assistant" : "user",
      content: own ? r.text : `${speaker} ${defuseSpeakerLabels(r.text)}`,
    };
  });
  // Триггер обезвреживаем ДО сравнения: иначе доставленный триггер со
  // скобкой в начале строки разошёлся бы с собственной копией в истории.
  const trigger = defuseTriggerText(triggerText).trim();
  if (!isTriggerDelivered(messages, trigger)) {
    messages.push({
      role: "user",
      content: `[${triggerAgentKey}] (handoff) ${trigger}`.trim(),
    });
  }
  return messages;
}

/**
 * Итог делегированного хода.
 *
 * Аудит 2026-08-13: раньше здесь было `string | null`, и `null` означал сразу
 * пять разных вещей — цель на паузе, исчерпан бюджет вызовов, ход закончился
 * инструментом без текста, падение до отправки, падение после отправки. Дальше
 * по цепочке различить их было нечем, поэтому DELEGATE_TO_ROLE отвечал модели
 * `ok:true` во всех случаях, а доску задач закрывал `failed`. Оркестратор при
 * этом честно рапортовал в чат «готово» — по единственному признаку, который до
 * него доходил.
 *
 * `acted` — это успех, а не пустота: у ролей из MAKER_ROLES включён
 * forceFirstTool, и нормальный конец их хода — картинка или файл в чате без
 * единой строки текста (`runWithTools` возвращает "" ровно на `end_turn` без
 * текста, всем прочим причинам обрыва `explainEmptyStop` даёт непустое
 * объяснение, и оно уходит в чат как обычный ответ).
 */
export type HandoffOutcome =
  | { status: "answered"; reply: string }
  | { status: "acted" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Шов `respondAsImpl` — точка инъекции: его подменяют тесты и легаси-вызовы,
 * которые про новую форму не знают и возвращают текст или `null`. Приводим
 * такие значения к явному итогу в одном месте, а не размазываем `typeof` по
 * потребителям. Для `null` берётся `failed`, а не `acted`: старый контракт
 * различия не знал, и считать неизвестное успехом — ровно та ошибка, которую
 * эта правка чинит.
 */
export function normalizeHandoffOutcome(
  v: HandoffOutcome | string | null | undefined,
): HandoffOutcome {
  if (v && typeof v === "object" && "status" in v) return v;
  if (typeof v === "string" && v) return { status: "answered", reply: v };
  if (v === "") return { status: "acted" };
  return { status: "failed", reason: "delegate returned no result" };
}

export async function respondAs(
  opts: RespondAsOpts,
  deps: HandoffDeps,
): Promise<HandoffOutcome> {
  const {
    target,
    chatId,
    triggerText,
    triggerAgentKey,
    depth,
    visited,
    triggerMessageId,
    delegationChain,
    requestId,
    inputImages,
    inputDocuments,
    triggerUserId,
  } = opts;
  const maxDepth = opts.maxDepth ?? MAX_HANDOFF_DEPTH;
  // Аудит 2026-08-09: остановленная цель (paused или disabled). У DELEGATE_TO_ROLE есть свой обход через
  // pickAvailableAgent, но respondAs — это ещё и легаси-путь по @-упоминанию,
  // и любой прямой вызов. Через него агент на паузе выходил в чат чужими
  // руками: сам он молчит, а делегирование его будит. Затыкаем в воронке.
  const targetStop = agentStopReason(target.def.key);
  if (targetStop) {
    log.info("[handoff] цель остановлена — вызов пропущен", {
      target: target.def.key,
      reason: targetStop,
      from: triggerAgentKey,
    });
    return {
      status: "skipped",
      reason: `роль ${target.def.key} остановлена (${targetStop})`,
    };
  }
  // S1: жёсткий потолок суммарных handoff-вызовов на user-turn (общий budget).
  // Если вызывающий счётчик не передал (путь DELEGATE_TO_ROLE — см. коммент к
  // HANDOFF_MAX_INVOCATIONS), заводим свой на это дерево: ниже он уходит во все
  // ветки, так что fan-out внутри делегата тоже ограничен.
  const budget = opts.budget ?? { n: 0, max: HANDOFF_MAX_INVOCATIONS };
  if (budget.n >= budget.max) {
    log.warn("[handoff] invocation budget exhausted — skipping", {
      target: target.def.key,
      n: budget.n,
      max: budget.max,
    });
    return {
      status: "skipped",
      reason: `исчерпан бюджет вызовов ролей на ход (${budget.max})`,
    };
  }
  budget.n += 1;
  // Build chain extension for the target's own runWithTools call. If no chain
  // was given (legacy callers / direct @-mention path), derive one from visited
  // by inserting triggerAgentKey first, then target.
  const chainForTarget: string[] = delegationChain
    ? [...delegationChain, target.def.key]
    : Array.from(new Set([triggerAgentKey, target.def.key]));
  const { anthropic, model, historyLimit, bots } = deps;
  // Точка невозврата: как только текст ушёл в чат, ход делегата состоялся, и
  // падение на послесловии (запись в историю, компактор, каскад по упоминаниям)
  // не должно превращаться в «роль не ответила». Раньше всё это лежало под одним
  // catch, который возвращал null: делегирование помечалось провалом ПОСЛЕ того
  // как ответ увидели в чате, и модель звала роль второй раз — второй платный
  // прогон и второе сообщение подряд.
  let deliveredReply: string | null = null;
  // Частичная доставка — отдельное состояние, и молчать о нём нельзя.
  // `sendChunked` бросает ПОСЛЕ того, как k из N частей уже видны в чате
  // (у юзербота на каждую часть свой FLOOD_WAIT-гвард, так что причина не
  // экзотическая). Без накопителя catch видит только исключение и `deliveredReply
  // === null`, то есть возвращает `{status:"failed"}`; в action-dispatch это
  // становится `delegate_failed: …`, модель делегирует роль заново, а self-diag
  // повторяет ход ещё раз через ~30с — и весь ответ дописывается ВТОРЫМ
  // экземпляром поверх уже видимой части 1. Копим доставленное здесь, как в
  // orchestrator/message-handler.ts.
  const deliveredParts: string[] = [];
  let lastPartSent: any;
  try {
    await target.bot.telegram.sendChatAction(chatId, "typing").catch(() => {});

    const recent = getRecentMessages(chatId, historyLimit);
    const teamIdx = wikiIndex("_team");
    const teamLog = tailLines(wikiLog("_team"), 30);
    const privIdx = wikiIndex(target.def.key);
    const hits = wikiSearch(triggerText, ["_team", target.def.key], 4);
    // Аудит 2026-08-10: содержимое вики уходило в system голым текстом —
    // см. WIKI_TRUST_BOUNDARY в lib/agent-prompts.ts.
    const hitPages = buildWikiPagesSystemText(
      hits.map((h) => ({
        scope: h.scope,
        slug: h.slug,
        body: wikiRead(h.scope, h.slug) ?? "",
      })),
    );

    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: target.def.system, cache_control: { type: "ephemeral" } },
      {
        // P1 дисциплина нарратива — единый источник lib/agent-prompts.ts
        // (раньше копия здесь была без 3-го буллета → делегаты получали слабее).
        type: "text",
        text: NARRATIVE_DISCIPLINE_BLOCK,
        cache_control: { type: "ephemeral" },
      },
      {
        // Шаг 1 автономности: форсим исполнение делегированной задачи в этом turn.
        type: "text",
        text: DELEGATED_EXECUTION_MANDATE,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: buildMemorySystemText({
          agentKey: target.def.key,
          teamIndex: teamIdx,
          privateIndex: privIdx,
          teamLog,
        }),
        cache_control: { type: "ephemeral" },
      },
      ...(hitPages ? [{ type: "text" as const, text: hitPages }] : []),
    ];

    const messages = buildDelegateMessages(
      recent,
      target.def.key,
      triggerAgentKey,
      triggerText,
    );

    const reply = await runWithTools({
      anthropic,
      model,
      system,
      messages,
      agentKey: target.def.key,
      chatId: Number(chatId),
      // S2 (security 2026-06-10): прокинуть botId, чтобы действия делегированного
      // агента шли через per-bot-per-chat rate-limit (раньше пропускался).
      botId: target.id,
      telegram: target.bot.telegram,
      triggerMessageId,
      // C10: keep the delegate-chain working when the target itself calls
      // DELEGATE_TO_ROLE — forward the resolver and deps bundle.
      resolveAgent: (key) => bots.find((b) => b.def.key === key),
      handoffDeps: deps,
      delegationChain: chainForTarget,
      // S1: тот же счётчик уходит в ход делегата — иначе его собственные
      // DELEGATE_TO_ROLE открывали свежий запас на 16 вызовов каждый.
      handoffBudget: budget,
      // Вложения хода: делегат работает по той же картинке, что видел вызвавший.
      ...(inputImages?.length ? { inputImages } : {}),
      ...(inputDocuments?.length ? { inputDocuments } : {}),
      // Тот же request_id, что у хода, который делегировал: иначе цепочку не сшить.
      requestId,
      // Исходный пользователь хода — по нему считается whitelist MAC_USER_IDS.
      // Без этой строки делегат терял его и получал тихий forbidden.
      triggerUserId,
      // Step 3: заставить «производящую» роль сразу вызвать инструмент.
      forceFirstTool: MAKER_ROLES.has(target.def.key),
      // Крупный потолок токенов makers (SVG/HTML/код в tool-инпуте не должны рваться).
      maxTokens: MAKER_ROLES.has(target.def.key) ? MAKER_MAX_TOKENS : undefined,
    });
    // Пусто здесь — это `end_turn` без текста, то есть ход, закрытый
    // инструментом. Отправлять в чат нечего, но и провалом это не является.
    if (!reply) return { status: "acted" };

    const sent = await sendChunked(
      // T-fmt: delegated agents now also render Markdown → Telegram HTML (was raw
      // text — only the orchestrator path had formatting). Plain-text fallback on
      // a parse error keeps delivery safe.
      (t) =>
        sendWithHtml(
          (text, pm) =>
            target.bot.telegram.sendMessage(
              chatId,
              text,
              pm ? { parse_mode: pm } : undefined,
            ),
          t,
          // Предикат, а не число: третий параметр `sendWithHtml` — это мерка
          // «влезает ли плейн-фолбэк», и она вызывается как функция.
          messagePlainFits,
        ),
      reply,
      (s, part) => {
        deliveredParts.push(part);
        lastPartSent = s;
      },
      // Части шлются с parse_mode: HTML, значит и мерить их надо по видимой
      // длине. Плейн-фолбэк прикрыт messagePlainFits выше.
      HTML_MESSAGE_FITS,
    );
    deliveredReply = reply;
    // Аудит 2026-09-11: тут стояли первые 80 символов ответа открытым
    // текстом — ровно то, что на прямом пути закрыли аудиты 2026-08-12 и
    // 2026-08-29. Ответ делегата такой же пересказ приватной переписки, как
    // и ответ орхестратора (`[out]` с redactText в message-handler.ts), а
    // восемьдесят символов — типичное сообщение целиком. Каскад по
    // упоминаниям заводит эту строку на каждый хоп, на уровне info, то есть
    // в journalctl на проде. Пишем симметрично со строкой `[out]`.
    log.info(
      `[handoff-out][${target.def.key}] chat=${chatId} text=${redactText(reply)}`,
    );

    recordMessage({
      chatId,
      agentKey: target.def.key,
      isBot: true,
      fromUserId: target.id.toString(),
      fromName: target.username,
      text: reply,
      ts: (sent?.date ?? Math.floor(Date.now() / 1000)) * 1000,
      // P2 dup-fix (2026-06-09): pass the sent message_id so the userbot's later
      // observation of THIS same message dedups via OR IGNORE on
      // (chat_id, tg_message_id). Without it, delegated-agent replies were
      // recorded twice ([pm]/[backend] + userbot copy).
      tgMessageId: sent?.message_id,
      transport: "bot_api",
    });

    const recentSummary = recent
      .slice(-10)
      .map((r) => {
        const who = r.agent_key ? `[${r.agent_key}]` : speakerLabel(r.from_name);
        return `${who} ${defuseSpeakerLabels(r.text).slice(0, 200)}`;
      })
      .join("\n");
    runCompactor(anthropic, {
      agentKey: target.def.key,
      chatId,
      userText: triggerText,
      agentReply: reply,
      recentContext: recentSummary,
    });

    if (depth < maxDepth) {
      const next = findHandoffTargets(reply, target.def.key, bots).filter(
        (t) => !visited.has(t.def.key),
      );
      for (const t of next) {
        const newVisited = new Set(visited);
        newVisited.add(t.def.key);
        void respondAs(
          {
            target: t,
            chatId,
            triggerText: reply,
            triggerAgentKey: target.def.key,
            depth: depth + 1,
            visited: newVisited,
            triggerMessageId,
            maxDepth,
            budget, // S1: тот же общий счётчик на все ветки
            // Аудит 2026-08-08: следующий хоп терял и цепочку, и request_id.
            // Без chain C13-детектор циклов на глубине >1 видел только
            // `visited` и терял порядок, а без requestId ход уезжал в
            // audit_logs под новым идентификатором — «оркестратор попросил
            // backend, backend позвал qa» переставало сшиваться (T-410).
            // chainForTarget уже заканчивается текущим target, а respondAs
            // допишет t сам — поэтому передаём именно его.
            delegationChain: chainForTarget,
            requestId,
            // И на следующий хоп: пользователь хода один на всю цепочку.
            triggerUserId,
            inputImages,
            inputDocuments,
          },
          deps,
        );
      }
      if (next.length) {
        log.info(
          `[handoff][${target.def.key}] d=${depth}→${depth + 1} → ${next.map((t) => t.def.key).join(", ")}`,
        );
      }
    } else {
      const skipped = findHandoffTargets(reply, target.def.key, bots).filter(
        (t) => !visited.has(t.def.key),
      );
      if (skipped.length) {
        log.info(
          `[handoff][${target.def.key}] d=${depth} max — skip ${skipped.map((t) => t.def.key).join(", ")}`,
        );
      }
    }
    // Шаг 2: вернуть текст ответа делегата — чтобы оркестратор увидел результат
    // в tool_result DELEGATE_TO_ROLE и передал его следующему шагу пайплайна.
    return { status: "answered", reply };
  } catch (e) {
    const reason = (e as Error)?.message ?? String(e);
    if (deliveredReply !== null) {
      log.error(`[handoff-post-err][${target.def.key}]`, { error: reason });
      return { status: "answered", reply: deliveredReply };
    }
    if (deliveredParts.length) {
      // Дошло k из N: side-effect состоялся наполовину. В историю пишем ровно
      // то, что реально видно в чате, а наверх отдаём «ответил» + словами, что
      // остаток не ушёл. Формулировка — та же, что у partialSendFailure в
      // dispatch/telegram.ts: слепой повтор дублирует уже доставленное, поэтому
      // остаток дописывает человек, а не второй прогон роли.
      const partial = deliveredParts.join("\n\n");
      log.warn(`[handoff-partial][${target.def.key}]`, {
        chatId,
        parts: deliveredParts.length,
        error: reason,
      });
      recordMessage({
        chatId,
        agentKey: target.def.key,
        isBot: true,
        fromUserId: target.id.toString(),
        fromName: target.username,
        text: partial,
        ts: (lastPartSent?.date ?? Math.floor(Date.now() / 1000)) * 1000,
        tgMessageId: lastPartSent?.message_id,
        transport: "bot_api",
      });
      return {
        status: "answered",
        reply:
          `${partial}\n\n[!] ${reason}. Части 1..${deliveredParts.length} уже ` +
          `доставлены — повтор их продублирует. Дошли остаток отдельным ` +
          `сообщением или сообщи человеку.`,
      };
    }
    log.error(`[handoff-err][${target.def.key}]`, { error: reason });
    return { status: "failed", reason };
  }
}
