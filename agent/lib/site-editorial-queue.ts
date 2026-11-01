/** Scheduling only. Admission/receipt/ownership gates remain in site-editorial-state. */
import type { Kind, RawRecord } from "./site-editorial-state.ts";

type Candidate = Pick<RawRecord, "id" | "date" | "activityMaintenanceRequired">;

/** Never mutate caller data or admit a row rejected by the state layer. */
export function selectEditorialBatch<T extends Candidate>(
  eligible: readonly T[],
  kind: Kind,
  limit: number,
  retryAfter: Readonly<Record<string, number>>,
): T[] {
  const ordered = [...eligible].sort((a, b) => (kind === "activities"
    ? (retryAfter[`${kind}:${a.id}`] ?? 0) - (retryAfter[`${kind}:${b.id}`] ?? 0)
    : 0) || String(b.date ?? "").localeCompare(String(a.date ?? "")) || a.id.localeCompare(b.id));
  // Keep changed guides moving while making room for new drafts.
  if (kind === "activities") {
    const maintenance = ordered.filter(row => row.activityMaintenanceRequired === true);
    const drafts = ordered.filter(row => row.activityMaintenanceRequired !== true);
    if (maintenance.length && drafts.length && limit >= 2)
      return [maintenance[0], ...drafts.slice(0, limit - 1), ...maintenance.slice(1)].slice(0, limit);
  }
  // Retain one historical digest slot alongside recent stories.
  if (kind === "digests" && limit >= 2 && ordered.length > limit)
    return [...ordered.slice(0, limit - 1), ordered.at(-1)!];
  return ordered.slice(0, limit);
}
