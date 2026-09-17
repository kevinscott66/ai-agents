# ai-agents

A multi-agent assistant with a twelve-role software team, Telegram integration
and an authenticated API for a native iPhone client. Each role is an autonomous agent with its own system prompt,
permission envelope and audit trail; a shared orchestrator routes conversation,
delegates work and escalates anything risky to a human.

The engineering focus is controlled delegation, scoped project memory,
human approvals and recoverable execution. This repository contains the server,
operator dashboard and supporting integrations.

## What it does

Twelve agents share one Telegram bot token and are differentiated by role
prompts. They read the group conversation, pick up work from a persistent
queue, execute tools, and report back. Actions that change the outside world
pass through a permission gate before dispatch; anything marked risky waits for
an explicit human approval issued from an authenticated client.

An MTProto userbot runs alongside the Bot API to cover what the Bot API cannot
do — reactions, deletions, dialog access.

## Recent capabilities

- **Project memory.** Conversations keep a compact record of facts, decisions and
  outstanding tasks with message provenance. Users assign projects manually;
  sharing a fact with other chats requires explicit approval.
- **Team dialogue.** The leader can answer alone or delegate to relevant roles.
  Specialist messages retain their actual author. Bounded delegation and cycle
  checks prevent an endless round of agent responses.
- **Native conversations.** Owner-scoped chat history, device authentication and
  in-chat action approvals support a companion iPhone client.
- **Media tools.** Authenticated media handling and image-generation integrations
  support assistant attachments, with provider configuration and access controls.
- **Mac execution.** A bridge dispatches approved work to Codex or Claude. Provider
  fallback is restricted to eligible failures before execution; it must not repeat
  an action whose execution outcome is uncertain.

See [chat and project knowledge](docs/native-knowledge.md) for storage boundaries,
concurrency controls and the collaboration model.

### Voice and browser chat

A standalone browser client at `/chat/` shares the native conversation history and
supports in-chat approvals. The rightmost voice control starts a conversation:
recording → transcription → existing team → neural speech. An audio-reactive orb
uses measured microphone and playback levels. Both sides remain in chat history.

The native client includes the same conversational mode. Recording pauses during
responses to prevent echo; interruption is an explicit playback control. Russian
transcription includes punctuation guidance. This is a chained voice pipeline,
not embedded ChatGPT or full-duplex speech-to-speech. Ordinary iPhone dictation
and device read-aloud remain available separately.

See [voice architecture and limitations](docs/conversational-voice.md). Private
configuration, signing material and release archives are excluded from this
portfolio update.

## Architecture

```
Telegram ──▶ telegraf bot ──▶ orchestrator-team.ts
                                    │
                     per-agent loop (tool-loop.ts) ◀──▶ Codex / Claude
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
TELEGRAM_ALLOWED_GROUP_IDS=   # fail-closed: empty means the bots answer nowhere
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_USERBOT_PHONE=
USERBOT_SESSION_KEY=
```

## Tests

```bash
bun test          # full suite
bun run typecheck # tsc --noEmit
```

Regression tests cover the permission gate, approval dispatch, deployment units,
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

Configure credentials and deployment-specific values outside Git. Do not commit
OAuth sessions, device tokens, signing certificates, conversation databases,
personal media or private operational logs. See [SECURITY.md](SECURITY.md).

## Licence

MIT — see [LICENSE](LICENSE).
