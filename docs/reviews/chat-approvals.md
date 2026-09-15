# Inline chat approvals

Native chat polls pending approvals scoped to the authenticated owner DM (identity supplied by native/status), presents full expandable parameters and explicit approve/reject buttons, and uses existing panel decision endpoint/admin gate/atomic pending→decision transition. No LLM inference of consent. Outcome frozen before POST; unknown transport never retries. Successful result requires matching approval ID/chat/status/executed. The UI cannot prove an external effect beyond the server response.

HIGH gate dispatch: independent iOS/security reasoning review mandated by shared QUALITY_GATES. Existing same-family Codex reviewer. Bounded changed files and this doc, approx3k context soft4k/max6k tokens, read-only no network/secrets. Output concrete findings or PASS, stop after scope. Gates: build and scoped backend + Swift fixture checks before release.

## Results

Backend targeted tests PASS (3 tests,24 assertions), backend typecheck PASS, all Swift fixtures PASS including owner scope, duplicate decision, uncertain transport outcome, account switch. Device build PASS. Independent iOS/security review PASS after credential snapshot fix: cards, owner lookup and decision requests are bound to the same Keychain credential; account changes invalidate prior cards. No live approval was executed for validation.
