# Owner-authenticated office integration

The office reuses the existing paired-device owner identity, `/api/web/` same-origin boundary, durable native turns, conversation memory and approval execution. It never fabricates Telegram initData, reads credentials from the browser store, or grants new tool permissions.

## Addressing and projection

`NATIVE_OFFICE_ENABLED=true` enables authenticated `GET /api/native/office` and explicit `agentKey` on native turns (also available through `/api/web/`). Twelve callbacks registered from the actual running bots execute their existing native message handlers. Non-Lead routing uses the registered bot username and a server-created mention entity; the prompt/history keep the original user text. Missing, paused or disabled roles fail closed. The existing implicit-Lead native/iOS path remains supported.

The selected role is bound atomically to both turn and conversation. Duplicate IDs include role in their fingerprint. Changing role, device, text, media or conversation cannot replay an accepted request. Nonempty legacy conversations belong to Lead. Owner-wide single-turn concurrency remains unchanged. Delegated replies retain their actual author, and native owner/turn/conversation context continues to govern approval and memory scope.

The projection describes **office/native requests only**, not all Telegram work, tool execution or processes. Availability means a registered, permitted handler. Running turns show THINKING; actual durable terminal states show DONE/ERROR. File, branch, progress and test telemetry remain unknown. Polling reads persisted metadata; it does not invoke a model or tool. The client does not switch to mock data on failure.

The UI keeps the device token in memory. Disconnect and revocation clear state; late responses cannot reenter another session. Uncertain turn submission preserves the same ID for an explicit retry. Approval decisions require the existing conversation-scoped admin permission; a decision with uncertain delivery is never resent automatically. Disconnect is not cancellation of already accepted work.

## Delivery and activation

Build the office with `OFFICE_BASE=/office/ bun run build` from `virtual-office/`. Ship the resulting `dist/` to a dedicated static release directory. Set `OFFICE_STATIC_DIR` to that absolute directory. `agent/lib/office-static.ts` serves only allowed compiled assets at `/office/`, with a same-origin CSP. The existing `/chat/` and Mini App remain independent. The UI uses the already configured HTTPS `WEB_APP_ORIGIN`; no additional CORS origin or DNS record is necessary. Local Vite demo has no live API proxy; browser integration tests use controlled routes.

Activation requires review and an explicitly approved exact commit per the local access policy. The local handoff and component deployment manifest record operational activation and owner-pairing status. Before delivery compare tracked production files against the candidate. If unrelated code has advanced independently, preserve it: use a reviewed scoped installer for the six office runtime files, with the existing pre-deploy smoke, shared deployment lock, verified old/new hashes and complete rollback copies before mutation. Configuration rollback restores only the two office keys, and the component-specific manifest must not claim the entire mixed server matches the office commit. Verify health, public static delivery and unauthenticated API denial before releasing the lock. Use the existing reviewed backend deployment procedure; don't copy runtime databases or credentials. Run migrations through the normal NativeAccess initialization. The two added role-binding tables contain derived routing metadata only.

After activation: open `/office/`, enter a fresh owner code obtained using `/pair_native`, inspect all role availability, send one harmless role-addressed request, confirm the actual reply author and durable history, then verify disconnect/reconnect. Do not run twelve paid model calls just to animate the office. Public static files may be served before pairing; all owner data and commands require the device credential.

Rollback: disable `NATIVE_OFFICE_ENABLED`, restart the existing service through its normal deployment mechanism, and restore the previous static release path if necessary. Existing native/iOS implicit-Lead requests and Telegram/Mini App keep their prior contract; leave additive role tables in place. Never replay uncertain side effects during rollback.

## Verification

Targeted tests cover owner isolation, actual role dispatch callbacks, turn idempotency, cross-role conversation conflicts, owner concurrency, disabled flag, token revocation, binding deletion, static traversal/CSP, live UI role selection, uncertain submission and reconnect during an unresolved request. Full backend CI runner and office browser suite results are recorded in CURRENT_STATE and implementation status. Independent same-family security review found two correctness issues (binding cleanup and reconnect sending state); both were fixed with regression coverage. No production activation or paid-model end-to-end success is claimed before the owner-paired live smoke test.
