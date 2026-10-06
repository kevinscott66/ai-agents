# Site editorial queue

`tools/site-editorial.ts` uses `lib/codex-editorial.ts` to research primary sources,
then the existing factual verifier before publishing editorial overlays. Headlines
must match the same project, event, date and conditions as the body. Engaging wording
must not introduce unsupported earnings, rewards or urgency. Digest headlines follow actor + action + concrete detail, using the owner-approved
Fermah/Hyperliquid examples as style only. Bodies require 600–3200 characters, targeting
3–5 substantive paragraphs about mechanism, conditions, dates and limitations. Missing
evidence is a reason to defer, not pad or invent details. Title 35–130 and summary
80–340 character bounds remain; source preservation
and factual checks remain mandatory, including when the model returns an empty list.

A failed entry waits six hours before another attempt. Retry deadlines are atomically
stored alongside the automatic editorial file as `<AUTO_PATH>.retries.json`, keeping
unreachable sources from occupying every batch. Success clears its deadline. If all
attempted entries fail, the run exits unsuccessfully rather than reporting a green
zero-result run. Existing service locking still serializes research runs. No messages
are sent to Telegram and no activity steps/statuses are edited by this tool.

Manual title-only edits no longer exclude missing digest bodies from research. Manual
bodies remain protected, while automatic bodies shorter than the new minimum become
eligible once more. The writer receives retained manual fields as untrusted data;
`checkPublication` applies them before factual verification so the verifier sees the
same title/summary/body combination that the site publishes. A contradiction blocks
the update. Generated source preservation checks still run before verification.
