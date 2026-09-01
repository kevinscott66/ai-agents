/** T-512: approval-gated enqueue into the local role runtime. */

import type { SpawnRolePayload } from "../action-payload.ts";
import {
  enqueueRoleTask,
  selectRoleProvider,
  toRoleSlug,
  type EnqueueRoleTaskInput,
  type RoleProvider,
  type RoleQueueItem,
} from "../role-runtime.ts";

export { toRoleSlug };

/** Backward-compatible default provider export. */
export const SPAWN_ROLE_PROVIDER = "internal" as const;
export const SPAWN_ROLE_STATE = "queued" as const;

export interface SpawnRoleHandlerContext {
  agentKey: string;
  chatId: number;
}

export interface SpawnRoleResult {
  ok: true;
  result: {
    action: "queued";
    role_slug: string;
    task_hint: string;
    provider: RoleProvider;
    state: "queued";
    task_id: string;
    queue_id: string;
    execution: "local_role_runtime";
  };
}

export interface SpawnRoleError {
  ok: false;
  error: string;
  provider: string;
  state: "rejected";
}

export type SpawnRoleOperationResult = SpawnRoleResult | SpawnRoleError;

export interface SpawnRoleDeps {
  /** Injectable queue writer for hermetic tests and alternate local runtimes. */
  enqueue?: (input: EnqueueRoleTaskInput) => RoleQueueItem;
  /** Codex is selectable only when the local supervisor confirms its presence. */
  codexAvailable?: boolean;
}

function rejected(error: string, provider = "internal"): SpawnRoleError {
  return { ok: false, error, provider, state: "rejected" };
}

/**
 * Validate and enqueue a temporary-role request. This function never invokes a
 * shell, GitHub API, workflow, or external scheduler. The existing approval
 * gate remains upstream in gateOrDispatch and is still mandatory.
 */
export async function handleSpawnRole(
  payload: SpawnRolePayload,
  ctx: SpawnRoleHandlerContext,
  deps: SpawnRoleDeps = {},
): Promise<SpawnRoleOperationResult> {
  if (ctx.agentKey !== "orchestrator") {
    return rejected(
      `Action SPAWN_ROLE is restricted to orchestrator, called by: ${ctx.agentKey}`,
    );
  }
  if (!payload.name || !payload.name.trim()) {
    return rejected("Invalid name: must be a non-empty string");
  }
  const roleSlug = toRoleSlug(payload.name.trim());
  if (!roleSlug) {
    return rejected("Invalid name: produces an empty role slug");
  }
  if (!payload.system_prompt || !payload.system_prompt.trim()) {
    return rejected("Invalid system_prompt: must be a non-empty string");
  }

  // Аудит 2026-08-29: тут был `??`, а он пропускает пустую строку. Строчку
  // `SPAWN_ROLE_PROVIDER=` в .env пишут именно чтобы «снять» значение, которое
  // .env.example показывает как `SPAWN_ROLE_PROVIDER=internal`. С `??` наружу
  // уезжает `""`, а `selectRoleProvider` спасает от пустоты только `null` и
  // `undefined` (`String(raw ?? "internal")`), поэтому каждый SPAWN_ROLE падал
  // бы с «unknown provider» вместо дефолта. Тот же дефект уже чинили в
  // `miniapp-entry.ts` (10f76f9e) — там теперь `||`, здесь тоже.
  const providerRaw = payload.provider || process.env.SPAWN_ROLE_PROVIDER || "internal";
  let provider: RoleProvider;
  try {
    provider = selectRoleProvider(providerRaw, { codexAvailable: deps.codexAvailable });
  } catch (error) {
    return rejected(error instanceof Error ? error.message : String(error), String(providerRaw));
  }

  try {
    const item = (deps.enqueue ?? enqueueRoleTask)({
      name: roleSlug,
      systemPrompt: payload.system_prompt,
      taskHint: payload.task_hint,
      chatId: ctx.chatId,
      createdBy: ctx.agentKey,
      provider,
      codexAvailable: deps.codexAvailable,
    });
    return {
      ok: true,
      result: {
        action: "queued",
        role_slug: item.roleSlug,
        task_hint: item.taskHint,
        provider,
        state: "queued",
        task_id: item.taskId,
        queue_id: item.id,
        execution: "local_role_runtime",
      },
    };
  } catch (error) {
    return rejected(error instanceof Error ? error.message : String(error), provider);
  }
}
