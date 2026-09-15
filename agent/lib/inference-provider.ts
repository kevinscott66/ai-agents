/** Reversible team-wide inference selection; legacy settings remain intact. */
export function inferenceProvider(env: Record<string, string | undefined> = { AGENT_PROVIDER: process.env.AGENT_PROVIDER }): "claude" | "codex" {
  const provider = env.AGENT_PROVIDER?.trim() || "claude";
  if (provider !== "claude" && provider !== "codex") throw new Error("AGENT_PROVIDER must be claude or codex");
  return provider;
}
