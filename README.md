# DOBROPALM Agent

[English](README.md) · [Русский](README.ru.md)

[![Repository checks](https://github.com/kevinscott66/ai-agents/actions/workflows/checks.yml/badge.svg)](https://github.com/kevinscott66/ai-agents/actions/workflows/checks.yml) · [MIT](LICENSE)

One team of AI roles across Telegram, browser and iPhone. Shared history, voice conversations and clear boundaries: the assistant can propose an action; the person keeps control.

**Status:** Active development. Current snapshot: September 2026.

[ Case study ](https://dobropalm.tech/case-studies/agent/) · [Portfolio](https://dobropalm.tech)

![Actual dashboard UI running locally. Tasks and counters are sample data; execution is disabled. This demonstrates the interface, not production usage.](https://dobropalm.tech/assets/media/agent.webp)

_Actual dashboard UI running locally. Tasks and counters are sample data; execution is disabled. This demonstrates the interface, not production usage._

## Problem & outcome

A regular AI chat has limited memory and little connection to real work. Giving it tools creates another problem: crossing project boundaries, repeating an action after a failure or treating its own inference as permission.

The source implements shared browser/iPhone conversations, voice input and spoken replies, message history with actual role attribution and in-chat approvals. These are delivered capabilities; no unmeasured time savings or user counts are claimed.

## My contribution

I define the assistant’s roles, interaction rules, memory boundaries and action policies. My responsibility is the product logic and system design: what it may decide, when it must ask and how the user understands what happened.

I use AI tools in development; product and architectural decisions are my responsibility.

## Engineering highlights

- **Do not repeat an unknown outcome.** Losing a response does not prove an action failed. Provider fallback is restricted to eligible failures before execution.
- **Memory with provenance.** Facts reference source messages. Ownership, revision checks and writes share a transaction, so a stale model response cannot overwrite newer memory.
- **Delegate only when useful.** The coordinator selects relevant roles. Call limits and cycle detection keep delegation bounded.

## Architecture & stack

| Layer | Implementation |
|---|---|
| Interfaces | Telegram, Preact, SwiftUI; browser chat |
| Backend / AI | Bun, TypeScript, role orchestration, Claude Agent SDK |
| Data | SQLite WAL; conversations, tasks, approvals, project memory |
| Infrastructure | systemd, GitHub Actions, separate execution bridge |

A conversation belongs to an owner; project membership is a separate mapping. Chat memory carries a revision, proposals snapshot it, and approved knowledge preserves provenance. New tables are additive to the existing conversation store.

## Quick start

```bash
# Requires Bun. These checks use local fixtures, not provider accounts.
git clone https://github.com/kevinscott66/ai-agents.git
cd ai-agents/agent
bun test tests/native-knowledge.test.ts tests/mac-provider-fallback.test.ts
```

For the UI: `cd miniapp && npm install && npm run build`. `npm run dev` starts the frontend; an authenticated backend is required for real data. To run the assistant, install the agent dependencies and configure `agent/.env.example` with your own provider and Telegram accounts. Never use a production token for experiments.

## Checks

```bash
bun test
bun run typecheck
```

The badge links to the actual workflow. Listing a command does not claim every check ran for each README edit.

## Deployment, observability & API

The service and dashboard are deployed separately from the signed iPhone build. Queues, action logs and health states distinguish completed work, pending decisions and failures. Credentials and production databases are excluded from the public repository.

```bash
# With a locally configured service:
curl --fail http://127.0.0.1:8787/api/health
```

The port depends on local configuration. Native and Telegram routes have separate authentication contracts; an unauthenticated health response is not proof of access to chats or tools.

## Security & limits

Provider accounts and owner setup are required. Working conversations are not public demos. The 2D/3D office and GitHub MCP adapter remain on a development branch; banking execution is not presented as a shipped capability.

SQLite keeps operations simple and memory updates atomic, but long operations in one process need care. Voice uses recording → transcription → response → synthesis: easier to control, but not full-duplex speech.

Disclosure policy: [SECURITY.md](SECURITY.md).

## History & documentation

The public repository contains server, browser and native-client code. Office/MCP work is currently on the linked development branch; a commit or screenshot is not an App Store release.

- [Memory boundaries & schema](docs/native-knowledge.md)
- [Voice architecture](docs/conversational-voice.md)
- [Memory regression tests](agent/tests/native-knowledge.test.ts)
- [Provider fallback tests](agent/tests/mac-provider-fallback.test.ts)
- [Dashboard health correction](agent/miniapp/src/pages/Dashboard.tsx)
- [Office / MCP development branch](https://github.com/kevinscott66/ai-agents/tree/codex/virtual-office-live)

## License

MIT - [LICENSE](LICENSE).
