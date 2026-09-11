/**
 * Anthropic tool_use loop: на каждом шаге пушим ассистент-блок в messages,
 * выполняем все tool_use → пушим user-сообщение с tool_result, повторяем.
 * Прерываемся, когда stop_reason !== 'tool_use' или превышен лимит. Одно
 * исключение: 'pause_turn' — серверный веб-поиск приостановил ход, и цикл
 * идёт дальше тем же контекстом (аудит 2026-09-11: шапка про это молчала, и
 * из неё следовало, что запросов к API за ход ровно столько же, сколько
 * раундов с tool_use, — а именно на паузах и набегал лишний счёт).
 * Возвращаем сконкатенированный финальный text.
 */
import { getErrorMessage } from "./errors.ts";
import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, executeTool } from "./tools-schema.ts";
import { callAnthropic } from "./anthropic-client.ts";
import {
  webSearchTool,
  webCapabilityAllowed,
  webSearchRequestsUsed,
  webSearchRunBudget,
} from "./web-search.ts";
import { isToolExposedToRole } from "./permissions.ts";
import { log } from "./log.ts";
import { logToolCall } from "./audit.ts";
import {
  useAgentSdk,
  runViaAgentSdk,
  AgentSdkRunError,
  buildAttachmentBlocks,
  shouldFallbackToRaw,
} from "./agent-sdk-runtime.ts";
import { BudgetExceededError } from "./token-budget.ts";
import {
  CONTROL_TOOL_STATUSES,
  HANDOFF_MAX_INVOCATIONS,
  MAX_CALLS_PER_TOOL_PER_RUN,
  MAX_CALLS_PER_TOOL_PER_RESPONSE,
} from "./constants.ts";


/**
 * Статусы, при которых инструмент отвечает `ok:false`, но НЕ провалился.
 *
 * Аудит 2026-08-28: `isError` выводился из одного лишь `ok === false`, а
 * formatGateResult (action-dispatch.ts) отдаёт `ok:false` ещё и на
 * `pending_approval` (действие ушло владельцу на согласование, строка в
 * approvals уже создана) и на `rate_limited` (есть retryInMs, ждать надо, а не
 * чинить). Модель получала `is_error: true`, читала это как провал и вызывала
 * тот же инструмент снова: MAX_CALLS_PER_TOOL_PER_RESPONSE не мешает — вызов в
 * каждом ответе один, — так что до MAX_CALLS_PER_TOOL_PER_RUN (8) набегало до
 * восьми карточек согласования на одну просьбу человека. action-dispatch.ts
 * называет ровно этот сценарий («плодя дубликаты»), но закрывает лишь свою
 * ветку read-back; общий случай жил здесь.
 */
// Сам набор переехал в constants.ts: он нужен и SDK-пути тоже, а прямой
// импорт между tool-loop.ts и agent-sdk-runtime.ts — цикл.

// Потолок токенов на ОДИН ответ агента. Был 700 (~2800 симв) — длинные ответы
// обрывались на полуслове в группе. Это ceiling: короткие ответы не дорожают
// (модель сама останавливается на end_turn), длинные перестают резаться.
// Настраивается env MAX_REPLY_TOKENS.
const DEFAULT_MAX_REPLY_TOKENS = (() => {
  const n = Number.parseInt(process.env.MAX_REPLY_TOKENS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 1500;
})();

// P0 (2026-06-09): был 4 — катастрофически мало. Цепочка
// SEARCH_WIKI→READ_WIKI→WRITE_WIKI + делегирование легко превышала 4 раунда,
// агент обрывался и постил буквальное «лимит инструментов» в чат. 14 даёт
// запас для реальной многошаговой работы. Настраивается env MAX_TOOL_ITERS.
// (Аудит 2026-08-20: этот абзац стоял над DEFAULT_MAX_REPLY_TOKENS — то есть
// объяснял env MAX_TOOL_ITERS у константы, которая читает MAX_REPLY_TOKENS.)
const MAX_TOOL_ITERS = (() => {
  const n = Number.parseInt(process.env.MAX_TOOL_ITERS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
})();

/**
 * Первое сообщение запроса обязано быть от роли "user".
 *
 * Аудит 2026-08-12: сборщики истории (buildDelegateMessages в handoff.ts,
 * orchestrator/message-handler.ts) размечают строку чата как "assistant", если
 * её написал сам отвечающий агент. Про хвост оба заботятся, про голову — никто,
 * а голова окна — это просто N-е с конца сообщение чата. Стоит агенту вести
 * ветку (ответил, окно съехало) — и первым в срезе лежит его собственный текст.
 *
 * Messages API на такое отвечает 400, ход падает целиком, ошибка ловится
 * наверху и логируется — пользователь не получает НИЧЕГО. И бьёт это по
 * raw-пути, то есть по откату после сбоя Agent SDK: отказывает ровно тот путь,
 * который должен спасать.
 *
 * Чиним в одной точке — здесь, а не в каждом сборщике: через неё проходят все
 * raw-вызовы, и следующий сборщик истории не заведёт третью копию правила.
 * Ведущие "assistant" срезаем (это прошлые реплики самого агента, задача
 * приходит хвостом). Если после среза не остаётся ничего — пустой messages это
 * тот же 400, — оставляем последнее сообщение, переразметив его как "user":
 * лучше агенту прийти со своей же репликой на входе, чем промолчать.
 */
export function normalizeLeadingRole(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const first = messages.findIndex((m) => m.role === "user");
  if (first === 0) return messages;
  if (first > 0) {
    log.debug("[tool-loop] история начиналась с реплики агента — голова срезана", {
      dropped: first,
    });
    return messages.slice(first);
  }
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  log.debug("[tool-loop] в истории нет ни одного user-сообщения", {
    kept: messages.length,
  });
  return [{ role: "user", content: last.content }];
}

export interface RunWithToolsOpts {
  /** Raw API client, absent when the process is subscription-only. */
  anthropic: Anthropic | null;
  model: string;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  agentKey: string;
  chatId: number;
  /** T-240: bot ID for per-bot-per-chat rate limiting */
  botId?: number;
  telegram?: import("telegraf").Telegram;
  triggerMessageId?: number;
  maxTokens?: number;
  /**
   * C7: ограничение набора tool'ов для этого вызова. По умолчанию (undefined)
   * передаются все TOOLS. Пустой массив — tool'ы не передаются вовсе
   * (модель отвечает только текстом). Иначе — фильтр по name.
   */
  allowedTools?: string[];
  /**
   * Internal capability boundary. Unlike `allowedTools`, which callers may use
   * to narrow a normal role turn, this allowlist is an executor-owned ceiling
   * that cannot be widened by the request. It is enforced both when tools are
   * exposed and when an unexpected tool_use reaches the raw loop.
   */
  capabilityAllowlist?: readonly string[];
  /**
   * C8: входящие картинки от пользователя (вложения в Telegram-сообщении).
   * Будут подмешаны в последний user-message как image content blocks
   * перед текстом — однократно, на первой итерации.
   */
  inputImages?: { mediaType: string; base64: string }[];
  /**
   * P1 (2026-06-09) READ_FILE: входящие текстовые файлы (вложения-документы
   * .md/.txt/.json/.csv и т.п.). Их содержимое подмешивается в последний
   * user-message как текстовые блоки перед текстом пользователя — однократно.
   */
  inputDocuments?: { filename: string; text: string }[];
  /** C10: resolver and deps for DELEGATE_TO_ROLE. */
  resolveAgent?: (role: string) => import("./types.ts").RunningBot | undefined;
  handoffDeps?: import("./handoff.ts").HandoffDeps;
  respondAsImpl?: (
    opts: import("./handoff.ts").RespondAsOpts,
    deps: import("./handoff.ts").HandoffDeps,
  ) => Promise<import("./handoff.ts").HandoffOutcome | string | null>;
  /**
   * C13 anti-pingpong: ordered chain of agent keys that already participated
   * in the current user-turn delegation (root first → current agent last).
   * Forwarded into ExecCtx so that DELEGATE_TO_ROLE can reject cycles.
   */
  delegationChain?: string[];
  /**
   * S1: общий на весь user-turn счётчик handoff-вызовов. Прокидывается в
   * ExecCtx, чтобы DELEGATE_TO_ROLE отдал его в respondAs, а не заводил свой.
   * См. handoff.ts:HANDOFF_MAX_INVOCATIONS.
   */
  handoffBudget?: import("./handoff.ts").HandoffBudget;
  /** Stage A: triggering Telegram user_id (for MAC_RUN_CLAUDE whitelist). */
  triggerUserId?: string;
  /** T-410: request-id propagated from ingress through every tool call. */
  requestId?: string;
  /**
   * Автономность Step 3: форсить вызов инструмента на первой итерации
   * (tool_choice:any). Ставится делегированным «производящим» ролям, чтобы они
   * сразу действовали (генерили/писали), а не отвечали «сейчас сделаю».
   */
  forceFirstTool?: boolean;
}

/**
 * Что вернуть, когда ход остановился без единого символа текста.
 *
 * `end_turn` оставляем пустым сознательно: это штатный конец хода, в котором
 * агент уже всё сказал инструментом (SEND_MESSAGE/SEND_DOCUMENT). Добавить
 * туда текст — значит продублировать сообщение в чате. Остальные причины
 * пустоты — сбой, о котором пользователь должен узнать.
 */
export function explainEmptyStop(stop: string | null | undefined): string {
  if (stop === "max_tokens") {
    return "Ответ не поместился в лимит длины и оборвался в самом начале. Переспроси покороче или по частям.";
  }
  if (stop === "refusal") {
    return "Модель отказалась отвечать на этот запрос.";
  }
  if (!stop || stop === "end_turn") return "";
  return `Ход оборвался без ответа (${stop}). Повтори запрос.`;
}

export async function runWithTools(opts: RunWithToolsOpts): Promise<string> {
  // S1: если вход не завёл общий счётчик (userbot, Mini App, планировщик,
  // mac-bridge — все они начинают собственный ход), заводим его здесь. Так ни
  // один вход не может «забыть» потолок: дерево делегирований этого хода
  // считается целиком, включая ветвление внутри делегатов.
  //
  // Аудит 2026-08-13: дефолт стоял НИЖЕ, за ранним возвратом ветки SDK, то
  // есть на боевом пути (USE_AGENT_SDK=true) не выполнялся вовсе. undefined
  // уезжал через tools-schema → action-dispatch в handoff.ts:248, а там такой
  // же `?? {n:0,max:...}` — и КАЖДЫЙ DELEGATE_TO_ROLE заводил собственный
  // счётчик с полным запасом. Общий потолок на ход исчезал: до восьми
  // независимых поддеревьев по HANDOFF_MAX_INVOCATIONS вызовов вместо одного.
  const handoffBudget = opts.handoffBudget ?? {
    n: 0,
    max: HANDOFF_MAX_INVOCATIONS,
  };
  // Подписочный путь (Claude Agent SDK, OAuth) вместо raw-SDK (API-кредиты).
  // При наличии OAuth это также дефолт; USE_AGENT_SDK=false явно возвращает
  // raw-путь для аварийной совместимости.
  if (useAgentSdk()) {
    try {
      return await runViaAgentSdk({ ...opts, handoffBudget });
    } catch (e) {
      // Бюджет исчерпан — оркестратор глотает эту ошибку штатно, откат только
      // сожжёт ещё один вызов ради того же отказа.
      if (e instanceof BudgetExceededError) throw e;
      if (!shouldFallbackToRaw(e, Boolean(opts.anthropic))) {
        const partial = e instanceof AgentSdkRunError ? e.partialText : "";
        log.error("[agent-sdk] НЕ откатываемся: ход уже дал побочные эффекты", {
          agentKey: opts.agentKey,
          subtype: e instanceof AgentSdkRunError ? e.subtype : undefined,
          error: getErrorMessage(e),
        });
        return (
          partial ||
          (!opts.anthropic
            ? "Claude Code не смог завершить ход. Повторный запуск через Anthropic API отключён, потому что настроена subscription-only авторизация."
            : "Не смог довести ответ до конца — часть действий уже выполнена, повторять их не стал. Скажи, если продолжить.")
        );
      }
      // Не переигрываем подписочный ход через API, если raw-клиент не задан.
      // Это нормальный режим при истёкшей API-квоте: ошибка должна остаться
      // видимой, а не превратиться в второй неавторизованный запрос.
      if (!opts.anthropic) throw e;
      log.error("[agent-sdk] fallback to raw SDK after error", {
        agentKey: opts.agentKey,
        error: getErrorMessage(e),
      });
      // на ошибке Agent SDK — мягкий откат на raw-SDK (если есть кредиты)
    }
  }
  const {
    anthropic,
    model,
    system,
    agentKey,
    chatId,
    botId, // T-240: Add bot ID for per-bot-per-chat rate limiting
    telegram,
    triggerMessageId,
    maxTokens = DEFAULT_MAX_REPLY_TOKENS,
    allowedTools,
    inputImages,
    inputDocuments,
    resolveAgent,
    handoffDeps,
    respondAsImpl,
    delegationChain,
    triggerUserId,
    requestId,
    forceFirstTool,
  } = opts;
  if (!anthropic) {
    throw new Error(
      "Anthropic API client unavailable: configure CLAUDE_CODE_OAUTH_TOKEN or set USE_AGENT_SDK=false with ANTHROPIC_API_KEY",
    );
  }
  const messages = normalizeLeadingRole([...opts.messages]);

  // C8 + READ_FILE: подмешать входящие картинки И/ИЛИ текстовые файлы в
  // последний user-message ровно один раз, ДО первой итерации loop'а.
  const hasImg = !!(inputImages && inputImages.length > 0);
  const hasDocs = !!(inputDocuments && inputDocuments.length > 0);
  if ((hasImg || hasDocs) && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === "user" && typeof last.content === "string") {
      // Аудит 2026-08-11: сборка этих блоков жила здесь ВТОРОЙ копией — теми же
      // строками, что и в buildAttachmentBlocks, и с тем же дефектом (ограду
      // вокруг содержимого файла можно было закрыть изнутри). Правка в одном
      // файле не чинила второй, поэтому копия одна на оба пути.
      const blocks = buildAttachmentBlocks(
        last.content,
        inputImages,
        inputDocuments,
      );
      if (blocks) {
        messages[messages.length - 1] = {
          role: "user",
          content: blocks as Anthropic.ContentBlockParam[],
        };
      }
    }
  }
  const builtTools = (() => {
    const base =
      allowedTools === undefined
        ? TOOLS
        : allowedTools.length === 0
          ? undefined
          : TOOLS.filter((t) => allowedTools.includes(t.name));
    // T-723 (SEC-audit F5): per-role exposure — don't even OFFER sensitive tools
    // to roles that aren't allowed (defense-in-depth over the gate/handler checks).
    const exposed = base?.filter((t) => isToolExposedToRole(t.name, agentKey));
    if (!exposed || (allowedTools === undefined && opts.capabilityAllowlist === undefined)) {
      return exposed;
    }
    const capabilityAllowlist = opts.capabilityAllowlist
      ? new Set(opts.capabilityAllowlist)
      : null;
    return exposed.filter((t) => !capabilityAllowlist || capabilityAllowlist.has(t.name));
  })();
  /**
   * Пустой список и «списка нет» — это одно и то же состояние, и оно обязано
   * иметь одно представление.
   *
   * Аудит 2026-08-28: `[]` истинно, поэтому `if (toolsForCall)` ниже отправлял
   * в API `tools: []`, а следом `if (ws && req.tools)` доклеивал туда
   * web_search — то есть ход, у которого ВСЕ клиентские инструменты отсеяны
   * ролевой экспозицией или capabilityAllowlist, всё равно получал серверный
   * поиск. Финализирующий вызов при этом проверял `.length > 0` и с тем же
   * `[]` решал иначе — то есть два места расходились в том, что означает
   * пустой массив.
   *
   * Реальный вход — orchestrator/message-handler.ts: анти-дуп на подходящем
   * ходу передаёт `allowedTools: []` (строка «tools disabled for this turn» в
   * логе). Тот же `[]` собирается и фильтрами ниже, когда ролевая экспозиция
   * или capabilityAllowlist отсеивают всё до единого имени.
   */
  const toolsForCall = builtTools && builtTools.length > 0 ? builtTools : undefined;
  let lastText = "";
  /**
   * Сколько НАШИХ инструментов ход успел реально выполнить.
   *
   * Аудит 2026-08-28: `callAnthropic` — единственный незащищённый await в теле
   * цикла, и он бросает штатно: `checkBudget` зовётся на КАЖДОЙ итерации, а
   * расход пишется после каждого успешного вызова, так что потолок ловится
   * посреди хода — уже после того, как SEND_MESSAGE отправил сообщение или
   * PUBLISH_TO_CHANNEL выложил пост. Раньше отсюда улетала голая
   * BudgetExceededError, и replyForTurnError (message-handler.ts) по пустым
   * sideEffects/partialText отвечал «Дневной лимит исчерпан — вернусь после
   * сброса», то есть «я ничего не сделал». Человек шёл повторять руками то,
   * что бот уже сделал. На SDK-пути это починили 2026-08-21; raw-путь —
   * который включается ИМЕННО когда SDK-путь уже упал — остался голым.
   */
  let executedTools = 0;
  /**
   * Последний НЕПУСТОЙ текст за весь ход — отдельно от `lastText`.
   *
   * Аудит 2026-08-21: `lastText` перезаписывается на каждой итерации, в том
   * числе пустой строкой — а ход с tool_use сплошь и рядом идёт без текста.
   * Трём читателям `lastText` это и нужно: на ветках «модель закончила»
   * (stop_reason !== tool_use) и «tool_use без блоков» возвращать надо ровно
   * то, что модель сказала СЕЙЧАС, иначе старая реплика выдаётся за финальный
   * ответ.
   *
   * А вот последнему читателю — заглушке после исчерпания MAX_TOOL_ITERS —
   * нужно обратное: там `lastText` заведомо пуст (цикл дошёл до предела,
   * значит последняя итерация просила инструмент), и осмысленная реплика,
   * сказанная на третьей итерации, молча выбрасывалась. Замер: модель на
   * первой итерации говорит «Картинка готова, вот ссылка: …» и просит
   * инструмент; финализирующий вызов падает — вызывающий получает
   * «(достигнут предел шагов инструментов…)», а строчка со ссылкой,
   * уже оплаченная, пропадает.
   */
  let bestText = "";
  /**
   * Счётчик на ВЕСЬ ход, а не на ответ модели.
   *
   * Аудит 2026-08-13: C12 ниже заводит свою карту внутри итерации, поэтому
   * «не больше двух раз за ход» на деле означало «за ответ модели», а ходов в
   * цикле до MAX_TOOL_ITERS. Настоящий потолок выходил 28, и — что хуже —
   * типичная петля (один вызов на итерацию, четырнадцать итераций подряд) не
   * задевала охрану вообще: n никогда не доходило до 3.
   *
   * Две границы, а не замена одной другой: пачка из трёх вызовов в одном
   * ответе — это модель не подумав, её отбивает C12 сразу; восемь вызовов,
   * размазанных по ходу, — это разгон, его ловит эта.
   */
  const runCallCounts = new Map<string, number>();
  /**
   * Бюджет серверного веб-поиска на ВЕСЬ прогон.
   *
   * Аудит 2026-09-11: та же ошибка масштаба, что у `runCallCounts` выше, но
   * стоящая денег напрямую. `max_uses` у серверного инструмента Anthropic
   * действует на ОДИН HTTP-запрос, а свежий `webSearchTool()` приклеивался
   * перед каждым из до MAX_TOOL_ITERS запросов плюс к финализирующему — то
   * есть настоящий потолок был `WEB_SEARCH_MAX_USES × 15`, при дефолте 45
   * поисков вместо трёх. Усугубляла пауза: `pause_turn` порождает именно
   * серверный поиск, и каждая пауза гарантированно давала новый запрос с
   * новым нетронутым `max_uses`.
   *
   * Ни `token-budget.ts`, ни бакеты `rate-limits.ts` поисков не считают —
   * это единственное место, где перерасход вообще виден. Считаем по
   * `usage.server_tool_use.web_search_requests`, по которому считает и
   * биллинг; когда остаток дошёл до нуля, инструмент просто не приклеиваем.
   */
  const webSearchBudget = webSearchRunBudget();
  let webSearchUsed = 0;
  for (let i = 0; i < MAX_TOOL_ITERS; i++) {
    const req: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system,
      messages,
    };
    if (toolsForCall) req.tools = toolsForCall;
    // T-web: give agents Anthropic's server-side web_search when enabled (and the
    // agent already has tools). web_search is resolved server-side, so it never
    // surfaces a client-actionable tool_use — the loop below ignores it safely.
    // Аудит 2026-08-27: web_search приклеивался мимо capabilityAllowlist —
    // см. webCapabilityAllowed() в web-search.ts.
    const ws = webCapabilityAllowed("WebSearch", opts.capabilityAllowlist)
      ? webSearchTool(webSearchBudget - webSearchUsed)
      : null;
    if (ws && req.tools) req.tools = [...req.tools, ws];
    // Автономность Step 3: на ПЕРВОЙ итерации делегированного «производящего»
    // turn'а ФОРСИМ вызов инструмента (tool_choice:any) — иначе sonnet часто
    // пишет «генерирую сейчас:» и заканчивает БЕЗ вызова GENERATE_*/WRITE_WIKI.
    // Только i===0 и только когда есть клиентские tools; дальше — auto.
    if (forceFirstTool && i === 0 && req.tools && req.tools.length > 0) {
      req.tool_choice = { type: "any" };
    }
    // Singleton + concurrency-limited + retry-on-429 wrapper.
    // Tests may inject a fake Anthropic via the `anthropic` opt — honor it.
    let resp: Anthropic.Message;
    try {
      resp = await callAnthropic(req, anthropic, agentKey);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        // Тот же протокол, что у SDK-пути: сообщаем, что часть работы сделана.
        throw new BudgetExceededError(e.agentKey, e.used, e.budget, {
          sideEffects: executedTools > 0 || e.sideEffects,
          partialText: e.partialText || bestText,
        });
      }
      // Прочие отказы (429/5xx после ретраев, обрыв связи). Если ход уже
      // наследил в реальном мире, «внутренняя ошибка» врёт так же, как врал
      // бюджетный текст. Формулировка — та же, что на SDK-пути выше.
      if (executedTools > 0) {
        log.error("[tool-loop] вызов модели упал после выполненных инструментов", {
          agentKey,
          executedTools,
          error: getErrorMessage(e),
        });
        return (
          bestText ||
          "Не смог довести ответ до конца — часть действий уже выполнена, повторять их не стал. Скажи, если продолжить."
        );
      }
      throw e;
    }
    // Списываем ДО всякого разбора ответа: любая ветка ниже — return, throw,
    // `continue` по паузе — уже не вернётся сюда, а поиски состоялись и
    // оплачены независимо от того, чем ход кончился.
    webSearchUsed += webSearchRequestsUsed(resp);
    messages.push({ role: "assistant", content: resp.content });
    lastText = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (lastText) bestText = lastText;
    // pause_turn: серверный web_search приостановил ход, ожидая продолжения с
    // тем же контекстом. Раньше это считалось «модель закончила», и половина
    // ответа с уже оплаченным поиском выбрасывалась. Цикл всё равно ограничен
    // MAX_TOOL_ITERS, так что зациклиться на паузах нельзя.
    if (resp.stop_reason === "pause_turn") continue;
    if (resp.stop_reason !== "tool_use") {
      // Пустой текст + необычная остановка = молчащий бот. Чаще всего это
      // max_tokens (потолок MAX_REPLY_TOKENS): модель начала tool_use-блок и
      // упёрлась в лимит, текста не осталось вовсе. Молчание в чате выглядит
      // как «бот сломался», а не как «ответ не поместился».
      if (!lastText) return explainEmptyStop(resp.stop_reason);
      return lastText;
    }

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    // Аудит 2026-08-28: было `return lastText`. Сюда попадают, когда
    // stop_reason === "tool_use", но ни одного КЛИЕНТСКОГО tool_use в ответе
    // нет (например, все actionable-блоки — server_tool_use). `lastText` тогда
    // пуст, runWithTools отдаёт "", а message-handler на `if (!reply) return;`
    // роняет ход вообще без сообщения — тот самый «молчащий бот», ради
    // которого десятью строками выше стоит explainEmptyStop. Заодно перестаём
    // выбрасывать текст, написанный на предыдущих итерациях.
    if (!toolUses.length) {
      return lastText || bestText || explainEmptyStop(resp.stop_reason);
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    // C12: per-turn per-tool-name counter. Refuse if same tool > 2 times in one model turn.
    const callCounts = new Map<string, number>();
    for (const tu of toolUses) {
      const n = (callCounts.get(tu.name) ?? 0) + 1;
      callCounts.set(tu.name, n);
      if (n > MAX_CALLS_PER_TOOL_PER_RESPONSE) {
        const errBody = JSON.stringify({
          ok: false,
          error: `${tu.name} called >${MAX_CALLS_PER_TOOL_PER_RESPONSE} times in one turn — refusing to prevent loop`,
        });
        log.warn("[tool] refused (turn-loop guard)", {
          agentKey,
          tool: tu.name,
          n,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: errBody,
          is_error: true,
        });
        continue;
      }
      // Счётчик хода двигают только вызовы, дошедшие сюда: отбитый C12 не
      // исполнялся, и записывать его в расход было бы неверно.
      const runN = (runCallCounts.get(tu.name) ?? 0) + 1;
      runCallCounts.set(tu.name, runN);
      if (runN > MAX_CALLS_PER_TOOL_PER_RUN) {
        log.warn("[tool] отбит: разгон в одном ходе", {
          agentKey,
          tool: tu.name,
          n: runN,
          max: MAX_CALLS_PER_TOOL_PER_RUN,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            ok: false,
            error: `${tu.name} вызван ${runN} раз за один ход — отказ, чтобы не зациклиться. Подведи итог тем, что уже сделано.`,
          }),
          is_error: true,
        });
        continue;
      }
      let content: string;
      let isError = false;
      if (!toolsForCall?.some((tool) => tool.name === tu.name)) {
        /*
         * Аудит 2026-08-27: отказ по потолку способностей был НЕМЫМ — ни
         * строки в лог, ни строки в agent_actions. А это единственный сигнал,
         * ради которого периметр и строят: попытка временной роли дотянуться
         * до PUBLISH_TO_CHANNEL или GRANT_PERMISSION выглядела снаружи как
         * «роль потратила ход и ничего не сделала», и расследовать её было
         * нечем (GET_LOGS читает как раз agent_actions).
         */
        log.warn("tool-loop: инструмент недоступен для этого хода", {
          agentKey,
          tool: tu.name,
          requestId,
        });
        try {
          logToolCall(tu.name, {
            agentKey,
            chatId,
            payload: { reason: "capability_denied" },
            status: "error",
            error: `tool unavailable: ${tu.name}`,
            requestId,
          });
        } catch {
          /* аудит не должен рушить ход */
        }
        content = JSON.stringify({
          ok: false,
          error: `tool unavailable: ${tu.name}`,
        });
        isError = true;
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content,
          is_error: isError,
        });
        continue;
      }
      try {
        content = await executeTool(tu.name, tu.input, {
          agentKey,
          chatId,
          botId, // T-240: Add bot ID for per-bot-per-chat rate limiting
          telegram,
          triggerMessageId,
          resolveAgent,
          handoffDeps,
          respondAsImpl,
          delegationChain,
          handoffBudget,
          // Вложения хода едут в делегата: в истории от них остаётся только
          // «[image]» / «[файл: …]».
          inputImages,
          inputDocuments,
          triggerUserId,
          requestId,
        });
        executedTools++;
        try {
          const parsed = JSON.parse(content) as { ok?: boolean; status?: string };
          if (
            parsed &&
            parsed.ok === false &&
            !CONTROL_TOOL_STATUSES.has(String(parsed.status ?? ""))
          ) {
            isError = true;
          }
        } catch (e) {
          log.debug("tool-loop: tool result is not JSON; treating as success", {
            e: String(e),
          });
        }
      } catch (e) {
        content = JSON.stringify({
          ok: false,
          error: getErrorMessage(e),
        });
        isError = true;
      }
      log.info("[tool] result", {
        agentKey,
        tool: tu.name,
        result: content.slice(0, 120),
        isError,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content,
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  // Hit the iteration cap while the model still wanted tools. Instead of dumping
  // a useless "лимит инструментов" placeholder into chat, make ONE final call
  // WITHOUT tools so the model summarizes what it actually did.
  try {
    // tools ОБЯЗАТЕЛЬНЫ, хотя вызывать их уже нельзя: messages к этому моменту
    // полны tool_use/tool_result, а запрос без `tools` API отбивает 400
    // («requests which include tool_use/tool_result must define tools»). 400 не
    // ретраится — значит этот вызов падал ВСЕГДА, лишний оплаченный запрос
    // заканчивался ровно той заглушкой «(достигнут предел шагов…)», которую он
    // и должен был устранить. Запрет на новые вызовы даёт tool_choice:none.
    const finalReq: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system,
      messages,
    };
    if (toolsForCall && toolsForCall.length > 0) {
      // web_search тоже возвращаем: если он отработал в цикле, в messages лежат
      // server_tool_use-блоки, и его определение в запросе так же обязательно —
      // иначе API не примет историю. Новых поисков это не разрешает:
      // финализирующий вызов идёт с `tool_choice:"none"`.
      //
      // Отсюда поправка к остатку. Нулевой остаток значит ДВЕ разные вещи, и
      // прежний комментарий здесь признавал только одну. «Бюджета не было
      // вовсе» — поиск ни разу не приклеивался, server_tool_use-блоков в
      // истории нет, определение не нужно. «Бюджет израсходован в цикле» —
      // блоки в истории ЕСТЬ, и запрос без определения отбивается 400, то есть
      // финализация снова падала бы ВСЕГДА, ради устранения чего её и
      // добавляли. Различает эти случаи `webSearchUsed`: раз хоть один поиск
      // состоялся, определение обязано уехать, и остаток поднимаем до единицы.
      const wsRemaining = webSearchBudget - webSearchUsed;
      const finalWs = webCapabilityAllowed("WebSearch", opts.capabilityAllowlist)
        ? webSearchTool(webSearchUsed > 0 ? Math.max(1, wsRemaining) : wsRemaining)
        : null;
      finalReq.tools = finalWs ? [...toolsForCall, finalWs] : toolsForCall;
      finalReq.tool_choice = { type: "none" };
    }
    const finalResp = await callAnthropic(finalReq, anthropic, agentKey);
    const finalText = finalResp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (finalText) return finalText;
  } catch (e) {
    log.warn("tool-loop: finalize call failed", { agentKey, e: getErrorMessage(e) });
  }
  return (
    // Не `lastText`: сюда попадают только через исчерпание лимита, а последняя
    // итерация в этом случае просила инструмент и текста не несла.
    bestText ||
    "(достигнут предел шагов инструментов — задача может быть выполнена частично)"
  );
}
