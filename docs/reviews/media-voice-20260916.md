# Voice and native media delivery

IN PROGRESS. User requests richer assistant voice and files/photos/video/location in native chat. HIGH risk: binary ingress, ownership, quota, trusted prompt vs file data. Shared QUALITY_GATES requires specialist and independent review.

Dispatch: native media specialist owns backend upload/storage/lead adapter + tests; iOS speech specialist owns VoiceOutput.swift only + focused tests. Parent owns picker/preparation/UI/API/client integration and final security review. Available models: Codex family, no external model claim. Context: scoped native files and protocol below, not full chat. Budgets: one implementation pass + <=3 review/fix cycles, no unrelated audit. Stop: bounded uploads, owner isolation, idempotent turns, builds/tests, real authenticated read-only/isolated upload verification; physical device permission acceptance recorded separately.

Preserve staged OpenFlux work from prior turn. No public push of OpenFlux without separate pending consent. No raw media, tokens or location in logs/public artifacts. No real payment/approval actions during tests.

## Reviews and targeted verification

native_media implemented backend; flux_security independently PASS (5 media security tests/34assertions at review time). Follow-up preserved immutable file metadata after binary expiry and avoided BLOB reads for history. Backend focused12tests/54assertions PASS; typecheck PASS. Full suite first run had one time-constants convention failure, corrected to DAY_MS; final rerun pending.

native_review implemented speech and reviewed parent client integration. Fixed speech batching/queue, cancellation of detached media preparations, and microphone activation failure ownership. Final bounded review PASS. Swift fixtures pass, including media-only send, upload-failure restoration, location and entire reply speech batch. Real simulator MediaSelfTest PASS: JPEG photo, PDF text+2page previews, text file, MP4+3frames. Release and simulator builds passed. Physical permissions/actual audible voice NOT RUN.

Final full backend gate:7278PASS/39SKIP/0FAIL,21566assertions,859files,144.01s (/private/tmp/agent-media-full-tests-clean.log). Final Release0.1.11(12) succeeded; debug probes absent. Only backend committed/pushed as e9b9838c to existing PR#3; OpenFlux staged work/iOS and private reports intentionally not published pending prior consent. SQLite read-only backups /var/backups/agent-media-20260916;0runningnativejobs beforedeploy. Nginx alreadyallows25MiB, no configuration/VPN/Mac change required. Deploy/health final status recorded in root handoff.
