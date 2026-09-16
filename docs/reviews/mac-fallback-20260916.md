# Mac provider fallback
Risk HIGH: provider execution and retry boundary. User requests alternate executor when initial agent cannot run. Existing screenshot approval690d8a31-1c63-4713-9080-f70430bd2da4 already successful(code0,42stdoutbytes); no replay.
Dispatch: daemon specialist owns mac-daemon execution/preflight result metadata and tests (~8k context,soft/max15k/25k), must guarantee alternate only before execution, no permissions escalation. Root owns bridge/dispatch/schema/native UI integration and runtime diagnosis. Independent specialist review after gates, same-family Codex (~8k context,soft/max10k/18k). No invented external model. Max3cycles. Preserve staged OpenFlux/private iOS, no broad commit.

### Native/UI specialist

Implemented the checkbox default-on for initial Claude; initial Codex disables it and sends false, preserving the chosen provider. The trusted main-frame bridge validates payload fields and the boolean, preserves absent-flag legacy opt-out, and emits an editable draft with explicit provider/allowFallback and pre-start-only language. Approval details describe the initial executor and fallback boundary while continuing to omit private metadata. Existing staged OpenFlux code was preserved.

Verification: miniapp typecheck/build PASS; production payload expression test PASS (both providers × both toggle values, 8 assertions); Swift fixtures exercise JSON bridge decoding, legacy/no-flag, invalid boolean rejection, explicit draft policy, and approval details/privacy. Simulator compilation result recorded separately below. No real task, approval or paid provider call executed.

Native/UI final gate: complete `python3 ios/tests/run.py` PASS after final code edits (log `/private/tmp/mac-fallback-ui-swift.log`); scoped diff whitespace check PASS. Sandbox simulator attempt failed solely because CoreSimulator runtimes were inaccessible; authorized unsandboxed arm64 build was started, still running at handoff (log `/private/tmp/mac-fallback-ui-build.log`). No visual or successful Xcode-build claim until that process completes.

### Follow-up native UI requests

Accepted approval cards now hide on validated POST success or server polling approval/completion. Tracking remains in memory; assistant result messages, polling, and failed/interrupted/unknown recovery stay intact. The chat toolbar has an OpenFlux on/off shortcut using the existing Keychain config and runtime reset; invalid enable settings open the setup sheet, and no HTTP mutation is retried.

Verification: full `python3 ios/tests/run.py` PASS (`/private/tmp/agent-ui-quick-flux-approvals-tests.log`), including pending visibility, acknowledgement hiding, relaunch, running approval, failure/interruption restoration, timeout→approved reconciliation without replay, and pure OpenFlux toggle validation/preservation. Scoped diff check PASS. Parent owns final Xcode build/package verification; no new version or IPA created by UI specialist.

### Independent final review — PASS

Reviewed final daemon preflight/configuration gate, provider spawn boundary, bridge/dispatch/audit metadata, native approval scope/visibility, and OpenFlux shortcut. No CRITICAL or HIGH findings remain in this scope. Legacy approved payloads remain opt-out; new approval payloads include the fallback choice. Cancellation spans both bounded probes and cleanup; fallback never repeats an already-started user task, never switches Codex to Claude, and never changes bypass permissions. Failed alternate execution now preserves its actual provider in audit/history.

Independent verification: 42 tests passed across mac-provider-fallback, mac-auth-preflight, mac-readiness-preflight, mac-probe-config, mac-fallback-integration, and miniapp-mac-fallback-wire (140 assertions), using a temporary database. Installed project configuration compatibility was independently checked and returned true without displaying configuration or credential values. Only the three explicitly allowed inference flags enter the isolated readiness environment; unknown/custom backend, model, or credential settings disable that probe conservatively. Installed SDK declarations confirm the typed assistant/api_retry error schema used for classification.

Limits: readiness makes a small fixed inference on a healthy account; real quota exhaustion was not independently exercised. Deployment, full-suite, and final app packaging remain the parent executor's verification gates. Reviewer did not execute any user task or transfer credentials.

## Delivery
Full suite7332pass/39skip/0fail (867files), typecheck and Swift fixtures PASS; Release0.1.13(14) PASS. Backend5f301eb9 published in PR3 and deployed, Mac immutable release5f301eb9 restarted and authenticated. Runtime11routes200/Maconline. Renamed probe-config→readiness-config to avoid deploy temporary-probe exclusion;4configuration regressions rerunPASS. PrivateiCloud IPA/source/README uploadedtrue; physicaldevice not tested. Higgsfield consent received and activation preflight succeeded; see ../higgsfield-mcp.md.
