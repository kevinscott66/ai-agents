# Site editorial queue

`tools/site-editorial.ts` uses `lib/codex-editorial.ts` to research primary sources,
then the existing factual verifier before publishing editorial overlays. Headlines
must match the same project, event, date and conditions as the body. Engaging wording
must not introduce unsupported earnings, rewards or urgency. Short verified news is
allowed (title 35–130, summary 80–340, body 160–1600 characters); source preservation
and factual checks remain mandatory, including when the model returns an empty list.

A failed entry waits six hours before another attempt. Retry deadlines are atomically
stored alongside the automatic editorial file as `<AUTO_PATH>.retries.json`, keeping
unreachable sources from occupying every batch. Success clears its deadline. If all
attempted entries fail, the run exits unsuccessfully rather than reporting a green
zero-result run. Existing service locking still serializes research runs. No messages
are sent to Telegram and no activity steps/statuses are edited by this tool.
