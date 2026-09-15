import { nativeAccess, type NativeAccess } from './native-access.ts';
import type { HealthSnapshot } from './health.ts';
import { isAssistantOwner } from './assistant-auth.ts';
import { agentStopReason } from './permissions.ts';
/** Uses the existing health scheduler; no extra timers and no unchanged-state messages. */
export function createAssistantHealthAlerts(
  send: (userId: string, text: string) => Promise<boolean>,
  store: () => NativeAccess = nativeAccess,
  allowed: (userId: string) => boolean = isAssistantOwner,
) {
  let busy = false;
  return async (snapshots: HealthSnapshot[]) => {
    if (busy || agentStopReason('orchestrator')) return;
    busy = true;
    try {
      const state = store();
      for (const user of state.alertUsers()) {
        if (!allowed(user)) continue;
        for (const snapshot of snapshots) {
          if (!allowed(user)) break;
          // Debounce failures, but recover immediately after a successful health probe.
          if (!snapshot.alive && snapshot.consecutiveFailures < 3) continue;
          const unhealthy = !snapshot.alive;
          if (!state.alertChanged(user, snapshot.agentKey, unhealthy)) continue;
          try {
            if (await send(user, unhealthy
              ? `Агент: роль ${snapshot.agentKey} не отвечает после трёх проверок.`
              : `Агент: связь с ролью ${snapshot.agentKey} восстановлена.`)) state.markAlert(user, snapshot.agentKey, unhealthy);
          } catch { /* Retry on the next existing health snapshot, without recording delivery. */ }
        }
      }
    } catch { /* Health reporting must not break on unavailable local state. */ } finally { busy = false; }
  };
}
