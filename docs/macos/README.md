# Agent for macOS

Native SwiftUI companion, version 0.2.0 (3), Apple Silicon/macOS 14+. Build with `AGENT_SERVER_URL=https://your-server.example sh macos/build.sh`. Alternatively keep the URL in ignored `macos/build/server-url.txt`. Output `macos/build/Агент.app` is ad-hoc signed, not notarized for distribution. A blank build configuration can be completed in Connection.

## Workspace

Overview contains real connection/voice status, runnable starter actions and recent local results. Chat connects to the existing Lead API, supports selectable text, pending-turn recovery and speech output. Sidebar includes Commands, Packs, History, Settings, Office and Connection. The floating animated companion, menu bar and Command-Shift-Space shortcut provide quick access. Theme, accent, animations and companion opacity are configurable. Hotkey registration failure is visible in Settings.

Office runs in a separate persistent WebKit window using the configured server origin. Its website store survives restarts; it is independent of the native Keychain credential. Closing the office window releases web content. Pair through the existing `/pair_native` workflow; native tokens stay in Keychain and server-scoped. Browser persistence depends on the hosted office session implementation.

## Commands and voice

The editor supports application launch, HTTPS/HTTP website opening, volume, bounded delays, system speech, shortcuts and clicks. Steps can be reordered, validated without execution, saved, imported/exported as JSON, executed and cancelled. Starter packs cover everyday tasks, Focus, Apple Music and Spotify. Run history records actual progress and completion/cancellation/failure, retaining 300 entries.

Recording is explicit, limited to 60 seconds and 20 steps. It captures clicks and Command/Option shortcuts with application identifiers, not ordinary typed text. Input Monitoring is required for recording; Accessibility is required for playback of clicks/keys. Playback activates the declared application and verifies the owner beneath the click with Accessibility hit testing; moved/overlaid targets fail closed. Coordinates remain layout-dependent. No arbitrary shell or AppleScript input is accepted; volume uses an integer-only script.

On-device Russian speech recognition supports explicit dictation and an explicitly armed wake phrase. It does not silently fall back to cloud recognition. Exact saved activation phrases run locally only when that command's voice-execution toggle is enabled. Other recognized requests become chat drafts. Wake listening is not armed automatically after launch. Output can use system voices, the server speech endpoint, or Fish Audio with a separately supplied Keychain key and reference ID. Third-party speech requests transmit the text being read.

Lead can propose a JSON scenario for editing. This uses a normal Lead turn with a no-execution instruction, not a server-enforced tool-free mode. Returned proposals require local review/save/run; imported proposals do not enable voice execution automatically. Phone/Telegram requests still use the existing Lead/Mac-daemon path; direct remote invocation of this local macro library is not implemented.

## Persistence and validation

Application Support/DobropalmAgent stores desktop state and local run history with private permissions. Corrupt history blocks overwrites. Native requests persist IDs before submission and resume through GET without blind resubmission. Never publish runtime state, Keychain data, WebKit profiles or build configuration.

Run `sh macos/tests/run.sh`. Tests cover URL/macro validation, JSON proposals, cancellation before an external action and private history restoration. Optimized build, signature and an authenticated read-only native API check passed. SwiftUI ImageRenderer output was visually inspected. CUA initialization failed, so physical microphone/recording/click playback and interactive office login were not accepted through UI automation. Higgsfield generation returned a transport error; no generated Higgsfield design is claimed. The native interface uses restrained typography, hierarchy and state feedback.
