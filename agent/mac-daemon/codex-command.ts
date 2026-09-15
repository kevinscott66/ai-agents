import type { RunMode } from './protocol.ts';
/** Fixed argv, stdin prompt. Never inherit daemon secrets or disable sandboxing. */
export function codexCommand(mode: RunMode, env: Record<string,string|undefined> = process.env): string[] {
  if (mode === 'bypass') throw new Error('codex_bypass_not_supported');
  const sandbox = mode === 'accept_edits' || mode === 'auto' ? 'workspace-write' : 'read-only';
  return [env.CODEX_BIN?.trim() ? env.CODEX_BIN : 'codex', 'exec',
    '--ignore-user-config', '--ignore-rules', '-c', 'approval_policy="never"',
    '--sandbox', sandbox, '-c', 'sandbox_workspace_write.network_access=false',
    '--skip-git-repo-check', '--color', 'never', '-'];
}
