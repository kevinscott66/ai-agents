/**
 * In-process pub/sub bus for SSE (M2).
 *
 * Simple `Set<(e) => void>` — synchronous fan-out. No persistence, no
 * cross-process delivery. Subscribers should be cheap and non-throwing;
 * any thrown error is caught and logged so it cannot break the emitter.
 */
import { getErrorMessage } from "./errors.ts";
import { log } from "./log.ts";

export type BusEventName =
  | "task.created"
  | "task.updated"
  | "approval.created"
  | "approval.decided"
  | "agent.health"
  | "agent.autonomy"
  | "agent.paused"
  // P1 (2026-06-09): каждое исполненное действие агента — для live-видимости
  // прогресса в Mini App («агент реально делает, а не симулирует»).
  | "action.executed";

export interface BusEvent {
  name: BusEventName;
  payload: unknown;
  ts: number;
}

export type BusListener = (e: BusEvent) => void;

const listeners = new Set<BusListener>();

export function emit(name: BusEventName, payload: unknown): void {
  const ev: BusEvent = { name, payload, ts: Date.now() };
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch (err) {
      log.error("[events-bus] listener error", {
        error: getErrorMessage(err),
      });
    }
  }
}

export function subscribe(fn: BusListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper. */
export function _listenerCount(): number {
  return listeners.size;
}

/** Test helper. */
export function _clearListeners(): void {
  listeners.clear();
}
