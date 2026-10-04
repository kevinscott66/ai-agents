/** Validates inference-only CLI events independently of subprocess transport. */
export class CodexEvents {
  completed = false;
  usage = { input_tokens: 0, output_tokens: 0 };

  constructor(private readonly onUsage?: (input: number, output: number) => void) {}

  accept(line: string): void {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "turn.completed") {
      if (this.completed) throw new Error("Duplicate Codex completion");
      const next = event.usage;
      if (!next || !Number.isSafeInteger(next.input_tokens) || next.input_tokens < 0 || !Number.isSafeInteger(next.output_tokens) || next.output_tokens < 0) throw new Error("Invalid Codex usage");
      this.completed = true;
      this.onUsage?.(next.input_tokens, next.output_tokens);
      this.usage = next;
    }
    if (event.type === "turn.failed" || event.type === "error") throw new Error("Codex turn failed");
    if (event.item?.type === "error" && event.item.message === "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.") return;
    if (event.item && !["agent_message", "reasoning"].includes(event.item.type)) throw new Error("Unexpected native Codex tool activity");
  }
}
