# Native assistant review

2026-09-15, independent same-family security/reasoning subagent. Read-only review of auth, state, native/voice pipeline, Mac operations and iOS request recovery.

## Findings and resolution

1. P1: a new send after network failure replaced the unresolved request ID. Fixed by retaining pending ID, blocking a new send, and requiring explicit abandonment with a warning that server work is not cancelled. Cancellation now cannot apply a stale poll response.
2. P2: legacy specialist replies went to Telegram and detached cascades completed after native job completion. Fixed using per-turn `HandoffDeps.nativeReply` and awaiting native cascades including recursive delegation. Regression: `native-pipeline.test.ts`.

## Re-review

PASS for the bounded re-review. No new evidenced security vulnerability or functional blocker. Device-token hashing, expiry, revocation, per-device result isolation, fixed Mac operation surface, owner/private-chat gates and pre-auth gate were consistent with intended boundaries. Opt-in health alerts use allowlisted private Telegram delivery, failure debounce and persisted delivered-state suppression.

This is a code review; runtime test/build evidence is recorded separately. No second model family or production verification is claimed.
