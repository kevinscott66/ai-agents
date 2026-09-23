# Virtual Office — implementation status

Updated 2026-09-23. Branch `codex/virtual-office-slice`, isolated checkout `.worktrees/virtual-office`. Base `bd12dab1`. This is the first C/D increment, not the complete office or real-agent integration.

## Delivered

- Separate `virtual-office/` package: React 19, R3F 9, Three.js, Vite; no existing backend/site dependency edits.
- Browser third-person movement, follow/orbit camera, collision against room/furniture and overview camera.
- Twelve distinct young adult role characters and workstations, including one mock Backend, licensed skinned Rocketbox body, five authored clips, bounded arm targeting, stand/walk/sit transitions, bounded A* around furniture, approach gaze and interaction.
- E/nearby monitor/status-label interaction; remote inspection through team card; readable DOM overlay with nullable telemetry, recent actions, direct mock chat and task creation.
- Engine-independent strict schemas for 16 states, runtime validation and client sequence reducer.
- Separate Bun gateway with atomic SQLite projection/event/idempotency commits, snapshot barrier, bounded replay, heartbeat, reconnect and socket backpressure. Local-only mock capability; no agent-system imports or calls.
- Stable data/animation separation: ambient walking cannot create backend events, status or progress. Disconnected data is marked stale and commands disabled.
- Lazy-loaded scene, 30 FPS cap, adaptive DPR, low-power WebGL hint, hidden-tab rendering pause and 2D mode that unmounts 3D entirely.

## Verified

From `virtual-office/`:

- `bun test tests`: 14 pass, 0 fail, 524 assertions. Includes SQLite restart, rollback, idempotency, schema restrictions, sequence gaps, replay expiry, real HTTP/WS handshake, one-use tickets, origin denial, bounds and navigation.
- `bun run typecheck` and `bun run build`: passed. Production output approximately 1.2 MB uncompressed, JS approximately 329 KB gzip total (plus on-demand local model/textures; see asset notes); scene is a separate lazy chunk. This is bundle size, not runtime memory.
- `bun run test:browser`: 7 scenarios in installed headless Chrome. Third-person approach/E → inspector → direct chat → mock task; mobile 390×844 no horizontal overflow; live socket cut + disabled commands + replay without reload; idle walk/window/return without productivity events. Screenshots examined at desktop 1440×1000 and mobile sizes, stored locally in ignored `.runtime/`.
- User-facing native browser automation was unavailable (CUA kernel failed twice). Browser QA used an isolated headless Chrome profile instead, not a personal session.

Found and fixed during validation: Bun-hosted Vite websocket proxy stalled upgrade (Vite now runs on Node); return route restarted before its completion branch (guarded empty path); disconnected animation no longer displays active typing; mobile connection status remains visible. The visual increment also fixed DataTexture atlas cropping during GLB conversion and economy DPR being reset by Canvas reconfiguration.

## Deliberate limits / next increment

The full architecture documents remain target contracts. This slice has one `world.agent`, no authenticated owners, no full WorldState entity maps, 512-event replay retention, mock-only data and commands. The gateway binds loopback and must not be published/tunnelled as-is. No domain or production host was changed.

The scene now has twelve role-specific young-adult looks and a player, plus the four legacy selectable presets. Provenance, budgets and limitations: [visual assets](VISUAL_ASSETS.md). This is an intermediate game-style result, not final photorealism. Foot IK, facial animation, separate wardrobe parts and target-hardware long-duration performance remain future work.

Next: review visual direction and measure a ten-minute full-roster run on target hardware. Owner-authenticated gateway/direct-role ingress and passive backend observation follow separately, with boundary review and an explicit deployment step. Existing iOS/OpenFlux and site/web changes remain untouched.

Local preview and run/verification commands: [prototype README](../../virtual-office/README.md).

## Safe entry after reported embedded-browser crash

The user reported a “This page crashed” tab while the local HTTP page and gateway both returned successfully. The crash was not reproduced in isolated Chrome; native browser automation also failed to initialize, so its cause is unconfirmed. Startup now defaults to 2D and does not import the lazy scene or request model/material assets. 3D requires an explicit quality selection. This is a recovery path, not a claimed fix for the browser process. A regression scenario checks asset-free entry and working inspection.

## Appearance presets

Sixteen selectable male/female looks differ in hair, clothing and footwear. The player and Backend have independent selectors under «Персонажи». Validated local preferences survive reload; safe startup still remains 2D. Models load on selection, and changing looks produces no gateway event or role change. Source alpha channels are preserved in PNG for hair/glasses; body/normal maps use JPEG. The converter retains all material slots. Full appearance and rendering verification is documented in [visual assets](VISUAL_ASSETS.md).

## Russian young-adult roster

Twelve fictional Russian team members are assigned unique appearances and permanent desks; roles match the existing twelve-role catalog including Lead. The additional eleven cards are explicitly unconnected. The player is a thirteenth visible person. See `web/src/roster.ts` and VISUAL_ASSETS.md for the visual and loading changes. Browser regression covers keyboard fingertip contact, stationary empty chair, role cards and unchanged event sequence during visual selection.
