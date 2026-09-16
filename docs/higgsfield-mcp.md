# Higgsfield MCP image provider

`GENERATE_IMAGE` accepts `provider: "higgsfield"` in addition to default OpenAI. Both providers retain the existing role gate, approvals and rate limits. Higgsfield currently generates one image with GPT Image2.5, 1k resolution; video/audio generation is not exposed by this integration. Files/images may be sent to native chats using existing SEND_DOCUMENT/SEND_PHOTO tools. Neither arbitrary files on the server nor arbitrary MCP tools are exposed.

The fixed official endpoint is https://mcp.higgsfield.ai/mcp (verified against https://higgsfield.ai/mcp). Initialization and tool calls use JSON-RPC over Streamable HTTP with bounded JSON/SSE responses. Only generate_image, jobs_wait and balance are client operations. Provider output URLs are HTTPS and downloaded through public-address validation, pinned DNS, no redirects and a10MiB ceiling; access tokens never go to image hosts.

## Private deployment configuration

- HIGGSFIELD_CREDENTIALS_FILE: absolute private JSON credential file, mode0600, in an ignored runtime-data directory excluded from code snapshots.
- HIGGSFIELD_OWNER_USER_ID: existing owner ID; only that personal chat can use this account.
- HIGGSFIELD_MAX_IMAGE_CREDITS: preflight ceiling per image, default10.

OAuth is provided by official Higgsfield CLI. Use its default callback port (8765); this installed client's custom redirect ports are not registered. Token refresh uses official Clerk endpoint and the CLI's public client ID, coalesces concurrent requests and atomically replaces the private file. Do not put tokens in .env, source, logs, IPA or deliverable archives. Existing local CLI and server should use separate sessions if used concurrently.

A cost-only request must return a finite price below the configured ceiling before a submission. Revalidate live native turn/device after preflight and after token refresh immediately before submission. A transport timeout never automatically resubmits or changes provider. Returned job IDs are polled; after timeout/error the owner checks Higgsfield Assets before creating another job. Server restart marks in-flight native generation interrupted; no automatic paid replay. Optional higgsfieldBilling=credits/unlimited is forwarded only after explicit user choice; omitted normally, so a provider billing-choice response stays visible.

## Limits and verification

The new UI shows actual tool execution, not vendor percentages or fabricated partial images. Media metadata persists in synchronized history; binary retention/quota follow native-media-voice.md. Tests isolate databases and mock vendor network to verify spend/revocation/timeout boundaries; live initialization and cost preflight are separate read-only checks.

## Activation 2026-09-16

Owner explicitly authorized credential transfer and private storage on vps72. Provisioned service-only credentials, configured owner scope and10-credit ceiling, restarted idle service. Live initialization, balance and cost-only preflight passed (1 credit for medium1k); no generation submitted by activation check.11 application API routes returned200 and Mac online. Credential refresh persists on VPS; avoid concurrent local reuse of the transferred session.
