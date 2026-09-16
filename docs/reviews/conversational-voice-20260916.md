# Conversational voice implementation dispatch

Risk HIGH: authenticated paid audio endpoints, browser origin boundary, microphone lifecycle.
Required by shared QUALITY_GATES: backend security specialist and independent review.
Backend specialist: bounded voice proxy + same-origin browser adapter, tests; existing APIs and ownership stay authoritative. Web specialist: browser chat/voice UI, no server edits. Root: native iOS voice UI/integration. Independent reviewer after deterministic checks. Available executor: inherited Codex, filesystem/CLI tools. Context budget targeted files ~6k each; soft 12k/max 24k output-work budget; stop at implementation + tests or specific blocker. No deployment, publication, credentials changes delegated.

## Independent review — 2026-09-16

Scope: bounded voice proxy, browser adapter and approval routing, browser recorder/playback lifecycle and turn state, iOS ConversationVoice/API/ChatModel integration. No implementation edits or deployment performed by reviewer. This is a focused source review plus deterministic browser VM probes, not a real-device microphone/playback assessment.

### Confirmed findings

- **P2 — first voice utterance fails when no conversation exists.** `agent/web-chat/app.js:102` stops every active voice session in `selectChat`. Reproduction: pair an account with an empty conversation list, start voice, speak. `send` calls `newChat` (`:119`), which calls `selectChat` (`:108`); this aborts the voice controller, and the following turn POST (`:121`) uses that aborted signal. The chat is created but the spoken turn is never sent. Preserve the voice session when creating its own initial conversation, while retaining stop-on-user-navigation.
- **P2 — voice submission erases an unsent typed draft.** `agent/web-chat/app.js:123` clears the textarea for all successful submissions. Reproduction: type a draft, press the voice button (currently enabled), speak a different phrase; the spoken phrase is submitted and the unrelated draft disappears. Disable voice startup with an existing draft or preserve that draft; also prevent editing it during voice if that is the chosen policy. iOS already guards unfinished input before sending speech.

Evidence: loaded the existing `app.test.cjs` harness through Node Module compilation and appended two in-memory tests. All six existing tests passed. The first probe asserted zero turn POSTs and an aborted voice controller after creating the first chat. The second asserted the previously nonempty textarea became empty after a voice send. Both assertions passed, confirming the unwanted behavior. No test files were modified.

No concrete authorization, cross-origin, credential-revocation or execution-approval bypass was found in the reviewed paths. Backend checks remain owner-bound with bounded input/output and provider deadlines. iOS closes recorder/player and removes its temporary recording on stop; speech turns use the existing ChatModel path and incremental reply counts. Real browser/device audio quality, platform audio-session behavior and interruption UX remain manual validation limits. Findings above need resolution and targeted regression verification before this review can be marked clean.

### Second cycle — fixes and chunk playback delta

Verified both original P2 findings resolved: first voice chat creation now preserves the requesting voice session, and voice startup is blocked with a typed draft while the textarea is disabled during voice. Ran `node agent/web-chat/app.test.cjs`: 10/10 PASS. Chunking preserves Unicode text and stays within provider input bounds; playback generations prevent later queued chunks after interrupt.

**New P2 in chunk lifecycle:** during synthesis of a later chunk, the interrupt button remains enabled from prior playback. Its handler increments `v.playback` and immediately calls `listen(v)`, but the pending `api('voice/speech', …, v.controller.signal)` is not aborted. Reproduction: receive a multi-chunk answer; while chunk two synthesis is pending, interrupt and speak a new utterance. The microphone resumes while the old provider request holds the owner's sole active voice slot (`native-voice.ts`), so transcription can receive 429 and stop the conversation. The enclosing send also remains `sending=true` until the pending synthesis resolves. An additional in-memory VM probe confirmed phase changes to listening while the pending HTTP signal stays un-aborted; all 10 repository tests plus this probe passed. Resolve by either making synthesis non-interruptible with a disabled control until playback resumes, or cancelling the current synthesis separately and coordinating resumed listening with send completion. No broader audit was performed in this cycle.

### Third cycle — targeted closure

Reviewed only the pending-synthesis interruption fix. Playback now has a separate abort controller linked to the voice session. Interrupt aborts the pending TTS request, pauses playback, invalidates queued chunks and enters `interrupted`; it does not restart the recorder directly. The existing `transcribe → await send → send finally` path clears `sending` before restarting listening, preserving the overall voice session. Stop also aborts the speech controller.

Re-ran `node agent/web-chat/app.test.cjs`: **11/11 PASS**, including a held second TTS request that verifies immediate request abort with zero recorder starts, then exactly one recorder start after `sending=false`, and an un-aborted overall voice session. The chunk-lifecycle P2 is resolved. All three findings from this independent review are closed; no remaining blocker in the focused reviewed scope. Real-device audio validation limitations from the initial review still apply. No broader audit or implementation changes performed in this cycle.
