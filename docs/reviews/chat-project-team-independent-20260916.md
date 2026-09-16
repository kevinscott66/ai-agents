# Independent chat/project/team review — 2026-09-16

Scope: current native knowledge, API/access/context, native handoff and approval restoration, role prompts, native tool boundaries, and private iOS knowledge/role metadata changes in agent-native-release. Same-family Codex independent inspection; no external-model claim.

## Findings and resolution

- Project entries had chat-local IDs used as global SwiftUI identities. Reviewed correction: sourceConversationId plus entry ID now supplies projectIdentity and the shared-project ForEach uses it.
- AgentAPI checked credentials before asynchronous OpenFlux startup, permitting an old-token POST after a token switch during startup. Reviewed correction: credential revalidation immediately before transport, after response headers, and after response body. KnowledgeModel reconciles ambiguous writes via GET and does not repeat POST.
- Reviewed native lead delivery guard now checks live device/owner, enabled flag, and running turn. Native LIST_RECENT_MESSAGES dispatch now refuses Telegram history; global wiki tools return only trusted-ingress scoped memory and native WRITE_WIKI refuses mutation.

No remaining confirmed HIGH/CRITICAL finding in scoped memory owner/conversation isolation, explicit project acceptance, revision CAS, role attribution, shared invocation budget, or restored native approval transport.

## Independent executed checks

- 17 tests / 100 assertions PASS: native-knowledge, native-knowledge-runtime, native-knowledge-api, native-team-dialogue, native-approved-delegation.
- Follow-up 9 tests / 49 assertions PASS: native-pipeline, native-knowledge-api, native-team-dialogue, native-approved-delegation after concurrent boundary corrections.
- `python3 ios/tests/run.py`: exit 0; protocol/role metadata, chat state, panel, approval, OpenFlux boundary, speech text and KnowledgeModel fixtures PASS.

## Limits / scope decisions sent to root

- Deterministic mocked inference proves plumbing and truthful stored speaker attribution, not real-provider answer quality or compliance with discussion-only prompts. No live provider, simulator/device UI, external message, commit or deployment performed.
- Root owns full backend suite, TypeScript and complete iOS build verification.
- Resolved on follow-up: native transport now allows explicitly listed read-only methods and native sendMessage/sendChatAction only. Implicit Telegram mutations, raw callApi and token exposure fail closed; media uses the native sink. Independent mutation-counter regression passed.
- Resolved on follow-up: compactor liveness now also checks NATIVE_APP_ENABLED. Device revocation, owner checks and app disabling block stale completion writes.
- Follow-up independent transport/runtime/approved-delegation checks: 10 tests / 60 assertions PASS.

## Final bounded recheck

Reviewed `shouldAutoPropose` and runtime wiring: accepted/rejected matching kind+text for the same project/chat/entry suppress automatic offers, source-ID-only changes do not bypass rejection, manual proposals remain available, changed content can be proposed, and rejection rows are owner-scoped through snapshot checks and bounded to 100 per project. Project deletion removes rejection rows. Independent storage/runtime run: 12 tests / 72 assertions PASS.

Final verdict: PASS for this scoped independent review; no unresolved HIGH/CRITICAL findings. Root retains full-suite/build/release responsibility.
