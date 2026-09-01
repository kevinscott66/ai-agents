import type { Telegraf } from "telegraf";
import type { CharacterDef } from "../characters/index.ts";
import { TASK_TRANSITIONS, type TaskStatus } from "./task-fsm.ts";
import type { AutonomyMode } from "./permissions.ts";

export interface RunningBot {
  def: CharacterDef;
  bot: Telegraf;
  username: string;
  id: number;
}

/**
 * Canonical list of task statuses (FSM). Consolidated from
 * miniapp-server.ts and tools-schema.ts (R3).
 *
 * Аудит 2026-08-20: список выводится из таблицы переходов, а не пишется руками.
 * `TASK_TRANSITIONS` — это `Record<TaskStatus, …>`, там пропустить статус не
 * даст компилятор; литеральный же `TaskStatus[]` проверялся только на
 * валидность каждого элемента, но не на полноту. Забытый статус молчал бы
 * сразу в трёх местах: digest.ts считает задачи по этому списку (пропущенный
 * статус выпадает из total — ровно это уже случалось, см. комментарий там),
 * tools-schema.ts кладёт его в enum схемы UPDATE_TASK_STATUS, а
 * miniapp-server.ts отвечает «bad status» на переход, который FSM разрешает.
 *
 * Тот же приём, что и у `OPEN_TASK_STATUSES` в tasks.ts.
 */
export const TASK_STATUSES: TaskStatus[] = Object.keys(
  TASK_TRANSITIONS,
) as TaskStatus[];

/**
 * Canonical list of autonomy modes. Consolidated from miniapp-server.ts (R3).
 * Note: lib/commands.ts maintains its own copy intentionally (different scope —
 * it isn't part of this refactor).
 */
export const AUTONOMY_MODES: AutonomyMode[] = [
  "locked",
  "manual",
  "semi_auto",
  "auto",
];

/**
 * Вложения хода пользователя. Живут здесь, потому что их надо прокинуть через
 * четыре слоя (tool-loop → ExecCtx → DispatchCtx → respondAs), и четыре копии
 * одного и того же литерала расходятся по определению.
 */
export type InputImage = { mediaType: string; base64: string };
export type InputDocument = { filename: string; text: string };
