# Validation — 2026-09-15

Base: main `4da99ec7`; branch `codex/agent-daily-assistant`; changes uncommitted for review.

- `agent/`: `bun run typecheck` — PASS.
- `agent/`: `bun test tests` — 6958 pass, 39 skip, 0 fail, 6997 tests / 803 files (149.02 seconds). Test preload isolates SQLite; local-port tests required unrestricted local execution. Initial sandbox failures were environmental. Two initial static failures (time constants/env example coverage) were fixed; final full suite is green.
- Targeted workflow, device-state/API, native handoff, alerts, voice gates and static checks — 53 pass, 0 fail.
- macOS Calendar helper — Swift compile PASS. Runtime `today` returned `calendar_access_required`, as expected without user TCC authorization; no calendar data read and no permission dialog triggered by the test.
- iPhone Release arm64 — xcodebuild PASS, `CODE_SIGNING_ALLOWED=NO`, `CODE_SIGNING_REQUIRED=NO`, empty signing identity. `codesign -dv` confirms no signature. IPA packaged directly from `Payload/Agent.app`.
- iOS simulator Debug — xcodebuild PASS; app installed and launched on iPhone simulator.
- Independent code review: `agent-native-review.md`, PASS after two findings corrected.

Production services were not deployed, keys were not rotated, actual taxi orders and bank transfers were not submitted. Live service accounts, signed-device microphone/TCC/APNs and production end-to-end remain outside this local build validation.
