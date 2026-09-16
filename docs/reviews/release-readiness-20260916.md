# Release readiness audit — 2026-09-16

User requested repeated security/logic/refactoring/UI audit, working flows and no placeholders. Baseline clean156f9b79 (iOS0.1.8); last deterministic baseline7265PASS39SKIP0FAIL plus Swift/build gates. Audit/fix limit three cycles. Production diagnostics read-only; do not execute approvals or external purchases/transfers.

## Specialist dispatch (required by shared HIGH quality gate)

- iOS specialist: inspect actual flows, input/account/lifecycle races, card/message behavior, voice and quick actions. Read-only baseline; propose bounded concrete fixes. Context ios/Agent+tests+DESIGN; soft one pass/max two follow-ups; stop with evidence or PASS.
- Native specialist: native ingress/history/approval lifecycle, data exposure and cross-device/restart consistency. Read-only baseline then primary-assigned fixes. Context native modules+commands+approval gate; same budgets.
- Mac/Mini App specialist: native panel routes vs UI capabilities, Mac history/status/output and transport/process security. Identify real dead paths rather than keyword placeholders. Context miniapp/PanelView/mac-daemon/bridge; same budgets.
- Primary: capability matrix, read-only runtime health/logs, verify findings, integration and release. Available reviewers are same-family Codex, not an external cross-family audit. Final applicable deterministic gates and independent diff reviews required.

## Confirmed fixes

1. Definitive turn rejection (including a two-device busy race) restores the draft and clears pending state. Unknown transport failures still poll without replay. HTTP errors are classified only from a bounded recognized JSON code/status pair.
2. Loading older messages preserves its visible anchor; tail changes drive auto-scroll. Dictation stops on conversation/account/sheet transitions.
3. Native and native-bearer Mini App mutations revalidate live credentials after streamed body reads. Revoking a device during upload cannot authorize a later mutation.
4. Approval execution uses a per-process marker. After restart, missing/old markers become explicitly interrupted/result-unknown, without replay. Same-process work stays pending, and audited success takes precedence.
5. Mac panel refresh uses actual completion events plus visible-page polling with coalescing/serialization. Removed the nonexistent output-stream subscription and misleading running-session copy; emitter coverage no longer allows that exception.
6. Native JSON ceiling now accommodates the documented8,000 UTF-16 input including escaped/multibyte characters while retaining byte/deadline limits.
7. Transfer preparation rejects partially parsed/invalid monetary strings and resets stale copy status. Taxi address errors are scoped to the requested input. Confirmation parameters use readable labels and omit internal metadata.
8. Native lead context explicitly directs confirmations to the current chat. Calendar failures expose only fixed diagnostic codes and actionable permission instructions; raw OS stderr remains private. Corrected Calendar application bundle ID in local configuration example.

## Runtime capability check

Authenticated read-only checks on all11 panel GET routes returned200/JSON;12 runtime roles present and Mac online. No owner action was replayed. This verifies service/data routes, not every possible LLM/external-service action.

The Calendar executable built successfully, but macOS did not grant Calendar access during the authorization request. This is an external permission prerequisite, not an empty-calendar success. Workspace app bundle IDs were verified against installed applications. Taxi/bank flows are explicit handoffs with final confirmation in those services; no booking/payment was performed for the audit.

## Reviews and gates

Independent same-family iOS/native/Mac reviews closed confirmed HIGH/MED code findings. Native revocation streamed-body regression5PASS; restart recovery5PASS; Mac refresh3PASS; targeted assistant/native-body/Mac suite20PASS; Swift fixturesPASS. Initial full run7272PASS39SKIP1FAIL correctly identified an obsolete SSE exception expectation; removed that exception and added a real-emitter assertion. Final full suite and builds follow.

Mac-calendar permission and physical microphone/device interaction are NOT VERIFIED. Synthetic UI previews/fixtures are confined to DEBUG/test builds and do not provide production data. No third-party service credentials or fabricated successful integrations were added.

Final gates: **7272 PASS,39 SKIP,0 FAIL**,21524 assertions across858 files. Backend/Mini App typechecks, web/native bundles, Swift fixtures, unsigned Release0.1.9(10) and Debug simulator builds PASS. Simulator checked actual bundled Mac form; removed duplicate heading and improved secondary-text contrast. Applicable independent code reviews PASS. No required HIGH/CRITICAL code finding remains; Calendar OS permission and physical-device microphone acceptance remain external prerequisites, not claimed PASS.
