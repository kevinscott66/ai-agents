# Engineering memory for the twelve-role team

The runtime team remains `orchestrator`, `pm`, `product`, `backend`, `frontend`,
`tgdev`, `aieng`, `qa`, `smm`, `copy`, `design`, `perm`. Roles share the selected
owner/project's evidence; they do not receive twelve duplicated knowledge stores.

## Four layers

| Layer | Owner / runtime representation |
|---|---|
| L1 permanent | `ENGINEERING_MEMORY_POLICY` in `lib/engineering-memory.ts`; trusted code, no imported document can change it |
| L2 project | Existing owner-approved project entries plus imported source excerpts |
| L3 working | Chat task memory plus imported root CURRENT_STATE excerpts; historical statuses remain dated evidence |
| L4 ephemeral | Current dialogue/reasoning, not a source of persistent authority |

The entry shared by the leader and delegated roles is `knowledgePrompt`. Native
execution context and approved continuations already carry that packet through
AsyncLocalStorage. There is no new background role loop or automatic Telegram
publication. Existing Telegram Wiki remains a separate boundary; project imports
are not copied into global or group-chat memory.

## Source format

Each excerpt has a stable ID, `project|working` layer, `fact|decision|task` kind,
text, and source path / SHA-256 / observed timestamp / Git revision. The source hash
identifies the original document; the exported text may have credential redactions.
The operator's private export manifest records the selected files and redactions.
The importer verifies structure, not source authenticity: construct and inspect the
bundle from an explicit local allowlist before approving it.

Imports never fabricate messages, source-message IDs or past conversations.
Imported entries are separate from model-extracted chat facts and approvals.
They appear as `importedProject` plus `importedProjectCount` in the native knowledge
response. Current clients can choose imported projects through existing project
selection; rendering the new source-excerpt field is an optional client update.

## Storage and project boundaries

Three additive tables in the existing native database: `engineering_project_keys`,
`engineering_entries`, `engineering_imports`. Every read joins/validates the owner
of the native project. New source keys create projects; same-title manual projects
cause a conflict instead of an automatic merge. Existing chats are never reassigned.
The owner explicitly selects a project for a dialogue using the existing UI/API.

Same batch and normalized content is an idempotent no-op, with exact original-row
integrity verification. Reusing a batch ID with changed data fails. A separately
reviewed later batch may supersede stable entry IDs; active retrieval uses the
newest receipt per source path, so shrinking a source does not revive obsolete
trailing chunks; older rows remain evidence. Sources omitted entirely from a later
partial batch are retained, not silently deleted. Project deletion removes its
imported entries and key mapping; retry of a deleted import fails rather than
silently resurrecting the project. Revisions/caps for existing chat memory stay intact.

## Context and bounds

An operator bundle is at most 10 million characters, 30 projects, 1,000 excerpts
per project, 1,200 characters per excerpt. Each project keeps at most 2,000 rows
including historical batches. These are storage caps, not model context targets.
Native snapshots expose eight excerpts. Task retrieval reserves up to three slots
for working state and ranks the remaining excerpts by task terms. Chat/project/
imported entries are interleaved into valid JSON capped at 22,000 characters. The
trusted policy and untrusted wrapper surround that packet; omitted totals remain
visible. No JSON string is cut in half to fit the budget.
`SEARCH_WIKI`/`READ_WIKI` can retrieve a different bounded packet by query/source
name. The reader captures trusted owner/chat/project; a project reassignment
invalidates it. Normal turns and approval continuations use the same boundary.

Imported text stays inside the existing untrusted-data fence. It grants no tool,
approval, deploy or model-switching authority. Operator import has no model tool
or public write route. Secrets are omitted/redacted by the exporter and scrubbed
again during parsing; backups and bundles belong outside public Git.

## Operator workflow

From `agent/`, inspect without writing:

```bash
bun tools/import-engineering-memory.ts --db /private/native.db \
  --bundle /private/reviewed-bundle.json --sole-owner
```

`--sole-owner` works only for exactly one existing conversation owner. Otherwise
specify `--owner ID`; never guess. After explicit owner approval and normal release
gates, apply the exact reviewed payload:

```bash
bun tools/import-engineering-memory.ts --db /private/native.db \
  --bundle /private/reviewed-bundle.json --sole-owner --apply --owner-approval \
  --expected-sha256 REVIEWED_FILE_SHA256 --backup /private/new-backup.db
```

The command takes a coherent SQLite `VACUUM INTO` backup, mode 0600, before importing
all projects in one transaction. It never opens a new empty production database,
overwrites an existing backup, logs raw memory, runs inference or sends messages.
Do not invoke `NativeAccess` merely to import: its startup recovery alters running
turn state; the operator deliberately constructs only `NativeKnowledge`.

## Role responsibilities

- orchestrator: select scope, resume, bounded specialist context, final handoff.
- pm/product: current tasks and accepted product decisions, not speculative goals.
- backend/frontend/tgdev: relevant API/UI/Telegram contracts and verified changes.
- aieng: memory extraction/context/model capability; never promote imported rules.
- qa/perm: verification and owner/privacy boundaries; evidence before findings.
- smm/copy/design: project-approved content/style decisions; no publishing permission
  is derived from a memory entry.

## Verification

`bun test tests/engineering-memory.test.ts tests/native-knowledge.test.ts
tests/native-knowledge-runtime.test.ts` from `agent/`: owner isolation, twelve-role
context transport, immutable retry, transactional rollback, version supersession,
redaction, bounded packets and backup-before-write. The twelve-role test checks
shared context transport, not twelve paid model runs. Full application gates and
typecheck remain required before deployment. Import counts alone are not proof of
runtime activation; verify the deployed packet for an explicitly selected project.
