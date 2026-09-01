// Словарь статусов — общий с сервером (lib/task-fsm.ts). Своя копия молча
// разошлась бы с серверной: подмножество индексируется без ошибки типов.
import type { TaskStatus } from "../../../lib/task-fsm.ts";
export type { TaskStatus };

export interface Task {
  id: string;
  parent_id: string | null;
  depth: number;
  chat_id: number;
  created_by: string;
  assigned_to: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  deadline: number | null;
  input: unknown | null;
  output: unknown | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Совпадает с ApprovalStatus в lib/approvals.ts. `failed` — одобрено, но
 * исполнение упало; `expired` — человек не решил за срок (аудит 2026-08-12).
 * Оба уже были в APPROVAL_STATUS_LABELS, но не в типе: фильтр по статусу
 * ходит на сервер строкой, и «отсутствует в типе» здесь значило только то,
 * что TS не поможет их не забыть.
 */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "failed"
  | "expired";

export interface Approval {
  id: string;
  action_id: string;
  chat_id: number;
  requested_by: string;
  action_type: string;
  payload: unknown;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
  created_at: number;
  request_id?: string | null;
  /**
   * Сервер вырезал содержимое строки не-админу (`redactContent`,
   * lib/miniapp-server.ts). Поле приходило всегда — объявлено 2026-08-20,
   * когда выяснилось, что карточка аппрува его не читала и рисовала сводку
   * поверх заглушки.
   */
  redacted?: boolean;
}

export type ActionStatus =
  | "attempted"
  | "ok"
  | "error"
  | "forbidden"
  | "pending_approval"
  | "rate_limited";

export interface AgentAction {
  id: string;
  agent_key: string;
  task_id: string | null;
  chat_id: number | null;
  action_type: string;
  payload: unknown | null;
  status: ActionStatus;
  result: unknown | null;
  error: string | null;
  created_at: number;
}

export interface AgentInfo {
  key: string;
  title: string;
  provider?: "internal" | "codex" | "claude";
  execution_state?: "running" | "paused" | "unavailable";
  status: string;
  paused?: boolean;
  health?: {
    alive: boolean;
    lastOkAt: number | null;
    consecutiveFailures: number;
  } | null;
}

export interface Permission {
  agentKey: string;
  actionType: string;
  allowed: boolean;
  requires_approval: boolean;
}

export type AutonomyMode = "locked" | "manual" | "semi_auto" | "auto";

export const AUTONOMY_MODES: AutonomyMode[] = [
  "locked",
  "manual", 
  "semi_auto",
  "auto",
];
