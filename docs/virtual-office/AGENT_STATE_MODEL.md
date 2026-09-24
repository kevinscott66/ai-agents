# AgentState and visual behavior

Status: proposed engine-independent contract.

## Authoritative state

AgentState = `{agentId, role, availability, lifecycle, activity, activeRuns, primaryRunId, taskId, projectId, progress, currentFile, repository, branch, tests, blockers, recentActionIds, updatedAt, evidence, freshness, capabilities}`.

Availability: online/offline/unknown. Lifecycle: enabled/paused/disabled. Freshness: fresh/stale/unknown. Activity is nullable: lack of observation does not imply IDLE. Each activeRun has its own state/task/updatedAt, so concurrent jobs of one role cannot overwrite each other. The UI shows the run count and deterministically selects a primary run: user-selected first, otherwise the latest confirmed active run. Never mix one run's task with another run's tool.

| Activity | Required evidence |
| --- | --- |
| OFFLINE | Confirmed executor unavailability; socket loss means stale, not OFFLINE |
| IDLE | Backend confirms no active runs and an available executor |
| THINKING | Generation started without an active tool; lifecycle only, no hidden reasoning |
| READING | A read tool actually started |
| RESEARCHING | A search/research tool started |
| CODING | An observed editing operation started |
| TERMINAL | An authorized shell process started |
| TESTING | An explicitly classified test run started |
| REVIEWING | A backend review job started |
| WAITING | Queue, approval or explicit blocker; reason required |
| WAITING_TOOL | Waiting for a tool result without a more precise activity |
| COMMUNICATING | Actual send/handoff with correlation |
| MEETING | Active backend meeting intent, not NPC proximity |
| ERROR | Confirmed run failure with a safe reason |
| DONE | Confirmed completion of a specific run |

The protocol supports these values, but **current telemetry does not provide all of them**. A running task establishes an active run with activity=null; `action.executed` establishes a recent action, not sustained CODING. Telegram bot health is channel health, not executor readiness. Paused/disabled are separate fields. Progress stays null until supplied by a reliable producer.

## Transitions

Typical run: queued/WAITING → generation/THINKING → tool activity → generation → DONE/ERROR. Explicit signals can move any active phase to WAITING/WAITING_TOOL. Tool completion restores the actual parent phase, not unconditional IDLE. DONE/ERROR terminate a run; a new run has a new ID. An authoritative snapshot may legitimately skip missed intermediate phases.

The reducer checks schema, identity, revision and run correlation. Late events for a finished run cannot change a newer run. Unknown extension activities render neutrally. Staleness does not finish a task: retain the last observation with its age and stop claiming current activity.

## PresentationState: client only

`{location, locomotion, posture, interaction, visualActivity, gazeTarget, seatReservation, ambientSeed, nextAmbientAt}` is never submitted as AgentState.

Locomotion: idle → start → walk → decelerate → stop → turn-in-place → idle. A kinematic controller sets acceleration/deceleration; the animation mixer blends speed/turning. Navigation follows a path rather than teleporting. Seat FSM: reserve → approach → align → sit → seated → stand → release. Failed paths or occupied seats fall back to standing idle and retry with backoff, without affecting backend tasks.

CODING can visualize typing, reading a monitor, mouse use and pauses. IDLE can visualize stretching, coffee, phone, window or kitchen activity. WAITING uses a quiet pose with accurate status. Seeded delays/clips avoid synchronized idle loops. Long ambient routes must not distract an actively working avatar.

MVP: walking, sitting, standing and working/idle/waiting blends. Phase 2: foot IK, hand anchors, head/eye tracking, refined turns, object grasp/release, chair/body turning and mocap variation. IK adjusts contact; it does not replace missing sit/stand clips. Every asset needs a compatible skeleton/retarget profile and license.

## Awareness, conversation and meetings

Player proximity triggers bounded gaze with smooth blending. E/Talk interrupts eligible visual activity: stop typing → hands off keyboard → body/head turn → conversation pose. UI input must not resubmit messages. On inspector close, choose behavior from **current** AgentState, not the state saved before conversation.

Communication appears immediately regardless of NPC travel speed. Walking to a colleague is optional visualization. Meeting intent: finish interruptible ambient activity → stand → reserve meeting seat → navigate → sit. A late NPC cannot block the real meeting. Return to the workstation afterward. Ambient conversation is explicitly visual and cannot create backend communication events.

## Invariants and acceptance

Movement, coffee and gaze neither invoke an LLM nor change task status. Animation time cannot advance progress. Stale feeds are visible. Role-directed chat cannot silently substitute Lead. Thirteen seats do not imply thirteen identities. Reducer tests use fake clocks and concurrent runs; motion acceptance covers obstacles, repeated E, occupied seats and disconnection.

## Task-driven character animation

Every seated role maps authoritative activity to a visual pose. THINKING, CODING,
TERMINAL, TESTING and REVIEWING animate typing at that role's own keyboard.
WAITING and approval/tool waiting stop typing and use a subtle waiting pose. DONE
plays a brief nod only when explicitly reported; ERROR stops typing. Missing or
lost live status returns to idle. Animation never changes execution state or
infers completion. Cross-chat visibility depends on the owner-scoped execution
tracker described in LIVE_INTEGRATION.md being deployed.

## Leader briefing

The owner-scoped live snapshot optionally includes `briefingTo`, containing only
role IDs from active direct orchestrator delegations. A briefing lasts at most
30 seconds from execution start and ends immediately when that execution exits.
Independent chat work and nested delegation do not create a leader briefing.
Clients without this optional field keep existing behavior.

The leader and recipients stand and navigate around desk obstacles to distinct
meeting positions, then return to their own seats. The original execution state
is unchanged. Facial bone animation provides blinking, subtle eyebrow movement,
and procedural jaw movement for the standing leader. This represents delegation;
it is not audio-driven lip synchronization or evidence of an actual spoken call.
