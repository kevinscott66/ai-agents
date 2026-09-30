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

## Retail discovery and incomplete results

Yandex Eda retail stores use `retail@slug` references, separate from restaurant
`brand:slug` references. Discovery checks restaurant results first, then the retail
directory. Retail search navigates to the selected store's `?query=` page and reads
visible product cards using current prices and enabled add controls. Only product
URLs from the selected store and trusted origin are accepted; ambiguous name-derived
IDs are omitted. Kitten/котят aliases and common Russian stopwords are normalized.

`search_incomplete` means the catalogue was not verified sufficiently. It must not
be reported as proof of unavailable stock, a closed store, or an incorrect address.
Visible add controls do not establish that a requested quantity can be fulfilled.

Retail checkout remains unverified. `prepare` returns `retail_checkout_unverified`
before navigation or cart mutation. Restaurant checkout behavior is unchanged.
A separate verified retail cart adapter is required before enabling preparation.

## Interactive catalogue failures

Shopping owner checks run before quota consumption, including on the inline tool
path. Rejected group calls remain audited without consuming the private owner's
shopping quota. Executor handlers retain their own authorization checks.

Restaurant cards are lazily rendered: their DOM indices and placeholder weights
can change on scroll. Read-only search opens a uniquely named card and verifies
the dialog title and any known weight. A default single-item placeholder can be
replaced by the actual dialog weight. Decimal supplements are parsed in kopecks;
selected supplements are subtracted before rounding the base estimate upward.
Checkout still verifies the current cart and requires the existing approval flow.

Search inspects at most three matching dialogs and stops starting inspections
after 25 seconds; an in-flight bounded operation can finish after that threshold.
A missing dialog stops the scan. `search_incomplete` blocks further catalogue
calls and follow-up scheduling in the same trusted request scope (request, role,
chat, owner). This state expires after 15 minutes and is bounded to 512 entries.
A new owner request has an independent scope. The agent should immediately report
verified restaurant results and identify prices it could not verify.
