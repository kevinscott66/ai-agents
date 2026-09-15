# Native release — 2026-09-15

User authorized deployment of the reviewed server version to activate iPhone pairing. Release is based on current github/main f4b4ef65, not the obsolete checkout branch. Applied reviewed patch via three-way merge; only conflict was message-handler trigger dedup. Kept main's per-role key and added the trusted-transcript already-ingested guard. All other main security fixes retained.

Independent HIGH gate dispatch: one bounded integration reviewer, existing same-family Codex, no secrets/network/write; inspect merged message-handler/voice-handler and native routing against main + prior reviewed source. ~3k context, soft4k/max6k tokens, stop after concrete findings or PASS. Targeted 25 tests PASS, typecheck PASS. Full suite PASS: 7243 passed, 39 skipped, 0 failed; 21321 assertions across 846 files. Miniapp typecheck/build PASS. Independent integration review PASS: preserved role-scoped dedup, speaker-label sanitization, provider accounting and per-turn native reply routing. No dependency versions changed by this feature.

Production activation: use existing Claude inference. Native HTTP enabled only for existing Mac owner; add only that verified owner's DM to chat allowlist. Snapshot code and read-only database backup before application migration/restart. No new owner grants, no service secret changes, no automatic Codex install.
