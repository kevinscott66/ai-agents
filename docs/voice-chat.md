# Native voice conversation

The iPhone voice conversation is a **half-duplex pipeline**: record an utterance → server transcription → the existing role-bound chat turn → server speech → playback. It is not a full-duplex Realtime connection. The microphone is closed during transcription, agent execution and reply playback. Explicit interruption skips spoken replies; it does not cancel the underlying agent task or external actions.

## Responsibilities

- `ios/Agent/VoiceSession.swift`: explicit conversation phases, bounded/deduplicated reply buffer, speech invalidation revision, utterance and UTF-16 chunk boundaries. Foundation-only and directly testable.
- `ios/Agent/ConversationVoice.swift`: session orchestration and separate capture/playback operations. The SwiftUI view renders one phase instead of independent speaking/failure/status flags.
- `ios/Agent/VoiceOutput.swift`: optional reading of chat replies and device fallback, separate from continuous conversation. Both paths share text chunk limits and voice/rate preferences.
- `ios/Agent/Voice.swift`: hybrid manual dictation and draft refinement; separate from automatically submitted voice conversations.
- `ios/Agent/API.swift`, `agent/lib/native-voice.ts`: existing paired-owner HTTP voice transport. This refactor does not change provider models, API contracts, authorization or server limits.

## Lifecycle rules

A session generation rejects results after stop/restart. Every asynchronous boundary checks the current owner credential and conversation before a transcription can be submitted or speech can play. A new conversation allocated synchronously by the same send remains within the voice session.

A separate speech revision invalidates audio already being prepared. Interruption cancels the speech request, stops playback and clears queued chunks; it keeps the conversation alive. The interrupt control is available during preparation as well as playback. An old request cannot revive playback or clean up a restarted session's resources.

Recording uses monotonic uptime for its 60-second bound. Silent capture yields promptly when a reply or remote work arrives. Speech already detected is not discarded merely because a reply arrives. If another request becomes active during transcription, recognized text is retained as a chat draft without sending a duplicate turn. An edited draft or changed conversation is never overwritten.

Each capture owns its temporary file and removes it on success, failure or cancellation. Audio-session deactivation verifies category/mode to avoid deactivating a different feature that has taken over. System interruption ends the conversation only for the interruption-began event.

Reply queues are limited to 24 chunks / 48,000 UTF-16 units, with a bounded 256-ID deduplication window. Overflow is reported in the UI; replies remain available in chat. Each neural speech chunk stays within 3,000 UTF-16 units. A pathological single grapheme exceeding the limit is omitted rather than submitted over the server limit.

Ordinary reply playback can pause during audio preparation or between chunks. A prepared response or device fallback waits for resume; stop wins over a delayed provider failure.

## Verification

`python3 ios/tests/run.py` compiles production policy/controller/playback code with deterministic platform/network fakes. Regression cases cover interruption during an uncooperative delayed request, stop/restart isolation, silent-microphone yield, conversation changes before dispatch, concurrent-work draft retention, queue limits/deduplication, cleanup and pause/fallback races.

The complete Swift app is also typechecked against the real iOS SDK. These checks do not establish microphone quality, Bluetooth routing, real provider latency or physical-device acceptance. A new signed iPhone build and owner-device playtest are required before claiming release acceptance. No backend deployment is required for this client-only refactor.
