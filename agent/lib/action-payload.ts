/**
 * Discriminated payloads per ActionType (R-A).
 *
 * `actionType` сам по себе — дискриминатор (хранится отдельно от payload
 * в Approval/AgentAction), поэтому здесь — только формы полезной нагрузки.
 * Не меняем формат записанных в БД payload'ов.
 */
import type { ActionType } from "./permissions.ts";
import type { TaskStatus } from "./tasks.ts";

export interface SendMessagePayload {
  chatId?: number;
  text: string;
  replyToMessageId?: number;
  /**
   * T-410: route through the MTProto userbot so the message appears as the
   * owner's real account (@owner_darkside). Orchestrator-only; requires
   * approval in semi_auto mode. Other callers receive a forbidden error.
   */
  via_userbot?: boolean;
}
export interface SetReactionPayload {
  chatId?: number;
  messageId: number;
  emoji: string;
  /**
   * C30: force routing through the MTProto userbot (any emoji incl. Premium,
   * bypasses Bot API whitelist). When false/undefined, dispatcher uses Bot API
   * and falls back to userbot only on "can't react" errors if userbot is up.
   */
  via_userbot?: boolean;
}
export interface EditMessagePayload {
  chatId?: number;
  messageId: number;
  text: string;
}
export interface PinMessagePayload {
  chatId?: number;
  messageId: number;
  disableNotification?: boolean;
}
export interface DeleteMessagePayload {
  chatId?: number;
  messageId: number;
  /**
   * C30: force routing through the MTProto userbot. Allows deleting service
   * messages (joins/leaves/pins/photo) that the Bot API cannot touch. When
   * false/undefined, dispatcher uses Bot API and falls back to userbot only
   * on errors if userbot is up.
   */
  via_userbot?: boolean;
}
export interface ForwardMessagePayload {
  chatId?: number;
  /** Пиннится к чату-источнику; необязателен — см. build-payload.ts. */
  fromChatId?: number;
  messageId: number;
}
export interface CreatePollPayload {
  chatId?: number;
  question: string;
  options: string[];
  isAnonymous?: boolean;
}
export interface CreateTaskPayload {
  chatId?: number;
  createdBy?: string;
  title: string;
  description?: string | null;
  parentId?: string | null;
  assignedTo?: string | null;
  priority?: number;
  inputPayload?: unknown;
}
export interface AssignTaskPayload {
  taskId: string;
  assignedTo: string;
}
export interface UpdateTaskStatusPayload {
  taskId: string;
  status: TaskStatus;
  output?: unknown;
  error?: string | null;
}
export interface RequestReviewPayload {
  taskId: string;
  comment?: string;
}
export interface CommentTaskPayload {
  taskId: string;
  text: string;
}
export interface SendPhotoPayload {
  chatId?: number;
  source: { url: string } | { base64: string };
  caption?: string;
  replyToMessageId?: number;
}
export interface CreateTeamChannelPayload {
  title: string;
  about?: string;
  /** Роли, чьи боты добавляются админами канала (smm/design/copy/…). */
  roles: string[];
}
export interface PublishToChannelPayload {
  channelId: number;
  text: string;
  photoUrl?: string;
  photoBase64?: string;
  /** Промпт для генерации обложки-превью (OpenAI растр → SVG-фолбэк). */
  coverPrompt?: string;
  /** Заголовок для дизайнерского баннера-обложки (DeLabs-стиль, чёткий текст). */
  coverTitle?: string;
  /** Подзаголовок баннера (опц.). */
  coverSubtitle?: string;
  /**
   * Стиль обложки-баннера: "illustrated" (по умолч.) — фон-иллюстрация из пула +
   * оверлей заголовка/даты/лого; "clean" — строгий SVG-баннер без картинки.
   */
  coverStyle?: "illustrated" | "clean";
}
export interface SendDocumentPayload {
  chatId?: number;
  content: string;
  filename: string;
  caption?: string;
  replyToMessageId?: number;
}
export interface GenerateSvgImagePayload {
  chatId?: number;
  svg: string;
  caption?: string;
  replyToMessageId?: number;
}
export interface GenerateImagePayload {
  chatId?: number;
  prompt: string;
  caption?: string;
  replyToMessageId?: number;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
}

export interface DelegateToRolePayload {
  /** Target agent key (CHARACTERS[*].key). */
  role: string;
  /** Что нужно сделать (free-form, рус/eng). */
  task: string;
  /** Дополнительный контекст. */
  context?: string;
  // Аудит 2026-08-10: тут было `_depth?: number` — «internal: depth in handoff
  // chain (set by dispatch, not by LLM)». Не ставил его никто: в схеме
  // инструмента поля нет, dispatch его не писал, и единственная запись во всём
  // репозитории была в тесте, который читавший его гейт и «проверял». Глубину
  // держит `_delegation_path` / DispatchCtx.delegationChain — она растёт на
  // каждом хопе, в отличие от счётчика, который не рос никогда.
  /**
   * C28 back-compat: ordered list of agent keys traversed in this delegation
   * chain (root first → current sender last). Used as a fallback when
   * DispatchCtx.delegationChain is absent. Set by the dispatcher, not by LLM.
   */
  _delegation_path?: string[];
  /**
   * C28: parent task id when the delegating agent is itself executing a task.
   * Lets the orchestrator stitch the delegated task into the tree.
   */
  _parent_task_id?: string;
  /**
   * C29: when set, this delegation has been rerouted from the originally
   * requested role (which was unavailable). The value is the original role.
   * Used by downstream tooling/UX to surface the reroute.
   */
  _rerouted_from?: string;
}

export interface SplitTaskPayload {
  /** Task title (for the parent task). */
  title: string;
  /** Optional description (propagated to each child as context). */
  description?: string;
  /** Chat to anchor the tasks to. Defaults to DispatchCtx.chatId. */
  chatId?: number;
  /** Target roles — one child task is dispatched per role, in parallel. */
  roles: string[];
  /** Additional free-form context appended to each child delegation. */
  context?: string;
}

export interface ListRecentMessagesPayload {
  /** Chat to read from. Defaults to DispatchCtx.chatId. */
  chat_id?: number;
  /** Unix timestamp (ms). Only messages with ts >= since are returned. */
  since?: number;
  /**
   * Which message kinds to return:
   *  - "service" — messages whose text starts with "[service]" (joins/leaves/pins)
   *  - "text"    — all other (non-service) messages
   *  - "all"     — everything
   * Default: ["service"].
   */
  kinds?: Array<"text" | "service" | "all">;
  /** Max rows to return (default 50, hard cap 200). */
  limit?: number;
}

export interface WriteWikiPayload {
  /** "_team" or the current agent's own key. */
  scope: string;
  /** Page slug (may include subpath like "projects/foo"). */
  slug: string;
  /** Page title. */
  title: string;
  /** Markdown body. */
  content: string;
}

export interface MacRunClaudePayload {
  /** Absolute path to project on the Mac (must be under MAC_PROJECT_ROOTS). */
  project: string;
  /** Prompt to feed into the `claude` CLI on stdin. */
  prompt: string;
  /** Stage-A permission mode forwarded to the Mac daemon. */
  mode: "ask" | "accept_edits" | "plan" | "auto" | "bypass";
  /** Triggering Telegram user_id (whitelist check). Set by tool-loop. */
  _userId?: string;
  /**
   * true, если ход пришёл делегированием (DELEGATE_TO_ROLE или @-упоминание),
   * а не напрямую от человека. Ставит tool-loop по длине delegationChain;
   * читает payloadForcesApproval — opt-in MAC_AUTONOMOUS на такие вызовы не
   * распространяется.
   */
  _delegated?: boolean;
}

/**
 * T-701: GRANT_PERMISSION — `perm` agent grants/revokes an action-type
 * for a target agent at runtime. ALWAYS approval-gated.
 */
export interface GrantPermissionPayload {
  /** Target agent key (must be a known role from CHARACTERS). */
  target_agent_key: string;
  /** Action type to grant/revoke (must be a known ACTION_TYPE). */
  action_type: string;
  /** Whether the target may invoke the action at all. */
  allowed: boolean;
  /** Whether each invocation needs explicit human approval. */
  requires_approval: boolean;
  /** Free-form rationale (min 10 chars, audited). */
  reason: string;
}

/**
 * T-703: CHANGE_AGENT_STATUS — `perm` agent enables/disables a target agent
 * or changes its autonomy mode at runtime. ALWAYS approval-gated.
 *
 * At least one of `new_status` or `new_autonomy_mode` MUST be provided.
 */
export interface ChangeAgentStatusPayload {
  /** Target agent key (must be a known role from CHARACTERS). */
  target_agent_key: string;
  /** New status; if omitted, status is unchanged. */
  new_status?: "active" | "disabled";
  /** New autonomy mode for scope=agent; if omitted, autonomy is unchanged. */
  new_autonomy_mode?: "locked" | "manual" | "semi_auto" | "auto";
  /** Free-form rationale (min 10 chars, audited). */
  reason: string;
}

export interface SchedulePostPayload {
  /** Channel ID or username (@channel_name) where to post. */
  channel: string;
  /** Content to post at the scheduled time. */
  content: string;
  /** Unix timestamp when the post should be sent. */
  scheduledAt: number;
}

/**
 * T-702: aieng proposes a new system-prompt for any agent. Mandatory
 * approval; on approval the agent_prompts row's applied_at is set. Actual
 * hot-swap of the running agent prompt is wired by T-705.
 */
export interface UpdateAgentPromptPayload {
  /** Target agent key (CHARACTERS[*].key). */
  target_agent_key: string;
  /** Proposed new system prompt (50..8000 chars). */
  new_prompt: string;
  /** Reason for the change (>=20 chars, operator accountability). */
  reason: string;
}

/**
 * T-701: CREATE_DIAGNOSTIC_TASK — any agent explicitly requests an
 * investigation into a previously-failed action. Routes to a responsible
 * role (or `target_agent_key` when supplied) and optionally carries a
 * `suggested_fix` for the resolver to apply. Creating a task is not an
 * external side-effect → allowed for all roles, never approval-gated.
 */
export interface CreateDiagnosticTaskPayload {
  /** agent_actions.id of the failed action to investigate. */
  failed_action_id: string;
  /** Free-form hypothesis about the root cause (min 10 chars). */
  hypothesis: string;
  /** Optional explicit assignee; defaults to the category's responsible role. */
  target_agent_key?: string;
  /** Optional concrete fix the resolver may apply (action + payload). */
  suggested_fix?: { action: string; payload: Record<string, unknown> };
}

/**
 * T-511: orchestrator reviews and merges PRs from other agents.
 * Validates pre-push checklist and merges if green, comments if red.
 */
export interface ReviewAndMergePrPayload {
  /** GitHub PR number to review. */
  pr_number: number;
  /** Optional reason for manual review trigger. */
  reason?: string;
}

/**
 * T-512: orchestrator queues a local ad-hoc role for the agent-team runtime.
 * ALWAYS approval-gated; restricted to orchestrator.
 */
export interface SpawnRolePayload {
  /** Human-readable role name — sanitised to a slug `[a-z0-9-]` before use. */
  name: string;
  /** Full system prompt for the temporary character (non-empty). */
  system_prompt: string;
  /** Free-form task hint stored in the local role queue. */
  task_hint?: string;
  /** Provider selected by the local runtime; omitted = internal. */
  provider?: "internal" | "claude" | "codex";
}

export type PayloadByType = {
  SEND_MESSAGE: SendMessagePayload;
  SET_REACTION: SetReactionPayload;
  EDIT_MESSAGE: EditMessagePayload;
  PIN_MESSAGE: PinMessagePayload;
  DELETE_MESSAGE: DeleteMessagePayload;
  FORWARD_MESSAGE: ForwardMessagePayload;
  CREATE_POLL: CreatePollPayload;
  CREATE_TASK: CreateTaskPayload;
  ASSIGN_TASK: AssignTaskPayload;
  UPDATE_TASK_STATUS: UpdateTaskStatusPayload;
  REQUEST_REVIEW: RequestReviewPayload;
  COMMENT_TASK: CommentTaskPayload;
  SEND_PHOTO: SendPhotoPayload;
  SEND_DOCUMENT: SendDocumentPayload;
  CREATE_TEAM_CHANNEL: CreateTeamChannelPayload;
  PUBLISH_TO_CHANNEL: PublishToChannelPayload;
  GENERATE_SVG_IMAGE: GenerateSvgImagePayload;
  GENERATE_IMAGE: GenerateImagePayload;
  DELEGATE_TO_ROLE: DelegateToRolePayload;
  WRITE_WIKI: WriteWikiPayload;
  SPLIT_TASK: SplitTaskPayload;
  LIST_RECENT_MESSAGES: ListRecentMessagesPayload;
  MAC_RUN_CLAUDE: MacRunClaudePayload;
  /**
   * MAC_STOP не принимает параметров от модели, но tool-loop дописывает в
   * payload `_userId` — по нему хендлер сверяется с MAC_USER_IDS. Тип говорил
   * `Record<string, never>`, поэтому хендлеру приходилось читать поле через
   * `as any`, а вызывающая сторона могла забыть его дописать, и никто бы не
   * заметил: `isUserAllowed(undefined)` — это тихий «forbidden», то есть
   * мёртвый аварийный тормоз (уже случалось, SEC-audit LOW-2).
   */
  MAC_STOP: { _userId?: string; _delegated?: boolean };
  SCHEDULE_POST: SchedulePostPayload;
  GRANT_PERMISSION: GrantPermissionPayload;
  UPDATE_AGENT_PROMPT: UpdateAgentPromptPayload;
  CHANGE_AGENT_STATUS: ChangeAgentStatusPayload;
  REVIEW_AND_MERGE_PR: ReviewAndMergePrPayload;
  CREATE_DIAGNOSTIC_TASK: CreateDiagnosticTaskPayload;
  SPAWN_ROLE: SpawnRolePayload;
};

export type PayloadFor<T extends ActionType> = PayloadByType[T];
