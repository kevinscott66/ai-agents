/** Metadata only; trusted ingress identity, never text/model payload or chat IDs. */
const active = new Map<symbol, { owner: string; role: string }>();
export async function observeOfficeActivity<T>(owner: string | undefined, role: string, work: () => Promise<T>): Promise<T> {
  const id = Symbol();
  if (owner) active.set(id, { owner, role });
  try { return await work(); } finally { active.delete(id); }
}
export function officeActivityCount(owner: string, role: string): number {
  return [...active.values()].filter(x => x.owner === owner && x.role === role).length;
}
