import {createCoalescer, SSE_COALESCE_MS} from './coalesce';

/** Completion events plus polling for starts, missed events and native panels. */
export function watchMacHistory(
  refresh: () => Promise<unknown>,
  subscribe: (name: string, callback: (payload: unknown) => void) => () => void,
  visible: () => boolean,
  pollMs = 15000,
) {
  const coalescer = createCoalescer(SSE_COALESCE_MS);
  let stopped = false, busy = false, pending = false;
  const run = async () => {
    if (stopped || !visible()) return;
    if (busy) { pending = true; return; }
    busy = true;
    try { await refresh(); } finally {
      busy = false;
      if (pending && !stopped) { pending = false; coalescer.schedule(() => { void run(); }); }
    }
  };
  const request = () => coalescer.schedule(() => { void run(); });
  const unsubscribe = subscribe('action.executed', request);
  const timer = setInterval(request, pollMs);
  request();
  return () => { stopped = true; clearInterval(timer); coalescer.cancel(); unsubscribe(); };
}
