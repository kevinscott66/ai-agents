# Cross-client synchronization corrections

## Conversation identity

The native conversation index, create response and history expose the server-owned `agentKey`. iPhone uses the create-or-read response immediately before sending, including a conversation restored after app launch. Legacy servers/Lead dialogs keep the omitted-role request. Pending-request recovery still polls the saved turn ID; it never resubmits or infers a role from assistant messages. The server's atomic role binding remains authoritative.

Office discovers a default conversation per role once per paired session. Subsequent snapshots do not replace that choice. Closing/reopening the dialog preserves its target; disconnect clears all pinned IDs.

## Execution visibility

Office scope becomes `owner-execution`. It observes all `runWithTools` paths, including SDK and delegated execution, attributed to the trusted ingress `triggerUserId`. Concurrent runs have independent lifetimes, and completion/exception always removes that execution. The registry contains only owner and role metadata.

Projection combines active owner-attributed execution, native turns, personal-chat durable tasks and approval links. Active execution takes precedence; pending or currently executing approved actions remain WAITING. A previous-process execution marker is ERROR/unknown, never replayed. Finishing a model reply no longer leaves a persistent DONE label that could imply completed external actions.

This is not a global group activity feed: background workers with no trusted initiating owner, other users' group tasks and separate executor processes are not observed. Private/group histories are not copied. UI states this coverage limit. Service restart clears the in-process registry; durable approval outcomes retain their own recovery semantics.

## Validation

- Native/office/activity targeted tests: 12 pass, 87 assertions, including role-preserving continuation, owner isolation, concurrent activity cleanup, pending/current/previous-process/completed approval states.
- iOS `python3 ios/tests/run.py`: passed, including authoritative Backend-role forwarding in the ChatModel fixture and existing restart recovery.
- Browser live-office tests: 2 passed, including another device changing its latest same-role conversation while the current tab sends to its pinned one.
- Dispatch/SDK regressions: 52 passed, 121 assertions.
- Server typecheck and frontend production build passed. Security baseline: 35 passed, 136 assertions.
- Independent security/correctness review completed; stale approval execution finding corrected and regression added.

## Delivery constraints

Code only; no production deployment, device installation or signed release performed. Release server + frontend together because new WAITING state/scope must be understood by the client. Existing connected tabs need reload/re-pair. iOS role support needs a new signed application release; old installed clients still reject non-Lead office replies. Integrate with ongoing iOS work before packaging so unrelated changes are not regressed.
