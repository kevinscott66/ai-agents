# Mini App task lifecycle

Creating a task in the Mini App adds a planning record. Choosing an assignee does
not start a worker. Execution is initiated through delegation, the role runtime
queue or the dedicated diagnostic workflow. Their completion paths update the
stored task; ordinary planning tasks can also be explicitly updated by an admin.
The UI explains this distinction instead of promising automatic execution.

Task CRUD, parent rollup and role queue state changes issue process-local cache
invalidations. Events contain only `{id}`; clients refetch authorized task data.
Delivery is deferred until the synchronous transaction stack unwinds. A rollback
may cause a harmless extra read, never a claimed completed status.

The task board also reconciles every 15 seconds while visible and on foreground
return. This covers disconnected SSE intervals, writes from other processes and
maintenance paths. Refreshes do not overlap and stop on unmount. Filtering and
selected-task requests retain the latest-response guard.

A newly created task opens immediately with filters cleared. An open task that
falls outside a filter is refreshed by its detail endpoint. Failure of that
optional request shows an error but does not prevent the fresh list from appearing.

Regression coverage: task-events-lifecycle, miniapp-task-refresh, c24-sse,
sse-events-alive, task FSM/rollup and role-runtime tests. All tests use isolated
storage; production inspection is read-only and does not create or complete tasks.
