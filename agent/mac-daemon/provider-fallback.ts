import type { RunMode } from './protocol.ts';

export type RunProvider = 'claude' | 'codex';
export interface ProviderMetadata {
  provider: RunProvider;
  requestedProvider: RunProvider;
  fallbackReason?: 'executable_not_found' | 'authentication_unavailable' | 'quota_exhausted' | 'billing_unavailable';
  fallbackBlocked?: 'permission_mismatch' | 'bypass_mode';
}

/** Synchronous spawn boundary only: once a child exists, never replay the task. */
export function spawnWithFallback<T>(
  requestedProvider: RunProvider,
  mode: RunMode,
  allowFallback: boolean | undefined,
  spawn: (provider: RunProvider) => T,
  executableMissing: (provider: RunProvider) => boolean,
): { child: T; metadata: ProviderMetadata } | { error: unknown; metadata: ProviderMetadata } {
  const metadata: ProviderMetadata = { provider: requestedProvider, requestedProvider };
  try {
    return { child: spawn(requestedProvider), metadata };
  } catch (error) {
    // Codex also restricts filesystem/network access in write modes. Claude's
    // permission modes cannot preserve that sandbox, so reverse fallback is denied.
    if (allowFallback !== true || typeof error !== 'object' || error === null
      || !('code' in error) || error.code !== 'ENOENT'
      || !executableMissing(requestedProvider)) return { error, metadata };
    if (mode === 'bypass') return { error, metadata: { ...metadata, fallbackBlocked: 'bypass_mode' } };
    if (requestedProvider === 'codex') return { error, metadata: { ...metadata, fallbackBlocked: 'permission_mismatch' } };
    const alternate: ProviderMetadata = {
      provider: 'codex', requestedProvider, fallbackReason: 'executable_not_found',
    };
    try {
      return { child: spawn('codex'), metadata: alternate };
    } catch (error) {
      return { error, metadata: alternate };
    }
  }
}
