# Implementation plan and checkpoint

Historical checkpoint: the user accepted A/B and the first C/D increment was implemented. See [implementation status](IMPLEMENTATION_STATUS.md) for checks/deviations and [live integration](LIVE_INTEGRATION.md) for later delivery. At this checkpoint, production and other sessions' changes were untouched.

## Increments and exit criteria

| Phase | Deliverable | Gate |
| --- | --- | --- |
| A Discovery | Existing system, roster, sources and gaps | Distinguish code, configuration and live evidence |
| B Architecture | Engine, protocol, states and plan | Clear engine decision, trust boundaries and scope |
| C Skeleton | Vite/React/R3F, player/camera, room, fixtures, loopback mock gateway | Production build, browser playtest/screenshots and reconnect smoke |
| D One-agent slice | Backend NPC/workstation, navigation/seat, inspect/chat | Mock event → gateway → snapshot/delta → NPC → interaction → chat; accurate reset/reconnect |
| E Scale / MVP | Config-driven real roster, workstations and basic zones | Twelve existing agents including Lead, reserved slot and MVP checklist |
| F Real integration | Owner projection, passive adapter, lifecycle hooks, direct-role ingress | Read-only shadow comparison, ACL/security tests, one real agent then scale |
| G Polish / Phase 2 | Realistic assets, IK, faces/eyes, objects, meetings, infrastructure/Git views | Licenses, animation QA and performance; infrastructure only with an API |
| Phase 3 | Voice/lip sync/spatial audio, mobile, notifications, rooms/customization/day-night, VR | Separate input/audio/security spikes and acceptance |

MVP E requires third-person movement/collision, twelve workstations, initial rigged characters, navigation and seat transitions, separate real/visual FSMs, mock gateway/WebSocket simulation, statuses, approach/E interaction, inspect overlay, direct mock chat and working/idle/waiting animation. Label simulation clearly. No live inference before F; demonstrate D before scaling.

## Proposed repository layout

```text
docs/virtual-office/
  EXISTING_SYSTEM.md
  ARCHITECTURE.md
  EVENT_MODEL.md
  AGENT_STATE_MODEL.md
  IMPLEMENTATION_PLAN.md

virtual-office/
  contracts/                 # Schemas/fixtures without engine/runtime imports
  gateway/                   # Bun, projection, journal, WSS and authentication
  adapters/mock/             # Deterministic scenarios; never live dispatch
  adapters/agent-team/       # Phase F scoped backend client
  tests/                     # Protocol, reducers, isolation and replay
  web/                       # React/R3F/Three.js, DOM overlay, glTF
  assets/manifest.json       # Source, license, skeleton and texture/LOD budgets

# Phase F proposed seams, exact paths subject to review:
agent/lib/office-observer.ts
agent/lib/office-api.ts
agent/lib/miniapp-server.ts
agent/orchestrator/message-handler.ts
agent/tests/office-*.test.ts
```

These are proposed filenames, not an existing API. Office dependencies, lockfile and scripts are separate; C–E do not change existing package.json. Do not commit build/cache output. Record asset licenses and budgets before adding heavy models/textures. Do not use `site/web` as the hosting root. Use `codex/virtual-office-*` from a verified base or isolated worktree, preserving another session's dirty checkout. Commit each finished increment with scoped staging; no automatic push.

## Phase C spike and performance

Verify WebGL2 and compatible pinned React/R3F/Three.js versions. Test rigged glTF loading, blending, navigation/collision and sit/stand, then production build/browser playtest. Plan a separate static deployment/CDN and TLS-protected WSS gateway; select hosting before publishing. Existing `site/web` remains untouched. No server GPU is needed because rendering is client-side; fully remote rendering requires reevaluating GPU streaming before C.

Initial **targets, not results**: 1080p, at least 30 FPS, p95 frame time at most 33.3 ms with the full roster, and no sustained hitches above 100 ms under normal event bursts. Measure one NPC at D and full roster at E over ten minutes of movement/inspect/reconnect. Record memory, CPU/GPU frame times, draw calls and startup. Tune mesh/texture/LOD budgets from measurements; start with 1–2K textures and off-focus animation LOD. Prioritize foreground character quality and avoid hardware assumptions unsupported on M1.

## Verification by increment

C/D: schemas, reducer causality, snapshot barrier, gaps/replay/epochs, heartbeat/reconnect, mock/live isolation and sit/walk/E/overlay/chat playtest.

E: roster completeness, identity uniqueness, seat contention, concurrent updates and performance. F: owner isolation, revocation, redaction canaries, duplicate commands, approval binding, observer failure/overflow without delaying actual turns, transaction rollback and multi-process reconciliation. Backend changes require `cd agent && bun test tests`, `bun run typecheck` and targeted checks. Authentication/dispatch changes require PR and independent boundary review.

Rollback disables office observer/routes, stops the gateway and preserves existing Telegram/iOS/Mini App operation. The office database is derived/rebuildable; do not migrate the backend database merely for visual state. Production activation is a separate step.

## Checkpoint decisions

- Web/R3F selected for website delivery; backend contract remains engine-independent.
- Twelve actual agents including Lead; a thirteenth seat is reserved. New identities require backend role/permission definitions first.
- Live runtime/models/infrastructure were not verified; precise state requires hooks.
- Direct-role chat was initially absent: mock in D, real ingress in F.
- Client GPU load remains; adaptive quality, 30 FPS cap, hidden-tab pause and 2D fallback are required.
- The one-agent glTF/animation spike is documented in [visual assets](VISUAL_ASSETS.md). At this historical checkpoint, visual direction, reusable controller/configuration, individual models and full-roster measurements were next; production authentication had not yet been implemented.
