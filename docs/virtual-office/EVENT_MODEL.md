# Agent event protocol v1 — proposed contract

Status: specification, not an existing endpoint. Available source signals are documented in [EXISTING_SYSTEM](EXISTING_SYSTEM.md).

## Envelope

```json
{
  "schemaVersion": 1,
  "streamId": "office-owner-scope-epoch",
  "seq": 42,
  "eventId": "018-example-uuid",
  "sourceEventId": "adapter-session:123",
  "type": "agent.state.changed",
  "timestamp": "2026-09-23T12:00:00.000Z",
  "observedAt": "2026-09-23T12:00:00.010Z",
  "source": "mock",
  "agentId": "backend",
  "runId": "run-example",
  "taskId": "task-example",
  "payload": {
    "state": "CODING",
    "project": "AirChat",
    "task": "Implement reconnect logic",
    "resource": "src/socket/client.ts",
    "progress": null,
    "summary": "Updating reconnect handling"
  }
}
```

This is a **mock fixture**, not a discovered task. `source` is mock or backend. agentId/taskId/runId may be null for other entity types; sourceEventId may be null for reconciliation. `seq` increases within streamId and is an integer no larger than JavaScript MAX_SAFE_INTEGER. The epoch changes after journal loss, incompatible reset or scope change. UUID eventId is unique; sourceEventId deduplicates before sequence assignment. `timestamp` is source time and `observedAt` is gateway time; ordering follows seq, not clocks.

Progress is null or an evidenced finite number in [0,1], never inferred from time or token count. Resource, branch, repository and test counts require telemetry evidence; ordinary model text does not prove a file changed.

## Event types and payloads

| Type | Payload / meaning |
| --- | --- |
| agent.state.changed | Complete AgentState revision and run correlation |
| agent.availability.changed | Availability, paused/disabled and freshness |
| task.upserted / task.removed | Safe Task, or ID and tombstone |
| action.observed | Action ID, safe tool name, known started/finished phase and outcome |
| communication.observed | Sender/recipient IDs, safe summary, correlation, importance; AGENT_COMMUNICATION visualization |
| meeting.upserted / meeting.removed | Intent ID, participants, topics and status; delegation alone does not imply a meeting |
| project.upserted / project.removed | ID, name and safe repository references |
| infrastructure.upserted / infrastructure.removed | Provider ID, capability and permitted metrics |
| source.health.changed | Connected/degraded/disconnected and freshness |

Snapshots contain the same entities. An upsert replaces the whole entity and clears omitted fields; avoid ambiguous merges. Unknown optional events may advance the cursor without application. Unknown mandatory changes/major versions require protocol_error and resync, not a partially applied world.

## Transport and reconnect

Proposed endpoints: GET `/office/v1/capabilities`, POST `/office/v1/stream-ticket`, WSS `/office/v1/stream`, POST `/office/v1/commands`, GET `/office/v1/commands/:id`. These are proposed office endpoints, not existing agent APIs.

1. After authentication, the client sends hello(version, streamId?, lastAppliedSeq?). The gateway fixes the authorized scope.
2. The writer establishes barrier N, captures a consistent snapshot N and buffers events above N until delivery. The client atomically replaces projection, then applies N+1 onward. No REST-snapshot/subscription gap.
3. Matching epoch/scope and a contiguous retained suffix permit resume.accepted plus replay from lastAppliedSeq+1. Otherwise send a new snapshot.
4. Ignore duplicate seq at/below cursor; gaps require resync before applying out-of-order events. Persist cursor with projection or request a snapshot after restart.
5. Initial heartbeat every 15 seconds, timeout 45 seconds; exponential retry 0.5–30 seconds with jitter. 401/revocation stops reconnect until reauthorization.
6. Initial bounds: 64 KiB frame, 2 MiB snapshot, 1 MiB outbound queue per client. Overflow disconnects slow clients with resync-required. Larger snapshots need pagination/chunking before scaling.
7. Retain at most 24 hours **and** 10,000 events per scope; otherwise use a snapshot. Restart restores projection/seq transactionally. Database loss creates a new epoch. Sensitive-summary TTLs and deletions apply to replay too.

Delivery is at-least-once with deduplication, not exactly-once. MVP polling/reconciliation every 5–15 seconds compensates for existing bus losses; this observes work rather than launching autonomous tasks.

## Commands

`{commandId, kind, agentId, conversationId?, expectedRevision?, payload}`. Derive actor/owner only from the session. Initial kinds are chat.send/task.create; task assignment requires backend capability checks. Accepted/queued is not completed. Correlate results by commandId and backend run/task IDs.

Scope idempotency to owner + commandId; changed payload hashes conflict. After timeout, inspect the existing result rather than blindly repeating costly/risky work. Mock/live sessions and journals are separate; mock commands cannot reach the real adapter.

## Required checks before live operation

Atomic snapshot races; duplicate/out-of-order/gap; retention expiry; restart epochs; clock skew; slow clients; revocation and cross-owner replay; malformed/oversized input; task rollback invalidation; duplicate commands/uncertain outcomes; secret and hidden-reasoning exclusion. Office load must not delay LLM/tool turns.
