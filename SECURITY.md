# Security Policy

## Reporting a vulnerability

Please report security issues privately to **hello@dobropalm.tech** or via
Telegram [@dobropalm](https://t.me/dobropalm). Do not open a public issue for
an unpatched vulnerability.

Include a description, affected version or commit, and reproduction steps.
Expect an initial response within 72 hours.

## Scope

This repository contains application source only. It ships no credentials:
every secret is supplied at runtime through environment variables documented
in `agent/.env.example`. Host names, IP addresses and account identifiers in
source, tests and deployment scripts are placeholders, not live infrastructure.

## Hardening notes

- The systemd units in `deploy/` run the service as a non-root user with
  `ProtectSystem=strict` and an explicit `ReadWritePaths` allowlist.
- Tool execution is fail-closed: an unrecognised permission resolves to deny.
- Actions marked risky require an explicit human approval before dispatch.
