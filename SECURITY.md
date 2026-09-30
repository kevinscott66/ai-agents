# Security Policy

## Reporting a vulnerability

Please report security issues privately to **hello@dobropalm.tech** or via
Telegram [@dobropalm](https://t.me/dobropalm). Do not open a public issue for
an unpatched vulnerability.

Include a description, affected version or commit, and reproduction steps.
Expect an initial response within 72 hours.

## Scope

This repository publishes application source and deployment templates, not a ready-to-use hosted account. Credentials, OAuth sessions, signing keys and personal databases must remain outside Git. See `agent/.env.example` for configuration names; never place real values in issues or pull requests.

Do not assume every domain, account name or historical example in source is a fictional placeholder. Public source is not an authorization to probe third-party services or production systems. Report any suspected credential exposure privately without repeating the secret.

## Hardening notes

- Deployment templates include non-root operation, `ProtectSystem=strict` and
  bounded writable paths. Verify the actual unit and host configuration; templates
  alone are not evidence that every deployed service uses those protections.
- Tool execution is fail-closed: an unrecognised permission resolves to deny.
- Actions marked risky require an explicit human approval before dispatch.

- External MCP access must use scoped credentials and an explicit tool policy.
  The GitHub adapter is restricted to read operations in a configured repository.
- Client-side confirmation text is not authorization. The server verifies owner,
  permission and applicable approval/signature requirements.
- Passing tests or a limited security review does not guarantee that the system
  has no vulnerabilities. Browser adapters and dependencies require ongoing review.
