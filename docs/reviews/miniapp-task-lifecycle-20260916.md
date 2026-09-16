# Mini App task lifecycle audit dispatch

Risk HIGH if execution/status semantics change. Shared QUALITY_GATES requires task-runtime specialist and independent review. Specialist scope: task creation/state transitions/events and queue execution; read-only audit first, no production mutations. Root: Mini App refresh/detail/filter logic and live aggregate diagnostics. Available inherited Codex + CLI, bounded source context ~5k; soft/max 10k/20k work budget. Expected output evidenced bugs/test paths; stop after bounded audit or concrete blocker. Independent review after targeted gates; max3cycles. Preserve unrelated iOS/staged files. Live DB read-only, isolated test storage.

## Findings and verification

Confirmed missing agent/role task invalidations (only Mini App routes emitted events). Added canonical metadata-only events and removed duplicate route events. Added visible periodic/foreground reconciliation for process-local or missed events. Selected details outside filter now refetch; new tasks clear filters and open immediately.

Independent review cycle1 found optional-detail failure blocked fresh list application. Fixed by applying list first and surfacing error inside modal. Extracted production load regression PASS. Cycle2 independent closure PASS, no HIGH/CRITICAL in scope. Backend transitions/lease/rollup unchanged.

Live read-only aggregates:20done/156failed/11cancelled;24h1done/0failed;0running older1h. Historical failures149gc_stale/3lease/4other. Last30minute service logs182lines, no ERROR/handlererror/Unhandled categories. No task contents or user identifiers exported.

Mini App create is a planning record, not automatic execution; form now states this. Real HTTP isolated test covers create→running→done→GETcompletedboard. Native Release0.1.16(17) built successfully. Initial full suite failures were old SSE test expectations after payload reduction; updated contract to exact{id} and retained literal emitter discovery. Finalfull pending.

Final:7370PASS/39SKIP/0FAIL,21962assertions876files174.73s. Backend/MiniApptypechecks and nativeReleasePASS. Deployed7afd3208,11APIroutes200/Maconline. iCloudall3uploadedtrue. PublicPR#3updated; noprivatefilespublished.
