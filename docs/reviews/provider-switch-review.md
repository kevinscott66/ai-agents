# Provider switch review

Request: temporarily switch the runtime team from Claude to Codex with rollback.
Base: main 4da99ec7073ed05bdf4bb0b934649a853b8b7b11. Three touched production library files match server SHA-256 before edits.
Risk: HIGH (inference and tool capability boundary). Shared QUALITY_GATES requires independent specialist reasoning.
Review dispatch: security/runtime reviewer; bounded to inference-provider.ts, codex-runtime.ts and integration diff in tool-loop.ts, anthropic-client.ts, agent-sdk-runtime.ts. Available executor: same-family Codex subagent with local read tools. No deployment or credentials. Context approximately 5k tokens; soft budget 5k, maximum 8k; output actionable findings with lines or PASS. Stop after one diff review; maximum three fix cycles.
Baseline: typecheck PASS; new parser/provider tests 4 PASS. Full suite running. Live authenticated smoke pending owner selection of login method. No provider switch performed yet.

Independent review cycle 1: completed invalid responses missed usage accounting (fixed with incremental completed-event accounting; subprocess regression verifies secret isolation and charge on invalid output). CLI max_tokens incompatibility is explicitly documented; not represented as hard limit. Native tool exposure is being verified with a dummy local Responses endpoint, no real account. Full suite repeated after fixes.

Final validation (2026-09-15): full suite 6947 PASS, 39 SKIP, 0 FAIL (6986 tests/799 files, 137.71s). After final catalog isolation: runtime tests 6 PASS (20 expectations), typecheck PASS, git diff --check PASS. Independent final same-family review PASS for pinned CLI0.149.0. Mock capture confirmed tools:[] with copied bundled catalog (apply_patch_tool_type=null) plus disabled plan/request-user-input. No unknown model fallback allowed. Exact numeric max_tokens is not supported; documented compatibility limitation.

Production remains Claude/agent-team active. Auth selection unanswered. CLI install ENOSPC; partial task-created install removed. No live model smoke, restart, switch, commit, push, PR or deployment performed. Existing iPhone feature clone is separate and preserved.
