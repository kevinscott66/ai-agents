# Агент — iPhone design specification

## Direction and sources

A personal assistant with one conversation as its home. User request: ChatGPT-like visual restraint plus native Liquid Glass.

- [Refero: ChatGPT DESIGN.md](https://styles.refero.design/style/52a007ed-ad1b-46a6-bd44-b76f91df6d0c), consulted 2026-09-15. Adapted principles: grayscale surfaces, system type, fine separators, and content-first conversation. This is an original native-app specification, not a copy of Refero's export.
- [Apple: Applying Liquid Glass](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views). Use system glass for controls and navigation, keep reading surfaces clear.
- Higgsfield MCP: generated a three-screen concept with `gpt_image_2_5`, job `41a4f809-399a-4324-9f01-7ef258e82614`. Result is displayed in the conversation's generation widget. [Concept](https://d8j0ntlcm91z4.cloudfront.net/user_3HrR2l1oExzobVERy9hGqOEigBg/hf_20260915_141055_41a4f809-399a-4324-9f01-7ef258e82614.png). The executable UI remains SwiftUI; generated imagery is a reference, not a background pretending to be an interface.

## Native tokens

| Role | Implementation |
|---|---|
| Canvas | `systemBackground`, follows light/dark mode |
| Content surface | `secondarySystemBackground` |
| Main ink | `.primary` |
| Secondary ink | `.secondary` |
| Hairline | primary at 10% opacity, 0.7 pt |
| Typeface | SF system; body 17 pt, secondary 15 pt, welcome 30 pt semibold |
| Spacing | 4, 6, 10, 14, 18, 22, 26 pt |
| Composer | radius 30 pt; native regular glass |
| User bubble | radius 24 pt, flat secondary surface |
| Primary action | 40 pt circle within a >=44 pt hit area |

## Screens

### Conversation

Top navigation: menu, title «Агент», write button. Empty state has a modest centered question and three suggestions. No marketing banner, large brand badge or permanent tab bar. User messages align right in gray bubbles; assistant messages occupy the reading surface directly. Copy, speak and stop-speaking controls follow each answer. The app stays a single conversation with the existing lead; no fake model selector or fake new-thread action.

### Composer

Anchored above the keyboard using `safeAreaInset`. Plus opens actions. Microphone transcribes into an editable draft; the user sends it explicitly. Empty primary button starts dictation; nonempty primary button sends. Pending turns block a second send; recovery controls appear only when relevant. Glass has a solid-surface alternative for Reduce Transparency, and material fallback before iOS 26.

### Actions and connection

Native sheets with a drag handle, clear title and Done. Work shortcuts prepare editable requests. Taxi resolves and previews addresses before leaving for Yandex Go. Transfer data stays on-device; bank confirmation occurs in T-Bank. Connection uses one-time pairing plus a device token stored in Keychain.

## Interaction and accessibility

44 pt minimum control target; system text sizing where practical; VoiceOver names for icon-only controls; 0.2-second scroll transition disabled with Reduce Motion. No glass over message text. No reliance on color alone for errors or progress. Both light and dark mode must remain readable.

## Visual acceptance

- Verify empty chat, typed composer, long reply, actions sheet and connection sheet at iPhone width.
- No clipped safe areas or keyboard obstruction.
- Native glass on iOS 26; fallback on supported older iOS.
- A successful unsigned device build is a packaging result, not proof of signed-device installation or production connectivity.

## Reviewed interaction details (2026-09-15)

- Microphone permission callbacks are generation-scoped: Stop/background/shortcut selection cannot resume old dictation.
- Old cancelled HTTP requests cannot reset a newer turn's progress state.
- Recovery keeps the original request server even when connection settings change.
- Connection edits are staged until successful pairing; fields are disabled during pairing.
- Primary send/dictation action has a 44 pt hit target.
- Native protocol and chat-race regression fixtures run with `python3 ios/tests/run.py`.

## Embedded team panel

Menu → «Панель команды» opens all nine Mini App sections inside a full-height native navigation sheet. The existing interface is bundled in the IPA and restyled with monochrome SVG icons, system typography, 44-point controls, rounded content surfaces and a translucent section rail. SwiftUI owns outer navigation; WebKit renders the shared panel forms. No Telegram launch is required. Light/dark follows iOS. Connection errors use a neutral actionable card.

Since 0.1.28 the panel uses the same tokens as the SwiftUI screens: iOS system colors (systemBackground, secondarySystemBackground, secondaryLabel, separator), SF 17 pt body and 30 pt semibold titles, flat 24 pt surfaces without borders or shadows, grouped-list section headers (13 pt, secondary, no tracking) and sentence-case status capsules in Russian. Styling lives in `agent/miniapp/src/native.css` and applies only inside the app, not in the Telegram Mini App.

The bridge uses the paired Keychain credential without exposing it to scripts. Six live data sections refresh every 15 seconds while visible and not editing; older Logs pages are retained. Settings, permissions and wiki are loaded on entry and keep their existing explicit refresh behavior.

## Dialog history and Mac launch (0.1.3)

Compose starts a separate dialog. Menu lists synchronized titles/dates; «Предыдущие сообщения» loads older messages while retaining loaded pages during refresh. Another device's active turn is explained with a text status. Connection switching is disabled during pending work.

Mac adds a project/task form with a single submission button. It preserves input on rejected local submission and directs accepted requests to chat for results and confirmations. Status cards use a full-width wrapping name row, with metadata and the status badge below; this removes one-letter truncation at iPhone widths.

### Confirmation refresh lifecycle (0.1.5)

The polling task is keyed by server and active ScenePhase so an initial inactive capture cannot keep refresh disabled. Completing a lead turn triggers an immediate confirmation refresh. Refresh failures expose a Retry action. A reported missing Mac confirmation was verified pending on the server for the paired owner; no approval was executed during diagnosis.

### Ambiguous decision recovery (0.1.6)

A decision POST may time out while the server awaits a long Mac action. The client freezes submission and reconciles unresolved IDs using owner-scoped approved/failed/rejected lists. Approved means decision accepted, not execution complete; later failure remains visible. Identity checks still apply and no POST is retried. Regression covers timeout → approved → failed with an unchanged POST count.


## Confirmation result placement

An approval card contains action parameters and decision/execution status. The result is a separate assistant message immediately below the card, with normal text selection, copy and speech controls. Its server archive identity links it to the correct conversation across devices. Completed cards use “Подтверждение действия”; output never appears as secondary text inside the card. Conversation menus load older pages on demand.

## Readiness polish (0.1.9)

Previous-history loading preserves its anchor; only an appended tail triggers scrolling down. Leaving a dialog/account or opening another sheet stops dictation. Rejected sends restore the draft instead of leaving permanent recovery controls. Interrupted approvals explicitly describe uncertainty and stay noninteractive. Action parameters use human-readable labels while hiding internal metadata. Transfer copy confirmation resets after editing, and the amount must be a complete positive decimal with at most two fractional digits.

## Image generation and assistant attachments (0.1.12)

Refero's [ChatGPT style reference](https://styles.refero.design/style/52a007ed-ad1b-46a6-bd44-b76f91df6d0c) was revisited 2026-09-16. Adapted principles remain grayscale chrome, system typography and subtle separators. Native image cards use the app's existing rounded surfaces rather than copying web layout measurements.

Only a running server generation creates the 280-point image canvas: low-contrast moving grayscale shapes with a restrained shimmer, followed by “Создаю изображение…”. There is no invented percentage or simulated partial output. Reduce Motion and inactive scenes stop the movement. Failure and interruption replace motion with a static symbol and explicit status; completion removes the waiting card and reveals the authenticated image with a short transition. Completed results remain ordinary assistant content outside confirmation cards.

Assistant image previews decode to at most1200pixels; tapping opens QuickLook and system sharing/saving. Other attachments use file rows. Expired downloads retain their history label and show an error instead of an empty frame. Polling and restored history use stable message IDs so reconnecting cannot duplicate media or replay speech.

Higgsfield MCP is a real optional generation provider, not a decorative animation service. The same loading component works for OpenAI, Higgsfield and SVG generation. DEBUG-only generation preview is excluded from Release.

## Mac executor fallback

The Mac form retains the selected initial executor. New Claude Code launches default to allowing Codex only if Claude is unavailable before task execution. Unchecking the control forces Claude. Selecting Codex disables fallback and explains that Claude requires a separate selection and confirmation because its permissions differ. The native bridge accepts an explicit boolean; old requests without the flag keep fallback disabled. Approval details name the first executor and describe the pre-start boundary; results identify the actual executor separately.

## Accepted confirmations and OpenFlux shortcut

An approval card disappears after a validated server acknowledgement or an approved/completed polling record. The model retains the approval for reconciliation; its result remains a separate assistant message. Unacknowledged decisions, failed and interrupted execution retain recovery status cards, with no automatic POST retry.

The chat navigation bar includes a compact “OF” power button with a 44-point target and a spoken on/off state. It toggles the existing Keychain configuration and resets the transport; it never retries chat mutations. Enabling without valid configuration opens OpenFlux settings. The indicator represents the saved setting, not verified connectivity, and refreshes after settings changes and foreground entry.

## Chat memory, projects and role attribution

Menu → «Память диалога» opens a native list for the selected conversation. It shows the distilled facts, decisions and tasks, with collapsible source message references. Projects are created and assigned explicitly by the user; «Без проекта» detaches the chat. Approved project entries appear separately from chat entries. Proposals display their exact text with independent «Принять» / «Отклонить» actions; a chat entry can also be proposed explicitly. Creating a project does not silently move the current chat.

The view pins its account credential for its lifetime. Mutations are never automatically retried: an uncertain response disables further writes until an explicit successful GET refresh reconciles the snapshot. A failed refresh after a successful mutation also keeps writes disabled. Loading, empty, unavailable and saving states use the existing grayscale system surfaces and readable inline text.

Team replies show a restrained role heading from verified message metadata, preserved through turn polling and history loading. Missing or unknown metadata retains the generic assistant label; the UI does not infer role names from message text or fabricate discussion participants. Existing media, copy/speech and confirmation behavior is retained.
