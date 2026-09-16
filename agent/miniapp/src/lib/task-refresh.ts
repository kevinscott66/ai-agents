/** SSE is only a hint: other processes and disconnected intervals can miss events. */
export function startTaskRefresh(refresh: () => Promise<unknown>, environment: {
  visible: () => boolean;
  subscribe: (listener: () => void) => () => void;
  interval: (listener: () => void) => () => void;
}) {
  let stopped = false, busy = false;
  const run = async () => {
    if (stopped || busy || !environment.visible()) return;
    busy = true;
    try { await refresh(); } catch { /* The view owns error presentation. */ }
    finally { busy = false; }
  };
  const unsubscribe = environment.subscribe(() => { void run(); });
  const cancel = environment.interval(() => { void run(); });
  return () => { stopped = true; unsubscribe(); cancel(); };
}
export const browserTaskRefresh = {
  visible: () => !document.hidden,
  subscribe(listener: () => void) {
    document.addEventListener('visibilitychange', listener);
    window.addEventListener('focus', listener);
    return () => { document.removeEventListener('visibilitychange', listener); window.removeEventListener('focus', listener); };
  },
  interval(listener: () => void) { const timer = setInterval(listener, 15000); return () => clearInterval(timer); },
};
