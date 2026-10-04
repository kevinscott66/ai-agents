# Codex inference adapter

`agent/lib/codex-runtime.ts` owns temporary inputs, process isolation, stream limits,
timeouts and output validation. It proposes tool calls to the existing dispatcher;
it does not execute native Codex tools.

`CodexEvents` in `agent/lib/codex-events.ts` owns event validation and completion
accounting. A completion charges usage before reply validation, duplicates fail,
and native tool events remain rejected. The existing exact disabled-code-mode
warning is the only permitted error-item exception.

`readBoundedUtf8` reads subprocess output with a bounded allocation and closes the
file on success or failure. The limit is measured in bytes, not characters.

Focused checks: from `agent/`, run
`bun test tests/codex-runtime.test.ts tests/codex-events.test.ts`.
Service storage setup is documented in
`../deploy/systemd/agent-team.service.d/README.md`.
