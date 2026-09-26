export type Activity = "working" | "waiting" | "done" | "error" | "idle";
// Visual interpretation of authoritative status, never a simulated task event.
export function activityFor(state?: string): Activity {
  if (
    ["THINKING", "CODING", "TERMINAL", "TESTING", "REVIEWING"].includes(
      state ?? "",
    )
  )
    return "working";
  if (
    ["WAITING", "WAITING_TOOL", "WAITING_APPROVAL", "BLOCKED"].includes(
      state ?? "",
    )
  )
    return "waiting";
  if (state === "DONE") return "done";
  if (state === "ERROR") return "error";
  return "idle";
}
