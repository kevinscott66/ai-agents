/** Metadata only; trusted ingress identity, never text/model payload or chat IDs. */
const active = new Map<symbol, { owner: string; role: string; parent?: string; started: number }>();
export async function observeOfficeActivity<T>(owner: string | undefined, role: string, work: () => Promise<T>, chain: string[] = []): Promise<T> {
  const id = Symbol();
  if (owner) active.set(id, { owner, role, parent: chain.at(-2), started: Date.now() });
  try { return await work(); } finally { active.delete(id); }
}
export function officeActivityCount(owner: string, role: string): number {
  return [...active.values()].filter(x => x.owner === owner && x.role === role).length;
}

/** Short presentation window for actual leader handoffs; no task text or IDs. */
export function officeBriefing(owner: string): string[] {
  return [...new Set([...active.values()].filter(x => x.owner === owner && x.parent === 'orchestrator' && Date.now() - x.started < 30000).map(x => x.role))];
}
