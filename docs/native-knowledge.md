# Native chat and project knowledge

`agent/lib/native-knowledge.ts` owns additive SQLite tables in the native access
store. Existing `conversations` and message schemas remain unchanged. Runtime data
stays outside Git. A `NativeKnowledge` instance receives the existing database only
after those base tables exist.

## Boundaries

Every public storage operation checks the authenticated owner against the existing
conversation or project. The model never chooses the owner. A conversation can be
manually linked to one project owned by the same person. Linking does not copy any
knowledge. A chat reads its own compact entries and its linked project's explicitly
approved entries; unlinked chats read only their own entries. No global wiki or
other-project search is part of this module.

A chat entry is `{id, kind, text, sourceMessageIds}`. Kinds are `fact`, `decision`,
and `task`; task entries describe remaining work. Completing a task removes it from
the next compact snapshot or replaces it with an evidenced decision. IDs are stable
within the chat. Every source message must exist in that exact chat's archive.
Provenance identifies evidence, not proof that a model interpretation is correct.
All stored text must be treated as untrusted data, not instructions or permissions.
Known credential patterns are scrubbed; extraction must omit secrets altogether.

## Updates and approval

`updateChat(owner, chat, expectedRevision, entries)` atomically replaces the bounded
snapshot only if its revision still matches. A stale completion returns `false`;
it must not retry blindly with a newer revision. Malformed or cross-chat provenance
rejects the entire update and leaves previous knowledge intact.

`propose(owner, chat, entryId)` snapshots a particular entry and its revision for
review. `decide(owner, proposalId, true)` is reserved for an authenticated, explicit
user decision. Rejection deletes the pending proposal. Model extraction can propose
an entry but cannot accept it. Approved entries retain `sourceConversationId`,
source message IDs and approval timestamp. Chat edits invalidate pending proposals;
approved entries change only through another accepted proposal or explicit removal.

Moving a chat invalidates its pending proposals. Already approved entries stay in
the old project; they are never copied into the new project. Deleting a project
unlinks its chats and removes its approved knowledge and proposals, preserving chat
history and chat memory. `removeProjectEntry` supports owner correction/removal.

## Storage and limits

- `native_projects`: owner, title and timestamps; at most 100 per owner.
- `native_project_chats`: separate conversation-to-project mapping.
- `native_chat_knowledge`: revision and full compact snapshot; at most 24 entries,
  600 characters per entry, eight source messages per entry.
- `native_knowledge_proposals`: up to 100 pending per project, unique per source
  chat and entry; exact revision and entry snapshot.
- `native_project_knowledge`: up to 100 approved entries per project, keyed by
  project, source chat and entry ID. Existing entries can be updated at the cap.

All mutations that involve multiple records use synchronous SQLite transactions.
The revision check and replacement execute within one transaction. There is no
asynchronous gap between authorization and mutation. The parser accepts only
`{entries:[...]}` and rejects unknown keys, duplicate IDs and oversized input.
No existing schema columns are altered and initialization is idempotent.

## Verification

`bun test tests/native-knowledge.test.ts` exercises owner separation, message
provenance, explicit approval, stale competing snapshots, invalidated proposals,
manual reassignment, project deletion, correction, parser bounds and redaction with
isolated in-memory SQLite databases.

## Native application integration

The native API exposes owner-authenticated `/api/native/projects`, conversation
`/knowledge`, `/project`, `/proposals` and explicit proposal decisions. iOS has
«Память диалога» in the conversation menu. Project assignment is manual. Sources,
last extraction status, approved shared entries and pending proposals are visible.
Device identity is checked again after asynchronous network setup and response reads.

After a completed native response, one tool-free model call compresses the latest
conversation messages plus existing memory. It uses the configured inference
provider and compactor budget. One extraction runs per chat; overlapping completed
turns queue only the latest snapshot. Failed/revoked/stale extraction leaves previous
memory intact, reports status and never repeats task execution. Historical dialogs
receive an initial compact snapshot when the next exchange completes; no bulk
backfill or background timer scans old conversations. Approved action outcomes can
be included in the next exchange's compression.

Native prompts, wiki reads and delegate history use the current dialogue plus
approved project facts. Native wiki writes and Telegram history reads are blocked;
they cannot populate the legacy global wiki. Telegram's existing memory remains
separate. Persisted assistant authors are trusted actual runtime role keys, not
model-written labels; legacy messages keep the Agent/lead label.

## Team conversation

The leader chooses whether to answer alone or invite the smallest useful set of
specialists through real delegation. Suggestions/questions do not authorize
execution. Relevant specialists can challenge an approach, consult another role,
perform their assigned work and return evidence; leader synthesizes the result and
states remaining disagreements. No scripted all-role round or fabricated consensus.
Native turns allow at most eight role calls under the existing loop/cycle and cost
limits; reviews do not force artifact tools. Later specialists see genuine earlier
contributions. Approved delegation restores the original scoped conversation.
Native chat-local output never falls back to Telegram mutation methods.

Automatic suggestions call `shouldAutoPropose` before creating a proposal. Identical
text and kind already approved or rejected for that project, source chat and entry
are suppressed; changing only evidence IDs does not resurface the same fact. A
changed fact can be suggested again, and explicit manual proposals remain allowed.
`native_knowledge_rejections` stores only a content fingerprint and timestamp, never
the rejected text, with at most 100 records per project (oldest evicted). Rejection
history stays scoped to its original project when a chat moves and is removed when
that project is deleted. Old evicted decisions can be suggested again.
