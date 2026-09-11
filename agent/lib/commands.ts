/**
 * Чистые функции-обработчики команд (этап 3, C4).
 *
 * Без зависимостей от telegraf. Принимают разобранные аргументы,
 * возвращают текстовый ответ для чата.
 */
import {
  decideApproval,
  getApproval,
  markApprovalFailed,
  resolveApproval,
  approvalTtlMs,
  type Approval,
} from "./approvals.ts";
import { listTasksByChat, listTasksByAssignee, type TaskStatus } from "./tasks.ts";
import { HOUR_MS } from "./time-constants.ts";
import {
  getAutonomy,
  setAutonomy,
  setPermission,
  ACTION_TYPES,
  type AutonomyMode,
  type ActionType,
  listAgentAutonomyOverrides,
} from "./permissions.ts";
import { getDiscussionMode, setDiscussionMode } from "./chat-settings.ts";
import { listActions, closeGatedActionRow } from "./audit.ts";
import {
  listPendingApprovals,
  countPendingApprovalsInChat,
  approvalPreview,
} from "./approvals.ts";
import { CHARACTERS } from "../characters/index.ts";
import { db } from "./db.ts";
import type { Telegram } from "telegraf";
import type { RunningBot } from "./types.ts";
import { dispatchAndAudit, type DispatchCtx } from "./action-dispatch.ts";
import {
  CALLER_RESTRICTED,
  evaluateGate,
  grantCaveat,
  grantIneffectiveReason,
  isToolExposedToRole,
} from "./permissions.ts";
import type { PayloadFor } from "./action-payload.ts";
import { auditRejectedApproval } from "./dispatch/agent-prompt.ts";
import {
  checkAndConsumeChatRateLimits,
  checkAndConsumeRateLimit,
  refundChatRateLimits,
  refundRateLimit,
} from "./rate-limits.ts";
import { log } from "./log.ts";

export type TelegramResolver = (agentKey: string) => Telegram | undefined;

/**
 * Всё, что путь апрува обязан донести до dispatch помимо самой заявки.
 *
 * Аудит 2026-08-12: ctx собирался из трёх полей — `{ agentKey, chatId,
 * telegram }`, — тогда как `gateOrDispatch` получает одиннадцать. Замер (заявка
 * DELEGATE_TO_ROLE от orchestrator, права выданы, владелец нажал Approve):
 *
 *   DELEGATE_TO_ROLE бросил: no resolveAgent in dispatch ctx
 *   agent_actions: {"status":"error","error":"no resolveAgent in dispatch ctx"}
 *   + [self-diag] created task … + [diagnostic] created task …
 *
 * То есть одобренное человеком действие не выполнялось никогда, а вместо этого
 * рождало две мусорные строки на доске и повторную попытку у aieng. В semi_auto
 * (режим по умолчанию) так себя вёл CREATE_TEAM_CHANNEL — он в SEMI_AUTO_RISKY
 * и иначе как через апрув не исполняется вовсе; в manual — любое действие,
 * кроме COMMENT_TASK.
 *
 * Тип выведен из `DispatchCtx`, чтобы поля не разъезжались снова.
 */
export type ApprovalExecDeps = Pick<
  DispatchCtx,
  "resolveAgent" | "handoffDeps" | "respondAsImpl" | "botId"
> & { resolveTg?: TelegramResolver };

/**
 * Единственное место, где этот набор собирается.
 *
 * Аудит 2026-08-13: собирали его ДВА раза — `orchestrator-team.ts` для
 * `/approve` в чате и `orchestrator/services.ts` для Mini App, — и наборы
 * разъехались: в веб-версии не хватало `handoffDeps`, то есть одобренный
 * DELEGATE_TO_ROLE выходил на `no handoffDeps in dispatch ctx`. Правка
 * 2026-08-12 добавила туда `resolveAgent` и тем самым сдвинула отказ на семь
 * строк ниже, а не убрала его: список полей и тогда переписывался руками.
 *
 * Цена расхождения тут выше обычного отказа. `decideApproval` уже закоммитил
 * `approved`, а провал исполнения переводит строку в `failed`; из pending она
 * не вернётся ни в веб (`WHERE status = 'pending'`), ни в `/approve`
 * (`existing.status !== "pending"`). Одно нажатие НЕОБРАТИМО сжигало заявку,
 * не выполнив действия.
 *
 * `botId` сюда намеренно не входит: `executeApproved` берёт бота по агенту,
 * который действие запросил, — см. `execBotId` там же.
 */
export function buildApprovalExecDeps(args: {
  bots: RunningBot[];
  handoffDeps: DispatchCtx["handoffDeps"];
}): ApprovalExecDeps {
  const { bots, handoffDeps } = args;
  return {
    resolveTg: (key: string) => bots.find((b) => b.def.key === key)?.bot.telegram,
    resolveAgent: (key: string) => bots.find((b) => b.def.key === key),
    handoffDeps,
  };
}

const AGENT_KEYS: string[] = CHARACTERS.map((c) => c.key);

function isActionType(s: string): s is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(s);
}

function isAgentKey(s: string): boolean {
  return AGENT_KEYS.includes(s);
}

function fmtTs(ms: number): string {
  // Хранится в ms (Date.now()). Если вдруг секунды (< 10^12) — поднимем до ms.
  const t = ms < 1e12 ? ms * 1000 : ms;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const OPEN_STATUSES: TaskStatus[] = [
  "pending",
  "running",
  "awaiting_approval",
  "awaiting_review",
];

const AUTONOMY_MODES: AutonomyMode[] = [
  "locked",
  "manual",
  "semi_auto",
  "auto",
];

export function isAutonomyMode(s: string): s is AutonomyMode {
  return (AUTONOMY_MODES as string[]).includes(s);
}

/**
 * Отказ ДО диспатча: строку действия закрываем сами.
 *
 * Аудит 2026-09-11. `executeApproved` может отказать пятью способами, и четыре
 * из них срабатывают ДО `dispatchAndAudit`: тип действия, которого в коде уже
 * нет (заявка пережила переименование), протухший TTL заявки, вызывающий,
 * которому этот тип действия не положен, и deny-гейт, появившийся между
 * созданием заявки и нажатием «Approve». В этих четырёх случаях второй строки в
 * `agent_actions` не заводится вовсе — а первая, заведённая гейтом в
 * `pending_approval`, так и остаётся ждать решения, которое уже принято.
 * Санитары мимо: `expireStaleApprovals` смотрит на `approvals.status='pending'`
 * (а тут `approved`), `expireStaleAttempts` — на `attempted`. То есть строка
 * висит «ждёт аппрув» вечно: и в `/audit`, и в ленте Mini App, и в GET_LOGS,
 * который читает сама модель, и в метрике `agent_actions_recent`.
 *
 * Обещание «dispatchAndAudit уже записал status='error'» стояло в обоих
 * вызывающих (`cmdApprove` ниже и Mini App) и для этих четырёх путей было
 * неправдой: до `dispatchAndAudit` управление не доходило.
 *
 * `forbidden` — тот же статус и тот же смысл, что у отказа человека и у
 * протухшей заявки (докблок `closeGatedActionRow`): наружу не ушло, потому что
 * не разрешили. Пятый способ отказать — провал самого диспатча — сюда не
 * заходит: у него своя пара строк с тем же `request_id`, и переписывать здесь
 * ещё и первую значило бы посчитать один ход дважды.
 */
function failBeforeDispatch(approval: Approval, msg: string): never {
  closeGatedActionRow(approval.action_id, msg);
  throw new Error(msg);
}

export async function executeApproved(
  approval: Approval,
  deps: ApprovalExecDeps = {},
): Promise<unknown> {
  const byAgent = approval.requested_by;
  if (!isActionType(approval.action_type)) {
    // Не «не может случиться»: тип пишется в заявку при создании, а читается
    // при нажатии — между этими двумя моментами тип успевают переименовать или
    // убрать. Закрываем строку так же, как остальные отказы до диспатча,
    // иначе она останется «ждёт аппрув» навсегда.
    failBeforeDispatch(approval, `unknown action_type: ${approval.action_type}`);
  }
  const actionType = approval.action_type as ActionType;
  // Аудит 2026-08-12: возраст заявки не проверялся нигде. Санитар в db-maint
  // переводит просроченные в 'expired', но он мог не отработать — процесс лежал,
  // интервал не наступил, — а нажатие «Approve» на карточке трёхмесячной
  // давности исполняет необратимое действие с трёхмесячным payload'ом: текст в
  // канал, промпт MAC_RUN_CLAUDE. Ниже уже перепроверяются вызывающий и
  // deny-гейты — то есть то, что мир между созданием и решением меняется, здесь
  // и так предполагается. Возраст — из того же ряда, и проверять его надо
  // именно в точке действия.
  const ttl = approvalTtlMs();
  const age = Date.now() - approval.created_at;
  if (age > ttl) {
    const hours = Math.round(age / HOUR_MS);
    failBeforeDispatch(
      approval,
      `approval expired: заявке ${hours} ч при сроке ${Math.round(ttl / HOUR_MS)} ч — ` +
        `пусть агент запросит заново, payload устарел`,
    );
  }
  // SEC-audit MED-1 (T-724): executeApproved dispatches directly, skipping the
  // gate. Re-enforce the caller restriction at EXECUTION time so an approved row
  // for a caller-restricted action (MAC_RUN_CLAUDE, GRANT_PERMISSION, …) can
  // never run from a non-allowed requester, even if the row was crafted.
  const requiredCaller = CALLER_RESTRICTED[actionType];
  if (requiredCaller && byAgent !== requiredCaller) {
    failBeforeDispatch(
      approval,
      `caller not allowed at execution: ${actionType} restricted to '${requiredCaller}' (was '${byAgent}')`,
    );
  }
  // Аудит 2026-08-04: перепроверялся ТОЛЬКО CALLER_RESTRICTED, поэтому запрет,
  // появившийся между созданием апрува и нажатием «Approve», не действовал.
  // Сценарий: у smm висит апрув на SEND_MESSAGE; perm выполняет одобренный
  // CHANGE_AGENT_STATUS и выключает smm (или админ шлёт
  // POST /api/permissions {allowed:false}); админ жмёт Approve на старой
  // карточке — и сообщение уходит от выключенного агента. Комментарий в
  // permissions.ts про «disabled-агент запрещён на КАЖДОЕ действие» на этом
  // пути был неправдой: isAgentDisabled не звался вовсе.
  //
  // Берём только deny-слои: «approval» здесь уже удовлетворён — человек
  // подтвердил именно этот payload, он в строке апрува и не переписывается.
  const gate = evaluateGate({
    agentKey: byAgent,
    actionType,
    chatId: approval.chat_id ?? undefined,
  });
  if (gate.decision === "deny") {
    failBeforeDispatch(approval, `blocked at execution: ${gate.reason}`);
  }

  const payload = (approval.payload ?? {}) as PayloadFor<typeof actionType>;
  // Бакеты: путь апрува звал dispatchAndAudit напрямую и не тратил их вовсе —
  // через очередь одобрений можно было провести сколько угодно действий, и
  // счётчик этого не замечал. Считаем, но человеку НЕ отказываем: он уже решил,
  // и отказ на его нажатие был бы новым поведением. Смысл счёта в том, что
  // последующие действия самого агента упрутся в лимит честно.
  //
  // Аудит 2026-08-13: бакет «этот бот в этом чате» тратился не тем ботом или
  // не тратился вовсе. Вызов в Telegram делает бот запросившего агента —
  // `deps.resolveTg?.(byAgent)` строкой ниже. А сюда приходило: с
  // Telegram-пути — id ОРКЕСТРАТОРА (там, в `orchestrator-team.ts`, регается
  // /approve), с Mini App — `undefined`, и `checkPerBotPerChatRateLimit` на
  // undefined молча отвечает «ок» (ранний выход в `rate-limits.ts`). То есть
  // очередь одобрений не трогала бакет отправителя ни на одном из двух путей — ровно
  // та дыра, которую комментарий выше считает закрытой. Берём бота по агенту,
  // deps.botId остаётся запасным вариантом.
  const execBotId = deps.resolveAgent?.(byAgent)?.id ?? deps.botId;
  const chatSlot = checkAndConsumeChatRateLimits(
    execBotId,
    approval.chat_id,
    actionType,
  );
  const agentSlot = checkAndConsumeRateLimit(byAgent, actionType);
  if (!chatSlot.ok || !agentSlot.ok) {
    log.warn("approved action over rate limit — исполняем, решение человека", {
      approvalId: approval.id,
      agentKey: byAgent,
      actionType,
      reason: chatSlot.reason ?? agentSlot.reason,
    });
  }
  const res = await dispatchAndAudit(actionType, payload, {
    agentKey: byAgent,
    chatId: approval.chat_id,
    botId: execBotId,
    telegram: deps.resolveTg?.(byAgent),
    // Строка апрува помнит ход агента, который её породил. Без этого
    // dispatchAndAudit лениво минтил НОВЫЙ id, и одобренное действие висело в
    // audit_logs сиротой — связать его с исходным запросом было нечем.
    requestId: approval.request_id ?? undefined,
    // Аудит 2026-09-10: id самой заявки. `agent_prompts` пишет его при
    // постановке в очередь, а применение искало свою строку по содержимому —
    // связь была, но ею не пользовались (см. `handleUpdateAgentPromptApproved`).
    approvalId: approval.id,
    resolveAgent: deps.resolveAgent,
    handoffDeps: deps.handoffDeps,
    respondAsImpl: deps.respondAsImpl,
  });
  if (!res.ok) {
    // Как в gateOrDispatch: неудавшийся диспатч не должен съедать лимит.
    //
    // Аудит 2026-08-28: «как в gateOrDispatch» было неправдой ровно в одном
    // месте. Там (`gateOrDispatch` в action-dispatch.ts) стоит `if (res.sideEffect)
    // refundNeeded = false;` — провал, уже оставивший след снаружи, не
    // рефандится. Частичная доставка (`sendChunked` бросает после k из N
    // частей) приходит сюда обычным `!ok` с `sideEffect: true`, и рефанд
    // возвращал слот за ход, положивший в чат k сообщений. Через очередь
    // одобрений это ещё дешевле, чем на прямом пути: одобрено человеком —
    // значит длинное, значит многочастное.
    if (!res.sideEffect) {
      // Аудит 2026-08-29: рефанд снимает отметку своей резервации, а не
      // «последнюю в окне» — иначе долгий провал забирал слот у чужого хода.
      if (agentSlot.ok) {
        refundRateLimit(byAgent, actionType, Date.now(), agentSlot.reservedAt);
      }
      if (chatSlot.ok) {
        refundChatRateLimits(
          execBotId,
          approval.chat_id,
          actionType,
          Date.now(),
          chatSlot.reservedAt,
        );
      }
    }
    throw new Error(res.error);
  }
  return res.result;
}

export async function cmdApprove(args: {
  approvalId: string;
  decidedBy: string;
  chatId: number;
  /** Резолверы для исполнения. См. ApprovalExecDeps: без них падают
   *  DELEGATE_TO_ROLE и CREATE_TEAM_CHANNEL. */
  deps?: ApprovalExecDeps;
}): Promise<string> {
  // Полный id решается из любого чата: админ, отклоняющий из лички,
  // — сценарий из аудита 2026-08-09, и журнал у него уходит в чат заявки.
  // Сужается только префикс — см. докблок `resolveApproval`.
  const existing = resolveApproval(args.approvalId, args.chatId);
  if (!existing) return `Approval не найден: ${args.approvalId}`;
  if (existing.status !== "pending") {
    return `Approval ${args.approvalId} уже ${existing.status}.`;
  }
  let approved: Approval;
  try {
    // existing.id — полный id (args.approvalId мог быть префиксом).
    approved = decideApproval(existing.id, "approved", args.decidedBy);
  } catch (e) {
    return `Не удалось одобрить: ${(e as Error).message}`;
  }
  try {
    await executeApproved(approved, args.deps ?? {});
  } catch (e) {
    // Строку действия закрыл тот, кто отказал: `dispatchAndAudit` пишет свою
    // пару `attempted` → `error`, а три отказа ДО него — `failBeforeDispatch`
    // (аудит 2026-09-11). Прежний комментарий обещал первое на все случаи.
    const msg = (e as Error).message;
    // Аудит 2026-08-07: сообщение в чат — единственный след провала, если не
    // пометить строку. Иначе апрув навсегда остаётся `approved`, и потом не
    // отличить «выполнилось» от «упало».
    markApprovalFailed(approved.id, msg);
    return `Approved ${approved.id}, но выполнение упало: ${msg}`;
  }
  return `OK: approval ${approved.id} (${approved.action_type}) approved by ${args.decidedBy}.`;
}

export function cmdReject(args: {
  approvalId: string;
  decidedBy: string;
  chatId: number;
  reason?: string;
}): string {
  const existing = resolveApproval(args.approvalId, args.chatId);
  if (!existing) return `Approval не найден: ${args.approvalId}`;
  if (existing.status !== "pending") {
    return `Approval ${args.approvalId} уже ${existing.status}.`;
  }
  try {
    const rejected = decideApproval(
      existing.id, // полный id (args.approvalId мог быть префиксом)
      "rejected",
      args.decidedBy,
      args.reason,
    );
    // T-702: on reject of an UPDATE_AGENT_PROMPT, write an audit_logs entry.
    // The pre-inserted agent_prompts row stays with applied_at=NULL.
    // Проверка типа и best-effort-обработка ошибки — внутри auditRejectedApproval,
    // общей с путём Mini App (аудит 2026-08-08).
    auditRejectedApproval({
      actionType: rejected.action_type,
      payload: rejected.payload,
      decidedBy: args.decidedBy,
      // Аудит 2026-08-09: раньше здесь стоял args.chatId — чат, В КОТОРОМ
      // набрали команду. Mini App на том же событии пишет чат самого approval'а.
      // Две записи об одном и том же классе решения оказывались в разных
      // чатах, а единственный читатель журнала фильтрует по chat_id: отказ,
      // сделанный админом в личке, пропадал из журнала командного чата —
      // ровно там, где его и будут искать. approvals.chat_id NOT NULL, так
      // что запасной вариант не нужен.
      chatId: rejected.chat_id,
      // Аудит 2026-08-21: заказчик и id approval'а — иначе в журнале нет ни
      // «кто просил», ни ключа, по которому его можно найти.
      requestedBy: rejected.requested_by,
      approvalId: rejected.id,
      reason: args.reason,
    });
    return `Rejected: ${rejected.id} (${rejected.action_type})${
      args.reason ? ` — ${args.reason}` : ""
    }.`;
  } catch (e) {
    return `Не удалось отклонить: ${(e as Error).message}`;
  }
}

export function cmdTasks(args: { chatId: number; agentKey?: string }): string {
  // Аудит 2026-08-27: параметр был, а звать его было некому — обработчик
  // `tasks` в `ADMIN_COMMANDS` (admin-commands.ts) глотал аргументы (`_args`)
  // и всегда звал без роли.
  // `/tasks smm` печатал ВЕСЬ чат под заголовком, который человек читает как
  // «задачи smm»: список ролевой на вид, общий по сути. Молчаливое расширение
  // выборки хуже отказа — по нему делают вывод «у smm семь задач».
  if (args.agentKey && !isAgentKey(args.agentKey)) {
    return `Неизвестный agent: ${args.agentKey}. Допустимо: ${AGENT_KEYS.join(", ")}`;
  }
  const list = args.agentKey
    // Сужение по чату переехало в SQL (аудит 2026-08-28): раньше та же мысль
    // жила здесь в .filter(), а в Mini App не жила вовсе. Результат тот же —
    // колонка chat_id объявлена INTEGER, так что равенство в SQL и в JS
    // совпадает.
    ? listTasksByAssignee(args.agentKey, OPEN_STATUSES, undefined, args.chatId)
    : listTasksByChat(args.chatId, OPEN_STATUSES);
  const scope = args.agentKey ? ` роли ${args.agentKey}` : "";
  if (!list.length) return `Открытых задач${scope} нет.`;
  const lines = list.slice(0, 20).map((t) => {
    const assignee = t.assigned_to ? `→${t.assigned_to}` : "(unassigned)";
    return `• [${t.status}] ${t.title} ${assignee} #${t.id.slice(0, 8)}`;
  });
  // Хвост: печатаем двадцать, а счётчик в шапке — полный, иначе двадцать
  // строк читаются как вся очередь (тот же класс, что чинили в /approvals).
  const tail =
    list.length > lines.length
      ? `\n… и ещё ${list.length - lines.length} — весь список в Mini App`
      : "";
  return `Открытые задачи${scope} (${list.length}):\n${lines.join("\n")}${tail}`;
}

/**
 * Приписка о ролях, которые этот режим не затронет.
 *
 * Аудит 2026-08-21: строка `autonomy_modes(scope='agent')` побеждает чатовую
 * (getAutonomy проверяет её первой), но команда об этом молчала и рапортовала
 * об успехе безусловно. Владелец набирал `/autonomy locked`, получал
 * «Autonomy для чата … → locked.», переспрашивал `/autonomy` и получал
 * «locked» — а роль с переопределением продолжала работать в `auto`, потому
 * что `cmdAutonomy` читает `getAutonomy(chatId)` без agentKey, а гейт зовёт
 * его с agentKey.
 */
function overrideNote(chatId: number): string {
  const rows = listAgentAutonomyOverrides();
  if (!rows.length) return "";

  // Аудит 2026-08-27: приписка утверждала «свой режим сильнее чатового»
  // безусловно — а с аудита 2026-08-20 это уже неправда для `locked`:
  // стоп-кран чата читается ПЕРВЫМ (`getAutonomy`, permissions.ts) и строку
  // роли перекрывает. Владелец жал стоп-кран посреди инцидента и читал в
  // ответ, что design продолжает работать в `auto`, — то есть шёл снимать
  // переопределения, которые уже не действуют, вместо того чтобы разбираться
  // с инцидентом. Ошибка была ровно в опасную сторону: команда сообщала, что
  // рубильник сработал не везде, хотя он сработал везде.
  //
  // Спрашиваем не карту приоритетов по памяти, а сам `getAutonomy` — ту же
  // функцию и с тем же agentKey, что зовёт гейт. Иначе приписка снова начнёт
  // расходиться с решением при следующей правке приоритетов.
  const ownWins: string[] = [];
  const chatWins: string[] = [];
  for (const r of rows) {
    const effective = getAutonomy(chatId, r.agent);
    (effective === r.mode ? ownWins : chatWins).push(
      effective === r.mode ? `${r.agent}=${r.mode}` : `${r.agent}=${r.mode}→${effective}`,
    );
  }
  const parts: string[] = [];
  if (ownWins.length) {
    parts.push(
      `⚠️ Не затронуты — у этих ролей свой режим, он сильнее чатового: ${ownWins.join(", ")}.`,
    );
  }
  if (chatWins.length) {
    parts.push(
      `Стоп-кран чата перекрывает собственный режим этих ролей — они тоже остановлены: ${chatWins.join(", ")}.`,
    );
  }
  return `\n\n${parts.join("\n")}\nСнять: Mini App → Agents → режим «inherit».`;
}

export function cmdAutonomy(args: {
  chatId: number;
  mode?: AutonomyMode;
}): string {
  if (!args.mode) {
    const current = getAutonomy(args.chatId);
    return `Текущий autonomy для чата ${args.chatId}: ${current}${overrideNote(args.chatId)}`;
  }
  if (!isAutonomyMode(args.mode)) {
    return `Неизвестный режим: ${args.mode}. Допустимо: ${AUTONOMY_MODES.join(", ")}`;
  }
  setAutonomy("chat", String(args.chatId), args.mode);
  return `Autonomy для чата ${args.chatId} → ${args.mode}.${overrideNote(args.chatId)}`;
}

export function cmdDiscussion(args: {
  chatId: number;
  on?: boolean;
}): string {
  if (args.on === undefined) {
    const cur = getDiscussionMode(args.chatId);
    return `Discussion-режим для чата ${args.chatId}: ${cur ? "ON" : "OFF"}.`;
  }
  setDiscussionMode(args.chatId, args.on);
  return args.on
    ? `Discussion-режим для чата ${args.chatId} → ON. Агенты могут вести более длинную цепочку обсуждения (каждая роль ≤1 раза за цепочку). /discussion off — выключить.`
    : `Discussion-режим для чата ${args.chatId} → OFF.`;
}

export function cmdGrant(args: {
  args: string[];
  /** Кто выполнил команду (`ctx.decidedBy`). Попадает в аудит. */
  changedBy?: string;
  chatId?: number;
}): string {
  const [agentKey, action, modeArg] = args.args;
  if (!agentKey || !action) {
    return "Usage: /grant <agentKey> <ACTION> [auto|approval]";
  }
  if (!isAgentKey(agentKey)) {
    return `Неизвестный agent: ${agentKey}. Допустимо: ${AGENT_KEYS.join(", ")}`;
  }
  if (!isActionType(action)) {
    return `Неизвестный action: ${action}. Допустимо: ${ACTION_TYPES.join(", ")}`;
  }
  const mode = modeArg ?? "auto";
  if (mode !== "auto" && mode !== "approval") {
    return `Неизвестный mode: ${mode}. Допустимо: auto | approval`;
  }
  // Аудит 2026-08-27: два статических рубежа стоят ВЫШЕ таблицы permissions —
  // `evaluateGate` отвечает `deny` по ним ещё до чтения строки
  // (`CALLER_RESTRICTED` и `ROLE_EXPOSED_TOOLS` в permissions.ts). То есть
  // `/grant smm GENERATE_IMAGE auto` писал строку, рапортовал «права обновлены» и не менял НИЧЕГО: владелец
  // считал, что выдал доступ, агент продолжал получать отказ, и разбирались с
  // этим по логам гейта. Строка при этом оставалась в БД и всплывала в
  // `/perms` как выданное право. Обе карты — решения владельца в КОДЕ, из чата
  // они не переписываются; поэтому здесь отказ с адресом, а не тихая запись.
  //
  // ПОПРАВКА 2026-08-28: рубежей выше таблицы не два, а четыре. Проверка
  // переехала в общий `grantIneffectiveReason` (lib/permissions.ts) — он же
  // используется в `/perms` и в `POST /api/permissions`, чтобы строка, которую
  // отказался писать один вход, не приходила через другой.
  const ineffective = grantIneffectiveReason(agentKey, action, mode);
  if (ineffective) {
    return (
      `${ineffective} — из чата это не переписать. Строку не пишу: она бы не ` +
      `подействовала. Нужно другое — правь код и деплой.`
    );
  }
  setPermission(
    agentKey,
    action,
    { allowed: true, requires_approval: mode === "approval" },
    { changedBy: args.changedBy ?? "admin", chatId: args.chatId, source: "command" },
  );
  const caveat = grantCaveat(action, mode);
  return (
    `права обновлены: ${agentKey}.${action} = ${mode}` +
    (caveat ? `\nОговорка: ${caveat}.` : "")
  );
}

export function cmdRevoke(args: {
  args: string[];
  /** Кто выполнил команду (`ctx.decidedBy`). Попадает в аудит. */
  changedBy?: string;
  chatId?: number;
}): string {
  const [agentKey, action] = args.args;
  if (!agentKey || !action) {
    return "Usage: /revoke <agentKey> <ACTION>";
  }
  if (!isAgentKey(agentKey)) {
    return `Неизвестный agent: ${agentKey}. Допустимо: ${AGENT_KEYS.join(", ")}`;
  }
  if (!isActionType(action)) {
    return `Неизвестный action: ${action}. Допустимо: ${ACTION_TYPES.join(", ")}`;
  }
  setPermission(
    agentKey,
    action,
    { allowed: false, requires_approval: false },
    { changedBy: args.changedBy ?? "admin", chatId: args.chatId, source: "command" },
  );
  return `права обновлены: ${agentKey}.${action} = denied`;
}

interface PermRow {
  agent_key: string;
  action_type: string;
  allowed: number;
  requires_approval: number;
}

export function cmdPerms(args: { args: string[] }): string {
  const filterAgent = args.args[0];
  if (filterAgent && !isAgentKey(filterAgent)) {
    return `Неизвестный agent: ${filterAgent}. Допустимо: ${AGENT_KEYS.join(", ")}`;
  }
  const rows = db
    .prepare(
      `SELECT agent_key, action_type, allowed, requires_approval
       FROM permissions
       ORDER BY agent_key, action_type`,
    )
    .all() as PermRow[];
  const filtered = filterAgent
    ? rows.filter((r) => r.agent_key === filterAgent)
    : rows;
  if (!filtered.length) return "permissions: пусто.";
  const byAgent = new Map<string, string[]>();
  for (const r of filtered) {
    const mode =
      r.allowed === 0
        ? "denied"
        : r.requires_approval === 1
          ? "approval"
          : "auto";
    // Аудит 2026-08-27: таблица — не последнее слово. Гейт сначала смотрит
    // CALLER_RESTRICTED и ROLE_EXPOSED_TOOLS (обе карты — в permissions.ts), и
    // строка `allowed=1` под ними мертва. Миграция 010 засеяла GENERATE_IMAGE
    // всем 12 ролям — `/perms` показывал двенадцать «auto» на инструменте,
    // который выдан двоим. Отчёт о правах, расходящийся с гейтом, хуже
    // отсутствия отчёта: по нему принимают решения.
    //
    // ПОПРАВКА 2026-08-28: рубежа было проверено два из четырёх, и отчёт
    // подтверждал ту самую ложную картину, ради разоблачения которой написан.
    // Теперь маркер считает тот же `grantIneffectiveReason`, что и `/grant`:
    // расхождение отчёта с гейтом стало невозможным по конструкции.
    const dead =
      r.allowed === 1 && mode !== "denied"
        ? grantIneffectiveReason(r.agent_key, r.action_type as ActionType, mode as "auto" | "approval")
        : null;
    if (!byAgent.has(r.agent_key)) byAgent.set(r.agent_key, []);
    byAgent
      .get(r.agent_key)!
      .push(
        // Оговорка про SEMI_AUTO_RISKY сюда НЕ идёт: множество большое, и
        // приписка к каждой второй строке превратила бы отчёт в стену текста.
        // Ей место в ответе `/grant`, где речь про одно конкретное действие.
        `${r.action_type}=${mode}` + (dead ? ` (мертва: ${dead})` : ""),
      );
  }
  const lines: string[] = [];
  for (const [agent, parts] of byAgent) {
    lines.push(`${agent}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

export function cmdAudit(args: { args: string[] }): string {
  let agentKey: string | undefined;
  let limit = 20;
  for (const a of args.args) {
    const n = Number(a);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      limit = Math.min(n, 100);
    } else if (isAgentKey(a)) {
      agentKey = a;
    } else {
      // Аудит 2026-08-09: непонятый аргумент молча выпадал, и фильтр по роли
      // просто не применялся. `/audit designer` (реальный ключ — design) или
      // опечатка отдавали последние 20 действий ВСЕХ двенадцати агентов в том
      // же формате «[ts] agent action status» — выглядит как валидная выдача,
      // и человек делает вывод про названную роль по чужим строкам. Соседние
      // команды на том же файле (/grant, /revoke, /perms) на такой же ввод
      // отвечают явной ошибкой; только чтение угадывало.
      return `Неизвестный agent: ${a}. Допустимо: ${AGENT_KEYS.join(", ")}`;
    }
  }
  const list = listActions({ agentKey, limit });
  if (!list.length) return "записей нет";
  return list
    .map(
      (a) =>
        `[${fmtTs(a.created_at)}] ${a.agent_key} ${a.action_type} ${a.status}`,
    )
    .join("\n");
}

export function cmdApprovals(args: {
  chatId: number;
  args: string[];
}): string {
  const LIMIT = 20;
  // Аудит 2026-08-27: параметр `args` команда принимала и не читала ни разу.
  // `/approvals smm` печатал ВСЮ очередь чата под запросом об одной роли —
  // тот же класс, что чинили в `/tasks` (admin-commands.ts глотал аргументы).
  // Молчаливое расширение выборки хуже отказа: по нему делают вывод «у smm
  // двадцать заявок» и идут решать чужие.
  const requestedBy = args.args?.[0];
  if (requestedBy && !isAgentKey(requestedBy)) {
    return `Неизвестный agent: ${requestedBy}. Допустимо: ${AGENT_KEYS.join(", ")}`;
  }
  const scope = requestedBy ? ` от ${requestedBy}` : "";
  const list = listPendingApprovals(args.chatId, LIMIT, requestedBy);
  if (!list.length) return `нет ожидающих approvals${scope}`;
  // Аудит 2026-08-20: список печатался как есть, хотя отдаётся двадцать самых
  // старых, а копится в чате до 120 (10 на роль × 12 ролей). Двадцать строк
  // без хвоста читаются как «это вся очередь» — остальные заявки не решают, и
  // они истекают по TTL. Хвост считаем отдельным запросом: обрезка нужна
  // именно из-за размера очереди, а её размер и есть то, что надо показать.
  // Счётчик фильтруется тем же условием, что и выдача: иначе хвост «и ещё N»
  // считал бы очередь всего чата под списком одной роли.
  const total = countPendingApprovalsInChat(args.chatId, requestedBy);
  const tail = total > list.length
    ? `\n… и ещё ${total - list.length} — весь список в Mini App`
    : "";
  return list
    .map((a) => {
      // Без выжимки владелец жал /approve, не видя ни строки того, что уйдёт
      // подписчикам: строка состояла только из id, роли и типа действия.
      // Чат — из строки заявки, не из payload'а: исполнение пинит действие
      // к `approval.chat_id` (`executeApproved` выше передаёт его как
      // `chatId` в `dispatchAndAudit`), а `payload.chatId` игнорируется.
      const preview = approvalPreview(a.action_type, a.payload, undefined, {
        chatId: a.chat_id,
      });
      const head = `${a.id} ${a.requested_by} ${a.action_type} (создано ${fmtTs(a.created_at)})`;
      return preview ? `${head} — ${preview}` : head;
    })
    .join("\n") + tail;
}
