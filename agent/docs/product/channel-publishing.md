# Daily Telegram publishing

The daily channel publisher is separate from the site editor. It uses the existing
pinned Codex subscription adapter in `lib/codex-editorial.ts`; no Claude runtime or
additional provider key is needed. Site ingestion is not implied by a Telegram post.

## Research and verification

`tools/daily-draft.ts` reads `/api/catalog`, recent proposed titles, and the last
50 channel messages (48-hour window). Read/schema/permission failures stop drafting;
publication history must not silently become empty. The one-shot Telegram reader
uses `destroy()` so no update/ping loop survives the read.

Each candidate needs a real ISO publication day and an independently supported
current/yesterday UTC event or new announcement. A future scheduled event is valid
only when the new official announcement is within that window. Missing/stale dates
are rejected, not replaced with today. The checker receives the final cleaned text
in a separate model context, requires two independently owned opened sources, and blocks
unsupported event claims, figures, attribution and speculative filler. Source HTTP
text reads reuse the public-address, DNS-pinned, bounded redirect/size/timeout guard.
Source images retain the existing fixed HTTPS pbs.twimg.com allowlist, forbidden
redirects, eight-second deadline, streamed size limits and signature checks.

One edition permits at most four initial candidates and one global correction.
A corrected article passes the same date, duplicate, form, URL and independent
factual checks again. Fewer confirmed stories are allowed; zero passing stories
means failure before preview or pending state. No automatic unbounded LLM retries.

## Delivery and duplicate protection

A valid edition renders a banner and sends a preview and full review to Saved
Messages before committing a channel-bound pending draft. Preview and final post
include escaped primary-source links. The shared footer uses current site sections,
the public DeLabs channel, and the established community chat; obsolete Notion links
are removed. Existing caption, Telegram formatting and custom emoji rules remain.

`approve-poll.ts` runs after drafting and from its fallback timer. An atomic publisher
lock is acquired before either process reads pending state. Stale recovery uses
an exclusive recovery directory and re-reads ownership under it; an interrupted
recovery fails closed and requires operator inspection of the recovery directory. The pending channel must
match configuration. The existing send-start marker prevents resending an ambiguous
Telegram send; such failures need human inspection. Published/proposed/channel
history additionally prevents repeated topics in later editions.

With explicitly configured `DELABS_AUTO_PUBLISH=1`, the existing automatic policy
publishes without approval and respects a readable explicit owner veto. Without
that flag it waits for the established owner reaction/reply. Do not enable automatic
mode or change channel identity implicitly.

## Operations

The daily timer is opt-in, at 08:00 UTC (11:00 Moscow), persistent across downtime.
The oneshot service is bounded to 5,400 seconds; its draft lock expires after 120
minutes. Research shares the existing editorial flock, waiting at most 30 minutes
for a running editor instead of spawning competing models on the small server.
The service may write its draft directory, the existing research lock file and
Codex auth home for subscription refresh under
`ProtectSystem=strict`. Other systemd restrictions remain. The weekly timer remains
independent and disabled unless separately requested.

The site automation health monitor observes an explicitly enabled daily timer,
warns on failure or more than 26 hours without success, and never enables or retries
this LLM publication job automatically. Before production activation: exact-commit
approval, scoped backup of modules and units, unit verification, rights/target check,
preview inspection, one-attempt send receipt, and channel readback. Keep the previous
modules, units and timer enabled-state for rollback; do not roll back content history
or resend an already delivered edition.

## Verification

`tests/daily-codex-research.test.ts` covers catalog failure, UTF-16 channel headings,
client lifetime, independent final-text checking, freshness/year boundaries, private
URLs, rejected/partial editions, bounded revision, safe source links and concurrent
publication locking. Run the daily/approve-poll/formatting/editorial subsystem suite
with an isolated temporary memory database and site ingestion disabled in tests.

## Exact daily content specification

The owner reaffirmed strict compliance with the existing TZ on29October. The
source rules are `lib/tools-schema.ts` → `PUBLISH_TO_CHANNEL`, the established daily
research format, and subsequent owner corrections. Daily's later3–4story target
supersedes the generic tool's5–6example; fewer independently confirmed stories are
allowed explicitly. Historical Notion/invite destinations are replaced with current
working destinations; the canonical footer label/structure remains. No invented
personal experience, unsupported market forecast or forced quota filler is permitted.

`channel-daily-spec.ts` enforces70–130character titles,180–340character descriptions,
600–1200character complete articles in2–3paragraphs,1–2short bold accents inside each
description,2–4distinct safe sources, and the TZ's explicit banned filler phrases.
The independent checker must identify at least two actually opened source owners
supporting all material claims; related company sites and syndicated mirrors count
once. A URL cannot be attributed to conflicting owners. Ownership/evidence
assessment still depends on the model and is not a safety certification.

New drafts carry `channelSpecVersion=1`. Preview and publication share the same
numbered caption with a brief introduction, complete descriptions, source links,
and canonical footer. Only complete story blocks may be removed to fit the verified
account limit, with an overall1900plain UTF-16character ceiling. No title, paragraph
or footer is truncated. The illustrated cover is the established default; a missing
or failed trusted image pool uses the historically documented clean fallback.

Strict publication makes exactly one photo send with no split/fallback messages.
It persists the returned message ID before readback, then verifies exact text,
photo, link/custom-emoji entities and bold coverage. Telegram may split one bold
entity where a link starts; identical coverage is valid. A send/readback ambiguity
retains the attempted draft and returned ID for inspection, never automatic resend.
Existing pending drafts and weekly formats remain readable through their legacy
branches. Format repairs and factual repairs share the same one-correction budget.
