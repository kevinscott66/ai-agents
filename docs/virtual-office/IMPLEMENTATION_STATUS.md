# Virtual Office — implementation status

Updated 2026-09-23. Branch `codex/virtual-office-slice`, isolated checkout `.worktrees/virtual-office`. Base `bd12dab1`. This is the first C/D increment, not the complete office or real-agent integration.

## Delivered

- Separate `virtual-office/` package: React 19, R3F 9, Three.js, Vite; no existing backend/site dependency edits.
- Browser third-person movement, follow/orbit camera, collision against room/furniture and overview camera.
- One Backend character and workstation, initial articulated body, typing/idle/wait poses, stand/walk/sit transitions, bounded A* around furniture, approach gaze and interaction.
- E/nearby monitor/status-label interaction; remote inspection through team card; readable DOM overlay with nullable telemetry, recent actions, direct mock chat and task creation.
- Engine-independent strict schemas for 16 states, runtime validation and client sequence reducer.
- Separate Bun gateway with atomic SQLite projection/event/idempotency commits, snapshot barrier, bounded replay, heartbeat, reconnect and socket backpressure. Local-only mock capability; no agent-system imports or calls.
- Stable data/animation separation: ambient walking cannot create backend events, status or progress. Disconnected data is marked stale and commands disabled.
- Lazy-loaded scene, 30 FPS cap, adaptive DPR, low-power WebGL hint, hidden-tab rendering pause and 2D mode that unmounts 3D entirely.

## Verified

From `virtual-office/`:

- `bun test tests`: 13 pass, 0 fail, 80 assertions. Includes SQLite restart, rollback, idempotency, schema restrictions, sequence gaps, replay expiry, real HTTP/WS handshake, one-use tickets, origin denial, bounds and navigation.
- `bun run typecheck` and `bun run build`: passed. Production output approximately 1.1 MB uncompressed, JS approximately 312 KB gzip total; scene is a separate lazy chunk. This is bundle size, not runtime memory.
- `bun run test:browser`: 4 pass in installed headless Chrome. Third-person approach/E → inspector → direct chat → mock task; mobile 390×844 no horizontal overflow; live socket cut + disabled commands + replay without reload; idle walk/window/return without productivity events. Screenshots examined at desktop 1440×1000 and mobile sizes, stored locally in ignored `.runtime/`.
- User-facing native browser automation was unavailable (CUA kernel failed twice). Browser QA used an isolated headless Chrome profile instead, not a personal session.

Found and fixed during validation: Bun-hosted Vite websocket proxy stalled upgrade (Vite now runs on Node); return route restarted before its completion branch (guarded empty path); disconnected animation no longer displays active typing; mobile connection status remains visible.

## Deliberate limits / next increment

The full architecture documents remain target contracts. This slice has one `world.agent`, no authenticated owners, no full WorldState entity maps, 512-event replay retention, mock-only data and commands. The gateway binds loopback and must not be published/tunnelled as-is. No domain or production host was changed.

Initial geometry is visibly a prototype. It is not the requested final realistic/semi-photorealistic style. It uses original procedural articulated characters rather than downloaded glTF or mocap; asset provenance is in `virtual-office/assets/manifest.json`. Authored skeletal blending, foot/hand IK, real character assets, facial animation, quality target and the 13-character performance budget have NOT been validated. No ten-minute production performance claim is made.

Next: extract the tested presentation controller into reusable per-agent configuration, select a licensed realistic glTF/animation set and measure it on the target browser; then E roster scaling to the 12 actual identities (including Lead). Keep the 13th workstation reserved. F owner-authenticated gateway/direct-role ingress and passive backend observer come afterwards, with independent boundary review and explicit deployment step. Existing iOS/OpenFlux and site/web changes remain untouched.

Local preview and run/verification commands: [prototype README](../../virtual-office/README.md).
