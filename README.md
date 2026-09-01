# ai-agents

A production multi-agent system that runs a twelve-role software team inside a
Telegram group. Each role is an autonomous agent with its own system prompt,
permission envelope and audit trail; a shared orchestrator routes conversation,
delegates work and escalates anything risky to a human.

Built as a working system, not a demo — 53k lines of TypeScript, 798 test files,
a fail-closed permission gate and a six-view operator dashboard.

## What it does

Twelve agents share one Telegram bot token and are differentiated by role
prompts. They read the group conversation, pick up work from a persistent
queue, execute tools, and report back. Actions that change the outside world
pass through a permission gate before dispatch; anything marked risky waits for
an explicit human approval issued from the Mini App.

An MTProto userbot runs alongside the Bot API to cover what the Bot API cannot
do — reactions, deletions, dialog access.

## Architecture

```
Telegram ──▶ telegraf bot ──▶ orchestrator-team.ts
                                    │
                     per-agent loop (tool-loop.ts) ◀──▶ Claude
                                    │
                     action-dispatch.ts + permissions-gate
                            ↙                    ↘
                 telegram-actions            userbot (gramjs)
                            ↘                    ↙
                          audit log + SQLite (WAL)
                                    │
                        miniapp-server ◀──▶ Preact UI
```

**Roles**

| Role | Responsibility |
|------|----------------|
| `orchestrator` | Team coordination and message routing |
| `pm` | Planning, status, deadlines |
| `product` | Product decisions and requirements |
| `backend` | Server code, APIs, data layer |
| `frontend` | UI and web interfaces |
| `tgdev` | Telegram platform integration |
| `aieng` | Prompts, model plumbing, self-diagnostics |
| `qa` | Testing and quality control |
| `smm` | Content and social distribution |
| `copy` | Copywriting and documentation |
| `design` | Visual design, SVG generation |
| `perm` | Access control and security review |

## Safety model

The interesting engineering here is the part that stops agents from doing
damage.

- **Tiered autonomy.** Every role runs in one of four modes — `locked`,
  `manual`, `semi_auto`, `auto` — set per role and per action class.
- **Fail-closed permissions.** An action with no explicit grant is denied.
  Unknown provider or role values resolve to deny rather than to a default.
- **Approval gates.** Risky actions are queued for human approval and dispatched
  only after an explicit decision; approval cannot be inferred from context.
- **Audited execution.** Every tool call and dispatched action is written to an
  append-only audit log alongside the task it belongs to.
- **Delegation loop protection.** Task handoff between roles is cycle-checked.
- **Hardened units.** The systemd units run as a non-root user under
  `ProtectSystem=strict` with an explicit `ReadWritePaths` allowlist and the
  environment file marked inaccessible to the service itself.

## Operator dashboard

A Preact + Vite Mini App served over HTTPS from the same process, with six
views: summary, tasks, approvals, agents, permissions and logs. Live updates
stream over SSE.

## Stack

Bun · TypeScript · `@anthropic-ai/claude-agent-sdk` · telegraf (Bot API) ·
telegram/gramjs (MTProto) · zod · SQLite via `bun:sqlite` in WAL mode ·
Preact + Vite · systemd · GitHub Actions

## Quick start

```bash
git clone https://github.com/kevinscott66/ai-agents
cd ai-agents/agent
bun install
cp .env.example .env
bun test
bun run start
```

Build the Mini App:

```bash
cd agent/miniapp && bun install && bun run build
```

Minimum configuration — see `agent/.env.example` for the annotated full set:

```bash
TELEGRAM_BOT_TOKEN=
CLAUDE_CODE_OAUTH_TOKEN=      # or ANTHROPIC_API_KEY with USE_AGENT_SDK=false
ALLOWED_CHAT_IDS=
TG_API_ID=
TG_API_HASH=
TG_PHONE=
USERBOT_SESSION_KEY=
```

## Tests

```bash
bun test          # full suite
bun run typecheck # tsc --noEmit
```

798 test files cover the permission gate, approval dispatch, deployment units,
database path resolution, secret scrubbing and userbot flood control. A large
share are regression tests written against specific production incidents and
named for the date they were found.

## Layout

```
agent/        application source, tests, tools, Mini App, mac bridge
site/         companion web service (server + Vite frontend)
deploy/       systemd units, staged blue/green deploy, deploy locking
```

## Notes on this repository

Host names, IP addresses and account identifiers in source, tests and deploy
scripts are placeholders. No credentials are committed; everything is supplied
at runtime through the environment. See [SECURITY.md](SECURITY.md).

## Licence

MIT — see [LICENSE](LICENSE).
