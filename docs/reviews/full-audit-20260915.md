# Full application audit — 2026-09-15

Baseline: 939b480e, clean codex/native-release worktree. User explicitly requested full audit and fixes.

## Review dispatch

HIGH scope includes native authentication, approval execution, Mac process isolation and synchronized conversations. Shared QUALITY_GATES requires specialist and independent reasoning reviews. Existing deterministic baseline: 7252 passing backend tests, 39 skips, Swift fixtures and unsigned Release build (previous release); new findings require targeted regressions and final applicable gates.

- iOS reviewer: complete native client lifecycle, credentials, polling, history and approval UX. Read-only, evidence with file/line and failure scenario, no production operations. Budget one baseline pass and at most two targeted follow-ups.
- Native reviewer: native API/store and approval HTTP execution/authentication, ownership, persistence and races. Same evidence and stop rules.
- Mac reviewer: payload normalization, dispatch, bridge, daemon, CLI sandbox/authorization/output secrets. Same evidence and stop rules.
- Primary: validate findings, cross-boundary regressions, integration fixes and release gates. No approval replay or live DB writes. Maximum three audit/fix cycles; stop at required gates PASS and no required HIGH/CRITICAL unresolved.

These are same-family independent reviews, not cross-family verification.

## Findings and fixes (cycle 1)

- HIGH: plain `auth_ok` could authorize a forged Mac bridge. Fixed mutual nonce/HMAC proofs plus authenticated, sequenced frames in both directions. New daemon never transmits secret or downgrades; production rollout disables legacy server authentication.
- HIGH: cancellation only killed CLI parent. Fixed isolated process groups and group SIGINT/SIGKILL. A real child/grandchild regression verifies the descendant stops.
- MED: late POST timeout overwrote terminal approval result. Terminal client states now dominate stale transport outcomes.
- MED: relaunch lost approved/running tracking and outputs. Approval associations are durable in main approval transaction; owner/admin-scoped retrieval repairs derived native archive without replay. Outputs are separate stable conversation messages.
- MED: catalog stopped at 200 dialogs and deselected older ones. Added stable seek pagination and retained client pages/selection.
- MED: optional-dialog legacy turns could be pruned before archival. Archive immediately on creation.
- MED: UTF-16 input/title mismatch could strand rejected turns. Validate before pending state and bound titles without splitting Unicode scalars.

User acceptance: execution text is outside/below its card, with normal assistant message controls. The simulator DEBUG fixture visually verified this placement; real execution was not replayed for testing.

## Independent reviews

- iOS: lifecycle, input limits, history and RootView placement PASS after fixes.
- Native: durable transaction association, owner/admin ACL, archive repair, idempotency and restored continuation context PASS. Integration regression uses actual native ingress and approval gate, injected archive failure, and both completion recovery paths without dispatch replay.
- Mac: mutual authentication/frame integrity and process-group cancellation independently reviewed PASS (reviewers cross-checked each other's changes).

## Gates

First full backend run: 7263 PASS,39 SKIP,1 FAIL (new environment switch missing from `.env.example`). Added documented switch; final full run follows. Backend typecheck PASS. Targeted native regression:9 PASS/88 assertions. Swift API/model/approval/transport fixtures PASS. Mini App typecheck/build PASS. iOS unsigned Release and Debug simulator builds PASS.

Known limits: this audit covers the agent backend, native client, bundled Mini App and Mac executor; it does not certify third-party services or the OS. Legacy pre-association approvals cannot be assigned to an original native dialog automatically. Process groups do not constrain intentionally detached external services; CLI sandbox and existing authorization remain separate controls. No live owner action was approved/replayed by audit tests.

Final full backend gate: **7265 PASS,39 SKIP,0 FAIL**,21491 assertions across855 files (131.60s). Final Swift fixtures PASS. No unresolved required HIGH/CRITICAL findings in audited scope. Unsigned iOS0.1.8(9) verified: bundled panel, no signature/provisioning, DEBUG fixtures absent. SHA256 `962c7ce52a3ab01af0e1e5b2c8df71f6c03ab5efe16546a381d00a1d013050a2`.
