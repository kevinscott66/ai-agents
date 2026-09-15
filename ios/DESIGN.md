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

The bridge uses the paired Keychain credential without exposing it to scripts. Six live data sections refresh every 15 seconds while visible and not editing; older Logs pages are retained. Settings, permissions and wiki are loaded on entry and keep their existing explicit refresh behavior.
