---
name: full-send
description: Complete a particular change through validation, review, PR creation, monitoring, and merge only when the user explicitly invokes full-send for that task.
metadata:
  upstream: "https://github.com/t3dotgg/tstack"
  upstream-revision: "7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd"
  adaptation: "Local Codex shared workflows, 2026-10-26"
---

# Full Send

Installing, discussing, or selecting this skill is not merge authority. Activate only on an explicit full-send request for the current task. Read [boundaries](references/boundaries.md) before starting; they apply throughout.

For that task only, full-send authorizes marking its draft PR ready after current-head validation checks and the review loop pass, and rebasing its branch with a verified `--force-with-lease` push when needed. These grants do not apply to full-stop, other branches, or other tasks, and do not override narrower user instructions, holds, protection, or separate safety requirements.

1. Confirm the task, repository, branch, intended base, applicable instructions, and existing user work. Finish the smallest change that meets the request. Preserve unrelated changes; use a task branch and never push directly to the default branch.
2. Validate the changed behavior with relevant repository checks and safe reproductions. Inspect commands before executing them. Observe UI/runtime behavior when needed and permitted. Record actual commands, results, missing coverage, and pre-existing failures. Add a regression test only when it adds meaningful evidence. Required approvals for a test method still apply.
3. Use [sol-loop](../sol-loop/SKILL.md). Review must cover the final behavior diff. An unavailable reviewer, incomplete validation, or exhausted budget blocks a claim of readiness.
4. Use [file-pr](../file-pr/SKILL.md); new PRs are drafts unless the user explicitly specifies otherwise. Preserve branch scope and verify the remote after pushing.
5. Use [babysit-pr](../babysit-pr/SKILL.md) in authorized fix mode. Before any operation that can advance the PR, enforce the shared auto-merge/queue guard; never let an automatic merge race the gate below. For an explicitly active full-send task, mark its draft PR ready after validation checks and Sol approval cover the current head. Address verified in-scope findings, validate fixes, and repeat review when behavior changes. A new head invalidates old head-specific evidence.
6. Evaluate the gate below from fresh remote data. Full-send authorizes merging this task's PR only after the gate passes and all separate approvals/restrictions are satisfied. Marking a PR ready does not waive any merge gate or release a user hold.
7. Use the repository's permitted merge method and normal protection/queue process. Never bypass protection or use admin overrides. Confirm GitHub reports merged and record the merge commit; an accepted request or queue entry is not a completed merge.

## Merge gate

Verify repository/PR identity, current head and base, open/non-draft state, required checks and approvals, all relevant unresolved threads, human change requests, mergeability, and branch freshness. Paginate reads. Missing permissions, incomplete results, pending checks, unknown mergeability, or unreadable rules mean unknown, not passing. Required reviews include required human review; confidence cannot waive them.

Validation and Sol approval must cover the actual current diff. Check the base again before merging; if an update changes behavior or introduces meaningful conflicts, update only within authorization, validate, review, push, and wait for current results again. Respect existing holds and user review requests. Do not change auto-merge settings or merge-queue membership unless that action is authorized for this task.

If blocked, report the exact remaining gate, current head, evidence, unresolved finding IDs, and required next action. Stop the watcher you own when handing off. Report the PR URL, confirmed merge status/commit if any, validation, review rounds/model, limitations, and material decisions. Never describe pending work as completed.
