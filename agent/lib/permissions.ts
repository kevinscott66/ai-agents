/**
 * Permissions-gate с autonomy overlay (этап 3, C3).
 *
 * Два уровня доступа:
 *  - permissions[agent_key, action_type] = { allowed, requires_approval }
 *    статическая роль-настройка (засеяна миграцией 006_seed_permissions).
 *  - autonomy_modes[scope, scope_id] = mode
 *    глобальный/чатовый режим автономии: locked|manual|semi_auto|auto.
 *
 * evaluateGate() сводит оба в одно из трёх решений: allow | deny | approval.
 */
import { db } from "./db.ts";
import { log } from "./log.ts";
import { logAction } from "./audit.ts";

export type AutonomyMode = "locked" | "manual" | "semi_auto" | "auto";

export const ACTION_TYPES = [
  "SEND_MESSAGE",
  "CREATE_TASK",
  "ASSIGN_TASK",
  "UPDATE_TASK_STATUS",
  "REQUEST_REVIEW",
  "COMMENT_TASK",
  "SET_REACTION",
  "EDIT_MESSAGE",
  "PIN_MESSAGE",
  "DELETE_MESSAGE",
  "FORWARD_MESSAGE",
  "CREATE_POLL",
  "SEND_PHOTO",
  "SEND_DOCUMENT",
  "CREATE_TEAM_CHANNEL",
  "PUBLISH_TO_CHANNEL",
  "GENERATE_SVG_IMAGE",
  "GENERATE_IMAGE",
  "DELEGATE_TO_ROLE",
  "WRITE_WIKI",
  "SPLIT_TASK",
  "LIST_RECENT_MESSAGES",
  "MAC_RUN_CLAUDE",
  "MAC_STOP",
  "SCHEDULE_POST",
  // T-701/T-702/T-703: inter-agent mutation actions. ALWAYS approval-gated.
  "GRANT_PERMISSION",
  "UPDATE_AGENT_PROMPT",
  "CHANGE_AGENT_STATUS",
  // T-511: orchestrator PR review and merge capability.
  "REVIEW_AND_MERGE_PR",
  // T-701: explicit diagnostic-task creation. Allowed for all roles, never
  // approval-gated (creating a task is not an external side-effect).
  "CREATE_DIAGNOSTIC_TASK",
  // T-512: legacy ad-hoc role boundary. Dispatch-only and restricted to the
  // orchestrator; it must not reach an external scheduler/executor.
  "SPAWN_ROLE",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Actions reachable only through backend dispatch/control flows, not model tools. */
export const DISPATCH_ONLY_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  GRANT_PERMISSION: "privilege escalation; вызывающего нет",
  UPDATE_AGENT_PROMPT: "меняет поведение ботов в проде; только approval-флоу",
  CHANGE_AGENT_STATUS: "административная; только approval-флоу",
  REVIEW_AND_MERGE_PR: "merge capability only through approved action; вызывающего нет",
  // Аудит 2026-08-28: прежняя формулировка («ставится движком self-healing
  // автоматически») описывала не то, что происходит. Движок его не ставит —
  // на catch-пути он зовёт библиотечный createDiagnosticTask() напрямую, мимо
  // диспетчера. Дальше — факт: до ветки диспетчера не доходит никто.
  CREATE_DIAGNOSTIC_TASK:
    "тула нет, и диспатчить её некому: движок self-healing зовёт createDiagnosticTask() напрямую",
  SPAWN_ROLE: "локальная очередь роли только через approved dispatch; вызывающего нет",
});

/**
 * T-701/T-702/T-703: Actions that ALWAYS require approval — even when the calling
 * agent has `requires_approval=false` and the autonomy mode is `auto`.
 * Used for inter-agent mutations (perm/aieng changing other agents'
 * security state). Keeps a human-in-the-loop for every privilege change.
 */
export const ALWAYS_APPROVE_ACTIONS: Set<ActionType> = new Set<ActionType>([
  "GRANT_PERMISSION",
  "UPDATE_AGENT_PROMPT",
  "CHANGE_AGENT_STATUS",
  // T-511: merging a PR into main is irreversible — always require approval,
  // regardless of autonomy mode, to match the action's own doc comment.
  "REVIEW_AND_MERGE_PR",
  // T-512: ad-hoc role requests stay approval-gated while the internal runtime
  // has no isolated temporary-role identity.
  "SPAWN_ROLE",
  // SEC-audit 2026-06-10 (MED-2): MAC remote-exec is RCE on the owner's machine.
  // requires_approval in the permissions table is GRANT_PERMISSION-flippable, so
  // under `auto` autonomy approval could be removed. Make approval MANDATORY —
  // independent of autonomy mode and grant state.
  // NB: MAC_STOP is deliberately NOT here — it is a safety kill-switch and must
  // fire immediately (it stays orchestrator-only via CALLER_RESTRICTED).
  "MAC_RUN_CLAUDE",
  // Аудит 2026-08-04: публикация в публичный канал шла БЕЗ человека в контуре.
  // Миграция 038 сеет PUBLISH_TO_CHANNEL как allowed=1, requires_approval=0, в
  // SEMI_AUTO_RISKY его не было, а дефолтная автономия — semi_auto: гейт
  // возвращал `allow`. Инверсия была наглядной — сообщение в приватный чат
  // команды требовало апрува, пост подписчикам канала нет.
  //
  // Здесь, а не в SEMI_AUTO_RISKY: пост уходит подписчикам мгновенно и
  // необратимо (та же логика, что у REVIEW_AND_MERGE_PR), а правило проекта —
  // публичный контент только через draft+approve, в любом режиме автономии.
  // Комментарий у handleSchedulePost (dispatch/misc.ts) и раньше утверждал,
  // что публикация «остаётся за PUBLISH_TO_CHANNEL под апрувом», — теперь это
  // наконец правда.
  "PUBLISH_TO_CHANNEL",
]);

/**
 * T-701/T-702/T-703: Actions that may only be invoked by a fixed agent key. Other
 * callers receive a "forbidden: caller not allowed" gate denial regardless
 * of their `permissions` row.
 */
export const CALLER_RESTRICTED: Record<string, string> = {
  GRANT_PERMISSION: "perm",
  UPDATE_AGENT_PROMPT: "aieng",
  CHANGE_AGENT_STATUS: "perm",
  // T-511: only the orchestrator may request a PR review-and-merge.
  REVIEW_AND_MERGE_PR: "orchestrator",
  // T-512: only the orchestrator may spawn ad-hoc roles.
  SPAWN_ROLE: "orchestrator",
  // T-116 (re-audit H1): Mac remote-exec is the strongest action — enforce
  // orchestrator-only at the CODE level (the permissions table is grantable and
  // must not be the sole gate for RCE on the owner's machine).
  MAC_RUN_CLAUDE: "orchestrator",
  MAC_STOP: "orchestrator",
  // Создание канала от имени владельца + назначение админов — действие реального
  // аккаунта; только лид (orchestrator) как контролёр процесса.
  CREATE_TEAM_CHANNEL: "orchestrator",
};

/**
 * T-723 (SEC-audit F5): per-role TOOL EXPOSURE. Sensitive tools that are guarded
 * by in-handler caller checks (read-only or scheduling) should ALSO not be
 * offered to other roles at the prompt level — so a prompt-injected agent can't
 * even attempt them. Multi-role allowlist (orchestrator included for oversight).
 * Single-role tools are covered by CALLER_RESTRICTED above (reused below).
 */
export const ROLE_EXPOSED_TOOLS: Record<string, readonly string[]> = {
  QUERY_DB: ["backend", "orchestrator"],
  // Аудит 2026-08-28: у renderMetrics два вызывающих, и закрыт был только один.
  // HTTP-ручка /metrics fail-closed по Bearer'у (miniapp-server.ts: нет
  // METRICS_TOKEN → 503, нет заголовка → 401), а инструмент GET_METRICS зовёт
  // ту же функцию напрямую — и, будучи инлайновым, коротко замыкается ДО
  // gateOrDispatch, так что единственной проверкой для него остаётся эта карта.
  // Строки здесь не было → isToolExposedToRole возвращал true всем 12 ролям.
  // Отдавалось при этом mac_bridge_connected — ровно тот сигнал «поднят ли мост
  // к машине владельца», который 2026-08-12 намеренно убрали из публичного
  // /api/health, — плюс tasks_open, approvals_pending, messages_stored и версия
  // сборки. Диагностика состояния системы — дело лида и aieng; остальным ролям
  // она в работе не нужна, а инъекции в любой из них давала карту прода.
  GET_METRICS: ["aieng", "orchestrator"],
  GET_PROMPT_HISTORY: ["aieng", "orchestrator"],
  CANCEL_SCHEDULED_POST: ["smm", "orchestrator"],
  // Аудит 2026-08-13: третий инструмент того же календаря — и единственный,
  // которого здесь не было. Соседняя строка про SCHEDULE_POST говорит «видеть и
  // отменять — только эти двое»; отменять — да, а ВИДЕТЬ мог кто угодно из 12
  // ролей. Выдача чат-скоупная (T-722), то есть чужой чат не вычитать, но
  // внутри своего инъекция в любой роли перечисляла план публикаций smm.
  LIST_SCHEDULED_POSTS: ["smm", "orchestrator"],
  // Пара к предыдущей строке. Заводить запись в календаре мог кто угодно из
  // 12 ролей, а видеть и отменять — только эти двое: инъекция в любой роли
  // оставляла в чужом календаре записи, которые её собственная роль потом не
  // могла ни перечислить, ни снять.
  SCHEDULE_POST: ["smm", "orchestrator"],
  // Каждый — свою роль (запрос владельца): картинки/макеты генерит ТОЛЬКО
  // дизайнер. Раньше forceFirstTool позволял фронту тоже вызвать GENERATE_*,
  // и он дублировал изображение вместо HTML-наработки. Остальным роль-ботам
  // image-генерация недоступна → нужен визуал → делегируют design.
  GENERATE_IMAGE: ["design", "orchestrator"],
  GENERATE_SVG_IMAGE: ["design", "orchestrator"],
  // Постинг в канал — контентные роли + лид-контролёр.
  PUBLISH_TO_CHANNEL: ["smm", "copy", "design", "orchestrator"],
};

/**
 * Whether a tool should be EXPOSED (offered) to a given role. Defense-in-depth
 * on top of the gate / in-handler checks: filters the tool list per role.
 * Unknown/common tools are exposed to everyone.
 */
export function isToolExposedToRole(tool: string, agentKey: string): boolean {
  const single = CALLER_RESTRICTED[tool];
  if (single) return agentKey === single;
  const multi = ROLE_EXPOSED_TOOLS[tool];
  if (multi) return multi.includes(agentKey);
  return true;
}

export interface Permission {
  allowed: boolean;
  requires_approval: boolean;
}

/**
 * Действия, которые в режиме semi_auto всегда требуют approval,
 * даже если permissions.requires_approval=false.
 * Пока — только исходящие сообщения (внешний side-effect).
 */
/**
 * Действия, у которых `via_userbot: true` означает «отправлено от лица живого
 * владельца» и потому требует человека, какой бы ни была autonomy.
 *
 * Аудит 2026-08-08: этот перечень был захардкожен ДВАЖДЫ — в gateOrDispatch и,
 * копией, в self-diag — и ничем не связан с тем, какие payload'ы поле реально
 * принимают. Стоило бы завести `via_userbot` четвёртому действию, и оно молча
 * ушло бы от имени владельца без подтверждения: в gateOrDispatch его нет в
 * списке, а в self-diag тем более. Теперь список один, и тест сверяет его с
 * tools-schema — то есть с тем, что модели вообще предложено вызвать.
 */
export const USERBOT_FORCE_APPROVAL: Set<ActionType> = new Set<ActionType>([
  "SEND_MESSAGE",
  "SET_REACTION",
  "DELETE_MESSAGE",
]);

/**
 * `via_userbot: true` в payload'е действия, для которого это значимо.
 *
 * Строгое сравнение с `true` сохранено намеренно: строка "true", 1 и прочие
 * «почти истинные» значения из JSON модели owner-voice не включают, и путь
 * остаётся обычным — а не тихо обходит approval.
 */
export function isOwnerVoice(
  actionType: ActionType,
  payload: unknown,
): boolean {
  if (!USERBOT_FORCE_APPROVAL.has(actionType)) return false;
  return (payload as { via_userbot?: unknown } | undefined)?.via_userbot === true;
}

/**
 * `mode: "bypass"` у MAC_RUN_CLAUDE — это `claude --permission-mode
 * bypassPermissions` в проекте на личном MacBook владельца, то есть выполнение
 * произвольных команд без единого подтверждения на его машине.
 *
 * Аудит 2026-08-08: и хендлер (`dispatch/mac.ts`: «bypass mode always requires
 * approval regardless of settings»), и комментарий у macAutonomous («остальные
 * слои защиты сохраняются: … без bypass-режима») утверждали, что человек здесь
 * обязателен. Не было ничего, что бы это делало: `macAuto` считался ровно по
 * actionType, payload гейт не видел вовсе. При MAC_AUTONOMOUS=true и
 * autonomy=auto (обе — осознанные настройки владельца, но про MAC_RUN_CLAUDE
 * вообще, не про bypass) ветка ALWAYS_APPROVE пропускалась, и bypass уходил на
 * исполнение без подтверждения — оставался только MAC_ALLOW_BYPASS, флаг
 * «разрешён в принципе», а не «разрешён без спроса».
 */
export function isBypassMacRun(
  actionType: ActionType,
  payload: unknown,
): boolean {
  if (actionType !== "MAC_RUN_CLAUDE") return false;
  return (payload as { mode?: unknown } | undefined)?.mode === "bypass";
}

/**
 * Mac-действие, пришедшее делегированием, а не напрямую от человека.
 *
 * Аудит 2026-08-13: `respondAs` не прокидывал `triggerUserId` в делегата, из-за
 * чего у делегированного MAC_RUN_CLAUDE/MAC_STOP `_userId` был undefined и
 * `isUserAllowed` молча возвращал false. Путь был мёртв — включая аварийный
 * MAC_STOP, ровно тот дефект, что уже чинили на хоп выше (SEC-audit LOW-2).
 *
 * Починка прокидывания оживляет и то, чего раньше не было: цепочку «любая роль
 * → оркестратор → запуск claude на маке владельца». Гейт CALLER_RESTRICTED
 * держит только имя вызывающего, а тут вызывающий как раз оркестратор —
 * законный. Единственное, что отличает такой ход от прямого обращения
 * владельца, это факт делегирования, и он же решает: opt-in MAC_AUTONOMOUS
 * давался оркестратору под указание человека, а не под просьбу соседней роли,
 * в которую могло приехать что угодно из веб-страницы или файла.
 *
 * Поэтому делегированный ход требует человека при любой autonomy. Whitelist
 * MAC_USER_IDS при этом продолжает считаться по ИСХОДНОМУ пользователю: чужой
 * человек не получает запуск ни делегированием, ни напрямую.
 */
export function isDelegatedMacAction(
  actionType: ActionType,
  payload: unknown,
): boolean {
  if (actionType !== "MAC_RUN_CLAUDE" && actionType !== "MAC_STOP") return false;
  return (payload as { _delegated?: unknown } | undefined)?._delegated === true;
}

/**
 * Что в payload'е требует человека независимо от autonomy. Возвращает причину
 * для карточки approval либо null.
 *
 * Единая точка: гейт по устройству не видит payload (GateInput его не несёт),
 * поэтому такие проверки живут у вызывающего — и раньше это означало «сколько
 * вызывающих, столько копий». Список причин расширяется здесь, а не по местам.
 */
export function payloadForcesApproval(
  actionType: ActionType,
  payload: unknown,
): string | null {
  if (isOwnerVoice(actionType, payload)) {
    return "owner-identity action requires approval";
  }
  if (isBypassMacRun(actionType, payload)) {
    return "bypass mode requires approval";
  }
  if (isDelegatedMacAction(actionType, payload)) {
    return "delegated Mac action requires approval";
  }
  return null;
}

export const SEMI_AUTO_RISKY: Set<ActionType> = new Set<ActionType>([
  "SEND_MESSAGE",
  "PIN_MESSAGE",
  "DELETE_MESSAGE",
  "EDIT_MESSAGE",
  "CREATE_POLL",
  "FORWARD_MESSAGE",
  // NB (S4/S5, security 2026-06-10): exfil-риск исходящих медиа (SEND_PHOTO/
  // SEND_DOCUMENT в произвольный чат) закрыт НЕ approval'ом (фрикшн), а pin'ом
  // chatId к исходному чату в хендлерах (см. dispatch/telegram.ts, dispatch/media.ts).
  "MAC_RUN_CLAUDE",
  "MAC_STOP",
  // Создание канала от имени владельца: в semi_auto — approval, в auto — сразу.
  "CREATE_TEAM_CHANNEL",
]);

/**
 * Действия без трения: не требуют апрува ни в `manual`, ни в `semi_auto`.
 *
 * Аудит 2026-08-10: набор назывался READONLY_ACTIONS и проверялся ДО режима
 * автономии — то есть работал и в `locked`. Но COMMENT_TASK не readonly: он
 * пишет строку в задачу, которую читают и другие агенты, и люди. А `locked`
 * означает ровно одно — «эта роль (или этот чат) не действует»; запись в общее
 * состояние это действие. Оставался канал, по которому выключенный агент
 * продолжал писать на доску, и именно как исключение, вынесенное выше гейта.
 *
 * Прецедент тот же: T-313 (finding #9) убрал отсюда LIST_RECENT_MESSAGES —
 * история чата это PII, и «read-only на уровне API» не повод обходить гейт.
 * Здесь ошибка была не в составе набора, а в его месте: набор проверяется
 * теперь ПОСЛЕ `locked`, так что смысл у него остался ровно один — не дёргать
 * человека апрувом на дешёвое внутреннее действие в manual/semi_auto.
 */
export const LOW_FRICTION_ACTIONS: Set<ActionType> = new Set<ActionType>([
  "COMMENT_TASK",
]);

/**
 * Подействует ли строка permissions, если её записать прямо сейчас.
 *
 * Аудит 2026-08-28. `/grant` уже отказывался писать строки, мёртвые по
 * `CALLER_RESTRICTED` и `ROLE_EXPOSED_TOOLS` — но рубежей выше таблицы не два,
 * а четыре, и остальные два он игнорировал в ОБЕ стороны:
 *
 *  - `/grant qa COMMENT_TASK approval` отвечал «права обновлены», а
 *    `evaluateGate` доходит до `LOW_FRICTION_ACTIONS` раньше, чем до ветвей
 *    manual/semi_auto — единственных, которые читают `requires_approval`. Флаг
 *    не читается ни в одном режиме. Владелец ставит тормоз, получает
 *    подтверждение и уходит; апрувов не будет ни одного, агент пишет дальше.
 *    Направление небезопасное: не срабатывает УЖЕСТОЧЕНИЕ.
 *  - `/grant smm PUBLISH_TO_CHANNEL auto` отвечал «= auto», а
 *    `ALWAYS_APPROVE_ACTIONS` стоит выше таблицы и всегда отвечает `approval`.
 *    Владелец рассчитывает, что публикации пойдут сами; вместо этого копятся
 *    заявки, которых никто не ждёт.
 *
 * Функция — общий рубеж для обоих входов к `setPermission` (команда `/grant` и
 * `POST /api/permissions` в Mini App) и для отчёта `/perms`: строка, которую
 * один вход отказывается писать, не должна проходить через другой и потом
 * выглядеть в отчёте как выданное право.
 *
 * Возвращает `null`, если строка подействует, иначе — причину с адресом в коде.
 */
export function grantIneffectiveReason(
  agentKey: string,
  action: ActionType,
  mode: "auto" | "approval",
): string | null {
  const requiredCaller = CALLER_RESTRICTED[action];
  if (requiredCaller && requiredCaller !== agentKey) {
    return `${action} закреплён за ролью '${requiredCaller}' (CALLER_RESTRICTED, lib/permissions.ts)`;
  }
  if (!isToolExposedToRole(action, agentKey)) {
    return `${action} не выдан роли '${agentKey}' (ROLE_EXPOSED_TOOLS, lib/permissions.ts)`;
  }
  if (mode === "approval" && LOW_FRICTION_ACTIONS.has(action)) {
    return (
      `${action} — low-friction (LOW_FRICTION_ACTIONS, lib/permissions.ts): гейт ` +
      `отвечает allow ДО того, как прочтёт requires_approval, во всех режимах автономии`
    );
  }
  if (mode === "auto" && ALWAYS_APPROVE_ACTIONS.has(action)) {
    return (
      `${action} всегда требует апрув (ALWAYS_APPROVE_ACTIONS, lib/permissions.ts): ` +
      `этот рубеж стоит выше таблицы, auto на нём недостижим`
    );
  }
  return null;
}

/**
 * Оговорка к строке, которая подействует — но не везде. `SEMI_AUTO_RISKY`
 * поднимает пол до апрува только в чатах с автономией `semi_auto` (а это
 * дефолт), так что `= auto` там честен ровно наполовину. Отказывать нельзя:
 * в чате с автономией `auto` строка работает как написано.
 */
export function grantCaveat(action: ActionType, mode: "auto" | "approval"): string | null {
  if (mode === "auto" && SEMI_AUTO_RISKY.has(action)) {
    return `в чатах с автономией semi_auto (дефолт) гейт всё равно спросит апрув — ${action} в SEMI_AUTO_RISKY`;
  }
  return null;
}

interface PermissionRow {
  allowed: number;
  requires_approval: number;
}

export function getPermission(
  agentKey: string,
  actionType: ActionType,
): Permission {
  const row = db
    .prepare(
      `SELECT allowed, requires_approval FROM permissions
       WHERE agent_key = ? AND action_type = ?`,
    )
    .get(agentKey, actionType) as PermissionRow | undefined;
  if (!row) return { allowed: false, requires_approval: false };
  return {
    allowed: !!row.allowed,
    requires_approval: !!row.requires_approval,
  };
}

/**
 * Типы действий, по которым в `permissions` нет НИ ОДНОЙ строки.
 *
 * Аудит 2026-08-19. Права раздаются одноразовыми нумерованными миграциями
 * (006…038, два десятка штук), и каждая — ручная. Забыть её нечем: гейт зовёт
 * `getPermission`, та на отсутствие строки возвращает `allowed:false`, и
 * действие отказывается с тем же «permission denied», что и отозванное
 * владельцем. Отличить «владелец забрал право» от «право никогда не выдавали»
 * нельзя ни по логу, ни по Mini App.
 *
 * На чистой БД так стоят пять типов: GRANT_PERMISSION, UPDATE_AGENT_PROMPT,
 * CHANGE_AGENT_STATUS, REVIEW_AND_MERGE_PR, SPAWN_ROLE. У каждого есть
 * хендлер, экспозиция инструмента, запись в CALLER_RESTRICTED и в
 * ALWAYS_APPROVE_ACTIONS — всё, кроме сида. То есть функция доехала до прода и
 * там молча не работает.
 *
 * Ноль строк — это именно «сида не было»: policy-отказы выглядят иначе, у них
 * есть явные строки `allowed=0` (MAC_RUN_CLAUDE, MAC_STOP) либо строки только
 * у разрешённых ролей (PUBLISH_TO_CHANNEL, CREATE_TEAM_CHANNEL). Поэтому
 * проверка узкая и не шумит на нормальной конфигурации.
 *
 * Раздавать права отсюда НЕЛЬЗЯ: какие роли и с каким approval — решение
 * владельца, и пять оставшихся типов это самые опасные действия в системе
 * (выдача прав, правка системных промптов, merge в main). Функция только
 * называет дыру вслух.
 */
export function unseededActionTypes(): ActionType[] {
  const rows = db
    .prepare(`SELECT DISTINCT action_type FROM permissions`)
    .all() as Array<{ action_type: string }>;
  const seeded = new Set(rows.map((r) => r.action_type));
  return ACTION_TYPES.filter((at) => !seeded.has(at));
}

/** Написать в лог про незасеянные права. Зовётся один раз на старте сервиса. */
export function warnUnseededActionTypes(): void {
  const missing = unseededActionTypes();
  if (missing.length === 0) return;
  log.warn(
    "[permissions] типы действий без единой строки прав — гейт откажет всем ролям",
    { actionTypes: missing.join(", "), hint: "нужен сид-миграция или выдача через Mini App" },
  );
}

/**
 * Кто и откуда меняет права — для строки в `agent_actions`.
 *
 * Аудит 2026-08-27: `setPermission` — единственная запись в таблицу
 * `permissions`, то есть точка, где роли выдаются и отбираются. Аудит писал
 * только один из трёх продовых вызовов (`dispatch/permissions.ts`), а
 * `POST /api/permissions` в Mini App и команды `/grant` `/revoke` меняли гейт
 * молча: в БД оставался результат без следа, кто его поставил. Параметр
 * опционален, потому что тем же вызовом пользуются сиды и тесты, где актора
 * нет; все продовые вызовы обязаны его передавать — это проверяет
 * `tests/audit-2026-08-27-set-permission-audit.test.ts`.
 */
export interface PermissionChangeAudit {
  /** Актор: `miniapp:<user_id>`, `tg:<user_id>`, agent_key инициатора. */
  changedBy: string;
  /** Чат, из которого пришло изменение. Для Mini App — id пользователя. */
  chatId?: number | string | null;
  /** Канал изменения: `miniapp` | `command` | `dispatch`. */
  source: string;
  /** Причина, если её спрашивают у вызывающего. */
  reason?: string;
}

export function setPermission(
  agentKey: string,
  actionType: ActionType,
  p: Permission,
  audit?: PermissionChangeAudit,
): void {
  const before = audit ? getPermission(agentKey, actionType) : undefined;
  db.prepare(
    `INSERT INTO permissions(agent_key, action_type, allowed, requires_approval)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_key, action_type) DO UPDATE SET
       allowed = excluded.allowed,
       requires_approval = excluded.requires_approval`,
  ).run(
    agentKey,
    actionType,
    p.allowed ? 1 : 0,
    p.requires_approval ? 1 : 0,
  );
  if (!audit) return;
  // Та же форма записи, что у GRANT_PERMISSION в `dispatch/permissions.ts`:
  // `_diff: true` + old/new, чтобы Mini App и GET_LOGS читали все изменения
  // прав одинаково, независимо от того, каким каналом их внесли.
  logAction({
    agentKey: audit.changedBy,
    chatId: audit.chatId ?? null,
    actionType: "GRANT_PERMISSION",
    payload: {
      target_agent_key: agentKey,
      action_type: actionType,
      old: before ?? null,
      new: { allowed: p.allowed, requires_approval: p.requires_approval },
      source: audit.source,
      reason: audit.reason,
      _diff: true,
    },
    status: "ok",
  });
}

/**
 * Режим автономии для пары (чат, агент).
 *
 * Приоритет — от частного к общему: agent → chat → global, первая найденная
 * строка выигрывает (`.claude/memory/procedures/autonomy-modes.md`, «Scope
 * Hierarchy»). Смысл agent-строки ровно в том, чтобы ОДНОМУ агенту дать режим,
 * отличный от чатового, — это не трогаем.
 *
 * Исключение одно: **chat=`locked` не перекрывается agent-строкой.** Аудит
 * 2026-08-20 — до правки стоп-кран владельца молча не срабатывал:
 *
 *   1. владелец ставит `smm` режим `auto` — через Mini App
 *      (`miniapp-server.ts:1433`) или одобренный CHANGE_AGENT_STATUS
 *      (`dispatch/agent-status.ts:176`); оба пути боевые;
 *   2. позже в чате что-то идёт не так, владелец шлёт `/autonomy locked`;
 *   3. `cmdAutonomy` умеет писать ТОЛЬКО chat-scope (`commands.ts:348`) —
 *      писать или чистить agent-строку из чата нечем;
 *   4. для `smm` первой находилась agent-строка, и всё с
 *      `requires_approval = 0` продолжало исполняться в «заблокированном»
 *      чате без человека.
 *
 * Хуже всего обратная связь: `cmdAutonomy` без аргумента читает
 * `getAutonomy(chatId)` БЕЗ agentKey, то есть владельцу показывалось честное
 * «locked» — режим, которого для этого агента не существовало.
 *
 * Почему только chat, а не «любой `locked` побеждает». global=`locked` при
 * chat=`auto` осознанно оставлен перекрываемым: глобальная строка — это
 * ДЕФОЛТ для чатов (сид миграции 003 — `semi_auto`, ставится с экрана
 * настроек), а не аварийный стоп; так это записано и в процедуре, и в тесте
 * `t200-autonomy-modes.test.ts` («global=locked but chat override=auto →
 * allow»). Чатовый `locked` отличается тем, что его набирают одной командой
 * посреди инцидента, и другого способа остановить чат у владельца нет.
 *
 * Обратный случай (agent=`locked`, chat=`auto`) и раньше давал `locked`.
 */
export function getAutonomy(chatId?: number, agentKey?: string): AutonomyMode {
  // Стоп-кран чата читается ДО agent-строки — он её и перекрывает.
  if (chatId !== undefined && chatId !== null) {
    const locked = db
      .prepare(
        `SELECT 1 FROM autonomy_modes
         WHERE scope = 'chat' AND scope_id = ? AND mode = 'locked'`,
      )
      .get(String(chatId)) as unknown;
    if (locked) return "locked";
  }
  if (agentKey) {
    const row = db
      .prepare(
        `SELECT mode FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`,
      )
      .get(agentKey) as { mode: AutonomyMode } | undefined;
    if (row) return row.mode;
  }
  if (chatId !== undefined && chatId !== null) {
    const row = db
      .prepare(
        `SELECT mode FROM autonomy_modes WHERE scope = 'chat' AND scope_id = ?`,
      )
      .get(String(chatId)) as { mode: AutonomyMode } | undefined;
    if (row) return row.mode;
  }
  const g = db
    .prepare(
      `SELECT mode FROM autonomy_modes WHERE scope = 'global' AND scope_id = '*'`,
    )
    .get() as { mode: AutonomyMode } | undefined;
  return g?.mode ?? "semi_auto";
}

/**
 * Все переопределения на уровне роли.
 *
 * Аудит 2026-08-21: строка `scope='agent'` побеждает и чат, и глобальный режим
 * (намеренно — T-313 finding #5), но её не показывала ни одна поверхность.
 * Замер:
 *
 *   1. perm проводит CHANGE_AGENT_STATUS{design → auto}
 *   2. владелец набирает /autonomy locked → «Autonomy для чата … → locked.»
 *   3. на деле: smm getAutonomy=locked гейт=deny
 *              design getAutonomy=auto   гейт=allow
 *   4. /autonomy переспросить → «Текущий autonomy …: locked»
 *
 * То есть подтверждение утверждало то, чего не произошло, а чтение возвращало
 * не тот режим, по которому будет принято решение: `cmdAutonomy` зовёт
 * `getAutonomy(chatId)` без agentKey, а гейт — с ним.
 *
 * Дефект не в самой precedence: роль, поставленную на паузу, чатовый `auto`
 * будить не должен. Дефект в том, что исключение было невидимым.
 */
export function listAgentAutonomyOverrides(): Array<{
  agent: string;
  mode: AutonomyMode;
}> {
  return db
    .prepare(
      `SELECT scope_id AS agent, mode FROM autonomy_modes WHERE scope = 'agent' ORDER BY scope_id`,
    )
    .all() as Array<{ agent: string; mode: AutonomyMode }>;
}

/**
 * Снять переопределение — режим снова наследуется от чата и глобального.
 *
 * `setAutonomy` умеет только upsert, DELETE в проде-коде не было вовсе: строка
 * `scope='agent'` создавалась двумя путями (Mini App и одобренный
 * CHANGE_AGENT_STATUS) и не удалялась ни одним. Approval-карточка на смену
 * статуса роли по факту выдавала бессрочное исключение из будущего рубильника.
 *
 * Возвращает `true`, если строка была.
 */
export function clearAutonomy(
  scope: "global" | "chat" | "agent",
  scopeId: string,
): boolean {
  const res = db
    .prepare(`DELETE FROM autonomy_modes WHERE scope = ? AND scope_id = ?`)
    .run(scope, scopeId);
  return res.changes > 0;
}

export function setAutonomy(
  scope: "global" | "chat" | "agent",
  scopeId: string,
  mode: AutonomyMode,
): void {
  db.prepare(
    `INSERT INTO autonomy_modes(scope, scope_id, mode, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, scope_id) DO UPDATE SET
       mode = excluded.mode,
       updated_at = excluded.updated_at`,
  ).run(scope, scopeId, mode, Date.now());
}

export interface GateInput {
  agentKey: string;
  actionType: ActionType;
  chatId?: number;
  /**
   * SEC-4 / T-602: the caller can force human approval based on payload flags
   * the gate itself can't see (e.g. SEND_MESSAGE {via_userbot:true} sends from
   * the owner's real account). When set, approval is required regardless of
   * autonomy mode — but only if the action is otherwise allowed.
   */
  forceApproval?: boolean;
  /**
   * Текст причины для карточки approval. Причин уже больше одной
   * (owner-voice, bypass-режим MAC_RUN_CLAUDE), и подставлять единственную
   * зашитую строку значит врать человеку о том, что он подтверждает.
   */
  forceApprovalReason?: string;
}

export type GateDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "approval"; reason: string };

interface AgentStateRow {
  status: string | null;
}

/**
 * T-704: A disabled agent is fully inert. Reads `agent_states.status`
 * (set via CHANGE_AGENT_STATUS). Defensive try/catch: minimal/legacy test
 * DBs may lack the table — treat a missing table as "active".
 *
 * Аудит 2026-08-04: `catch { return false }` был голым и покрывал не только
 * отсутствующую таблицу, ради которой писался, но и SQLITE_BUSY, залоченный
 * файл и битую страницу. Любая такая заминка превращала выключенного агента в
 * активного — и это ПЕРВАЯ проверка гейта, то есть fail-open в самом начале
 * цепочки. Глотаем ровно «нет таблицы»; всё остальное считаем «выключен»:
 * недоступность реестра статусов — не повод действовать.
 */
export function isAgentDisabled(agentKey: string): boolean {
  try {
    const row = db
      .prepare(`SELECT status FROM agent_states WHERE agent_key = ?`)
      .get(agentKey) as AgentStateRow | undefined;
    return row?.status === "disabled";
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message ?? e))) return false;
    log.error("[permissions] agent_states недоступна — считаем агента выключенным", {
      agentKey,
      error: String((e as Error)?.message ?? e),
    });
    return true;
  }
}

/**
 * Пауза агента из Mini App (`agent_states.paused`).
 *
 * Аудит 2026-08-08: кнопка «Пауза» писала флаг, меняла подпись карточки на
 * «paused» — и на этом всё. Флаг читали ровно два места: список агентов в
 * Mini App (подпись) и выбор запасного исполнителя в role-skills. Сам агент
 * продолжал отвечать в Telegram как ни в чём не бывало, то есть UI показывал
 * состояние, которого в системе не было. Теперь пауза — это гейт: как
 * `disabled`, но обратимая из Mini App одним кликом (`/resume`), и она не
 * трогает `status`, которым управляет только perm через CHANGE_AGENT_STATUS.
 *
 * Ошибку чтения глотаем в «не на паузе»: сюда попадаем только после успешного
 * чтения той же строки в isAgentDisabled, так что реальный сбой БД уже привёл
 * бы к deny выше — молча глушить все 12 ролей на второй попытке незачем.
 */
export function isAgentPaused(agentKey: string): boolean {
  try {
    const row = db
      .prepare(`SELECT paused FROM agent_states WHERE agent_key = ?`)
      .get(agentKey) as { paused: number | null } | undefined;
    return row?.paused === 1;
  } catch {
    return false;
  }
}

/** Почему агент не должен сейчас ничего делать, либо null. */
export type AgentStopReason = "disabled" | "paused";

/**
 * Аудит 2026-08-09: `paused` и `disabled` — две независимые колонки одной
 * строки agent_states, и почти во всём проекте проверялась только первая.
 * `setAgentStatus` намеренно сохраняет `paused` как есть, так что выключенный
 * агент почти всегда имеет `paused = 0`: каждая проверка «а не на паузе ли он»
 * пропускала выключенного насквозь. За пределами evaluateGate `isAgentDisabled`
 * не звался вообще нигде — то есть CHANGE_AGENT_STATUS('disabled'), который
 * требует approval владельца и заявлен как «агент полностью инертен», не
 * затыкал ни речь в чате, ни инлайновые инструменты, ни вызов через handoff.
 *
 * Один предикат на оба флага, чтобы третья колонка (если появится) не начала
 * ту же историю заново. Порядок важен для формулировки отказа: «disabled»
 * снимается только запросом к perm, «paused» — кнопкой владельца.
 */
export function agentStopReason(agentKey: string): AgentStopReason | null {
  if (isAgentDisabled(agentKey)) return "disabled";
  if (isAgentPaused(agentKey)) return "paused";
  return null;
}

/**
 * Owner opt-in: разрешить оркестратору запускать MAC_RUN_CLAUDE БЕЗ ручного
 * approval. ВЫКЛ по умолчанию (approval — безопасный дефолт от RCE). Включается
 * env MAC_AUTONOMOUS=true И только в чате с autonomy=auto (двойное условие).
 * Остальные слои защиты сохраняются: orchestrator-only (CALLER_RESTRICTED),
 * MAC_USER_IDS-whitelist, project-allowlist, denied-паттерны, без bypass-режима.
 *
 * «Без bypass-режима» до аудита 2026-08-08 было только обещанием: macAuto
 * считался по одному actionType, payload гейт не видел. Теперь bypass
 * форсирует approval отдельно — см. isBypassMacRun.
 */
export function macAutonomous(): boolean {
  return process.env.MAC_AUTONOMOUS === "true";
}

export function evaluateGate(input: GateInput): GateDecision {
  // Owner opt-in: MAC_RUN_CLAUDE может идти без approval только при
  // MAC_AUTONOMOUS=true И autonomy=auto (проверяется ниже).
  const macAuto =
    input.actionType === "MAC_RUN_CLAUDE" && macAutonomous();
  // T-704: a disabled agent is denied at the gate for EVERY action, regardless
  // of permissions/autonomy. Re-enabling happens via perm's approved
  // CHANGE_AGENT_STATUS — never by the disabled agent itself.
  if (isAgentDisabled(input.agentKey)) {
    return { decision: "deny", reason: "agent disabled" };
  }

  // Аудит 2026-08-08: пауза из Mini App теперь действительно останавливает
  // агента, а не только меняет подпись на карточке. Причина отличается от
  // «disabled» намеренно: человек должен видеть, что это его же пауза и
  // снимается она кнопкой «Продолжить», а не запросом к perm.
  if (isAgentPaused(input.agentKey)) {
    return { decision: "deny", reason: "agent paused" };
  }

  // T-701/T-702/T-703: caller-restricted actions — reject non-allowed agents up-front,
  // before consulting the permissions table. Prevents accidental seeding
  // mistakes from letting other agents call security-mutating actions.
  const requiredCaller = CALLER_RESTRICTED[input.actionType];
  if (requiredCaller && input.agentKey !== requiredCaller) {
    return {
      decision: "deny",
      reason: `caller not allowed: ${input.actionType} restricted to '${requiredCaller}'`,
    };
  }

  // Аудит 2026-08-08: ROLE_EXPOSED_TOOLS был границей только для инлайновых
  // тулзов (проверка в executeTool). Для гейтованных действий он оставался
  // фильтром выдачи в промпте — то есть держался на том, что модель не назовёт
  // неотданный ей инструмент. Для tool_use это почти правда: API не даст
  // вызвать необъявленный тул. Но есть путь, где действие называется свободным
  // JSON'ом, вне всякого списка: self-diag просит aieng предложить ретрай
  // («OR a different action»), берёт parsed.action как есть и идёт сразу в
  // гейт (lib/self-diag.ts). Гейт про экспозицию не знал.
  //
  // Через эту щель пролезал GENERATE_IMAGE: миграция 010 засеяла его ВСЕМ 12
  // ролям как allowed=1, requires_approval=0, в CALLER_RESTRICTED и
  // SEMI_AUTO_RISKY его нет — значит любая роль получала `allow` и тратила
  // $0.04 у OpenAI, при том что решение владельца («картинки генерит только
  // дизайнер») записано прямо в шапке ROLE_EXPOSED_TOOLS.
  //
  // Проверка тут закрывает класс: следующая запись в ROLE_EXPOSED_TOOLS станет
  // ограничением сразу, а не обещанием до первого аудита.
  if (!isToolExposedToRole(input.actionType, input.agentKey)) {
    return {
      decision: "deny",
      reason: `caller not allowed: ${input.actionType} недоступен роли '${input.agentKey}'`,
    };
  }

  const perm = getPermission(input.agentKey, input.actionType);
  if (!perm.allowed) {
    // Аудит 2026-08-19: «строки нет» и «владелец отозвал» — разные состояния с
    // одинаковым текстом отказа. Первое означает забытый сид (см.
    // unseededActionTypes), и по логу это было неотличимо от нормальной
    // работы гейта. Различаем в причине; решение — то же самое, отказ.
    const seeded = db
      .prepare(`SELECT 1 FROM permissions WHERE agent_key = ? AND action_type = ?`)
      .get(input.agentKey, input.actionType);
    return {
      decision: "deny",
      reason: seeded
        ? "permission denied"
        : `permission denied: право ${input.actionType} не выдано роли '${input.agentKey}' (строки в permissions нет)`,
    };
  }

  // T-313 fix (finding #5): pass agentKey so per-agent autonomy overrides
  // (e.g. Mini App "pause this specific agent") are actually consulted.
  // Falls back to chat-level then global default inside getAutonomy.
  const mode = getAutonomy(input.chatId, input.agentKey);

  // Аудит 2026-08-21: `locked` проверялся ПОСЛЕ forceApproval и
  // ALWAYS_APPROVE_ACTIONS, то есть не применялся ровно к тому набору, ради
  // которого рубильник и дёргают. Замер на чате в `locked`:
  //
  //   SEND_MESSAGE          обычное         → deny      остановлено
  //   GRANT_PERMISSION      ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
  //   UPDATE_AGENT_PROMPT   ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
  //   REVIEW_AND_MERGE_PR   ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
  //   SPAWN_ROLE            ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
  //   MAC_RUN_CLAUDE        ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
  //   PUBLISH_TO_CHANNEL    ALWAYS_APPROVE  → approval  ВЫПОЛНИТСЯ
  //
  // Рубильник держал дешёвое и пропускал необратимое — выдачу прав, смену
  // системного промпта, мерж в main, запуск роли, RCE на машине владельца и
  // пост подписчикам канала. Ровно наоборот к замыслу.
  //
  // Смысл ALWAYS_APPROVE — пол, а не потолок: «не меньше, чем апрув, ни в
  // каком режиме». Читать его как «не больше апрува» и значило запереть
  // `locked` на уровне слабее отказа. То же и с forceApproval: owner-voice —
  // это действие агента от лица владельца, а `locked` говорит, что агент не
  // действует.
  //
  // Прецедент тот же и в этом файле: аудит 2026-08-10 перенёс
  // LOW_FRICTION_ACTIONS (тогда READONLY_ACTIONS) ПОД эту проверку по этой же
  // причине — набор выше `locked` оставлял канал, по которому выключенный
  // агент продолжал писать. Тогда починили COMMENT_TASK, а GRANT_PERMISSION и
  // MAC_RUN_CLAUDE остались выше.
  //
  // Второй половиной дефект доезжал до исполнения: commands.ts:183 при нажатии
  // «Approve» перепроверяет гейт и берёт ТОЛЬКО deny-слои. Карточка, одобренная
  // до блокировки, у обычного действия упиралась в `blocked at execution`, а у
  // ALWAYS_APPROVE — нет, потому что до `locked` не доходила.
  if (mode === "locked") {
    return { decision: "deny", reason: "autonomy locked" };
  }

  // SEC-4 / T-602: payload-driven force-approval (e.g. owner-voice via_userbot
  // sends) overrides the autonomy mode — a human must confirm even in `auto`.
  // Comes after the deny checks (включая `locked` выше) so a forbidden caller
  // is still denied.
  if (input.forceApproval) {
    return {
      decision: "approval",
      reason: input.forceApprovalReason ?? "payload requires approval",
    };
  }

  // T-701/T-702/T-703: always-approve actions (inter-agent mutations) raise the
  // floor above the autonomy mode — even `auto` callers see an approval prompt.
  // Пол, а не потолок: `locked` выше уже отказал, и это сильнее апрува.
  // macAuto exempts MAC_RUN_CLAUDE here (owner opted in); manual/semi_auto STILL
  // force approval.
  if (ALWAYS_APPROVE_ACTIONS.has(input.actionType) && !macAuto) {
    return { decision: "approval", reason: "always-approve action" };
  }

  // Дешёвые внутренние действия — без апрува, но ТОЛЬКО после проверки
  // `locked` (теперь она вообще первая из режимных): выключенная роль не пишет
  // никуда, в том числе на доску задач.
  if (LOW_FRICTION_ACTIONS.has(input.actionType)) {
    return { decision: "allow" };
  }

  if (mode === "manual") {
    return { decision: "approval", reason: "manual mode" };
  }
  if (mode === "semi_auto") {
    if (perm.requires_approval || SEMI_AUTO_RISKY.has(input.actionType)) {
      return { decision: "approval", reason: "semi_auto requires approval" };
    }
    return { decision: "allow" };
  }
  // mode === 'auto'
  // macAuto bypasses the requires_approval flag too (owner opt-in) — so in `auto`
  // mode + MAC_AUTONOMOUS the orchestrator runs Mac builds directly.
  if (perm.requires_approval && !macAuto) {
    return { decision: "approval", reason: "permission requires approval" };
  }
  return { decision: "allow" };
}
