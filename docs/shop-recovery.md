# Shopping browser recovery

Read-only browser operations (`quote`, `places`, `status`) have bounded shutdown
recovery. Pending or rejected shutdown quarantines that browser: the runner
refuses to launch replacement work until successful closure. Optional diagnostic
screenshots and bringing a captcha window forward have their own deadlines.
Mutation/payment shutdown does not opt into early release; payments are never
replayed by this recovery path.

Scheduled followups carry an internal async execution context scoped to owner and
chat. Exhausting busy/browser launch/connectivity recovery blocks subsequent
shopping calls and followup creation in that execution. Continuations already
created by that same execution are cancelled. The original followup remains
stored as `failed` with `dependency_blocked`, not `done`. No task text matching
or database schema changes are used. Independent owner turns can resume work;
recovery never interprets that as authorization to repeat payment.

This is bounded recovery, not a guarantee that browsers never fail. An uncertain
shutdown can require an operator to restart the daemon. No automatic restart,
automatic payment replay, or automatic selector repair is implemented here.
