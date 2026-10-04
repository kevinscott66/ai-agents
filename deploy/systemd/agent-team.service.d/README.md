# Codex service storage

When agent-team uses Codex with `CODEX_AUTH_HOME=/var/lib/agent-codex`, install
`95-codex-storage.conf` under `/etc/systemd/system/agent-team.service.d/`, then
reload systemd and restart the service through the deployment workflow.
The directory must already exist, owned by agent-team with mode 0700.

`ProtectSystem=strict` otherwise makes it read-only inside the service, even when
an interactive probe under the same Unix user succeeds. Codex then exits before
inference with `failed to initialize in-process app-server client: Read-only file
system`. Check from the service mount namespace, not only a login shell.

This drop-in does not change the inference sandbox or expose auth to other users.
For blue/green instances install the same drop-in on the selected unit. A custom
CODEX_AUTH_HOME requires the corresponding explicit path here. Rollback removes
only this drop-in and reloads/restarts the unit.
