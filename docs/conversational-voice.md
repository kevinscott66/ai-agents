# Conversational voice

The conversational client uses a transcription → existing team → speech pipeline.
It does not embed ChatGPT or replace the existing orchestrator. User transcripts
are submitted as ordinary conversation turns; actual assistant replies are spoken
and remain in the same server-backed history. Model tools, owner boundaries,
project knowledge and action confirmations stay on the existing execution path.

## Audio

The server calls OpenAI's speech endpoint with `gpt-4o-mini-tts` and `marin`, and
transcribes recordings with `gpt-4o-mini-transcribe`. The iPhone chat's "speak answer" button uses the same
speech endpoint, so a replayed text reply sounds like the voice conversation. Russian language context and
punctuation guidance improve readability without requesting paraphrasing. Speech
recognition is probabilistic: a transcript can still contain an error.

Audio credentials remain on the server. Temporary audio is not a conversation
attachment; the persistent chat contains text. Clients stop microphone capture
while waiting for or playing a reply to prevent speaker output becoming a new
request. Interrupting playback is an explicit client control; it does not cancel
or repeat an already submitted tool action. Orb amplitude comes from measured
microphone or playback audio. Closing voice mode releases audio resources.

## Web access

`/chat` is a standalone client, distinct from the Telegram operator Mini App.
Its `/api/web` adapter requires the configured exact HTTPS `WEB_APP_ORIGIN` and
same-origin browser metadata. It uses device bearer authorization and one-time
pairing, not ambient cookies. The native API keeps its browser-origin rejection.
Do not configure wildcard origins or publish pairing codes, tokens, audio samples,
chat archives or production configuration.

## Verification scope

Backend tests cover authorization, bounds and upstream failures. Client checks
cover state transitions and resource cleanup; a compiled app is not a substitute
for testing microphone permissions and speaker feedback on a physical device.
A short synthetic Russian speech/transcription round trip has been verified
against the configured provider, independently from real user conversations.
