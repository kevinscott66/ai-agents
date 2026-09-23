# Existing system — discovery checkpoint

Date: 2026-09-23. Inspected checkout `claude/site-editorial-every-30min`, HEAD `bd12dab1eaa209c72063e1b3a329856efaa4b10f`. This is a code/configuration review, not a live VPS audit. Secret values, runtime databases and private conversations were not read. An adapter's existence does not establish external-account access or model availability. This historical checkpoint predates the [live integration](LIVE_INTEGRATION.md).

## Workspace map

| Area | Purpose / source |
| --- | --- |
| `agent/` | Bun/TypeScript runtime; `agent/orchestrator-team.ts`, dependencies in `agent/package.json` |
| `agent/miniapp/` | Existing web UI; API in `agent/lib/miniapp-server.ts` |
| `ios/` | Standalone native client; API in `agent/lib/native-api.ts` |
| `agent/mac-daemon/` | Authorized local execution through Mac bridge |
| `site/` | Separate site; another session's `site/web/**` excluded from this work |
| `eliza/` | Separate untracked tree, not this team's production runtime |
| `deploy/` | Scripts and service templates; README includes historical configurations |
| `memory/`, `data/`, `agent/data/` | Local memory/state; never copy into the office or Git |

Uncommitted iOS/OpenFlux/site work predates this task. Live Git takes precedence over stale branch claims in local handoffs.

## Actual roster

Source: `RoleKey` and `CHARACTERS` in `agent/characters/index.ts`. **Twelve identities total, including Lead**, not twelve plus Lead.

| agentId | Character | Responsibility |
| --- | --- | --- |
| orchestrator | Lead | Routing, coordination and delegation |
| pm | PM | Tasks, deadlines and risks |
| product | Product | Value, scenarios and prioritization |
| backend | Backend | APIs, data and business logic |
| frontend | Frontend | React/UI and accessibility |
| tgdev | TG-Dev | Telegram Bot API, MTProto and Mini Apps |
| aieng | AI Eng | LLMs, prompts, tools, RAG and evaluations |
| qa | QA | Testing and regressions |
| smm | SMM | Social channels and analytics |
| copy | Copy | Writing and content |
| design | Design | Design |
| perm | Permissions | Actions and permissions |

iOS and Security are not separate identities. Visuals must not invent real agents. The initial office configuration allows thirteen seats, twelve occupied and one reserved. Roster changes require separate backend work.

## Execution, communication and models

`agent/orchestrator/message-handler.ts` routes mentions and role replies. `DELEGATE_TO_ROLE` uses the existing dispatcher. `CREATE_TASK`, `ASSIGN_TASK`, `UPDATE_TASK_STATUS`, `REQUEST_REVIEW`, `COMMENT_TASK` manage tasks; assignment does not mean execution has started.

`role-runtime.ts` and `role-runtime-worker.ts` implement a separate durable SQLite queue for temporary roles: queued/running/done/failed, leases/heartbeats/recovery, and internal/claude/codex providers. These are not twelve continuously running OS processes. Collaboration passes through the backend/shared context; an animated meeting cannot initiate delegation.

At this checkpoint, `role-models.ts` configured Lead as Claude Opus 5 or Codex gpt-5.6-sol; engineering roles as Claude Sonnet 5 or gpt-5.6-terra with high effort; PM/Product/Design/Copy/SMM with the same base model at medium effort. Role overrides exist. These are code defaults, not verified provider availability. See `docs/inference-providers.md`, `agent-sdk-runtime.ts` and `codex-runtime.ts`.

## Tools, MCP and GitHub

Catalog: `agent/lib/tools-schema.ts`. Execution boundaries: `action-dispatch.ts`, `dispatch/`, `approval-policy.ts`. Categories include tasks, wiki, Telegram, media, web search, Mac, GitHub, site, DNS and personal-service workflows. The SDK exposes internal MCP server `team`. `docs/higgsfield-mcp.md` describes the scoped image integration with role/approval gates; it is not every tool available in the development Codex session.

`dispatch/github.ts` implements checked PR review/merge; `code-task.ts` implements authorized Mac work producing a PR. GitHub Actions runs CI/checks, not the agent runtime. The office does not start obsolete agent workflows.

## Memory and infrastructure

`db.ts` stores SQLite messages/work data. `memory.ts` provides short context and `_team`/role Markdown knowledge with FTS5. Native conversations/knowledge form a separate layer (`native-context.ts`, `native-knowledge.ts`, `native-db-path.ts`). See `docs/engineering-memory.md`. The office stores a derived projection, not a second agent memory.

Server shape: Bun service, reverse proxy, durable storage and a separately connected Mac daemon (`mac-bridge.ts`). `deploy/README.md` marks Caddy/blue-green material historical. Exact hosts, service state, environment and rollout procedures belong in the private operational handoff and were not verified here. No complete infrastructure API for a server-room view was established.

## Observable surfaces at this checkpoint

| Source | Provides | Limitation |
| --- | --- | --- |
| GET `/api/agents`, `/api/dashboard` | Roster/health and aggregates | Telegram health is not execution state |
| GET `/api/tasks`, `/api/actions` | Tasks and audit summaries | No guaranteed current file/progress |
| POST `/api/sse-ticket`, GET `/api/events` | Task/action/health/autonomy/pause/approval events | Single-use ticket; process-local bus without replay/sequence |
| `events-bus.ts`, `task-events.ts` | Cheap invalidation hooks | Task IDs require committed rereads; other processes invisible |
| `/api/native/status`, `/api/native/turns`, conversations | Paired transport, history and jobs | Lead-centric ingress at discovery; not yet a direct-role office API |
| `/api/web/*` | Browser gateway for native API | Its own origin/credential boundary |
| `mac-bridge.ts` | Authenticated daemon WebSocket | Privileged execution channel, not office events |

Mini App REST has its own authentication/ACL; never forge Telegram initData to reuse it. Native API rejects browser origins/cookies. The office needs a scoped transport.

Use passive read projections, existing invalidations and periodic reconciliation. Never invoke LLMs, tools or extra getMe calls merely to animate. A completed-call audit does not establish ongoing tool activity. At discovery there was no complete tool/turn lifecycle feed or durable cursor: an explicit integration gap.
