# Autonomous VPS cycle (GitHub Actions replacement)

Historical deployment notes: the cycle moved from exhausted private-repository GitHub Actions minutes to an always-on VPS systemd timer, following `delabs-daily-draft`. **Installing these files does not authorize activation.** The timer's recorded state below is disabled.

## Behavior

After an explicit readiness gate, `autonomous-cycle.sh` runs every two hours:

1. Updates isolated `/opt/agent-autonomous` to `origin/main`.
2. Creates `agent/<role>-vps-<ts>`.
3. Runs a preauthenticated local headless `claude` with a role-scoped collaboration prompt. GitHub Actions is neither scheduler nor executor.
4. Commits, pushes the branch and opens a PR labeled `needs-human-review`.

**It never pushes to main.** All changes require PR review.

## Readiness and control

Before reading `.env`, the script requires `/etc/agent-autonomous/readiness` containing exactly `ready` or `green`. Missing/other content produces a successful no-op and the JSONL event `readiness_missing_or_red`. Only the owner's separate decision after all current project quality gates pass authorizes creating this file; it is not precreated in source or on the VPS.

Additional controls:

- `/etc/agent-autonomous/disabled` or `AUTO_DISABLED=1`: disabled/no-op.
- Atomic `/run/lock/agent-autonomous-cycle`: prevents a second cycle.
- `/var/lib/agent-autonomous/{failures,next-run}`: exponential failure backoff, capped at six hours.
- JSON failure reports in `/var/log/agent-autonomous-reports/`, excluding prompts, environment and stderr.
- `DRY_RUN=1`: no commit, push or PR.
- `AUTO_ROLLBACK=1`: resets only isolated `$AUTO_WORKDIR` to `origin/main`, never production `/opt/agent-team`.
- Child Claude receives an explicit safe base environment, without `GH_TOKEN`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*` or other secrets. Local CLI authentication must already exist.

Before any future activation, check readiness, dry-run, rollback, state/log directory permissions and non-root deployment.

## Security

- Isolated working directory; production is not modified.
- `permission-mode=acceptEdits`, explicit allowed tools and the unprivileged `agent-autonomous` service user.
- 540-second Claude iteration timeout.
- Prompt prohibits secret reads and production service/database/systemd changes.
- `node_modules` is an untracked symlink to the production dependency installation, historically saving 566 MB.

## Installation

Commands use a documentation IP; substitute an authorized target. Only the wrapper needs deployment secrets.

### 1. Owner creates a fine-grained GitHub PAT

Limit repository access to `kevinscott66/ai-agents`; grant Contents and Pull requests read/write. Keep the generated token private.

### 2. Service account and credentials

```bash
ssh root@203.0.113.10
useradd --system --home-dir /var/lib/agent-autonomous --create-home --shell /usr/sbin/nologin agent-autonomous || true
install -d -o agent-autonomous -g agent-autonomous -m 0750 /opt/agent-autonomous
install -d -o root -g agent-autonomous -m 0750 /etc/agent-autonomous
umask 077
cat > /etc/agent-autonomous/credentials <<'EOF'
GH_TOKEN=github_pat_xxx
CLAUDE_CODE_OAUTH_TOKEN=oauth_xxx
EOF
chown root:agent-autonomous /etc/agent-autonomous/credentials
chmod 0640 /etc/agent-autonomous/credentials
```

Install the Claude CLI as root-owned `/usr/local/bin/claude`, not writable by the service account. Credentials are read by the wrapper and are not forwarded to child Claude.

### 3. Install wrapper and units

```bash
ssh root@203.0.113.10 'mkdir -p /opt/vps-autonomous'
scp deploy/vps-autonomous/autonomous-cycle.sh     root@203.0.113.10:/opt/vps-autonomous/
scp deploy/vps-autonomous/scan-staged-secrets.sh  root@203.0.113.10:/opt/vps-autonomous/
scp deploy/vps-autonomous/agent-autonomous.*      root@203.0.113.10:/etc/systemd/system/
ssh root@203.0.113.10 'chmod +x /opt/vps-autonomous/*.sh && systemctl daemon-reload'
```

`scan-staged-secrets.sh` must sit **beside the wrapper**, not be loaded from the agent-editable working tree. Without it, the wrapper refuses to commit.

### 4. Dry-run, verification, readiness, then owner-approved activation

`DRY_RUN=1` performs clone → branch → Claude → staging, but only prints changed files and diffstat; it does not commit, push or create a PR. Without it, a test iteration can create a PR.

```bash
ssh root@203.0.113.10 'sudo -u agent-autonomous env DRY_RUN=1 AUTO_ENV_FILE=/etc/agent-autonomous/credentials bash /opt/vps-autonomous/autonomous-cycle.sh qa "smoke test"'
cat /var/log/agent-autonomous/agent-autonomous.log      # staged files and diffstat
```

First ensure readiness is absent or the cycle is disabled. Confirm `agent/node_modules` is not staged and the diff is appropriate. After final project quality gates pass, the owner may explicitly create readiness:

```bash
printf 'green\n' | ssh root@203.0.113.10 'umask 077; mkdir -p /etc/agent-autonomous; cat > /etc/agent-autonomous/readiness'
```

Only after separate owner approval:

```bash
ssh root@203.0.113.10 'systemctl enable --now agent-autonomous.timer'
```

Recorded QA dry-run on 2026-08-02: subscription worked, no PR was created and the symlink was not staged. The agent may produce draft files; wrapper-wide staging can include them, so `needs-human-review` remains essential.

## Feedback loop (added 2026-08-13)

The original cycle created 114 open PRs in eleven days: unmerged work left tasks open, so later runs repeated them. `tools-schema.ts` was rewritten ten times and `self-diag.ts` seven times.

Four defenses:

1. **Open-PR ceiling:** `AUTO_MAX_OPEN_PRS`, default 5, checked before Claude starts. A full queue returns `[skip]` with no model cost; a GitHub read failure returns `[fatal]`.
2. **ALREADY TAKEN prompt block:** task IDs extracted from open cycle PR titles.
3. **YOUR QUEUE:** trusted adjacent `queue-filter.awk` parses TASKS.md, excluding closed, `needs-human:`, `dropped:`, `deferred:` and already-taken tasks, and supplies up to five IDs. A known-empty queue skips Claude entirely. Missing TASKS.md/filter means unknown, not empty, and preserves previous selection behavior. An explicit human HINT overrides the queue. Previously, empty queues produced roughly 75 documentation-only PRs because the agent sought any work after the iteration had already started.
4. **Duplicate rejection:** the agent writes one `T-<number>` in `.autonomous-task-id`. The wrapper sanitizes it and refuses a duplicate PR, leaving the branch locally in `$WORKDIR`.

Prompt-based controls can be influenced by editable task/memory text, and task-ID files may be missing or malformed. The deterministic PR ceiling remains necessary; humans still review/merge the queue.

A live run wrote `loop-dedup` rather than a task ID. Sanitization rejected it safely (`no-task-id`), but deduplication could not identify the work. Supplying candidate IDs in the prompt reduces that ambiguity. Do not invent an ID on the agent's behalf: it may have worked on something else.

### Inspect the prompt without a model call

`PROMPT_ONLY=1` prints the assembled prompt and exits. ALREADY TAKEN and YOUR QUEUE are read from GitHub/TASKS.md, avoiding a paid iteration merely to inspect them.

```bash
ssh root@203.0.113.10 'PROMPT_ONLY=1 bash /opt/vps-autonomous/autonomous-cycle.sh backend ""'
```

### Dirty-tree recovery

Early exits after dry-run, duplicate detection or secret-check failure previously blocked the next checkout forever. The isolated runner now performs `reset --hard HEAD` and `clean -fd` before checkout. These commands apply to the disposable runner, not a developer checkout.

Dirty changes survive only until the next run. Duplicate-task work is preserved in a local commit **after** the secret gate. Secret-check failure explicitly requires immediate inspection; flagged material must not be committed even locally.

### Recorded live checks on 2026-08-13

| Control | Check | Result |
| --- | --- | --- |
| PR ceiling | `AUTO_MAX_OPEN_PRS=0` | `[skip]`, exit 0, no Claude |
| Fail closed | Invalid test GitHub token | `[fatal]`, exit 1, no iteration |
| Taken tasks | Synthetic PR-list JSON | Duplicate task combined as `T-742 — PR #401, #404` |
| Role queue | Existing TASKS.md | QA selected `T-805`; `T-80` was not confused with `T-802` |
| ID sanitizer | Dry-run wrote `loop-dedup` | Rejected, `no-task-id`, no PR |
| Injection rejection | Malformed task ID containing shell syntax | Regex rejected before PR creation |
| Full prompt | `PROMPT_ONLY=1 … backend ""` | Five Backend tasks and no taken tasks |
| Dirty checkout | Previously blocking staging state | Exit 0; next checkout recovered |
| Queue filtering | Twelve roles | Eight stale rework tasks excluded; open T-735 retained |
| Empty queue | Design role with no tasks | `[skip]`, exit 0, no Claude |

The filter examines the heading and first six nonempty body lines. Heading-only matching missed `needs-human:` markers in the body; scanning the entire section incorrectly excluded an open task due to an unrelated trailing summary. When uncertain, excluding an extra task is safer than sending a human-only task to the agent.

**Task IDs belong in PR titles**, not editable bodies. A PR without an ID gets `no-task-id`, making lack of deduplication visible.

Before each new run, the wrapper invokes the T-513 control loop (`bun run agent --role orchestrator --mode review`). It checks fresh PRs, skips previously marked control-loop comments and leaves even green PRs for human approval; it has no merge capability. GitHub failure stops the iteration. `AUTO_CONTROL_LOOP=0` requires an explicit temporary owner override.

## Operations

- Logs: `/var/log/agent-autonomous/agent-autonomous.log`.
- One run: `systemctl start agent-autonomous.service`; a drop-in chooses the role, and readiness still applies.
- Pause: `systemctl disable --now agent-autonomous.timer`.
- Frequency: edit `OnCalendar` in `agent-autonomous.timer`.
- Temporary queue ceiling: `AUTO_MAX_OPEN_PRS=8 bash /opt/vps-autonomous/autonomous-cycle.sh`.

## Recorded state on 2026-08-13

The timer was **disabled** at the owner's request. The feedback-loop script was deployed; enabling it remains an owner decision:

```
systemctl enable --now agent-autonomous.timer
```

Before that date the VPS still had the August 2 revision. The August 12 hardening—reading only two specific variables instead of all `.env`, stripping `GH_TOKEN` from headless Claude and running `scan-staged-secrets.sh` before commit—was subsequently deployed and compared by SHA-256. These historical notes do not authorize enabling the timer now.
