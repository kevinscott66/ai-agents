# Site editorial queue

Digest candidates come from `src/data/current/editorial-candidates.json`, not
the public `current/digests.json`. The site builds this private queue from the
Telegram snapshot before applying its publication gate, using the same API-date
selection as the public corpus. Reading public digests would create a permanent
queue deadlock for withheld drafts. Activities still come from
`current/activities.json`. A missing queue fails the run instead of looking
like an empty queue.

`tools/site-editorial.ts` uses `lib/codex-editorial.ts` to research primary sources,
then the existing factual verifier before publishing editorial overlays. Headlines
must match the same project, event, date and conditions as the body. Engaging wording
must not introduce unsupported earnings, rewards or urgency. Digest headlines convey the event and a concrete detail with varied natural syntax, using the owner-approved
Fermah/Hyperliquid examples as style only. Bodies require 350–3200 characters, targeting
2–5 substantive paragraphs about mechanism, conditions, dates and limitations. Missing
evidence is a reason to defer, not pad or invent details. Title 35–130 and summary
80–340 character bounds remain; source-page preservation
and factual checks remain mandatory, including when the model returns an empty list.

When the event itself cannot be confirmed, the writer returns `defer: true` with a
private reason. It must not turn that reason into a headline or article. Entry and
final-manual-overlay checks reject editorial refusal prose. The factual checker
requires an explicit supported-event verdict with evidence from an opened source;
missing, false or uncited verdicts fail closed. A blocked X post is a research
failure, not proof that the team has made no statement: check official and founder
channels before deferring. Unknown secondary details can remain caveats in a
confirmed story. Regression coverage: `tests/site-editorial.test.ts` and
`tests/editorial-event.test.ts`.

The shared Codex adapter defaults to web-search-only research. If the writer or
fact checker actually fetched platform records using `readSources`, that call
explicitly enables `suppliedSourceRecords`. These records remain untrusted evidence:
author, date and event must be assessed, third-party claims distinguished from
official announcements, and reading an excerpt must not be claimed as a web visit.
The option is carried through writer retries and does not bypass the separate
event-evidence or final-manual-overlay gates. Without a fetched record the default
web-search policy remains in force.
The site's separate freshness runner may explicitly enable bounded observations
downloaded from curated official drop-rule URLs. These page excerpts remain untrusted
data; the site verifies that every cited quote appears in the fetched text before a
positive review can be accepted. This mode is opt-in per call and does not permit
filesystem, shell, or publication tools.

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

Headlines must not share a mandatory dash, project-first opening, or other fixed template.
Choose a complete sentence, a detail-led opening, a colon or a dash according to the story;
do not replace repetitive dashes with repetitive colons or questions. Factual gates remain unchanged.

## Repeat review and source attachments (policy version 3)

Recent automatic digests (30 days from their publication date) are revisited when
they predate this policy, lack a valid review schedule or reach `reviewAfter`.
The schedule is editorial metadata: one day for registration/claim/snapshot/drop
copy and seven days for other news; it is never a source-backed event date.
Historical complete entries do not loop indefinitely. Confirmed malformed titles
or discarded-draft commentary remain researchable regardless of age. Existing
six-hour failure cooldown and batch budgets still apply. API/saved automatic
entries also participate even when their raw bodies are complete.

The live `edits.json` journal is folded into the human editorial layer. A manual
body protects the article; title-only corrections remain available to the writer
and final verifier. A corrupt journal fails the run rather than silently removing
human protection. No activity steps or statuses are rewritten.

Platform records retain bounded HTTPS media URLs from the platform's media hosts
and optional untrusted alt text. They are references, not inspected pixels.
The verifier must explicitly assess each attachment: `inspected` with a reason,
`text_sufficient` when caption evidence fully supports a nonvisual story, or
`unavailable`. A story about a photo/teaser cannot use `text_sufficient`; missing
or unavailable necessary media blocks publication. There is no automatic claim
that every attachment can be opened: inaccessible visual evidence defers the
story. Caption-only access cannot establish the absence of numbers or phrases in
an image. No arbitrary media URL is downloaded by the platform reader.

Dates in source forecasts remain announced dates. Crossing the deadline triggers
review, not automatic past-tense assertion that the event happened. Avoid reporting
which phrases were discarded from a draft; retain only useful event limitations.
Coverage: `tests/editorial-recheck-media.test.ts` plus existing entry/event/source-
policy regressions. The final site gate has matching source-first/residue cases.

## Research transport and retry diagnostics

The pinned Codex CLI 0.149.0 catalog can mark the selected model `code_mode_only`.
Disabling that host then hides hosted web search despite `web_search="live"`.
`editorialCatalog` selects `direct` tools for the selected research model only;
it does not change the shared inference catalog, model choice or runtime agents.
The existing native-capability denylist, read-only sandbox, clean subprocess
environment and emitted-event allowlist remain in force. Tool configuration
errors now fail the call instead of being ignored. Validate actual web-search
events when accepting a CLI/catalog change, not just a plausible final answer.

Activity research includes up to eight unique sources: the app URL and X
announcements already linked in the original intro/steps. Writer and verifier use the same
selection; this does not add arbitrary discovered URLs to the service fetcher.
Source records remain untrusted and official authorship is still checked.
The publication subject uses an explicit record kind. For activities it includes
the retained steps, costs, reward type and status alongside the proposed intro;
correcting the intro cannot conceal contradictory retained conditions. These
fields remain human-owned: an unsupported instruction blocks the edit rather
than being silently rewritten or ignored by the verifier.
Retained fields use plain labeled text, not JSON serialization inside article
text: JSON string delimiters must not turn ordinary instructions into alleged
verbatim source quotes. Editorial time estimates are labeled as estimates.

Verifier complaints using `text`, `reason` or `explanation` instead of `issue` retain their real
meaning. Missing/invalid complaint lists or malformed entries block the verdict;
they never become an empty list. Explicit writer deferrals preserve a bounded,
single-line private reason in retry diagnostics, without publishing that reason.
Archive editing verifies the original historical event and dates; it does not
require a second launch or turn elapsed registration terms into a current CTA.
Regression coverage: `tests/editorial-research-recovery.test.ts` and the isolated
subprocess contract in `tests/editorial-adapter-contract.test.ts`.

`lib/editorial-images.ts` downloads actual source pixels only from HTTPS
`pbs.twimg.com/media/` or `/tweet_video_thumb/`. Redirects, arbitrary hosts,
credentials, nondefault ports, unknown formats and MIME/signature mismatches are
rejected. There are at most four attempts, 4 MiB per image, 12 MiB total and an
eight-second timeout per request, with streamed size enforcement. Only JPEG,
PNG and WebP are attached; video/GIF content is not falsely called inspected.
The adapter revalidates each image, writes private temporary files, attaches
them with `--image`, maps filenames to source URLs as untrusted evidence and
removes the directory after the call. Downloading is not approval: the existing
explicit media-review and event gates still apply. Tests cover URL boundaries,
redirects, chunked overflow, format checks, batch caps and actual adapter inputs
without using credentials or a live model.

## Source identity and attribution

`lib/editorial-sources.ts` removes explicit referral and UTM query parameters
before research and automatic publication. The preservation gate compares those
clean URLs: removing an incentive is no longer mistaken for losing a source.
Paths, record IDs, fragments and functional parameters remain significant; a
different page or a dead source cannot be silently substituted. Human source
lists use the same conservative query cleanup in the verification projection
without rewriting the stored journal. The site also removes additional legacy
referral paths and parameters; this helper does not authorize changing paths
or dropping functional arguments. Source-list checks still
reject unclean generated URLs. Regression: `tests/editorial-sources.test.ts`.

For a platform record, independent attribution can use a link from the official
website/documentation to the matching account plus the matching record author
and post ID. Both sources must be listed by the checker; an unavailable direct
X page does not require the official website to republish the same post. An
account name, logo or badge alone is insufficient. This is research guidance,
not a deterministic authenticity certificate or a bypass of event/media gates.
An explicitly labeled editorial duration estimate is checked against the steps,
not demanded as a project's official promise. Costs, rewards and deadlines still
require source-backed conditions. Unsupported retained activity instructions
continue to block publication; they are not silently changed by the writer.

Risk complaints must explain how an omission makes a concrete claim or reader
action misleading. A historical announcement without a fixed-payout promise or
current participation instructions does not require reproducing every general
legal reservation or share-price disclaimer. Material eligibility, deposit,
identity, deadline and loss conditions remain blocking where they affect the
claim or proposed action. Actual read-only checks must exercise this distinction;
prompt wording alone is not evidence that a generated article is correct.
