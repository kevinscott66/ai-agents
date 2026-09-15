# Independent review dispatch

Required by /Users/dobropalm/programs/.ai/QUALITY_GATES.md and ROUTING.md for HIGH auth/protocol changes.
- Role: security specialist / independent reasoning reviewer.
- Task: inspect only daily assistant + native app diff against main, report evidenced correctness/security defects.
- Risk: HIGH (device credentials, authenticated native chat, Mac capability).
- Executor: available same-family subagent; no cross-family execution claimed.
- Tools: local git/read/test; no live secrets, external messaging or production writes.
- Context: this dispatch + changed files, approx 15k tokens; no whole chat needed.
- Soft/max budget: 8k/16k tokens estimate; no metered enforcement available.
- Baseline: TypeScript PASS; 13 new workflow/store tests PASS; targeted voice gates PASS; unsigned iOS arm64 build PASS. Full suite currently blocked on sandbox port binding; unrestricted local test retry pending.
- Expected output: findings with file/line, exploit/failure evidence and minimal fix; PASS is valid.
- Stop: one review pass; do not edit files or expand into unrelated project issues.
