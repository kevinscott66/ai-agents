import { killChild } from './kill.ts';
import type { AuthProbeChild } from './auth-preflight.ts';

export type Readiness = 'available' | 'quota_exhausted' | 'billing_unavailable' | 'authentication_unavailable' | 'unknown' | 'cancelled';

/** Local CLI help + official Agent SDK SDKAssistantMessageError wire types. */
export function claudeReadinessCommand(binary: string): string[] {
  return [binary, '--print', '--verbose', '--output-format', 'stream-json',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
    '--permission-mode', 'dontAsk', '--system-prompt', 'Reply only OK.',
    'Reply only OK.'];
}

/** No regex on human/model text: only CLI-owned typed error fields. */
export function classifyReadinessFrame(frame: unknown): Readiness | null {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return 'unknown';
  const m = frame as Record<string, any>;
  if (m.type === 'assistant' && Array.isArray(m.message?.content)
      && m.message.content.some((block: any) => block?.type === 'tool_use')) return 'unknown';
  if (m.type === 'system' && m.subtype === 'init') {
    return Array.isArray(m.tools) && m.tools.length === 0 && Array.isArray(m.mcp_servers)
      && m.mcp_servers.length === 0 ? null : 'unknown';
  }
  if (m.type === 'system' && ['hook_started','hook_progress','hook_response'].includes(m.subtype)) return 'unknown';
  if (m.type === 'assistant' || (m.type === 'system' && m.subtype === 'api_retry')) {
    if (m.error === 'rate_limit') return 'quota_exhausted';
    if (m.error === 'billing_error') return 'billing_unavailable';
    if (m.error === 'authentication_failed') return 'authentication_unavailable';
    // Explicit policy refusals and every unrecognized error stop probing, with
    // no provider switch. Model text is never read for availability decisions.
    if (m.error !== undefined) return 'unknown';
  }
  if (m.type === 'result') return m.subtype === 'success' && m.is_error === false ? 'available' : 'unknown';
  return null;
}

/** A fixed, tool-free request checks quota before sending any user task. */
export async function probeClaudeReadiness(
  spawn: () => AuthProbeChild,
  signal: AbortSignal,
  track: (child: AuthProbeChild) => void,
  timeoutMs = 10_000,
): Promise<Readiness> {
  if (signal.aborted) return 'cancelled';
  let child: AuthProbeChild;
  try { child = spawn(); track(child); } catch { return 'unknown'; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<Readiness>(resolve => {
    abort = () => resolve('cancelled');
    signal.addEventListener('abort',abort,{once:true});
    timer = setTimeout(() => resolve('unknown'),Math.min(timeoutMs,10_000));
    if(signal.aborted) abort();
  });
  const output = (async (): Promise<Readiness> => {
    const reader = child.stdout.getReader(); const decoder = new TextDecoder();
    let pending = ''; let size = 0; let initialized = false;
    while(true) {
      const {done,value} = await reader.read();
      if(done) return 'unknown';
      size += value.byteLength; if(size > 65_536) return 'unknown';
      pending += decoder.decode(value,{stream:true});
      let newline: number;
      while((newline=pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0,newline); pending=pending.slice(newline+1);
        if(!line.trim()) continue;
        const frame = JSON.parse(line);
        const result = classifyReadinessFrame(frame);
        // Verify the CLI actually initialized without tools/MCP before trusting
        // an error as grounds for provider fallback.
        if(frame.type==='system' && frame.subtype==='init' && result===null) initialized=true;
        if(result !== null) return initialized ? result : 'unknown';
      }
    }
  })().catch(() => 'unknown' as const);
  try {
    const result = await Promise.race([output,interrupted]);
    return signal.aborted ? 'cancelled' : result;
  } finally {
    if(timer) clearTimeout(timer);
    signal.removeEventListener('abort',abort);
    await killChild(child,0).catch(()=>{});
  }
}
