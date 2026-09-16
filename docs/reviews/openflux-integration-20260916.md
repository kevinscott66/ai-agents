# OpenFlux integration

Status: IN PROGRESS. Scope: optional embedded iOS tunnel for native chat and panel URLSession requests; no backend or VPN port changes.

Risk: HIGH (network routing/credential boundary). Required review: security specialist and independent reasoning review after deterministic checks. Available executor: Codex collaboration agent, same family; no claim of external model. Review pack: only new iOS network code, API/Panel request diff and vendored core changes. Budget: focused diff review, maximum three cycles. Stop: no HIGH/CRITICAL, device/simulator compile and regression gates passed. Real carrier whitelist acceptance remains external.

Source: user's local OpenFlux working tree based on a8a8937c59fbb275603bd53e150ecaf46e92148e, including uncommitted mobile support; original untouched. No configuration/credentials copied into public source.

## Outcome

Implemented 0.1.10(11). Deterministic gates: Go `go test ./...` PASS (SOCKS stream boundary, malformed Yandex config and idempotent stack disposal); `python3 ios/tests/run.py` PASS; Release iPhone and arm64 simulator builds PASS. Actual simulator HTTPS health through user's existing OpenFlux document PASS. No real command/approval/payment executed. Carrier-specific whitelist acceptance NOT RUN.

Specialist flux_security identified/fixed Yandex panic, socket disposal and reconnect backoff. Parent fixed SOCKS framing bounds and tunnel disposal. Independent flux_final_review PASS, including follow-up on disposal and pending-request network settings. No confirmed remaining HIGH/CRITICAL in scoped integration.

MAX deliberately not exposed due to incomplete original signaling/status. Original OpenFlux tree unchanged. IPA has notices, no private document or debug probe. SHA256 ff8e428420c26ece59ba0e827bb3d3f694e0bbcca30525aa34e661ecb14b30fa. Private iCloud delivery includes corresponding source archive. Server/Mac deployments unchanged.

Publication status: staged source ready on codex/native-release based on aba3b3d9. Automatic review rejected combined commit/push because prior public publication consent did not explicitly cover this separate OpenFlux project. Neither command ran. Required async approval is pending; do not retry public upload without explicit consent. This detailed report remains local, as does docs/openflux-ios.md.
