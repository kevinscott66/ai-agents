# Office UI logic review — 2026-09-23

Scope: role selection, 2D/3D navigation, status projection, dialog addressing and connection feedback. This is a focused interaction review, not a full security audit or a claim that all backend tools were exercised.

## Confirmed and fixed

- The side card always displayed Backend and 01/12, regardless of selected role. It now follows the persistent active role, including name, roster index, availability and that role's state.
- The 2D workplace likewise always opened Backend. Its name, seat number and action now follow the same selection.
- Closing a live dialog discarded the visible team selection. Active role is now separate from the open dialog; closing and reopening preserves the selected employee.
- Lost live snapshots inherited the demo gateway's initial “Connecting” message. Real connection feedback now follows the live snapshot rather than demo state.
- The brand link left the production /office/ path. Ordinary clicks now return to the office overview without reloading the page or discarding its in-memory owner session; modified clicks retain the correct base URL.
- Production exposed a demo switch even though the mock gateway is local-only. The deployed build labels real mode without offering that unavailable switch; local development retains both modes.

## Confirmed boundaries

Backend NPC movement still uses its own projection; selecting another employee must not substitute that employee's state into Backend's animation. Clicking the nearby Backend interaction explicitly selects Backend. Other 3D labels select their own role. Closing a dialog does not send a command.

The live dialog captures the selected role when sending, binds its conversation on the server and preserves the same request ID for explicit uncertain-delivery retries. Browser tests check actual request bodies and reply attribution. The production owner-paired Backend smoke is recorded in the local handoff.

Statuses cover office/native turns, not the agents' entire Telegram activity. Ambient movement is visual only. Production approval execution and reconnect are not claimed from the first real reply test; automated tests provide the current coverage for those paths. Tokens intentionally remain in memory, so a full page reload requires pairing again.

## Regression coverage

The live browser scenario checks all twelve side cards and 2D seats, different per-role states, persistent selection after close, reopening the correct role, brand navigation retaining the paired session and truthful disconnection feedback. The existing suite covers movement/proximity, mobile layout, demo reconnect, safe startup, character variants, keyboard alignment and empty-chair behavior. Current command results and deployment state belong in CURRENT_STATE.md.
