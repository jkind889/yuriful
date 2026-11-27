---
name: sol-loop
description: Use a read-only GPT 6.1 Sol reviewer in bounded review/fix rounds when the user requests sol-loop or an authorized workflow invokes it.
metadata:
  upstream: "https://github.com/t3dotgg/tstack"
  upstream-revision: "7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd"
  adaptation: "Local Codex shared workflows, 2026-10-26"
---

# Sol Loop

Read [shared boundaries](../full-send/references/boundaries.md) and [routing](references/routing.md). Review is read-only; the coordinator alone makes authorized fixes. A review-only request does not authorize fixes.

## Scope and evidence

Inspect applicable instructions and git status. Preserve unrelated staged, unstaged, and untracked work. Resolve the real target/base: for a PR verify repository, base ref, remote head SHA, and local HEAD alignment; for a local branch determine the intended upstream/default base and merge-base. Fetch only when permitted. If base or ownership cannot be determined, report the uncertainty instead of guessing.

Record the base SHA, HEAD, exact path scope, and a fingerprint of the complete reviewed state (diff plus scoped untracked file contents). Inspect the actual base-to-working-tree diff, including staged/unstaged changes and scoped untracked files, and relevant callers/tests. Use a consistent comparison each round. Do not treat a stale patch, implementation summary, or tests from another head as current evidence.

The coordinator runs permitted relevant validation and records command, working directory, revision/state, exit/result, and skipped/pre-existing failures. Test source inspection is review, not test execution. The reviewer must read actual current files, diff, and relevant tests; it must not run tests or commands that write caches, files, state, or external systems. Give it actual validation output to inspect.

## Route and budget

Use one GPT 6.1 Sol reviewer through a currently exposed native route, following routing.md. Record the returned ID and exact model/effort only when confirmed. No nested delegation. Freeze scoped edits while review runs; if files move unexpectedly, invalidate the round and restart within the budget.

Normally at most 3 review rounds total. Use up to 5 only for security/auth/permissions, data-loss, or state/concurrency risk with an evidenced unresolved issue, or explicit user request; explain the extension. A failed/incomplete review attempt consumes a round. Stop early on approval or only nonblocking nits. No endless retry. Timeout, silence, unavailable routing, or budget exhaustion is not approval.

## Reviewer brief

Send a self-contained brief (especially with no inherited history):

- Read-only; no edits, test execution, commits, pushes, PR actions/comments, watchers, or child agents.
- Absolute repository path, base SHA, HEAD, state fingerprint, scope, intent, applicable instructions, exact diff command, relevant test paths, and actual validation output/limitations.
- Read the complete current diff and surrounding callers/tests in round 1. Later rounds cover changed code, affected interactions, and open findings; inspect the current state rather than relying on prior snippets.
- Return APPROVE, CHANGES, or INCOMPLETE, reviewed state identity, and actionable findings. Use stable IDs S1, S2, etc., with severity, file:line, concrete affected scenario, evidence, and smallest suggested correction.
- Distinguish blocker (serious incorrect/unsafe behavior), should (actionable bug), and nit (optional low-impact improvement). Do not downgrade security or data-integrity defects just because they are uncommon.
- Report old IDs as resolved or still open with reasons; never renumber or recycle IDs. Separate reviewed tests, coordinator-reported validation, and any validation actually executed (normally none). State access gaps and unknowns.

## Reconcile and stop

Maintain a ledger: ID, severity, location/scenario, evidence, status, rationale, and round. Independently verify findings. Fix only evidenced in-scope issues within authorization, run relevant checks, and give the reviewer the updated state and ledger. Challenge unsupported findings with evidence; do not silently mark a disputed blocker resolved. Keep optional/out-of-scope suggestions as declined/deferred with reasons.

Start another round only when an actionable issue remains, behavior changed, or approval no longer covers the current behavior. A finding disputed after two replies or the round cap requires an explicit unresolved handoff. Agreement requires APPROVE on current behavior, no unresolved blocker/should, adequate executed validation, and no coordinator concern. Review approval alone does not establish test success or merge permission.

Do not push during the loop. After agreement, push only if authorized by the task; use [file-pr](../file-pr/SKILL.md) for an authorized PR update. Report rounds, verified route/model, reviewed state, findings fixed/declined/unresolved, validation and gaps, diff size before/after, usage only if exposed, and whether anything was pushed. Put review provenance into a PR only when updating it is authorized.
