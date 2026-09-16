# Native media and speech

## User flow

The composer + menu provides Photos/videos, Camera, Files, one-time Location and existing actions. Media is prepared locally and attached to the draft; only Send uploads it. Up to4 attachments, originals up to10MiB each; videos up to120s are exported to720p MP4 and must remain under10MiB. Photos are downsampled to2048px JPEG. PDF text is bounded and first3 pages rendered; video supplies start/middle/end frames and explicitly does not transcribe audio. Text files extract a bounded UTF-8 excerpt. Unknown binary types remain downloadable, with no claim their contents were read. Current uploads restore the draft on a definite pre-submission failure; ambiguous turn submission is polled, never replayed.

Input permissions are requested on action: camera or one-time when-in-use location; no background location tracking. Photo library uses the system picker. Changing dialog/account cancels preparation and discards stale callbacks. Location is previewed in draft before sending.

## Storage and API

POST `/api/native/attachments` accepts JSON `{id,name,mimeType,data,text?,previews?}`. Base64 is canonical, files<=10MiB, <=3 JPEG previews512KiB each, text<=16000UTF16. Body<=16MiB, deadline60s, one in-flight upload/device and two global. Live native bearer/owner authorization is checked before and after reading. Native turns accept<=4 attachmentIds and optional finite ranged location. Upload association is atomic with turn creation; duplicate ID payload changes conflict. GET `/api/native/attachments/:id` is owner-authenticated, no-store/nosniff with attachment disposition. Ordinary JSON remains2MB, native small JSON64KiB.

SQLite `native_attachments` holds owner metadata, blob, extracted data and binding time; `native_turn_media` records canonical request media and immutable display metadata. Orphans expire24h, linked bytes30days. Display metadata remains in history after byte expiry; history does not load blobs. Quotas40MiB/owner,80MiB global and128MiB free-disk reserve plus transient write headroom. The app displays storage limits. Runtime database remains excluded from source archives.

Originals never become executable paths. Native input uses the existing model image/document interfaces and untrusted attachment fencing, not Telegram download APIs. Other devices sync metadata and fetch bytes with their own owner-bound token. OpenFlux applies to upload/download as well as ordinary requests.

## Speech

Settings → Voice offers actual installed Russian Apple voices, preferring premium/enhanced voices when available; speed0.35–0.65, preview, opt-in automatic speech. A single output controller cleans Markdown/code/URLs and owns the playback session. Newly received response chunks queue in order, while restored history does not auto-speak. Pause/stop and interruption handling are explicit; microphone and output release only sessions they own. No paid cloud TTS or voice cloning.

Physical iPhone camera/location/microphone permissions and audible voice quality remain device acceptance items. Simulator verifies real preparation of synthetic JPEG/PDF/text/MP4+frames; tests cover media ownership, revocation, quotas, idempotency, history expiry, model ingress, draft restoration and speech normalization.

## Assistant artifacts and image progress

Native ingress binds a provider-independent artifact sink to its authenticated owner,
paired device, conversation and running turn through AsyncLocalStorage. SEND_PHOTO,
SEND_DOCUMENT, GENERATE_IMAGE and GENERATE_SVG_IMAGE use that sink during native
execution; their existing Telegram delivery remains active outside native execution.
No delayed output can be appended after terminal status or device revocation.

Polling retains `replies: string[]`. Optional `outputMedia` entries contain
`messageId` (`<turn>:reply:<1-based index>`) and `attachments` with the same metadata
and authenticated download route as user uploads. Caption-only empty replies are
valid media messages. History puts attachments directly on assistant messages.
Binary retention, per-owner/global quotas and maximum 10 MiB per file are shared
with uploads; immutable metadata remains visible after binary expiry.

Optional turn `generations` and history `generations` contain UUID `id`, `state`
(`running`, `completed`, `failed`, `interrupted`), millisecond `started`, and terminal
`ended`. Records begin at actual generation invocation, not when the user submits
text. A turn allows at most 40 generation records and 80 replies; history returns
the latest 100 generation records. Restarts and unfinished work at turn completion
mark running records interrupted; work is never replayed.

Remote output photos use the existing public-address policy with validated DNS
addresses pinned to the socket, bounded DNS/body time and 10 MiB maximum body.
Redirects are rejected. PNG, JPEG, WebP and GIF are identified by their bytes.
