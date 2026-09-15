# feat: add Agent daily workflows and unsigned native iPhone client

The lead now accepts recognized Telegram voice as a real turn and answers to «Агент». A native iPhone client connects to the same lead through one-time device pairing and exposes chat, dictation, spoken answers, daily commands and service shortcuts. Unresolved requests retain their ID across reconnection; native specialist replies return to the app before the turn finishes.

Apple Calendar is read through a fixed EventKit helper on the Mac. Personal commands remain owner/DM-scoped. Opening apps uses locally configured bundle IDs. Optional role-health alerts suppress unchanged states. Taxi prepares a Yandex Go route; transfer preparation stays local and opens the bank for final execution.

## Validation

Typecheck PASS; full agent suite 6958 pass / 39 skip / 0 fail; unsigned iPhone and simulator builds PASS; independent security review PASS. See `agent-validation.md` for boundaries.

## Activation

Review and deployment required. Enable native API, update Mac daemon, authorize Calendar locally, then pair the iPhone. No production changes included in this review preparation.
