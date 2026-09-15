# Native dialogs and Mac launch review

Scope: owner-scoped server archive, iOS synchronization/recovery, trusted local panel request to existing lead pipeline, responsive status cards.
Risk HIGH: identity, persistent schema and Mac commands. Shared quality gates require independent specialists.
Dispatch: backend authentication/archive and iOS state/bridge; available Codex reviewers with local source/test tools, no credentials or live operations. Context limited to diff and relevant fixtures. Soft 6k / max 10k tokens each, stop with concrete reproducer/findings or PASS. Same-family independent reasoning, not cross-family. Implementation owner fixes findings, maximum three rounds.

## Findings and resolution

Independent iOS review found stale cross-server replies, stale remote busy in a fresh dialog, and false Mac acceptance without credentials. Fixed with operation/token binding, index-level running state, and explicit send acceptance. Second review PASS. Swift extracted-production fixtures cover server switching, pending recovery, history pagination/refresh, new dialog and remote busy.

Independent backend review found delegate context still using shared recent messages and archived retry UNIQUE failures. Fixed context propagation and persistent replay tombstones. Second review found predictable legacy migration IDs could collide across owners; fixed with owner-scoped lookup, random IDs and reserved creation namespace. Third review PASS; collision regression verifies no messages enter attacker-owned archive. Same-family independent reviews only.

Validation: server and miniapp typechecks; Telegram/native builds; unsigned iOS Release and simulator Debug builds; scoped backend and Swift fixtures. Full-suite result recorded after completion. Screenshots use DEBUG-only fabricated dashboard data, no production credentials/actions. Physical device Mac execution and two-device user acceptance were not performed.

Final full suite: 7247 PASS / 39 SKIP / 0 FAIL, 21351 assertions, 848 files. Initial sandbox run could not bind local HTTP ports and was stopped; rerun with local server capability passed. Final scoped archive/API regression: 5 PASS, 37 assertions. Operational backup and release artifact locations are kept in private state.
