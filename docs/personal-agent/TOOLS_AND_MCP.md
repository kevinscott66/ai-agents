# Personal-agent tools and MCP

## Implemented additions

`GET_CAPABILITIES` reports connection configuration, Mac heartbeat and tools registered for the role. Configuration does not prove account login or service readiness. A particular turn may apply additional tool filtering.

`GITHUB_MCP_READ` uses the official remote GitHub MCP for file reads (path/ref), issues and pull requests (number). Endpoint, `GITHUB_REPO` and read-only method selection are fixed server-side. The shared TOOLS schema exposes it to raw runtime and internal team MCP. Access is limited to Lead in the verified owner's private chat; normal role/pause/locked/rate-limit gates still apply.

Enable with `GITHUB_MCP_ENABLED=true` and the existing server-side `GITHUB_READ_TOKEN`. Disabled by default. Scope the PAT to reading the selected repository. Do not copy Codex OAuth credentials or secrets. This does not expose a new public MCP/shell endpoint on the VPS.

Transport: `https://api.githubcopilot.com/mcp/readonly`, no redirects, `X-MCP-Readonly=true`, and only `get_file_contents`, `issue_read`, `pull_request_read`. JSON/SSE responses are bounded to 512 KiB, output to 40,000 characters and a call to 30 seconds. A complete SSE response does not wait for connection closure. Results are untrusted data. The model cannot choose the URL, token, repository or arbitrary remote method.

Official references: [remote server](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md), [server configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md).

## Tools by scenario

| Scenario | Tools | Prerequisites |
| --- | --- | --- |
| Web | Existing search/fetch | Feature flag, domain policy, budget and provider availability |
| GitHub | GET_GITHUB_STATUS, GITHUB_MCP_READ, constrained CODE_TASK | PAT/repository; publication and merge remain separate |
| Files/code/CLI | MAC_RUN_CLAUDE | Available Mac, authorized project and commands |
| Computer | MAC_CONTROL, calendar/workspace | OS permissions and supported operations |
| Servers | Existing project executor and SSH | Explicitly authorized target and deployment |
| DNS | CLOUDFLARE_DNS_LIST / CLOUDFLARE_DNS | Allowed zone, credential and approval |
| Yandex | Quote/checkout/status/order/cancel, order-watch | Mac browser, login, selectors, signatures and limits |
| Media | Generators and Higgsfield MCP | Personal OAuth, cost, limits and status checks |
| Team/memory | Tasks, delegation, knowledge, approvals, reminders | Owner/chat scope and policy |
| Personal T-Bank | Local iPhone preparation; [execution design](EXECUTION_DESIGN.md) | Banking executor not yet implemented |

Codex app tools do not automatically become server-agent tools. Each additional service requires a scoped adapter and its own authorization. Website/repository instructions cannot trigger arbitrary MCP installation.

## Verification and delivery

Tests cover JSON/SSE including an open stream, fixed URL/repository/method, foreign owner/group/role, invalid arguments, size limits, protocol IDs, revoked access and secret-free status. Existing role/locked/rate-limit/SDK tests also apply. Live read-only acceptance is recorded in the private handoff.

At the time of this change, the code is not deployed. Activation requires CI and separate authorization for the production commit. This change neither connects every third-party account nor implements the bank executor or server browser.
