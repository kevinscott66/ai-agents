import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizeChildEnv } from './child-env.ts';
import { parseCalendarDay } from '../lib/assistant-types.ts';

export type AssistantOperation = 'calendar_today' | 'open_workspace';
export type NativeExec = (file: string, args: string[], signal?: AbortSignal) => Promise<string>;
export const nativeExec: NativeExec = (file, args, signal) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 20_000, signal, killSignal: 'SIGKILL', maxBuffer: 60_000, env: sanitizeChildEnv(process.env) }, (err, stdout, stderr) => {
    // Never forward OS stderr (may contain personal information).
    if (err) reject(new Error(stderr.trim() === 'calendar_access_required' ? 'calendar_access_required' : 'native_command_failed'));
    else resolve(stdout);
  });
});

export async function runAssistantOperation(
  operation: AssistantOperation,
  env: NodeJS.ProcessEnv = { MAC_CALENDAR_ENABLED: process.env.MAC_CALENDAR_ENABLED, MAC_WORKSPACE_APPS: process.env.MAC_WORKSPACE_APPS },
  exec: NativeExec = nativeExec,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = new AbortController();
  const cancel = () => deadline.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 20_000);
  const check = () => { if (signal?.aborted || deadline.signal.aborted) throw new Error('assistant_cancelled'); };
  try {
    check();
    if (operation === 'calendar_today') {
      if (env.MAC_CALENDAR_ENABLED !== 'true') throw new Error('calendar_disabled');
      const helper = fileURLToPath(new URL('./bin/agent-calendar', import.meta.url));
      const raw = await exec(helper, ['today'], deadline.signal);
      check();
      return JSON.stringify(parseCalendarDay(raw));
    }
    if (operation !== 'open_workspace') throw new Error('unsupported_operation');
    // Only locally configured application bundle IDs; remote input cannot name an app or URL.
    const ids = (env.MAC_WORKSPACE_APPS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    if (!ids.length || ids.length > 8 || ids.some(x => !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(x))) {
      throw new Error('workspace_not_configured');
    }
    const opened: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      check();
      try { await exec('/usr/bin/open', ['-b', id], deadline.signal); check(); opened.push(id); }
      catch { check(); failed.push(id); }
    }
    return JSON.stringify({ opened, failed });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Only fixed diagnostic codes may leave the Mac; never OS stderr or personal data. */
export function assistantErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return ['calendar_disabled','calendar_access_required','workspace_not_configured','assistant_cancelled'].includes(code) ? code : 'assistant_unavailable';
}
