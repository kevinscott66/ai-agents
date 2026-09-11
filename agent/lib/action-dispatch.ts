/**
 * R-A: единый диспатчер для 12 action types.
 *
 * dispatchAction — выполняет действие (telegram-side-effect или task-операция),
 * НЕ пишет audit. dispatchAndAudit — обёртка с логированием ok/error.
 *
 * gateOrDispatch — единая точка для tool_use/approval: оценивает gate,
 * на allow вызывает dispatchAndAudit, на deny/approval пишет audit и
 * создаёт approval-запись.
 *
 * Task-actions идут напрямую в lib/tasks.ts, минуя lib/actions.ts::doXxx
 * (чтобы аудит писался ровно один раз — здесь).
 */
import { getErrorMessage } from "./errors.ts";
import type { Telegram } from "telegraf";
import {
  handleGenerateImage,
  handleGenerateSvgImage,
} from "./dispatch/media.ts";
import {
  handleSendMessage,
  handleSetReaction,
  handleEditMessage,
  handlePinMessage,
  handleDeleteMessage,
  handleForwardMessage,
  handleCreatePoll,
  handleSendPhoto,
  handleSendDocument,
  type TelegramHandlerContext,
} from "./dispatch/telegram.ts";
import {
  handleCreateTeamChannel,
  type ChannelHandlerContext,
} from "./dispatch/channel.ts";
import {
  handlePublishToChannel,
  fitToLimit,
  type PublishHandlerContext,
} from "./dispatch/publish.ts";
import { getCurrentUserbot, type UserbotHandle } from "./userbot.ts";
import { getUserbotHandle } from "./userbot-router.ts";
import { ensureChannelFooter } from "./channel-footer.ts";
import {
  createTask,
  assignTask,
  updateTaskStatus,
  getTask,
  reconcileExpectedChildren,
} from "./tasks.ts";
import {
  handleCreateTask,
  handleAssignTask,
  handleUpdateTaskStatus,
  handleRequestReview,
  handleCommentTask,
  type TaskHandlerContext,
} from "./dispatch/tasks.ts";
import {
  handleMacRunClaude,
  handleMacStop,
  type MacHandlerContext,
  type MacBridge,
} from "./dispatch/mac.ts";
import {
  handleWriteWiki,
  handleListRecentMessages,
  handleSchedulePost,
  type MiscHandlerContext,
} from "./dispatch/misc.ts";
import { logAction } from "./audit.ts";
import { db } from "./db.ts";
import { emitActionEvents, finalizeActionRow, insertActionRow } from "./audit.ts";
import { genRequestId } from "./request-id.ts";
import { log } from "./log.ts";
import {
  createDiagnosticTask,
  joinDelegationErrors,
  shouldSkipSelfDiag,
} from "./diagnostic.ts";
import { evaluateGate, payloadForcesApproval, type ActionType } from "./permissions.ts";
import {
  handleGrantPermission,
  validateGrantPermissionPayload,
} from "./dispatch/permissions.ts";
import {
  handleChangeAgentStatus,
  validateChangeAgentStatusPayload,
} from "./dispatch/agent-status.ts";
import {
  handleCreateDiagnosticTask,
  validateCreateDiagnosticTaskPayload,
} from "./dispatch/diagnostic-action.ts";
import {
  maxPendingApprovals,
  countPendingApprovals,
  emitApprovalCreated,
  insertApprovalRow,
  getApproval,
  withApprovalTransaction,
} from "./approvals.ts";
import {
  getFixChain,
  appendFixChain,
  getFixChainMaxDepth,
  isDiagTaskThrottled,
  diagTaskThrottleMax,
} from "./fix-chain.ts";
import {
  handleUpdateAgentPromptApproved,
  insertPendingAgentPrompt,
  validateUpdateAgentPromptPayload,
} from "./dispatch/agent-prompt.ts";
import { handleReviewAndMergePr } from "./dispatch/github.ts";
import { pinnedChatId } from "./dispatch/helpers.ts";
import { handleSpawnRole } from "./dispatch/spawn-role.ts";
import type { PayloadFor, PayloadByType } from "./action-payload.ts";
import {
  checkRateLimit,
  checkPerChatRateLimit,
  checkPerBotPerChatRateLimit,
  checkAndConsumeRateLimit,
  checkAndConsumeChatRateLimits,
  refundRateLimit,
  refundChatRateLimits,
} from "./rate-limits.ts";
import {
  respondAs as defaultRespondAs,
  normalizeHandoffOutcome,
  type HandoffDeps,
  type HandoffOutcome,
  type RespondAsOpts,
  type HandoffBudget,
} from "./handoff.ts";
import { CHARACTERS } from "../characters/index.ts";
import type { RunningBot, InputImage, InputDocument } from "./types.ts";
import type { TaskStatus } from "./tasks.ts";
import {
  allCandidatesStopped,
  pickAvailableAgent,
  type AvailabilityDeps,
} from "./role-skills.ts";

// Backward-compatible helper export used by payload tests and integrations.
export { fitToLimit };
export { ensureChannelFooter };

export interface DispatchCtx {
  agentKey: string;
  chatId: number;
  /** T-240: bot ID for per-bot-per-chat rate limiting */
  botId?: number;
  telegram?: Telegram;
  triggerMessageId?: number;
  /**
   * T-410 (T-303 HIGH #2): correlation id generated at the earliest ingress
   * (ход пользователя в telegram — единственное такое место, см. докблок
   * lib/request-id.ts) и carried through dispatch → handlers → logAction →
   * structured log lines.
   * Optional: legacy callers (and tests) may omit it; dispatchAndAudit will
   * lazily generate one via genRequestId() so every audit row gets a value.
   */
  requestId?: string;
  /**
   * Id заявки, по решению которой это действие исполняется.
   *
   * Аудит 2026-09-10. Ставит его ровно один вызывающий — `executeApproved`
   * (commands.ts), общий для Telegram-команды и Mini App; у обычного хода
   * агента его нет и быть не должно. Нужен там, где одобренное действие
   * обязано найти СВОЮ строку, заведённую при постановке в очередь:
   * `agent_prompts.approval_id` (см. `handleUpdateAgentPromptApproved`).
   * Раньше связь восстанавливали по содержимому — единственное, что сюда
   * доезжало, — а два одинаковых текста по содержимому неразличимы.
   */
  approvalId?: string;
  /**
   * C10: resolver from agent key → RunningBot. Required for DELEGATE_TO_ROLE.
   * Injected by orchestrator-team.ts at runWithTools-call time.
   */
  resolveAgent?: (role: string) => RunningBot | undefined;
  /**
   * C10: deps bundle (anthropic, model, historyLimit, bots) used by respondAs.
   */
  handoffDeps?: HandoffDeps;
  /**
   * C10 (test seam): override the respondAs implementation. Defaults to the
   * real `respondAs` import. Tests can pass a stub here.
   *
   * Тип шире, чем у самого `respondAs`, намеренно: заглушки и легаси-вызовы
   * отдают текст или `null`, и `normalizeHandoffOutcome` приводит их к явному
   * итогу в одном месте.
   */
  respondAsImpl?: (
    opts: RespondAsOpts,
    deps: HandoffDeps,
  ) => Promise<HandoffOutcome | string | null>;
  /**
   * C13 anti-pingpong: ordered list of agent keys already in the delegation
   * chain for this user turn (root first → current agent last). When the current
   * agent calls DELEGATE_TO_ROLE(role=X) and X is already in the chain, dispatch
   * returns ok:false with a clear "cycle" error in the tool_result.
   *
   * Аудит 2026-08-10: здесь было «ортогонально legacy-счётчику `_depth`,
   * оставленному как backstop». Backstop'а не было — `_depth` никто не ставил,
   * и гейт по нему не срабатывал ни разу; счётчик удалён. Длина этой цепочки —
   * единственный потолок глубины, и он же единственный, который растёт.
   */
  delegationChain?: string[];
  /**
   * S1: счётчик handoff-вызовов, общий на весь ход пользователя.
   *
   * Аудит 2026-08-12: счётчик заводился в message-handler ПОСЛЕ runWithTools и
   * жил только на пути @-упоминаний, а сюда не доходил вовсе. Замер (три
   * DELEGATE_TO_ROLE подряд через реальный dispatch):
   *
   *   HANDOFF_MAX_INVOCATIONS = 16
   *   budget в opts respondAs: null, null, null
   *
   * `null` значит «заводи свой»: handoff.ts:241 на каждое делегирование
   * создаёт новое `{n:0,max:16}`. Потолок «16 LLM-вызовов на ход» превращался в
   * 16 на каждую ветку. Теперь ссылка одна на весь ход и её видят оба входа.
   */
  handoffBudget?: HandoffBudget;
  /**
   * Вложения ЭТОГО хода пользователя.
   *
   * Аудит 2026-08-12: делегат их не получал. В историю картинка без подписи
   * ложится строкой «[image]» (message-handler.ts:219), документ — строкой
   * «[файл: имя]». Замер того, что видит дизайнер, когда владелец бросил
   * картинку и оркестратор передал задачу дальше:
   *
   *   user | [Егор] [image]
   *   user | [orchestrator] Понял, передаю дизайнеру.
   *   user | [orchestrator] (handoff) DELEGATE: свёрстай баннер по картинке
   *
   *   inputImages в handoff.ts: 0
   *   inputImages в action-dispatch.ts: 0
   *   inputImages в tools-schema.ts (ExecCtx): 0
   *
   * Картинки нет ни в одном слое. А «производящим» ролям dispatch ставит
   * forceFirstTool — то есть делегат ОБЯЗАН сразу вызвать инструмент, имея на
   * входе слово «[image]». Он и вызывал: рисовал баннер из головы.
   */
  inputImages?: InputImage[];
  inputDocuments?: InputDocument[];
  /**
   * C29: optional override for the availability check used by DELEGATE_TO_ROLE
   * fallback logic. Tests inject stubs; production callers leave undefined to
   * use the real DB / health-snapshot lookups.
   */
  availability?: AvailabilityDeps;
  /**
   * C30 (test seam): override the userbot lookup. Defaults to the module
   * singleton. Tests pass a stub here.
   */
  userbot?: UserbotHandle | null;
  /**
   * Stage A: triggering Telegram user_id, used by MAC_RUN_CLAUDE for the
   * MAC_USER_IDS whitelist check. Pre-filled from ExecCtx by tool-loop.
   */
  triggerUserId?: string;
  /**
   * Stage A test seam: override the Mac bridge sender. Defaults to the real
   * `sendToMac` import. Tests pass stubs (or rely on offline default).
   */
  macBridge?: MacBridge;
}

const ROLE_KEYS_SET = new Set<string>(CHARACTERS.map((c) => c.key));

export type DispatchResult =
  | { ok: true; result: unknown; taskId?: string }
  // taskId и у провала: SPLIT_TASK успевает создать строку родителя до того,
  // как выяснится, что ни одна роль задачу не взяла. Без id вызывающий не
  // может ни сослаться на неё, ни показать человеку, что именно закрылось.
  // sideEffect — см. HandlerResult в dispatch/helpers.ts: провал, у которого
  // часть работы уже видна снаружи. Пробрасывается наверх нетронутым.
  | { ok: false; error: string; taskId?: string; sideEffect?: boolean };


/**
 * T-541: Get userbot handle with optional router support.
 * When USERBOT_ROUTER_ENABLED=true, attempts to use agent-specific session first.
 */

/**
 * Сколько символов ответа делегата уходит наверх в tool_result DELEGATE_TO_ROLE
 * и в строку доски. Ответ целиком уже в чате — здесь он нужен оркестратору,
 * чтобы передать результат следующему шагу пайплайна, а не чтобы пересказать.
 * Всё, что длиннее, помечается `truncated` — молчаливая обрезка выдавала
 * оборванный на полуслове текст за полный ответ роли.
 */
const DELEGATE_REPLY_MAX = 4000;

async function resolveUserbotHandle(ctx: DispatchCtx): Promise<UserbotHandle | null> {
  // Test seam override
  if (ctx.userbot !== undefined) {
    return ctx.userbot;
  }

  // T-541: Router support behind feature flag
  //
  // Аудит 2026-08-28: откат делался ДВАЖДЫ. `getUserbotHandle` сам отдаёт
  // синглтон агенту без объявленной сессии; строка `if (routerHandle) return`
  // и падение вниз повторяли это для агента, чья ОБЪЯВЛЕННАЯ сессия не
  // поднялась — а это уже подмена личности. Отсюда уходят PUBLISH_TO_CHANNEL,
  // WRITE_WIKI, SCHEDULE_POST и CREATE_TEAM_CHANNEL, и ни один из них не
  // ограничен оркестратором: любая роль молча публиковала с ЛИЧНОГО аккаунта
  // владельца. Решение об откате принимается ровно в одном месте.
  if (process.env.USERBOT_ROUTER_ENABLED === "true") {
    try {
      return await getUserbotHandle(ctx.agentKey);
    } catch (error) {
      // Сбой роутера — тоже не повод уйти с чужого аккаунта.
      log.warn(`[userbot-router] error getting agent handle for ${ctx.agentKey}`, { error: String(error) });
      return null;
    }
  }

  // Fallback to singleton userbot
  return getCurrentUserbot();
}


/**
 * Выполняет действие. Не пишет audit. Ловит исключения в {ok:false}.
 */
export async function dispatchAction<T extends ActionType>(
  actionType: T,
  payload: PayloadFor<T>,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  try {
    switch (actionType) {
      case "SEND_MESSAGE": {
        const p = payload as PayloadByType["SEND_MESSAGE"];
        return await handleSendMessage(p, ctx as TelegramHandlerContext);
      }
      case "SET_REACTION": {
        const p = payload as PayloadByType["SET_REACTION"];
        return await handleSetReaction(p, ctx as TelegramHandlerContext);
      }
      case "EDIT_MESSAGE": {
        const p = payload as PayloadByType["EDIT_MESSAGE"];
        return await handleEditMessage(p, ctx as TelegramHandlerContext);
      }
      case "PIN_MESSAGE": {
        const p = payload as PayloadByType["PIN_MESSAGE"];
        return await handlePinMessage(p, ctx as TelegramHandlerContext);
      }
      case "DELETE_MESSAGE": {
        const p = payload as PayloadByType["DELETE_MESSAGE"];
        return await handleDeleteMessage(p, ctx as TelegramHandlerContext);
      }
      case "FORWARD_MESSAGE": {
        const p = payload as PayloadByType["FORWARD_MESSAGE"];
        return await handleForwardMessage(p, ctx as TelegramHandlerContext);
      }
      case "CREATE_POLL": {
        const p = payload as PayloadByType["CREATE_POLL"];
        return await handleCreatePoll(p, ctx as TelegramHandlerContext);
      }
      case "SEND_PHOTO": {
        const p = payload as PayloadByType["SEND_PHOTO"];
        return await handleSendPhoto(p, ctx as TelegramHandlerContext);
      }
      case "SEND_DOCUMENT": {
        const p = payload as PayloadByType["SEND_DOCUMENT"];
        return await handleSendDocument(p, ctx as TelegramHandlerContext);
      }
      case "CREATE_TEAM_CHANNEL": {
        const p = payload as PayloadByType["CREATE_TEAM_CHANNEL"];
        return await handleCreateTeamChannel(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
          resolveAgent: ctx.resolveAgent,
          resolveUserbot: () => resolveUserbotHandle(ctx),
        } satisfies ChannelHandlerContext);
      }
      case "PUBLISH_TO_CHANNEL": {
        const p = payload as PayloadByType["PUBLISH_TO_CHANNEL"];
        if (!ctx.telegram) return { ok: false, error: "no telegram context" };
        // Аудит 2026-08-27: без `await` отказ промиса улетал мимо try/catch
        // этого switch — публикация в канал падала без строки в аудите.
        return await handlePublishToChannel(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
          telegram: ctx.telegram,
          resolveUserbot: () => resolveUserbotHandle(ctx),
        } satisfies PublishHandlerContext);
      }
      case "GENERATE_SVG_IMAGE": {
        const p = payload as PayloadByType["GENERATE_SVG_IMAGE"];
        return await handleGenerateSvgImage(p, {
          telegram: ctx.telegram,
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
        });
      }
      case "GENERATE_IMAGE": {
        const p = payload as PayloadByType["GENERATE_IMAGE"];
        return await handleGenerateImage(p, {
          telegram: ctx.telegram,
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
        });
      }
      case "CREATE_TASK": {
        const p = payload as PayloadByType["CREATE_TASK"];
        return handleCreateTask(p, ctx as TaskHandlerContext);
      }
      case "ASSIGN_TASK": {
        const p = payload as PayloadByType["ASSIGN_TASK"];
        return handleAssignTask(p, ctx as TaskHandlerContext);
      }
      case "UPDATE_TASK_STATUS": {
        const p = payload as PayloadByType["UPDATE_TASK_STATUS"];
        return handleUpdateTaskStatus(p, ctx as TaskHandlerContext);
      }
      case "REQUEST_REVIEW": {
        const p = payload as PayloadByType["REQUEST_REVIEW"];
        return handleRequestReview(p, ctx as TaskHandlerContext);
      }
      case "DELEGATE_TO_ROLE": {
        const p = payload as PayloadByType["DELEGATE_TO_ROLE"];
        const originalRole = String(p.role ?? "");
        const task = String(p.task ?? "").trim();
        if (!originalRole || !ROLE_KEYS_SET.has(originalRole)) {
          return { ok: false, error: `unknown role: ${originalRole}` };
        }
        if (!task) {
          return { ok: false, error: "task is required" };
        }
        if (originalRole === ctx.agentKey) {
          return { ok: false, error: "cannot delegate to self" };
        }
        // C13/C28 anti-pingpong. Priority for chain source:
        //   1) explicit DispatchCtx.delegationChain (in-process propagation)
        //   2) payload._delegation_path (back-compat for callers that thread
        //      the chain through the payload rather than ctx)
        //   3) fall back to [ctx.agentKey] (fresh chain starting with sender)
        //
        // Аудит 2026-08-20: блок поднят ВЫШЕ выбора исполнителя. Он ничего не
        // возвращает и зависит только от ctx и payload — но именно он знает,
        // кого выбирать бессмысленно, а раньше вычислялся после выбора.
        let chain: string[];
        if (ctx.delegationChain && ctx.delegationChain.length > 0) {
          chain = [...ctx.delegationChain];
        } else if (
          Array.isArray(p._delegation_path) &&
          p._delegation_path.length > 0
        ) {
          // Back-compat path. If the sender hasn't been appended yet, do so —
          // we always want the chain to end with the immediate parent.
          chain = [...p._delegation_path];
          if (chain[chain.length - 1] !== ctx.agentKey) chain.push(ctx.agentKey);
        } else {
          chain = [ctx.agentKey];
        }
        // C29: skill-based fallback when the primary target is unavailable
        // (paused OR silent per health snapshot). pickAvailableAgent returns
        // either the original role, a fallback, or null when nothing is up.
        //
        // Третий аргумент — кого выбирать бессмысленно: отправитель (проверка
        // ниже) и вся цепочка (C28/C13 ниже). Без него фолбэк отдавал первого
        // доступного, вызывающий его же и отвергал, а следующий кандидат в
        // списке не пробовался никогда. Обоснование и разбор — в role-skills.ts.
        const picked = pickAvailableAgent(originalRole, ctx.availability, [
          ctx.agentKey,
          ...chain,
        ]);
        if (!picked) {
          // Аудит 2026-08-21: маркер причины читает shouldSkipSelfDiag. Все
          // кандидаты остановлены политикой — отказ по правилам, диагностику не
          // заводим. Хоть один недоступен по здоровью — текст без маркера, и
          // мёртвый бот доезжает до aieng, как и должен.
          //
          // `allCandidatesStopped` намеренно не смотрит на `avoid`: null здесь
          // бывает и от коллизии с цепочкой (все живые кандидаты уже в ней), а
          // это не решение владельца. Маркер ставим только когда остановлено
          // буквально всё — ошибаемся в сторону «завести диагностику».
          const stopped = allCandidatesStopped(originalRole, ctx.availability);
          return {
            ok: false,
            error: `no_available_agent: ${originalRole}${stopped ? " (all candidates stopped)" : ""}`,
          };
        }
        const role = picked.role;
        const reroutedFrom =
          picked.reroutedFrom ??
          (typeof p._rerouted_from === "string" ? p._rerouted_from : undefined);
        if (role === ctx.agentKey) {
          return { ok: false, error: "cannot delegate to self" };
        }
        // C28: absolute length cap.
        if (chain.length > 5) {
          return {
            ok: false,
            error: `delegation cycle detected: path=[${chain.join(",")}] exceeds max length 5`,
          };
        }
        // C28: direct ping-pong — target appears in the last 2 chain entries.
        const lastTwo = chain.slice(-2);
        if (lastTwo.includes(role)) {
          return {
            ok: false,
            error: `delegation cycle detected: path=[${chain.join(",")}] target='${role}' appears in last 2 entries`,
          };
        }
        // Legacy C13: reject when target appears anywhere in the chain.
        if (chain.includes(role)) {
          return {
            ok: false,
            error: `delegation cycle: '${role}' is already in chain [${chain.join("→")}]`,
          };
        }
        // Аудит 2026-08-10: здесь стоял второй потолок, `p._depth >=
        // MAX_HANDOFF_DEPTH`. Поле объявлено как «set by dispatch, not by LLM»,
        // но не ставилось ни dispatch'ем, ни кем-либо ещё: в схеме инструмента
        // его нет, и единственной записью во всём репозитории была строка в
        // тесте c10, который этот же гейт и «проверял». Гейт не срабатывал
        // никогда, а тест создавал уверенность, что глубина ограничена именно
        // тут. Настоящий потолок — длина цепочки выше: она растёт на каждом
        // хопе и приходит из ctx, а не из модели. Второй счётчик того же самого
        // не добавлял защиты, зато давал чему расходиться.
        const parentId =
          typeof p._parent_task_id === "string" && p._parent_task_id
            ? p._parent_task_id
            : null;
        // Аудит 2026-08-21: `createTask` переоткрывает ЛЮБОГО терминального
        // родителя голым UPDATE'ом. Для done/failed это осознанно (набор
        // детей оказался неполон), но `cancelled` ставит человек, и решение
        // «не делаем» новым ребёнком не опровергается. Дальше rollupParent
        // закрывает воскрешённого родителя по детям — отмена владельца
        // снималась входом модели, без единого аппрува и без следа в
        // истории: перехода cancelled → running в FSM нет вовсе.
        //
        // Отсечка на входе модели уже стоит в `dispatch/tasks.ts:116`, но
        // она закрывает только CREATE_TASK. Сюда parentId приезжает двумя
        // другими дорогами: явным `_parent_task_id` и — чаще — циклом
        // SPLIT_TASK, который создаёт детей по одному через gateOrDispatch.
        // Каждая итерация цикла это полный ход делегата (десятки секунд ×
        // N ролей), так что владелец, нажавший «отменить» на `[split] …`,
        // отменял только уже созданное: следующий ребёнок переоткрывал
        // родителя. В `createTask` не режем сознательно — та же функция
        // обслуживает аппрувы и Mini App, где снятие отмены человеком
        // законно (см. тест «граница именно на входе модели»).
        if (parentId) {
          const parentRow = getTask(parentId);
          // Аудит 2026-08-28: чат родителя здесь не смотрел никто. У
          // CREATE_TASK такая проверка есть — `ownTask` в dispatch/tasks.ts, и
          // причина названа там же: ребёнок ложится в СВОЙ чат, а rollupParent
          // потом пересчитывает по нему статус задачи чужого и, если та уже
          // закрыта, ещё и переоткрывает её. Второй вход модели остался без
          // неё: агент чата A прикреплял ребёнка к родителю чата B, и задача
          // на доске B меняла статус без единого действия в чате B.
          //
          // Чужая задача отдаётся как отсутствующая, и текст тот же: иначе
          // перебор id даёт оракул существования по чужим доскам. Разница
          // видна только в логе — там, куда модель не дотягивается.
          // Несуществующий родитель отвечает тем же текстом не для красоты:
          // иначе отказ отличал бы «лежит на чужой доске» от «нет вовсе», и
          // оракул возвращался бы через сообщение об ошибке. Заодно исчезает
          // висячий parent_id, который CREATE_TASK не пропускает с 2026-08-12.
          if (!parentRow || parentRow.chat_id !== ctx.chatId) {
            log.warn(
              "[security] DELEGATE_TO_ROLE: родитель не с этой доски — отказ",
              {
                task_id: parentId,
                task_chat: parentRow?.chat_id ?? null,
                originating: ctx.chatId,
                agent: ctx.agentKey,
              },
            );
            return { ok: false, error: `parent task not found: ${parentId}` };
          }
          if (parentRow?.status === "cancelled") {
            log.warn(
              "[security] DELEGATE_TO_ROLE: ребёнок под отменённым родителем — отказ",
              { task_id: parentId, agent: ctx.agentKey },
            );
            return {
              ok: false,
              error: `parent task is cancelled: ${parentId}. Отменённую задачу не переоткрывают подзадачей — создай новую задачу или попроси владельца снять отмену.`,
            };
          }
        }
        if (!ctx.resolveAgent) {
          return { ok: false, error: "no resolveAgent in dispatch ctx" };
        }
        const target = ctx.resolveAgent(role);
        if (!target) {
          return { ok: false, error: `target agent not found: ${role}` };
        }
        if (!ctx.handoffDeps) {
          return { ok: false, error: "no handoffDeps in dispatch ctx" };
        }
        const triggerText = p.context
          ? `[from:${ctx.agentKey}] DELEGATE: ${task}\n\n${p.context}`
          : `[from:${ctx.agentKey}] DELEGATE: ${task}`;
        // C28: create a task row so the Mini App "Задачи" tab reflects the
        // delegation. We do this BEFORE invoking respondAs so the row exists
        // even if the downstream agent errors.
        //
        // T-730: раньше строка создавалась и НИКОГДА не закрывалась — через 24ч
        // gcStaleTasks штамповал ей failed/gc_stale. В проде на 2026-08-02 это
        // дало 148 из 154 «провалов» при 116 успешных делегированиях, а дневной
        // дайджест показывал «(no data)», потому что доска состояла из мусора.
        // Теперь статус ведём по FSM: pending → running → done|failed.
        let delegatedTaskId: string | undefined;
        // Доска задач — вторичный контур: её сбой не должен ломать делегирование,
        // поэтому все переходы non-fatal (как и createTask ниже).
        const closeDelegatedTask = (
          status: "done" | "failed",
          patch: { output?: unknown; error?: string },
        ): void => {
          if (!delegatedTaskId) return;
          try {
            // Пока делегат работает (десятки секунд: LLM + tool-loop), админ
            // может перевести строку из Mini App в awaiting_review /
            // awaiting_approval — оба перехода из running легальны. Из них
            // FSM в done|failed уже не пускает, ошибка глушится ниже в warn,
            // и строка остаётся навсегда: gcStaleTasks смотрит только
            // pending/running и до неё не дотянется. Возвращаемся в running.
            const cur = getTask(delegatedTaskId);
            if (
              cur &&
              (cur.status === "awaiting_review" ||
                cur.status === "awaiting_approval")
            ) {
              updateTaskStatus(delegatedTaskId, "running");
            }
            updateTaskStatus(delegatedTaskId, status, patch);
          } catch (e) {
            log.warn("[delegate] failed to close task row", {
              taskId: delegatedTaskId,
              status,
              error: String(e),
            });
          }
        };
        try {
          const t = createTask({
            chatId: ctx.chatId,
            createdBy: ctx.agentKey,
            assignedTo: role,
            title: `[delegate→${role}] ${task.slice(0, 120)}`,
            description: p.context ?? null,
            parentId,
            inputPayload: {
              role,
              task,
              fromAgent: ctx.agentKey,
              context: p.context,
              type: "delegated",
              provider: "internal",
              execution: "in_process_handoff",
              ...(reroutedFrom ? { _rerouted_from: reroutedFrom } : {}),
            },
          });
          delegatedTaskId = t.id;
        } catch (e) {
          // Non-fatal: log but keep delegating. Common cause: parent depth cap.
          log.error("[delegate] failed to create task row", { error: String(e) });
        }
        if (delegatedTaskId) {
          // FSM запрещает pending → done напрямую (agent/lib/tasks.ts:63).
          // Переводим в running сразу после создания, иначе закрыть не сможем.
          try {
            updateTaskStatus(delegatedTaskId, "running");
          } catch (e) {
            log.warn("[delegate] failed to mark task running", {
              taskId: delegatedTaskId,
              error: String(e),
            });
          }
        }
        // Порядок (UX, запрос владельца): объявляем делегирование ДО того как
        // делегат ответит — чтобы в чате сначала шло «→ роль: задача», потом
        // ответ роли, а не наоборот (раньше делегат постил первым).
        if (ctx.telegram) {
          try {
            const announce = `\u{1F500} ${ctx.agentKey} → ${role}: ${task.slice(0, 160)}`;
            await ctx.telegram.sendMessage(ctx.chatId, announce);
            log.info("[delegate] announced", { from: ctx.agentKey, to: role });
          } catch (e) {
            log.warn("[delegate] announce failed", { error: getErrorMessage(e) });
          }
        } else {
          log.warn("[delegate] no telegram in ctx — announce skipped", {
            from: ctx.agentKey,
            to: role,
          });
        }
        const impl = ctx.respondAsImpl ?? defaultRespondAs;
        let outcome: HandoffOutcome;
        try {
          outcome = normalizeHandoffOutcome(await impl(
            {
              target,
              chatId: String(ctx.chatId),
              triggerText,
              triggerAgentKey: ctx.agentKey,
              // Глубина берётся из цепочки, а не из отдельного счётчика: это
              // ровно то же число, только считаемое тем, что действительно
              // растёт на каждом хопе. Для обычного делегирования (chain =
              // [отправитель]) выходит 1 — как и было, когда сюда приходило
              // `_depth + 1` при вечном `_depth = 0`. Разница видна только
              // глубоко в цепочке: делегат на четвёртом хопе больше не получает
              // полный запас каскада по упоминаниям, как будто он первый.
              depth: chain.length,
              visited: new Set<string>([...chain, role]),
              triggerMessageId: ctx.triggerMessageId,
              // C13: propagate the full ordered chain so deeper hops can detect
              // cycles too (not just direct parent↔child ping-pong).
              delegationChain: [...chain, role],
              // T-410: делегат работает в том же request_id, что и делегирующий.
              requestId: ctx.requestId,
              // Аудит 2026-08-13: без этого делегат терял пользователя хода, и
              // whitelist MAC_USER_IDS у него отказывал всегда — вместе с
              // аварийным MAC_STOP. Делегированный ход отдельно форсит
              // approval (isDelegatedMacAction), так что круг поводов не растёт.
              triggerUserId: ctx.triggerUserId,
              // S1: общий счётчик хода. Если его нет (легаси-вызов, тест),
              // respondAs заведёт свой — но у боевых входов он есть.
              budget: ctx.handoffBudget,
              // Вложения хода: без них делегат работает по слову «[image]».
              inputImages: ctx.inputImages,
              inputDocuments: ctx.inputDocuments,
            },
            ctx.handoffDeps,
          ));
        } catch (e) {
          closeDelegatedTask("failed", { error: getErrorMessage(e) });
          throw e;
        }
        // Аудит 2026-08-13: доска и модель должны говорить одно и то же. Раньше
        // здесь при пустом ответе строка закрывалась `failed`, а модель получала
        // `ok:true` с `reply:null` — и оркестратор писал в чат «готово» о работе,
        // которой не было. Признак, по которому tool-loop ставит `is_error`, ровно
        // один: `ok === false` (agent/lib/tool-loop.ts).
        if (outcome.status === "failed" || outcome.status === "skipped") {
          closeDelegatedTask("failed", { error: outcome.reason });
          return {
            ok: false,
            error: `delegate_${outcome.status}: ${outcome.reason}`,
            // Аудит 2026-08-21: без этого dispatchAndAudit писал `task_id =
            // NULL` рядом с только что закрытой строкой доски, и сшить их можно
            // было только по времени. Провал SPLIT_TASK отдаёт `taskId` ровно
            // по той же причине.
            taskId: delegatedTaskId,
          };
        }
        // `acted` — успех без текста: роль закончила ход инструментом, и её
        // картинка/файл/сообщение уже в чате. Отдавать за это `ok:false` значило
        // бы ронять нормальную работу makers: у ролей из MAKER_ROLES такой конец
        // хода — штатный. Но и выдавать пустоту за ответ нельзя, поэтому вместо
        // `reply` уходит явная пометка — иначе модель перескажет своими словами
        // то, чего не читала.
        const replyText = outcome.status === "answered" ? outcome.reply : null;
        // Аудит 2026-08-20: обрезка на 4000 была МОЛЧАЛИВОЙ — и в строке доски,
        // и в tool_result. Оркестратор получал ответ делегата, оборванный на
        // полуслове, и пересказывал его человеку как полный; а конец текста
        // роли — это обычно вывод, а не вступление. Форма отчёта та же, что у
        // PUBLISH_TO_CHANNEL и QUERY_DB выше: маркер в самом тексте плюс
        // `truncated` в теле результата и словами, что с этим делать.
        const replyClipped =
          replyText !== null && replyText.length > DELEGATE_REPLY_MAX;
        const replyForModel =
          replyText === null
            ? null
            : replyClipped
              ? replyText.slice(0, DELEGATE_REPLY_MAX) + "\n…(truncated)"
              : replyText;
        closeDelegatedTask("done", {
          output: { role, reply: replyForModel },
        });
        return {
          ok: true,
          taskId: delegatedTaskId,
          result: {
            role,
            delegated: true,
            provider: "internal",
            state: "completed",
            execution: "in_process_handoff",
            taskId: delegatedTaskId,
            // Шаг 2 автономности: вернуть оркестратору ОТВЕТ делегата (обрезанный),
            // чтобы он мог передать результат следующему шагу пайплайна в этом turn.
            reply: replyForModel,
            ...(replyClipped
              ? {
                  truncated: true,
                  reply_full_len: replyText!.length,
                  note:
                    `ответ роли ${role} показан не целиком (${DELEGATE_REPLY_MAX} ` +
                    `из ${replyText!.length} символов) — полный текст уже в чате; ` +
                    `не выдавай обрезанный за весь ответ`,
                }
              : {}),
            ...(replyText
              ? {}
              : {
                  note: `${role} отработал(а) действием: результат уже отправлен в чат, текстового ответа нет — не пересказывай его`,
                }),
            ...(reroutedFrom ? { _rerouted_from: reroutedFrom } : {}),
          },
        };
      }
      case "SPLIT_TASK": {
        const p = payload as PayloadByType["SPLIT_TASK"];
        const title = String(p.title ?? "").trim();
        const roles = Array.isArray(p.roles) ? p.roles.map(String) : [];
        if (!title) return { ok: false, error: "title is required" };
        if (roles.length === 0)
          return { ok: false, error: "roles must be non-empty" };
        for (const r of roles) {
          if (!ROLE_KEYS_SET.has(r))
            return { ok: false, error: `unknown role: ${r}` };
        }
        // Пиннинг, а не resolveChatId: p.chatId приходит из сырого инпута
        // модели (build-payload.ts), и родительская `[split] …` вставала на
        // доску названного чата — вместе с title/description, куда инъекция
        // кладёт содержимое чата-источника. Дети создаются через
        // DELEGATE_TO_ROLE с тем же ctx и утекали не они, а родитель.
        const chatId = pinnedChatId(p.chatId, ctx.chatId, "SPLIT_TASK");
        // Parent task: not assigned to anyone; tracks aggregate child status.
        const parent = createTask({
          chatId,
          createdBy: ctx.agentKey,
          title: `[split] ${title.slice(0, 120)}`,
          description: p.description ?? null,
          inputPayload: {
            type: "split",
            roles,
            title,
            description: p.description,
            context: p.context,
            fromAgent: ctx.agentKey,
            // T-730a: дети создаются по одному в цикле ниже. Без обещанного
            // числа rollupParent посчитает набор из одного ребёнка полным и
            // отдаст родителю статус первого делегата.
            expectedChildren: roles.length,
          },
        });
        const childIds: string[] = [];
        const errors: string[] = [];
        for (const role of roles) {
          // Аудит 2026-08-12: здесь стоял dispatchAction — сырой исполнитель.
          // Всё, что делает делегирование легальным, живёт слоем выше, в
          // gateOrDispatch: рейт-лимиты (per-chat / per-bot-per-chat /
          // per-agent), payloadForcesApproval, evaluateGate и строка в
          // agent_actions. Ни одна из этих проверок для детей не выполнялась.
          //
          // Ни SPLIT_TASK, ни DELEGATE_TO_ROLE не входят в ROLE_EXPOSED_TOOLS,
          // то есть оба открыты каждой роли. Значит владелец, отобравший у роли
          // право делегировать, не отбирал ничего: та же роль звала SPLIT_TASK
          // и получала N делегирований — N объявлений в чат и N оплаченных
          // LLM-ходов — мимо одобрений, мимо лимитов и мимо аудита. В журнале
          // оставался один SPLIT_TASK и ноль делегирований.
          //
          // Цена за честность: делегирование, ушедшее на одобрение, приходит
          // сюда как отказ и в childIds не попадает — reconcileExpectedChildren
          // ниже сведёт обещание к факту. Родитель не станет ждать ребёнка,
          // которого человек может так и не подтвердить.
          const r = await gateOrDispatch(
            "DELEGATE_TO_ROLE",
            {
              role,
              task: title,
              context: p.context ?? p.description,
              _parent_task_id: parent.id,
            } as PayloadFor<"DELEGATE_TO_ROLE">,
            ctx,
          );
          if (r.kind === "ok") {
            if (r.taskId) childIds.push(r.taskId);
          } else {
            errors.push(`${role}: ${gateRefusalText(r)}`);
          }
        }
        // Часть ролей могла не создать строку (отказ по циклу делегирования,
        // упавший createTask). Сводим обещание к факту и пересчитываем
        // родителя — иначе счётчик не сойдётся и он провисит до gc_stale.
        if (childIds.length !== roles.length) {
          try {
            reconcileExpectedChildren(parent.id, childIds.length, {
              error: joinDelegationErrors(errors) || "all delegations failed",
            });
          } catch (e) {
            log.warn("[split] reconcile failed", {
              parentId: parent.id,
              error: String(e),
            });
          }
        }
        // Ни одна роль не взялась — это провал сплита, а не успех с пустым
        // списком. Модель по `ok:true` считала работу розданной и шла дальше,
        // хотя не создалось ничего.
        if (childIds.length === 0) {
          return {
            ok: false,
            taskId: parent.id,
            error: `split failed: no roles accepted the task (${
              joinDelegationErrors(errors) || "unknown reason"
            })`,
          };
        }
        return {
          ok: true,
          taskId: parent.id,
          result: {
            parentTaskId: parent.id,
            childTaskIds: childIds,
            roles,
            errors: errors.length ? errors : undefined,
          },
        };
      }
      // Аудит 2026-08-27: у четырёх обработчиков ниже (WRITE_WIKI,
      // LIST_RECENT_MESSAGES, MAC_RUN_CLAUDE, MAC_STOP) `return` без `await`
      // уносил отказ промиса мимо catch этого switch — действие падало
      // без строки в `agent_actions`. Тот же дефект чинили для
      // PUBLISH_TO_CHANNEL выше.
      case "WRITE_WIKI": {
        const p = payload as PayloadByType["WRITE_WIKI"];
        return await handleWriteWiki(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
          resolveUserbot: () => resolveUserbotHandle(ctx),
        });
      }
      case "LIST_RECENT_MESSAGES": {
        const p = payload as PayloadByType["LIST_RECENT_MESSAGES"];
        return await handleListRecentMessages(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
          resolveUserbot: () => resolveUserbotHandle(ctx),
        });
      }
      case "MAC_RUN_CLAUDE": {
        const p = payload as PayloadByType["MAC_RUN_CLAUDE"];
        return await handleMacRunClaude(p, ctx as MacHandlerContext);
      }
      case "MAC_STOP": {
        const p = payload as PayloadByType["MAC_STOP"];
        return await handleMacStop(p, ctx as MacHandlerContext);
      }
      case "COMMENT_TASK": {
        const p = payload as PayloadByType["COMMENT_TASK"];
        return handleCommentTask(p, ctx as TaskHandlerContext);
      }
      case "SCHEDULE_POST": {
        const p = payload as PayloadByType["SCHEDULE_POST"];
        return handleSchedulePost(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
          resolveUserbot: () => resolveUserbotHandle(ctx),
        });
      }
      case "GRANT_PERMISSION": {
        const p = payload as PayloadByType["GRANT_PERMISSION"];
        const res = handleGrantPermission(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, result: res.result };
      }
      case "CHANGE_AGENT_STATUS": {
        const p = payload as PayloadByType["CHANGE_AGENT_STATUS"];
        const res = handleChangeAgentStatus(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, result: res.result };
      }
      case "UPDATE_AGENT_PROMPT": {
        // T-702: handler runs ONLY after user approval (always-approve gate).
        const p = payload as PayloadByType["UPDATE_AGENT_PROMPT"];
        const res = handleUpdateAgentPromptApproved(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
          approvalId: ctx.approvalId,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, result: res.result };
      }
      case "REVIEW_AND_MERGE_PR": {
        // T-511: orchestrator reviews and merges PRs from other agents.
        const p = payload as PayloadByType["REVIEW_AND_MERGE_PR"];
        const res = await handleReviewAndMergePr(
          p,
          { agentKey: ctx.agentKey, chatId: ctx.chatId },
          { authority: "approved-action" },
        );
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, result: res.result };
      }
      case "SPAWN_ROLE": {
        // T-512: queue an ad-hoc role for the local runtime. The upstream gate
        // keeps this action human-approval-only and orchestrator-only.
        const p = payload as PayloadByType["SPAWN_ROLE"];
        const res = await handleSpawnRole(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, result: res.result };
      }
      case "CREATE_DIAGNOSTIC_TASK": {
        // T-701. Мёртвая ветка: тула у действия нет, а движок self-healing
        // зовёт createDiagnosticTask() напрямую (ниже, T-704). Подробнее — в
        // заголовке dispatch/diagnostic-action.ts.
        //
        // Аудит 2026-09-11: мёртвой она стала не сама собой. Оживлял её
        // self-diag-ретрай, чей разбор принимал любое имя из ACTION_TYPES;
        // теперь он отвергает ключи DISPATCH_ONLY_ACTIONS.
        const p = payload as PayloadByType["CREATE_DIAGNOSTIC_TASK"];
        const res = handleCreateDiagnosticTask(p, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, result: res.result };
      }
      default:
        return { ok: false, error: `unknown action type: ${actionType}` };
    }
  } catch (e) {
    const msg = getErrorMessage(e);
    return { ok: false, error: msg };
  }
}

export type DispatchAndAuditResult =
  | { ok: true; result: unknown; taskId?: string; actionId: string }
  // taskId и у провала — см. комментарий у DispatchResult. Раньше расширение
  // обрывалось здесь: dispatchAction уже возвращал id родителя, а
  // dispatchAndAudit его выбрасывал, так что строка в agent_actions про
  // провалившийся SPLIT_TASK уходила с task_id = NULL и связать её с
  // осиротевшей `[split] …` можно было только по времени.
  | {
      ok: false;
      error: string;
      actionId: string;
      taskId?: string;
      /**
       * `sideEffect` — часть работы уже видна снаружи (частичная доставка,
       * см. HandlerResult в dispatch/helpers.ts). `retryable: false` — тот же
       * факт для модели: повтор продублирует уже сделанное. Первый читает
       * gateOrDispatch (рефанд слота), второй уезжает в tool_result.
       */
      sideEffect?: boolean;
      retryable?: false;
    };

type DispatchAuditFaultPhase = "inflight" | "primary" | "recovery";
let dispatchAuditFaultForTests:
  | ((phase: DispatchAuditFaultPhase) => void)
  | null = null;

/** Test-only fault injection for the dispatch/audit recovery path. */
export function __setDispatchAuditFaultForTests(
  fault: ((phase: DispatchAuditFaultPhase) => void) | null,
): void {
  dispatchAuditFaultForTests = fault;
}

function writeDispatchAudit(
  phase: DispatchAuditFaultPhase,
  input: Parameters<typeof logAction>[0],
): { id: string } {
  dispatchAuditFaultForTests?.(phase);
  return logAction(input);
}

/**
 * Заводит строку `attempted` ДО обращения к внешнему миру.
 *
 * Аудит 2026-08-29: до этого единственная строка писалась после `await
 * dispatchAction`, и смерть процесса в промежутке (деплойный рестарт, OOM)
 * оставляла отправленное сообщение вообще без следа в базе. Строка «в полёте»
 * закрывает окно: она уже зафиксирована, когда действие уходит наружу.
 *
 * Отказ этой записи НЕ отменяет действие. Аудит не может быть условием
 * исполнения: иначе занятая на секунду база превращалась бы в отказ
 * обслуживания. Не легло — работаем по-старому, одной строкой после факта, и
 * говорим об этом в лог.
 */
function openInflightAudit(
  input: Parameters<typeof logAction>[0],
): string | null {
  try {
    return writeDispatchAudit("inflight", input).id;
  } catch (e) {
    log.warn("in-flight audit row not written; falling back to post-hoc audit", {
      requestId: input.requestId ?? null,
      agentKey: input.agentKey,
      actionType: input.actionType,
      error: getErrorMessage(e),
    });
    return null;
  }
}

/**
 * Закрывает строку «в полёте» терминальным статусом; если её нет — пишет
 * обычную одиночную строку, как делалось до аудита 2026-08-29.
 *
 * Событие в шину поднимается здесь же и только один раз: `finalizeActionRow`
 * возвращает его вместо того, чтобы слать самому, ровно по той же причине, что
 * и `insertActionRow` (см. его докблок).
 */
function closeDispatchAudit(
  inflightId: string | null,
  input: Parameters<typeof logAction>[0],
): { id: string } {
  if (inflightId) {
    dispatchAuditFaultForTests?.("primary");
    const finalized = finalizeActionRow(inflightId, {
      status: input.status,
      taskId: input.taskId ?? null,
      result: input.result,
      error: input.error ?? null,
    });
    if (finalized) {
      emitActionEvents(finalized);
      return { id: finalized.id };
    }
    // Строка в полёте исчезла или уже терминальна — санитар успел раньше, либо
    // её унесла архивация. Второй попытки переписать её не делаем: пишем новую
    // и оставляем обе, потому что молча слить их значило бы потерять факт.
    log.warn("in-flight audit row was not open at completion; writing a fresh one", {
      requestId: input.requestId ?? null,
      actionId: inflightId,
      actionType: input.actionType,
    });
  }
  return writeDispatchAudit("primary", input);
}

/**
 * Аварийная запись, когда штатное закрытие не прошло.
 *
 * Строка в полёте уже существует и уже несёт payload — вторая строка на то же
 * действие превратила бы «одно действие — одна запись» в «иногда две», и любой
 * счётчик по `agent_actions` начал бы врать ровно в тех случаях, когда база и
 * так шатается. Поэтому сначала пробуем дописать результат в неё, и только
 * если её больше нет (санитар, архивация) — заводим новую.
 *
 * Отдельный отказ на фазе `recovery` оставлен наблюдаемым для тестов: он
 * должен доходить до вызывающего и здесь, а не тонуть в успешном закрытии.
 */
function closeRecoveryAudit(
  inflightId: string | null,
  input: Parameters<typeof logAction>[0],
): { id: string } {
  if (inflightId) {
    dispatchAuditFaultForTests?.("recovery");
    const finalized = finalizeActionRow(inflightId, {
      status: input.status,
      taskId: input.taskId ?? null,
      result: input.result,
      error: input.error ?? null,
    });
    if (finalized) {
      emitActionEvents(finalized);
      return { id: finalized.id };
    }
    log.warn("in-flight audit row was gone at recovery; writing a fresh one", {
      requestId: input.requestId ?? null,
      actionId: inflightId,
      actionType: input.actionType,
    });
  }
  return writeDispatchAudit("recovery", input);
}

function auditRecoveryPayload(payload: unknown): unknown {
  try {
    JSON.stringify(payload);
    return payload;
  } catch {
    return {
      audit_recovery: true,
      original_payload: "unserializable",
    };
  }
}

/**
 * Что успело случиться снаружи к моменту, когда упала запись аудита.
 *
 * Третье состояние («partial») — не педантизм: провал с уже случившимся
 * побочным эффектом приходит сюда обычным `!ok` с `sideEffect: true`
 * (частичная доставка `sendChunked` после k из N частей), и оба прежних
 * варианта текста были про него неправдой.
 */
type SideEffectState = "succeeded" | "partial" | "none";

function auditFailureMessage(auditError: unknown, state: SideEffectState): string {
  const prefix =
    state === "succeeded"
      ? "external side effect succeeded"
      : state === "partial"
        ? "external side effect partially completed"
        : "external side effect did not complete";
  return `${prefix}, but audit write failed: ${getErrorMessage(auditError)}`;
}

function unavailableAuditId(requestId: string): string {
  return `audit-unavailable:${requestId}`;
}

/**
 * Выполняет действие и пишет один agent_action (ok|error).
 */
export async function dispatchAndAudit<T extends ActionType>(
  actionType: T,
  payload: PayloadFor<T>,
  ctx: DispatchCtx,
): Promise<DispatchAndAuditResult> {
  // T-410: ensure every audit row has a request id. Callers that already set
  // it at ingress (telegram bot/userbot, Mini App, mac-bridge, scheduler)
  // win; legacy callers get a per-dispatch id.
  if (!ctx.requestId) ctx.requestId = genRequestId();
  const requestId = ctx.requestId;
  // Строка заводится ДО вызова — см. `openInflightAudit`. taskId здесь ещё
  // неизвестен (его возвращает хендлер), его проставит закрытие.
  const inflightId = openInflightAudit({
    agentKey: ctx.agentKey,
    taskId: null,
    chatId: ctx.chatId,
    actionType,
    payload,
    status: "attempted",
    requestId,
  });
  const res = await dispatchAction(actionType, payload, ctx);
  // chatId, который реально использовался хендлером — всегда чат-источник.
  //
  // Аудит 2026-08-02/08-04 закрыл этим пиннутые действия: иначе в
  // agent_actions попадал бы чат, куда сообщение как раз НЕ ушло. Развилка
  // «пиннутое → ctx, остальное → из payload» осталась, и аудит 2026-08-28
  // показал, что вторая её половина неверна ровно так же. Адресат действия НЕ
  // приходит из payload ни у одного хендлера — это отдельный инвариант в
  // chat-pinning-invariant.test.ts, — поэтому чат из payload не описывает
  // ничего. Достижимо это было не с тулзового пути (там payload собирает
  // buildPayload, и все 14 типов, объявляющих chatId, пиннуты), а с ретрая
  // self-diag: он собирает payload из ответа модели, где `chatId` переживает
  // и TRUSTED_ONLY_PAYLOAD_FIELDS, и `_`-фильтр. Гейт, лимиты и хендлер там
  // работают по task.chat_id, так что действие уходило правильно — врал
  // только след: из ленты своего чата действие пропадало (Mini App и
  // GET_LOGS фильтруют по chat_id), а в чужой ленте появлялось лишнее.
  const chatId = ctx.chatId;
  const taskId = res.taskId;
  if (res.ok) {
    let actionId: string;
    try {
      ({ id: actionId } = closeDispatchAudit(inflightId, {
        agentKey: ctx.agentKey,
        taskId: taskId ?? null,
        chatId,
        actionType,
        payload,
        status: "ok",
        result: res.result,
        requestId,
      }));
    } catch (auditError) {
      // The handler may already have sent to Telegram or changed another
      // external system. Record that fact as an error; do not report success
      // merely because the side effect cannot be rolled back.
      const error = auditFailureMessage(auditError, "succeeded");
      try {
        const recovery = closeRecoveryAudit(inflightId, {
          agentKey: ctx.agentKey,
          taskId: taskId ?? null,
          chatId,
          actionType,
          payload: auditRecoveryPayload(payload),
          status: "error",
          result: { side_effect_succeeded: true },
          error,
          requestId,
        });
        log.error("dispatch completed but primary audit failed; recovery audit recorded", {
          requestId,
          agentKey: ctx.agentKey,
          actionType,
          actionId: recovery.id,
          error,
        });
        return {
          ok: false,
          error: `${error}; recovery audit status recorded as error`,
          actionId: recovery.id,
          taskId,
          // Аудит 2026-08-27: `retryable: false` говорил модели «не повторяй»,
          // но gateOrDispatch читает не его, а `sideEffect`. Без этого флага
          // рефанд возвращал слот рейт-лимита за ход, который уже отправил
          // сообщение в Telegram — то есть открывал дорогу дубликату.
          sideEffect: true,
          retryable: false,
        };
      } catch (recoveryError) {
        const recoveryMessage = getErrorMessage(recoveryError);
        log.error("dispatch completed but audit recovery also failed", {
          requestId,
          agentKey: ctx.agentKey,
          actionType,
          error,
          recoveryError: recoveryMessage,
        });
        return {
          ok: false,
          error: `${error}; recovery audit also failed: ${recoveryMessage}`,
          actionId: unavailableAuditId(requestId),
          taskId,
          sideEffect: true,
          retryable: false,
        };
      }
    }
    log.info("dispatch ok", {
      requestId,
      agentKey: ctx.agentKey,
      actionType,
      actionId,
      taskId: taskId ?? null,
    });
    return { ok: true, result: res.result, taskId, actionId };
  }
  let actionId: string;
  try {
    ({ id: actionId } = closeDispatchAudit(inflightId, {
      agentKey: ctx.agentKey,
      taskId: taskId ?? null,
      chatId,
      actionType,
      payload,
      status: "error",
      error: res.error,
      requestId,
    }));
  } catch (auditError) {
    // Аудит 2026-09-11: эта ветка теряла `sideEffect`/`retryable`.
    //
    // Зеркальная ветка на `ok`-пути (выше) ставит их намеренно: без
    // `sideEffect` рефанд в `gateOrDispatch` возвращает слот рейт-лимита за
    // ход, который уже написал в Telegram. Здесь рассуждение то же и случай
    // не гипотетический: частичная доставка приходит именно `!ok` с
    // `sideEffect: true` (см. audit-2026-08-28-approved-partial-delivery-
    // refund). Наложи на это падение записи аудита (SQLITE_BUSY, диск) — и
    // получаем ход, положивший k сообщений в чат, которому вернули слот и
    // сказали модели «ошибка, можно повторить». Под залипшей БД это
    // повторяется каждый ход: чат набивается кусками, а лимит не срабатывает,
    // потому что его каждый раз возвращают.
    const error = auditFailureMessage(
      auditError,
      res.sideEffect ? "partial" : "none",
    );
    const sideEffectFields = res.sideEffect
      ? { sideEffect: true as const, retryable: false as const }
      : {};
    try {
      const recovery = closeRecoveryAudit(inflightId, {
        agentKey: ctx.agentKey,
        taskId: taskId ?? null,
        chatId,
        actionType,
        payload: auditRecoveryPayload(payload),
        status: "error",
        error: `${error}; original dispatch error: ${res.error}`,
        requestId,
      });
      log.error("dispatch failed and primary audit failed; recovery audit recorded", {
        requestId,
        agentKey: ctx.agentKey,
        actionType,
        actionId: recovery.id,
        error,
      });
      return {
        ok: false,
        error: `${error}; recovery audit status recorded as error`,
        actionId: recovery.id,
        taskId,
        ...sideEffectFields,
      };
    } catch (recoveryError) {
      const recoveryMessage = getErrorMessage(recoveryError);
      log.error("dispatch failed and audit recovery also failed", {
        requestId,
        agentKey: ctx.agentKey,
        actionType,
        error,
        recoveryError: recoveryMessage,
      });
      return {
        ok: false,
        error: `${error}; recovery audit also failed: ${recoveryMessage}`,
        actionId: unavailableAuditId(requestId),
        taskId,
        ...sideEffectFields,
      };
    }
  }
  log.warn("dispatch error", {
    requestId,
    agentKey: ctx.agentKey,
    actionType,
    actionId,
    taskId: taskId ?? null,
    error: res.error,
  });
  // C7/C15 self-diagnosis: создаём задачу для AI Eng на runtime-ошибки tool'ов.
  // Не создаём там, где так решил shouldSkipSelfDiag (каскад создания задач +
  // отказы делегирования «по правилам»), при payload._diag === true (ручной
  // opt-out) и при payload._retry_count >= 1 (C15: жёсткий cap = 1 self-diag
  // retry per original action).
  //
  // Аудит 2026-08-12: оба предохранителя C15 ниже (потолок цепочки и
  // анти-шторм) выходили отсюда через `return`, то есть уносили с собой и блок
  // T-704 — тот самый, про который в его же комментарии написано ORTHOGONAL.
  // Выключались они там, где T-704 нужнее всего: цепочка упёрлась в потолок
  // или падений столько, что сработал анти-шторм. Отказ класса
  // permission_denied в такой момент не доезжал до perm вообще никогда.
  // Теперь C15 только подменяет текст ошибки (если есть чем) и идёт дальше.
  let c15Error: string | null = null;
  try {
    const p = payload as
      | { _diag?: boolean; _retry_count?: number; _fix_chain?: string[] }
      | null;
    const diagFlag = p?._diag === true;
    const retryCount =
      typeof p?._retry_count === "number" ? p._retry_count : 0;
    if (!shouldSkipSelfDiag(actionType, res.error) && !diagFlag && retryCount < 1) {
      // T-705b: circuit breaker on the diagnostic-fix chain.
      const parentChain = getFixChain(p);
      const maxDepth = getFixChainMaxDepth();
      if (parentChain.length >= maxDepth) {
        const finalChain = appendFixChain(
          parentChain,
          `diag:${actionType}:circuit_breaker`,
        );
        log.error("inter_agent_fix.circuit_breaker", {
          actionType,
          chain: finalChain,
          max_depth: maxDepth,
          error: res.error,
        });
        // Do NOT spawn another diag task. Mark this as a terminal failure.
        c15Error = `circuit breaker tripped (fix_chain depth ${parentChain.length} >= ${maxDepth}): ${res.error}`;
      } else if (isDiagTaskThrottled(`Tool error: ${actionType}`)) {
        // T-705 throttle: не плодить >5 diag-задач одного типа в час
        // (анти-шторм). Текст ошибки не подменяем — причина та же.
        log.warn("[self-diag] throttled — too many diag tasks for actionType", {
          actionType,
          max_per_hour: diagTaskThrottleMax(),
        });
      } else {
        const newChain = appendFixChain(
          parentChain,
          `diag:${actionType}:${String(res.error ?? "error").slice(0, 40)}`,
        );
        const task = createTask({
          chatId,
          createdBy: ctx.agentKey,
          assignedTo: "aieng",
          title: `Tool error: ${actionType}`,
          description: res.error,
          inputPayload: {
            actionType,
            payload,
            error: res.error,
            _diag: true,
            _retry_count: retryCount,
            _fix_chain: newChain,
          },
          priority: 1,
        });
        log.info(
          `[self-diag] created task ${task.id} for aieng (actionType=${actionType}, chain_depth=${newChain.length})`,
        );
      }
    }
  } catch (e) {
    log.error("[self-diag] failed to create diagnostic task", { error: String(e) });
  }

  // T-704: auto-diagnostic task for systemic failures (permissions, missing
  // capabilities, unknown errors). ORTHOGONAL to the C15 self-diag loop
  // above: C15 fixes payload-shape via aieng; T-704 routes the failure to
  // the responsible ROLE (perm / aieng / orchestrator) to address the
  // underlying class of problem. createDiagnosticTask is idempotent on
  // (action, category) and is a no-op for rate_limited / network (handled
  // elsewhere).
  try {
    const p2 = payload as { _diag?: boolean; _retry_count?: number } | null;
    const diagFlag2 = p2?._diag === true;
    const retryCount2 =
      typeof p2?._retry_count === "number" ? p2._retry_count : 0;
    if (!diagFlag2 && retryCount2 < 1 && !shouldSkipSelfDiag(actionType, res.error)) {
      createDiagnosticTask({
        failedActionId: actionId,
        actionType,
        error: res.error,
        chatId,
        originatingAgent: ctx.agentKey,
      });
    }
  } catch (e) {
    log.error("[diagnostic] auto-diagnostic creation crashed", {
      error: getErrorMessage(e),
    });
  }

  return {
    ok: false,
    error: c15Error ?? res.error,
    actionId,
    taskId,
    ...(res.sideEffect ? { sideEffect: true } : {}),
  };
}

/**
 * Единая точка tool_use: оценивает gate → выполняет / отказывает / создаёт approval.
 * Возвращает структурированный результат, оборачивание в JSON — на стороне executeTool.
 */
export type GateOrDispatchResult =
  | { kind: "ok"; result: unknown; taskId?: string; actionId: string }
  // taskId — для провалов, успевших создать строку задачи (SPLIT_TASK).
  // Модель получает id родителя и может сослаться на него в ответе человеку,
  // а не описывать провал словами.
  | {
      kind: "error";
      error: string;
      actionId?: string;
      taskId?: string;
      /** False when an external side effect may already have happened. */
      retryable?: false;
    }
  | { kind: "forbidden"; reason: string; actionId: string }
  | {
      kind: "pending_approval";
      reason: string;
      actionId: string;
      approvalId: string;
    }
  | {
      kind: "rate_limited";
      reason: string;
      retryInMs: number;
      actionId: string;
    };

/**
 * Причина отказа гейта одной строкой — для вызывающих внутри dispatch, которым
 * нужен текст, а не разбор вариантов (SPLIT_TASK собирает такие строки в
 * сводку по ролям). Отказ по правам и отказ по лимиту различимы по тексту:
 * первый — окончательный, второй и «ушло на одобрение» — про «не сейчас».
 */
function gateRefusalText(r: GateOrDispatchResult): string {
  switch (r.kind) {
    case "ok":
      return "ok";
    case "error":
      return r.error;
    case "forbidden":
      return `forbidden: ${r.reason}`;
    case "pending_approval":
      return `pending_approval: ${r.reason}`;
    case "rate_limited":
      return `rate_limited: ${r.reason}`;
  }
}

/**
 * Аудит 2026-08-29: рефанд получил отметки собственных резерваций.
 *
 * Без них снималась «последняя отметка в окне», кто бы её ни поставил. Для
 * действия, отвалившегося дольше чем через окно, это чужая живая отметка:
 * `MAC_RUN_CLAUDE` ждёт мост до пяти минут и на таймауте штатно рефандится, а
 * его резервация к тому моменту из минутного окна вышла. Подробности — в
 * `refundBucket`.
 */
function refundDispatchReservations(
  agentKey: string,
  botId: number | undefined,
  chatId: number,
  actionType: ActionType,
  reservedAt: { agent?: number; chat?: number },
): string[] {
  const errors: string[] = [];
  try {
    refundRateLimit(agentKey, actionType, Date.now(), reservedAt.agent);
  } catch (e) {
    errors.push(`agent rate-limit refund failed: ${getErrorMessage(e)}`);
  }
  try {
    refundChatRateLimits(botId, chatId, actionType, Date.now(), reservedAt.chat);
  } catch (e) {
    errors.push(`chat rate-limit refund failed: ${getErrorMessage(e)}`);
  }
  return errors;
}

let approvalTransactionFaultForTests: (() => void) | null = null;

/** Test-only fault injection for the approval unit-of-work rollback contract. */
export function __setApprovalTransactionFaultForTests(
  fault: (() => void) | null,
): void {
  approvalTransactionFaultForTests = fault;
}

export async function gateOrDispatch<T extends ActionType>(
  actionType: T,
  payload: PayloadFor<T>,
  ctx: DispatchCtx,
): Promise<GateOrDispatchResult> {
  // T-410: lazy-init requestId so downstream logAction + handlers all share it.
  if (!ctx.requestId) ctx.requestId = genRequestId();
  const requestId = ctx.requestId;
  // C12: rate limit check BEFORE gate evaluation.
  // T-315: per-chat check is a SEPARATE call alongside per-agent.
  // T-240: per-bot-per-chat check is an additional dimension.
  // Fail closed on any limit hit.
  const rlChat = checkPerChatRateLimit(ctx.chatId, actionType);
  const rlBotChat = rlChat.ok ? checkPerBotPerChatRateLimit(ctx.botId, ctx.chatId, actionType) : rlChat;
  const rl = rlBotChat.ok ? checkRateLimit(ctx.agentKey, actionType) : rlBotChat;
  if (!rl.ok) {
    const retryInMs = rl.retryInMs ?? 0;
    const reason = rl.reason ?? "rate limited";
    log.info("rate limited", {
      requestId,
      agentKey: ctx.agentKey,
      actionType,
      reason,
      retryInMs,
    });
    const { id } = logAction({
      agentKey: ctx.agentKey,
      chatId: ctx.chatId,
      actionType,
      payload,
      status: "rate_limited",
      error: reason,
      requestId,
    });
    return { kind: "rate_limited", reason, retryInMs, actionId: id };
  }

  // SEC-4 / T-602 (+re-audit): действия «от лица владельца» (via_userbot) и
  // bypass-запуск Claude на его Mac требуют человека при любой autonomy.
  // Аудит 2026-08-08: проверки переехали в payloadForcesApproval — здесь и в
  // self-diag жили две независимые копии одного инварианта, а bypass не
  // проверял никто, хотя оба комментария утверждали обратное.
  const forcedReason = payloadForcesApproval(actionType, payload);
  const gate = evaluateGate({
    agentKey: ctx.agentKey,
    actionType,
    chatId: ctx.chatId,
    forceApproval: forcedReason !== null,
    forceApprovalReason: forcedReason ?? undefined,
  });

  if (gate.decision === "deny") {
    const { id } = logAction({
      agentKey: ctx.agentKey,
      chatId: ctx.chatId,
      actionType,
      payload,
      status: "forbidden",
      error: gate.reason,
      requestId,
    });
    return { kind: "forbidden", reason: gate.reason, actionId: id };
  }

  // T-701/T-702/T-703: validate inter-agent mutation payloads AFTER gate (so caller
  // restriction returns forbidden first) but BEFORE approval-row creation,
  // so invalid payloads don't sit in the approvals queue.
  {
    let vErr: string | null = null;
    if (actionType === "GRANT_PERMISSION") {
      vErr = validateGrantPermissionPayload(
        payload as PayloadByType["GRANT_PERMISSION"],
      );
    } else if (actionType === "CHANGE_AGENT_STATUS") {
      vErr = validateChangeAgentStatusPayload(
        payload as PayloadByType["CHANGE_AGENT_STATUS"],
      );
    } else if (actionType === "UPDATE_AGENT_PROMPT") {
      vErr = validateUpdateAgentPromptPayload(
        payload as PayloadByType["UPDATE_AGENT_PROMPT"],
      );
    } else if (actionType === "CREATE_DIAGNOSTIC_TASK") {
      vErr = validateCreateDiagnosticTaskPayload(
        payload as PayloadByType["CREATE_DIAGNOSTIC_TASK"],
      );
    }
    if (vErr) {
      const { id } = logAction({
        agentKey: ctx.agentKey,
        chatId: ctx.chatId,
        actionType,
        payload,
        status: "error",
        error: vErr,
        requestId,
      });
      return { kind: "error", error: vErr, actionId: id };
    }
  }

  if (gate.decision === "approval") {
    // Аудит 2026-08-20: две строки писались двумя отдельными операциями, то
    // есть двумя коммитами. Если процесс убит между ними (рестарт, OOM) или
    // INSERT в approvals падает, остаётся действие в статусе
    // `pending_approval`, к которому не привязана ни одна заявка. Подобрать
    // его некому: expireStaleApprovals работает по таблице approvals и такой
    // строки не видит, а gcStaleTasks трогает только tasks. Санитар по
    // `pending_approval` с тех пор появился — `closeGatedActionRow` зовут
    // отказ, протухание заявки и три отказа исполнения до диспатча, — но все
    // три входа идут ОТ строки заявки, поэтому именно сиротскую строку без
    // заявки не подберут и они. Ради этого случая транзакция здесь и стоит.
    //
    // P1: action, approval, and UPDATE_AGENT_PROMPT proposal are one durable
    // unit. BEGIN IMMEDIATE also makes COUNT+INSERT an atomic cap reservation
    // across separate agent-team processes. No event is emitted in the tx.
    const cap = maxPendingApprovals();
    let txResult:
      | { kind: "full"; pending: number; cap: number }
      | { kind: "queued"; action: ReturnType<typeof insertActionRow>; approvalId: string };
    try {
      txResult = withApprovalTransaction((database) => {
        // Аудит 2026-09-10: счёт идёт по чату — предел защищает выдачу
        // `/approvals` этого чата, и складывать в него доски, которых человек
        // здесь не видит, значит отбивать работу без причины (докблок
        // `maxPendingApprovals`). Запрос тот же самый, что у счётчика в
        // approvals.ts, — одна форма на оба места.
        const pending = countPendingApprovals(ctx.agentKey, ctx.chatId, database);
        if (pending >= cap) return { kind: "full" as const, pending, cap };

        const action = insertActionRow(actionType, {
          agentKey: ctx.agentKey,
          chatId: ctx.chatId,
          payload,
          status: "pending_approval",
          requestId,
        });
        approvalTransactionFaultForTests?.();
        const approvalId = insertApprovalRow({
          actionId: action.id,
          chatId: ctx.chatId,
          requestedBy: ctx.agentKey,
          actionType,
          payload,
        }, database);
        // Аудит 2026-09-10: строка версии писалась ДО заявки и ссылки на неё
        // не получала — сопоставить их потом можно было только по содержимому
        // (докблок `closeAgentPromptProposals`). Порядок внутри одной
        // транзакции роли не играет: снаружи видны либо обе строки, либо ни
        // одной, — а заявка, вставленная первой, отдаёт свой id.
        if (actionType === "UPDATE_AGENT_PROMPT") {
          insertPendingAgentPrompt(
            payload as PayloadByType["UPDATE_AGENT_PROMPT"],
            ctx.agentKey,
            database,
            approvalId,
          );
        }
        return { kind: "queued" as const, action, approvalId };
      }, db);
    } catch (e) {
      const msg = getErrorMessage(e);
      const { id } = logAction({
        agentKey: ctx.agentKey,
        chatId: ctx.chatId,
        actionType,
        payload,
        status: "error",
        error: msg,
        requestId,
      });
      return { kind: "error", error: msg, actionId: id };
    }
    if (txResult.kind === "full") {
      const err =
        `очередь одобрений переполнена: у ${ctx.agentKey} в этом чате уже ` +
        `${txResult.pending} нерешённых заявок при пределе ${txResult.cap} — ` +
        `дождись решения человека`;
      log.warn("approval queue full", {
        requestId,
        agentKey: ctx.agentKey,
        actionType,
        pending: txResult.pending,
        cap: txResult.cap,
      });
      const { id } = logAction({
        agentKey: ctx.agentKey,
        chatId: ctx.chatId,
        actionType,
        payload,
        status: "error",
        error: err,
        requestId,
      });
      return { kind: "error", error: err, actionId: id };
    }
    // Only now, after BEGIN IMMEDIATE committed, publish the two events.
    emitActionEvents(txResult.action);
    const approval = getApproval(txResult.approvalId);
    if (!approval) {
      // Аудит 2026-08-27: транзакция уже закоммичена, approval существует и
      // ждёт владельца. Отвечать `kind: "error"` — врать вызывающему: модель
      // считает ход провалившимся и запрашивает согласование повторно, плодя
      // дубликаты. Событие отправить нечем, поэтому громко логируем и всё
      // равно возвращаем pending_approval с закоммиченным id.
      log.error("approval committed but could not be read back", {
        requestId,
        agentKey: ctx.agentKey,
        actionType,
        approvalId: txResult.approvalId,
        actionId: txResult.action.id,
      });
      return {
        kind: "pending_approval",
        reason: gate.reason,
        actionId: txResult.action.id,
        approvalId: txResult.approvalId,
      };
    }
    emitApprovalCreated(approval);
    return {
      kind: "pending_approval",
      reason: gate.reason,
      actionId: txResult.action.id,
      approvalId: approval.id,
    };
  }

  // T-314: race-free reservation. Atomically check+commit the rate-limit
  // slot SYNCHRONOUSLY (no await between) before kicking off the async
  // dispatch. Closes the window where N concurrent calls all see "count <
  // max" at the early `checkRateLimit` above and then all commit after
  // dispatch, exceeding the bucket.
  // Аудит 2026-08-09: чат-бакеты резервируются так же. Раньше они только
  // проверялись наверху, а коммитились после await — то есть ровно та гонка,
  // которую T-314 закрыл для агентских бакетов и описал абзацем выше.
  const reserveChat = checkAndConsumeChatRateLimits(
    ctx.botId,
    ctx.chatId,
    actionType,
  );
  const reserve = reserveChat.ok
    ? checkAndConsumeRateLimit(ctx.agentKey, actionType)
    : reserveChat;
  if (!reserve.ok) {
    // Агентский бакет проиграл гонку уже после того, как чат-слот занят —
    // вернуть, иначе проигравший всё равно съедает лимит чата.
    if (reserveChat.ok) {
      refundChatRateLimits(
        ctx.botId,
        ctx.chatId,
        actionType,
        Date.now(),
        reserveChat.reservedAt,
      );
    }
    const retryInMs = reserve.retryInMs ?? 0;
    const reason = reserve.reason ?? "rate limited";
    log.info(
      `[ratelimit][${ctx.agentKey}] ${actionType}: ${reason} (race-lost), retry in ${retryInMs}ms`,
    );
    const { id } = logAction({
      agentKey: ctx.agentKey,
      chatId: ctx.chatId,
      actionType,
      payload,
      status: "rate_limited",
      error: reason,
      requestId,
    });
    return { kind: "rate_limited", reason, retryInMs, actionId: id };
  }

  // allow
  // T-315/T-240: чат-бакеты уже зарезервированы выше — как и агентский
  // внутри checkAndConsumeRateLimit (T-314). The reservation is released in
  // finally on non-success paths — but NOT on all of them: a failure that
  // already left a mark outside keeps its slot (`res.sideEffect` below, audit
  // 2026-08-21). This comment used to promise "every non-success path,
  // including an audit exception after an external handler side effect has
  // already completed" — which is the exact case the sideEffect branch was
  // added to exclude.
  let outcome: GateOrDispatchResult = {
    kind: "error",
    error: "dispatch/audit did not produce a result",
  };
  let refundNeeded = true;
  try {
    const res = await dispatchAndAudit(actionType, payload, ctx);
    if (res.ok) {
      refundNeeded = false;
      outcome = {
        kind: "ok",
        result: res.result,
        taskId: res.taskId,
        actionId: res.actionId,
      };
    } else {
      // Аудит 2026-08-21: провал, уже оставивший след снаружи, рефандить
      // нельзя. Частичная доставка (`sendChunked` бросает после k из N частей)
      // приходит сюда обычным `!ok`, и рефанд возвращал слот за ход, положивший
      // в чат k сообщений. Рассуждение то же, что у NO_REFUND_ACTIONS для
      // GENERATE_IMAGE («побочный эффект случился внутри dispatch'а»), только
      // там оно записано списком типов действий, а здесь нужно по факту хода:
      // полный провал SEND_MESSAGE рефандить по-прежнему правильно.
      if (res.sideEffect) refundNeeded = false;
      outcome = {
        kind: "error",
        error: res.error,
        ...(res.actionId ? { actionId: res.actionId } : {}),
        ...(res.taskId ? { taskId: res.taskId } : {}),
        ...(res.retryable === false ? { retryable: false as const } : {}),
      };
    }
  } catch (e) {
    const error = `dispatch/audit failed: ${getErrorMessage(e)}`;
    log.error("dispatch/audit threw after rate-limit reservation", {
      requestId,
      agentKey: ctx.agentKey,
      actionType,
      error,
    });
    outcome = { kind: "error", error };
  } finally {
    if (refundNeeded) {
      const refundErrors = refundDispatchReservations(
        ctx.agentKey,
        ctx.botId,
        ctx.chatId,
        actionType,
        { agent: reserve.reservedAt, chat: reserveChat.reservedAt },
      );
      if (refundErrors.length > 0 && outcome.kind === "error") {
        outcome.error = `${outcome.error}; ${refundErrors.join("; ")}`;
        log.error("dispatch failure could not fully refund rate-limit reservation", {
          requestId,
          agentKey: ctx.agentKey,
          actionType,
          refundErrors,
        });
      }
    }
  }
  return outcome;
}

// =====================================================================
// R4 (T-112 follow-up): buildPayload extracted to dispatch/build-payload.ts.
// Re-exported here so existing importers keep working unchanged.
// =====================================================================
export {
  buildPayload,
  type BuildPayloadCtx,
  type BuildResult,
} from "./dispatch/build-payload.ts";

function fmtToolResult(r: Record<string, unknown>): string {
  return JSON.stringify(r);
}

/**
 * Format a GateOrDispatchResult as a short JSON string for tool_result.
 */
export function formatGateResult(
  name: ActionType,
  r: GateOrDispatchResult,
): string {
  if (r.kind === "ok") {
    const result = (r.result ?? {}) as Record<string, unknown>;
    if (name === "COMMENT_TASK") {
      return fmtToolResult({ ok: true, actionId: r.actionId });
    }
    if (
      name === "CREATE_TASK" ||
      name === "ASSIGN_TASK" ||
      name === "UPDATE_TASK_STATUS" ||
      name === "REQUEST_REVIEW"
    ) {
      return fmtToolResult({
        ok: true,
        taskId: (result.taskId as string | undefined) ?? r.taskId,
        status: result.status as string | undefined,
      });
    }
    // Telegram-side-effect: подмешать messageId и т.п. в JSON.
    return fmtToolResult({ ok: true, ...result });
  }
  if (r.kind === "error") {
    return fmtToolResult({
      ok: false,
      error: r.error,
      actionId: r.actionId,
      // Провал, успевший создать задачу (SPLIT_TASK), отдаёт её id — иначе
      // модель знает только текст ошибки и не может сослаться на строку,
      // которая уже висит на доске.
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.retryable === false ? { retryable: false } : {}),
    });
  }
  if (r.kind === "pending_approval") {
    return fmtToolResult({
      ok: false,
      status: "pending_approval",
      approvalId: r.approvalId,
      actionId: r.actionId,
      reason: r.reason,
    });
  }
  if (r.kind === "rate_limited") {
    return fmtToolResult({
      ok: false,
      status: "rate_limited",
      actionId: r.actionId,
      reason: r.reason,
      retryInMs: r.retryInMs,
    });
  }
  return fmtToolResult({
    ok: false,
    status: "forbidden",
    actionId: r.actionId,
    reason: r.reason,
  });
}
