import { killChild, type KillableChild } from './kill.ts';

export interface AuthProbeChild extends KillableChild {
  stdout: ReadableStream<Uint8Array>;
}
/** Only structured loggedIn:false proves unavailable. Never expose probe output. */
export async function probeClaudeAuth(
  spawn: () => AuthProbeChild,
  signal: AbortSignal,
  track: (child: AuthProbeChild) => void,
  timeoutMs = 5_000,
): Promise<'available' | 'unavailable' | 'unknown' | 'cancelled'> {
  if (signal.aborted) return 'cancelled';
  let child: AuthProbeChild;
  try { child = spawn(); track(child); } catch { return 'unknown'; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('cancelled'));
    signal.addEventListener('abort', onAbort, {once:true});
    timer = setTimeout(() => reject(new Error('timeout')), Math.min(timeoutMs, 5_000));
    if(signal.aborted) onAbort();
  });
  try {
    const output = (async () => {
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const {done,value} = await reader.read();
        if(done) break;
        size += value.byteLength;
        if(size > 16_384) throw new Error('oversized');
        chunks.push(value);
      }
      // auth status uses nonzero for logged-out installations; only valid JSON
      // determines unavailability, never its exit status or textual diagnostics.
      const code = await child.exited;
      if (code !== 0 && code !== 1) return 'unknown' as const;
      const bytes = new Uint8Array(size); let offset = 0;
      for(const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed.loggedIn === false ? 'unavailable' as const : parsed.loggedIn === true ? 'available' as const : 'unknown' as const
        : 'unknown' as const;
    })();
    const result = await Promise.race([output, interrupted]);
    return signal.aborted ? 'cancelled' : result;
  } catch {
    return signal.aborted ? 'cancelled' : 'unknown';
  } finally {
    if(timer) clearTimeout(timer);
    signal.removeEventListener('abort',onAbort);
    // Include descendants even after leader exit; no probe survives its deadline.
    await killChild(child, 0).catch(() => {});
  }
}
