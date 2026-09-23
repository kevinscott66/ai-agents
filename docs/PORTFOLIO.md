# Engineering case study: DOBROPALM Agent

## Problem

An assistant can answer correctly and still fail to complete a task: a second client can select a different conversation, a delegated reply can lose its author, or a timeout can tempt the system to repeat a purchase. This project explores the infrastructure needed to connect conversational interfaces to real tools while keeping identity, permissions and execution outcomes explicit.

## System design

Twelve specialist roles share an orchestration backend, with separately configured Telegram bots. Native iPhone and browser clients use owner-paired APIs. The virtual office is another view over execution state, with simulated local mode kept distinct from connected operation.

The tool boundary is shared across raw model execution and the internal team MCP. New tool names must be registered, exposed to appropriate roles and checked during dispatch. External MCP does not receive arbitrary write access: the GitHub adapter fixes the endpoint and repository, permits three read operations and checks the initiating owner.

SQLite stores durable conversations, tasks, knowledge and audit data. Native conversation IDs, task IDs, turn IDs and external operation IDs are separate concepts. The proposed universal operation model is documented as future work rather than presented as an existing workflow engine.

## Selected engineering decisions

| Decision | Reason | Trade-off |
| --- | --- | --- |
| Server-owned conversation role | Prevent an iPhone reply from silently routing to Lead instead of the specialist | Clients must preserve role metadata; legacy clients need an update |
| Stable office conversation selection | Another device must not change where an in-progress message will be sent | Latest conversation discovery is a default, not automatic navigation |
| Separate response and action completion | A model reply may precede approval or external execution | UI needs waiting and unknown/error states, not a single done flag |
| No automatic replay after uncertain side effects | Timeout does not establish that nothing happened | Recovery may require a provider status check or a concrete owner step |
| Scoped execution visibility | Avoid exposing other users' group activity in private clients | Unattributed background workers are not represented as global office state |
| Native owner pairing and signed purchase parameters | Keep credentials and important approvals separate from model text | Device setup and recovery are explicit product flows |
| Opt-in 3D with a 2D fallback | Keep the assistant usable without loading WebGL | Visual richness depends on client hardware; hosting does not eliminate GPU use |

## Representative implementation

- [Native API](../agent/lib/native-api.ts): owner boundaries, conversation routing and office projection.
- [Native storage](../agent/lib/native-access.ts): durable turns, history and role binding.
- [Tool dispatch](../agent/lib/tools-schema.ts): common schema and execution entry point.
- [GitHub MCP](../agent/lib/github-mcp.ts): scoped read-only remote integration with bounded JSON/SSE transport.
- [iPhone API client](../ios/Agent/API.swift): validated native contracts.
- [Office dialog](../virtual-office/web/src/LiveOffice.tsx): pinned conversation and uncertain-send handling.
- [Personal execution policy](../agent/characters/personal-execution.ts): persistent problem-solving within actual tools and permissions.

## Validation approach

Tests target failure boundaries: ownership mismatch, revoked credentials during a request, duplicate IDs, approval recovery, simultaneous role execution, interrupted streams and disconnect/reconnect. MCP tests exercise both JSON and an SSE stream that remains open after its response. Swift fixtures compile real model/API code where applicable; browser scenarios use isolated test data rather than personal sessions.

Independent reviews complement deterministic checks, but do not certify the absence of vulnerabilities. Source implementation, test success, configured integration and live acceptance are distinct states. Current CI results belong to the exact commit, not to a permanent README test-count badge.

## Product maturity

This is a working development project, not a claim of a universal autonomous assistant. The repository includes external-service workflows, but accounts, permissions, compatible pages and deployment setup determine whether they can run. The personal T-Bank executor and general durable goal engine are designs awaiting implementation. Private operational handoffs, tokens and personal test data do not belong in this public case study.

For setup and current capabilities, start with the [README](../README.md). For the planned execution lifecycle and banking boundaries, see [Execution design](personal-agent/EXECUTION_DESIGN.md).
