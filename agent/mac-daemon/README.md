# mac-daemon (Stage A)

A Bun script that connects to the agent-team backend over WebSocket, receives `MAC_RUN_CLAUDE` commands and launches the local `claude` CLI in an allowed project, streaming stdout/stderr back.

## Requirements

- Bun >= 1.1.
- `claude` installed in PATH, or configured through `CLAUDE_BIN`.

## Environment

| Variable | Purpose |
| --- | --- |
| `MAC_BRIDGE_URL` | Backend WebSocket URL, such as `ws://localhost:8788` |
| `MAC_BRIDGE_SECRET` | Shared secret, at least 32 characters, matching the backend |
| `MAC_PROJECT_ROOTS` | Comma-separated absolute roots allowed for `project` |
| `CLAUDE_BIN` | Optional executable path; defaults to `claude` in PATH |
| `MAC_BRIDGE_INSECURE_PLAINTEXT` | Set to `1` to permit non-loopback `ws://`; disabled by default |

### Bridge URL and authentication

Mutual HMAC authentication uses random nonces without transmitting the secret. Commands and results are signed separately per direction, connection and sequence number. Startup validation in `bridge-url.ts` permits `wss://`, or `ws://` only for loopback (`localhost`, `127.0.0.0/8`, `::1`). Other addresses fail startup with a diagnostic.

For a separately encrypted transport such as SSH or Tailscale, non-loopback plaintext can be explicitly permitted with `MAC_BRIDGE_INSECURE_PLAINTEXT=1`. Replacing a local listener cannot forge authenticated commands/results without the key. HMAC does not encrypt content; confidentiality requires TLS or an SSH tunnel.

### Protocol upgrade

Update the backend, including `mac-daemon/auth-handshake.ts`, before the daemon. The new daemon does not fall back to the old handshake. Then set backend `MAC_BRIDGE_ALLOW_LEGACY_AUTH=false` and restart to disable old-client compatibility. Rollback requires coordinated versions.

The CLI uses its own process group. Cancellation/timeout sends SIGINT, followed by SIGKILL after a grace period, including remaining shell/tool children. macOS EPERM for a group containing only zombies is treated like ESRCH rather than crashing cancellation (#42).

## Manual startup

```bash
cd mac-daemon
MAC_BRIDGE_URL=ws://localhost:8788 \
MAC_BRIDGE_SECRET=$(cat ~/.config/mac-daemon/secret) \
MAC_PROJECT_ROOTS=/absolute/path/to/projects \
bun run start
```

## launchd installation

Save the following as `~/Library/LaunchAgents/com.dobropalm.mac-daemon.plist`, replacing the project paths and secret:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dobropalm.mac-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string><string>run</string>
    <string>/absolute/path/to/ai_agents/agent/mac-daemon/daemon.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MAC_BRIDGE_URL</key><string>ws://localhost:8788</string>
    <key>MAC_BRIDGE_SECRET</key><string>REPLACE_WITH_AT_LEAST_32_CHAR_SECRET</string>
    <key>MAC_PROJECT_ROOTS</key><string>/absolute/path/to/projects</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/mac-daemon.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/mac-daemon.err.log</string>
</dict>
</plist>
```

Load:

```bash
launchctl load -w ~/Library/LaunchAgents/com.dobropalm.mac-daemon.plist
launchctl list | grep mac-daemon
```

Unload:

```bash
launchctl unload ~/Library/LaunchAgents/com.dobropalm.mac-daemon.plist
```

## Stage B security

- Five application modes map to four CLI `--permission-mode` flags: `ask` → `default`, `accept_edits` → `acceptEdits`, `auto` → `acceptEdits`, `plan` → `plan`, `bypass` → `bypassPermissions`. The flag is used because `sanitizeChildEnv` would strip an environment override. `auto` is an alias of `accept_edits`, not a mode bypassing `MAC_ALLOW_BYPASS`; see `toPermissionMode` in `protocol.ts`.
- Bypass requires backend `MAC_ALLOW_BYPASS=true`.
- The backend checks prompts against CSV regexes in `MAC_DENIED_PROMPT_PATTERNS`.
- `MAC_STOP` sends SIGINT to all active Claude processes, escalating to SIGKILL after `KILL_GRACE_MS` (5 seconds); see `kill.ts`.
- `MAC_PROJECT_ROOTS` is the sole path allowlist. Paths outside it are rejected before spawning.
- One WebSocket is active at a time. Disconnect terminates children with SIGINT/SIGKILL and reconnects after 1, 2, 5 and then 10 seconds.

## Codex sessions

The app's Mac form selects Claude Code or Codex. The existing `MAC_RUN_CLAUDE` action accepts `provider: "claude" | "codex"` (default Claude for compatibility). Codex travels as `run_codex`; an old daemon cannot silently run Claude for this request. Deploy the backend first, then the daemon, then disable legacy authentication as described above.

Install/sign in to Codex locally (`codex login status`). `CODEX_BIN` optionally names its executable; otherwise it must be in the daemon PATH. Prompts use stdin and the same project allowlist, stream limits and cancellation handling. Codex uses `exec`: ask/plan → read-only, accept_edits/auto → workspace-write, approval policy never (headless), network access for workspace commands disabled. User config and execpolicy overrides are ignored for this controlled invocation. Authentication still belongs to the local Codex installation, not daemon environment credentials. Codex bypass is rejected; there is no fallback to Claude on failure.

CLI reference: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode). Verified against the locally installed CLI help and a control response with production argv/sanitized environment.

## Opt-in provider fallback

`allowFallback: true` permits selecting Codex before a Claude task starts. Omitted/false preserves the original behavior. Results retain `requestedProvider` and identify the selected `provider`, plus a structured `fallbackReason` when used.

Before an eligible Claude run, the daemon checks `claude auth status --json` (5 seconds, 16 KiB maximum). Exact `loggedIn:false` permits fallback. With `loggedIn:true`, a separate readiness request checks provider availability (10 seconds, 64 KiB maximum). This sends only the fixed text “Reply only OK.” in a disposable directory; the user's task and project content are not sent. It can consume a small model request. The command disables tools, MCP, hooks, skills, session persistence, Chrome integration and filesystem settings sources. Standard local OAuth/keychain authentication remains available. Both probes are skipped when user, ancestor/project, or managed configuration selects a custom model/provider/auth helper, contains custom settings-based environment overrides, or cannot be inspected safely; the actual Claude task retains its normal configuration. Only the three non-secret inference flags `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`, `MAX_THINKING_TOKENS`, and `CLAUDE_CODE_DISABLE_1M_CONTEXT` may pass from settings into the readiness environment; other environment overrides disable probes. Configuration values are never logged.

The readiness parser requires the CLI's initialization frame to confirm empty tools/MCP and accepts only typed `assistant.error` or `system/api_retry.error`: `rate_limit` → `quota_exhausted`, `billing_error` → `billing_unavailable`, `authentication_failed` → `authentication_unavailable`. Billing failures may include an expired subscription; the daemon does not infer subscription status from freeform text. These fields follow the [official Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript). Malformed output, unknown errors, policy refusals, timeouts and model-generated text never authorize a provider switch. Unknown preflight results proceed with the original provider.

A synchronous task-spawn `ENOENT` also permits fallback only when the executable is independently absent (`executable_not_found`). Once any actual task child starts, its failures, quota errors, cancellation or timeout never replay the task with another provider. Both probes are tracked by run ID and killed on cancel/stop/disconnect; cancellation prevents a subsequent task launch. The project allowlist is revalidated after probes finish. Probe output is not forwarded or logged.

Fallback is disabled in bypass mode. Codex → Claude is blocked (`fallbackBlocked: permission_mismatch`) because Claude's permission modes cannot preserve Codex's filesystem/network sandbox. A separately requested Claude session remains possible under the normal approval flow.

Verification: local installed Claude accepted the readiness command and produced the structured `authentication_unavailable` classification with sanitized daemon environment; no raw provider output was logged. Quota/billing cases are covered with isolated subprocess fixtures, not a live exhausted account.

## Mac control (`MAC_CONTROL`)

A closed command set runs without the Claude CLI: `lock`, `sleep`, `volume`, `mute`, `unmute`, `open_app`, `reminders`, `reminder_add`, `event_add`, `shutdown`, `restart`. Both sides use the strict parser in `lib/mac-control.ts`; `macctl.ts` constructs fixed argv without a shell. Only the owner (`MAC_USER_IDS`) through the orchestrator can invoke commands.

Reminders and calendar operations, including today's calendar, are permitted from any owner chat: native app, web panel or team group. Device operations (`lock`, `sleep`, `volume`, `mute`, `unmute`, `open_app`, `shutdown`, `restart`, `open_workspace`) remain private-chat only. Reminder data requested in a group becomes visible there. Shutdown/restart always require chat approval; see `docs/approval-policy.md`.

Disabled by default. The owner configures:

- `MAC_CONTROL_ENABLED=true`.
- `MAC_APPS=alias=bundle.id,...`: the only application names accepted by `open_app`.
- `MAC_CALENDAR_ENABLED=true` for the EventKit helper.
- `MAC_CALENDAR_BIN_DIR=/absolute/path`: a stable helper directory outside release folders. macOS permission is bound to the executable path; omitting this uses the release directory and loses permission continuity after replacement.

Only the owner grants macOS permissions:

1. `sh build-calendar.sh` builds `bin/agent-calendar` and `bin/agent-calendar-run`. The launcher establishes the helper as the TCC-responsible process; otherwise Bun lacks the calendar usage description and access is silently denied. See `calendar-spawn.c`.
2. Run `bin/agent-calendar-run authorize` and `bin/agent-calendar-run authorize-reminders` through the launcher/launchd. An agent shell can make the terminal responsible instead, preventing the intended prompt.
3. `osascript` operations request Automation → System Events permission on first use. Without it, the daemon returns `automation_access_required`.

Manual check: `bun macctl.ts '{"command":"volume","level":30}'`. Only fixed error codes leave the daemon; stderr is not forwarded.

## Taxi (Yandex Go)

The `taxi` frame supports `quote`, `prepare`, `confirm`, `abandon`, `status`, `cancel`, validated by `lib/taxi.ts`. It uses installed Chrome through `playwright-core` with an isolated profile and no stealth techniques. Login/CAPTCHA returns a failure and an owner screenshot. CAPTCHA keeps the browser visible for 15 minutes (`CAPTCHA_HOLD_MS`, shared by executors) for owner completion; the agent then retries. Shopping items added before CAPTCHA are removed at the next `prepare`. Selectors live in `taxi-selectors.ts`.

Disabled by default; owner setup:

1. Use a separate Yandex account and a spending-limited card, not the primary account.
2. `cd agent/mac-daemon && bun install` installs `playwright-core`; it does not download a browser.
3. Set `TAXI_ENABLED=true`, `TAXI_PROFILE_DIR` to an absolute, current-user-owned directory with mode `700` (otherwise `profile_insecure`), optional `TAXI_HEADLESS=true`, and `TAXI_BROWSER_CHANNEL` (default `chrome`). Headless mode may trigger more CAPTCHAs.
4. `TAXI_PROFILE_DIR=… bun taxi.ts login`: the owner signs in directly in Chrome and presses Enter. The agent does not enter passwords or codes.
5. `bun taxi.ts probe` prints the accessibility tree; `bun taxi.ts quote "origin" "destination"` estimates without ordering. Adjust only `taxi-selectors.ts` if labels differ.
6. Verify `taxi.yandex.ru` opens without a regional redirect, particularly when the Mac uses a VPN.
7. Set server `TAXI_ENABLED=true`, include the owner in `MAC_USER_IDS` and `MINIAPP_ADMIN_USER_IDS`, and enroll an active app signing key.

`prepare` reads route, fare and price without ordering. `confirm` rereads price, checks the signed ceiling and clicks Order once. Preparation is single-use and expires after three minutes; browser idle timeout is five minutes.

## Delivery (Yandex Go)

The `delivery` frame uses the same operations (`lib/delivery.ts`), with `delivery.ts`, `delivery-playwright.ts` and `delivery-selectors.ts`. The page is `dostavka.yandex.ru/order/express/`. Address entry and express estimates were checked on a live profile. Courier/Cargo tariff options are not offered on that page and are rejected. Contacts and the order button were verified on 2026-09-18; comment/status selectors were still **unverified**, causing a refusal before purchase until confirmed.

1. Set `DELIVERY_ENABLED=true`; `DELIVERY_PROFILE_DIR` must be separate from `TAXI_PROFILE_DIR` and mode `700`. Shared profiles are rejected as `profile_shared` because Chrome locks them. `DELIVERY_HEADLESS` and `DELIVERY_BROWSER_CHANNEL` follow taxi settings.
2. `DELIVERY_PROFILE_DIR=… bun delivery.ts login`: owner signs in and presses Enter. Yandex supplies the sender's phone; an empty recipient phone is filled from that field without exporting it. Other missing required contacts produce `contact_required`. Owner adds payment details directly; missing payment returns `payment_needs_owner`. An identity-confirmation screen returns `data_confirm_needs_owner`; the owner enters SMS codes.
3. `bun delivery.ts probe` reports guard/contact state and accessibility; `bun delivery.ts quote "origin" "destination"` estimates. Check comment, contacts, order button and `DELIVERY_STATE_TEXT`; edit only `delivery-selectors.ts`.
4. Enable server `DELIVERY_ENABLED`, owner allowlists and an active signing key.

`prepare` reads route, tariff, comment and price; `confirm` checks the ceiling and clicks once. Session TTL is three minutes; browser idle timeout is five minutes.

## Yandex Lavka

The `shop` frame supports `quote`, `prepare`, `confirm`, `abandon`, `status` through `lib/shop.ts`. Chrome isolation, owner login and CAPTCHA handling follow taxi rules. `shop-selectors.ts` contains page selectors. Public search/product cards were verified; authenticated cart, checkout, payment and order selectors require owner verification.

Owner setup:

1. Use the separate Yandex account and spending-limited card.
2. Set `SHOP_ENABLED=true`, an isolated mode-700 `SHOP_PROFILE_DIR` distinct from taxi, plus optional `SHOP_HEADLESS` and `SHOP_BROWSER_CHANNEL`.
3. `SHOP_PROFILE_DIR=… bun shop.ts login`: owner signs in, adds delivery addresses and a payment method, then presses Enter. No saved payment produces `payment_needs_owner`. The agent does not create addresses; `set_address` selects an existing address only when exactly one label matches the request, then rereads the header. Missing/ambiguous matches close the dialog without changing the address; no address returns `address_required`.
4. `bun shop.ts quote "milk" "bread"` searches without a cart. `bun shop.ts probe` inspects the current page; manually open a populated cart, checkout before payment and order history, pressing Enter at each. Update only `shop-selectors.ts`.
5. A nonempty preexisting cart returns `cart_not_empty`.
6. Enable server `SHOP_ENABLED`, owner allowlists and an active signing key.

`prepare` adds signed items to an empty cart and reads checkout total without paying. `confirm` rereads total, checks the signed ceiling and clicks Pay once. Failure before payment removes the added items. Preparation is single-use with a five-minute TTL.

## Yandex Eats

Uses the same `shop` frame, `SHOP_ENABLED` and `SHOP_PROFILE_DIR` as Lavka. Page code is `eda-playwright.ts`; selectors are `eda-selectors.ts`. Restaurant search, header address, delivery fee, menu cards (`product-card-v2-*`), dish dialog and cart were verified on a live profile. Checkout, payment and orders remain **unverified**; failures such as `address_required`, `place_not_found`, `cart_mismatch` or `price_unreadable` stop execution before payment.

Owner verification:

1. `SHOP_PROFILE_DIR=… bun shop.ts login eda`: sign in, choose delivery address, check saved card and press Enter.
2. `bun shop.ts eda-quote "restaurant" "dish"`: search without a cart. For `place_not_found`, inspect `edaSearchUrl`, `placeLink`, `placeTitle`; for empty dishes, inspect `dishCard`, `dishTitle`, `dishPrice`, `dishMeta`.
3. `bun shop.ts probe eda`: open a restaurant, add one dish, inspect counters/minus controls, then cart, checkout before payment and order history. Press Enter at each. Verify `dishCounter`, `dishMinus`, `addressButton`, `cartRow*`, `addressDialog`, `addressRadio`, `checkout`, `pay`, `total`, `savedCard`, `EDA_STATE_TEXT`. Edit only `eda-selectors.ts`.
4. Start with an empty Eats cart. A remaining modal after Add to cart, such as a different-restaurant warning, is closed and execution rejected.

Live verification of the Papa John's dish/cart UI covered name, weight, price, quantity, option groups (`h4` hints, surcharge labels, required radio choices and bounded checkbox choices), `product-full-card-add-to-cart[-disabled]` and `product-card-row-root`. Estimates inspect up to three matching dish dialogs and return option groups. Unknown hints/surcharges exclude a dish rather than guessing. Execution selects signed options and quantity, rereads the dialog, rejects `options_mismatch`, then adds to cart.

## Yandex Market

Uses the same shopping frame, flag and profile. Selectors: `market-selectors.ts`; page code: `market-playwright.ts`. Search, product page and address were verified; cart, checkout and statuses remain **unverified** and must fail before payment until checked.

Product identity is the numeric ID in `/card/<slug>/<id>`. Estimates return `delivery_rub: null`; delivery appears at checkout and the final total is checked against the signed ceiling.

1. `SHOP_PROFILE_DIR=… bun shop.ts login market`: sign in, choose address, verify a saved card rather than pay-on-delivery, then Enter.
2. `bun shop.ts market-quote "product"`: search without a cart. Check `marketSearchUrl`/`snippet*` for empty results, and `snippetLink`/`marketIdFromHref` for missing IDs.
3. `bun shop.ts probe market`: inspect product page, cart addition, quantity controls, cart, checkout before payment and order history. Verify `productTitle`, `productOffer`, `cartButton`, `qty*`, `addressButton`, `cartItem*`, `checkout`, `pay`, `total`, `savedCard`, `payOnDelivery`, `MARKET_STATE_TEXT`; edit only `market-selectors.ts`.
4. Start with an empty Market cart. Required size/color selection returns `options_required`; upsell dialogs are closed.

## Selector repair (`SHOP_REPAIR`)

A `repair {service, code}` frame invokes `selector-repair.ts`: fresh branch from `origin/main` under `<SELECTOR_REPAIR_REPO>/.claude/worktrees/`, `bun install`, `claude --print` with a fixed task, changed-path validation, commit, push and `gh pr create`. It never merges.

- `SELECTOR_REPAIR_REPO` must be within `MAC_PROJECT_ROOTS`, with git push and gh access. Missing configuration returns `repair_disabled`.
- `bun shop.ts selfcheck [eda|market]` is read-only: opens search and reports selector counts and `data-testid` / `data-auto` / `data-zone-name` names, not page text.
- Repair closes the shopping browser; concurrent purchases return `shop_busy`.

## Code tasks (`CODE_TASK`)

`code_task {id, task: {title, goal}}` invokes `code-task.ts` in the same configured repository. It creates `claude/improve-YYYYMMDD-HHMM` from `origin/main` under `.claude/worktrees/`, runs `bun install --frozen-lockfile`, then `claude --print` with `lib/code-task.ts` constraints and the approved task.

The daemon checks git status: no changes returns `code_task_no_change`; paths outside `isCodeTaskPath` return `code_task_forbidden_paths`. Otherwise it runs `tsc`, commits only named paths, pushes and opens a PR. It never merges.

- One task at a time (`code_task_busy`); shopping browser state is untouched.
- Timeouts: preparation five minutes, executor 35 minutes, `tsc` three minutes, git two minutes.
- Response is one `CodeTaskOutcome` JSON line; executor output is not forwarded to the bridge.
- Worktrees remain on disk for owner cleanup.
