# Personal agent: execution and Russian services

Status: architecture and Lead behavior policy. This document **does not implement** a banking executor, server browser, durable-goal scheduler or universal device control. A prompt change creates neither authority nor an API.

## User experience

The user states a goal by text or voice. The agent resolves context, prepares a concrete result, asks only for material missing information, executes authorized steps and returns a verified outcome. Target requirement: one task retains identity across iPhone, web chat and office. Native conversations are already shared; a universal goal/task/turn relationship still requires implementation. Public Telegram groups receive only events intended for them, not copies of private or banking conversations.

“Order dinner home for up to RUB 1,500” requires checking the known address, preferences and budget; real menu availability and required options; the total including delivery/fees; approval of the exact order; execution and outcome monitoring. If the budget cannot be met, offer a concrete alternative before payment. Do not invent allergies or permitted substitutions.

## Existing capabilities

| Area | Implementation basis | Boundary |
| --- | --- | --- |
| Yandex Go, Eats, Lavka, Market, Delivery | `taxi.ts`, `shop.ts`, `delivery.ts`, dispatch, Mac browser, signed-actions, order-watch | Requires available Mac/profile/login and supported pages; code is not live acceptance |
| Personal T-Bank | Local iPhone details preparation and opening internet banking | No banking executor yet |
| Computer | MAC_CONTROL and MAC_RUN_CLAUDE | Supported commands, project permissions and Mac availability; not arbitrary iOS control |
| GitHub | Status reads, constrained CODE_TASK and project executor | PR, merge and production deployment have separate states/permissions |
| Servers/domains | Existing CLI/SSH through an available executor, constrained DNS actions | Each target/environment/change must be authorized; possessing a key does not grant authority |
| Memory/team | Chat-scoped tasks, native conversations, knowledge, approvals, roles | taskId, turnId, conversationId and external operation ID are distinct |

Check executor availability and service session before promising execution. A specialized-tool rejection must not be bypassed through a general shell/browser.

## Target execution model

A controller links intent, tasks, operations and approvals. Lead plans; specialists execute bounded steps. No LLM grants itself capabilities.

1. **Context:** trusted owner, source channel/visibility, goal, constraints and permitted targets.
2. **Plan:** dependencies, tools, outcome criteria, budget and deadline. Simple operations do not require lengthy plans.
3. **Preparation:** actual data, session/permission checks and a draft/quote with TTL.
4. **Authorization:** existing policy/approval/signature gates bound to exact objects and parameters. Independent safe preparation continues autonomously.
5. **Execution:** atomic operation claim, one executor, immutable approved parameters and external ID tracking.
6. **Verification:** provider status, receipt or recorded outcome rather than a model's promise.
7. **Recovery:** after timeout/restart, reconcile the existing operation. Never automatically create another irreversible operation.
8. **Completion:** evidence, remaining steps/limits and a secret-free log.

Proposed durable record, requiring separate implementation/migration: owner; goal/task/step IDs; source scope; capability ID/version; executor; immutable parameter digest; preparation expiry; approval reference; operation ID; external reference; state; receipt reference; timestamps. Do not store secrets or complete bank details here. Link existing tasks and native turns through foreign keys/link tables rather than treating them as interchangeable.

States: requires_input → preparing → prepared → awaiting_approval → ready → executing → verifying → succeeded. Additional states: awaiting_owner_in_service, unavailable, rejected, expired, failed, unknown, cancelled. `unknown` cannot trigger another submission before reconciliation. Cancellation after submission is a separately authorized operation, not a bank-transfer rollback.

## T-Bank: two phases, a separate banking adapter

The owner selected a **personal account** and a browser workflow analogous to Yandex. This is a target design, not an active banking connection.

Official [T-API documentation](https://developer.tbank.ru/docs/api/t-api) describes business/sole-trader integrations; it is not an established personal-account interface. The bank also documents [personal internet banking](https://www.tbank.ru/bank/help/interfaces/online-banking/start/enter/). Neither source guarantees stable DOM or complete automation. Adapter feasibility and permitted use require separate verification.

### Preparation

- Use a separate protected bank-browser profile, without shared Yandex sessions or a public remote-debugging endpoint. The owner signs in directly. Passwords, OTPs and cookies never go to the model, Telegram or GitHub.
- The local banking process is limited to the allowed origin and explicit active account. Origin/account changes or unfamiliar pages stop the operation.
- Resolve the recipient unambiguously by phone plus bank or account details; compare the name shown by the bank. Ask the owner when identity is unclear; never guess a matching name or bank.
- Read amount, fee, currency and total debit from the bank's review page without pressing a potentially submitting button. If no safe preparation boundary exists, automated submission is unsupported.
- Use integer kopecks, never floating-point amounts or post-signature rounding. The review card includes masked source account, recipient, bank, amount, fee, total and expiry.

### Approval and submission

- The owner signs the exact snapshot. Unlike taxi pricing, no price increase is allowed: amount, fee, recipient, currency and source account must match. Any change invalidates preparation and signature.
- Current signed-actions serve purchases. Banking needs a separate service, integer-amount validation, limits and TTL; do not reuse taxi price tolerance. Until implemented, it stays disabled without a model-callable tool.
- Persist a single-use claim before any potentially debiting action. Repeated signatures/HTTP requests must not create another transfer. An account-wide lock prevents concurrent executors.
- A bank may require its own SMS/app confirmation. Our signature does not replace it; transition to `awaiting_owner_in_service`. Do not extract OTPs from notifications or approve on the owner's behalf.
- Save the bank operation ID and reconcile that operation. If no ID or reliable match exists, return `unknown` for owner reconciliation, without retrying the transfer.
- Success requires bank evidence matching approved parameters. Store receipts separately with restricted access, never in a group chat. Do not promise cancellation of a potentially irreversible transfer.

### Acceptance before real money

Fixtures must cover changed recipient/account/amount/fee, expired preparation, invalid signature, concurrent executors, crashes before/after claim, timeout after click, delayed receipt, missing ID, duplicate webhook/command, changed owner, OTP/CAPTCHA and lost session. Ambiguous outcomes stop submission and are not retried. Inspect real DOM with the owner without transferring money, then separately authorize a specific live acceptance operation. Until then, status remains not connected.

## Server execution with the Mac offline

Coordination, memory, queues and available API work run on the server. Physical computer control needs its active local executor. Yandex browser execution currently also depends on the Mac. Moving browser services requires an isolated server worker, protected profiles and an observable owner session, not copying cookie files to a shared VPS. Never automatically migrate banking sessions there.

## Implemented policy and remaining work

Lead now has behavior rules for executor selection, minimal clarification, verified completion, no gate bypass and uncertain outcomes. Existing tool restrictions are unchanged. This is not a new durable workflow engine or proof of LLM reliability across all scenarios.

Separate implementation areas: read-only capability/readiness inspection; durable operations and reconciliation; fixture-tested bank adapter; secure browser worker; linked goal/task/turn/approval UI. Configuration-level capability discovery has since been added; see [tools and MCP](TOOLS_AND_MCP.md), which distinguishes configuration from readiness. Each area requires independent checks and concrete acceptance. Until then, the agent uses connected tools and reports actual boundaries.

The official [Yandex Go API](https://yandex.ru/dev/taxi/taxicorp/) targets corporate clients. The reviewed [Yandex Eats API](https://yandex.ru/dev/eda-vendor/doc/ru/ref/) serves partners, not consumer carts. Browser workflows must not be presented as a connected public consumer API.

## Persistence instead of premature refusal

Lead should find and execute a working route: inspect tools/docs/code, choose API/browser/CLI/specialist, resolve technical failures and verify results. Within authorization, use development tools to prepare a missing adapter. Absence of a ready-made button is not grounds to abandon a task.

Stop only for a verified blocker: owner login, mandatory approval, a material missing choice, an unavailable physical executor or exhausted runtime budget. Complete independent preparation first, then report the actual state and one concrete next step. Alternatives cannot bypass permissions, signatures, limits, publishing restrictions or an unknown payment outcome. This behavior policy does not itself implement new executors or guaranteed background resumption.
