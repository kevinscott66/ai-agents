# Native panel integration

All nine existing Mini App sections are bundled in the iPhone app through a local WKWebView. Existing forms and server action controls are retained. The native bridge accepts only bounded GET/POST data requests to explicit panel routes on the paired HTTPS server, rejects redirects, limits responses to 4 MiB and keeps the bearer in Keychain. Remote navigation never receives bridge access. CSP prevents external scripts, frames and browser network requests. Native authentication requires the existing owner ACL plus the separate panel allowlist; admin checks remain server-side.

Native content uses system typography, monochrome semantic colors, 44-point controls, rounded surfaces and a translucent section rail. The surrounding navigation is SwiftUI. Changes refresh every 15 seconds while visible; this is not SSE. Bundled assets build with `bun run build --mode native`; `ios/build-unsigned.sh` runs it before packaging. Telegram build remains separate.

HIGH gate review dispatch: bounded security/iOS specialist and independent reasoning review of bridge + authentication decisions, mandated by shared QUALITY_GATES. Available existing Codex reviewer; same family, no cross-family claim. Context: this document + diff and changed files only, approximately 4k tokens. Soft 5k / max 7k tokens. Read-only, no secrets or network. Output concrete findings or PASS; stop after scope is covered. Initial backend/frontend typechecks, native build and protocol/ACL targeted tests PASS; full suite and simulator acceptance in progress.

## Validation and review resolution

Full backend suite: 7244 passed, 39 skipped, 0 failed, 21329 assertions across 847 files. Backend/miniapp typechecks, Telegram/native builds and Swift API/chat/path-boundary fixtures passed. Unsigned device and debug simulator builds passed. Simulator executed the local main module and lazy Dashboard/Mac modules, exercised bridge error delivery, and rendered the native panel. This is not a live authenticated phone test.

Both bounded reviewers passed after confirmed P2 fixes: preserve known mutation results after UI timeout; native resource timeout 15s below JS20s; ambiguous mutation outcomes require checking state before retry; replace fabricated SSE payloads with explicit refresh callbacks. Native AbortSignal does not immediately cancel Swift requests; resource timeout and view teardown bound them.

WebKit bridge uses [Apple WKScriptMessageHandlerWithReply](https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply). No production credential was issued or copied for simulator validation.
