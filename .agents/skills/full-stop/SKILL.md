---
name: full-stop
description: Prepare and validate a change through PR review and handoff when the user requests full-stop, always leaving merging to the user.
metadata:
  upstream: "https://github.com/t3dotgg/tstack"
  upstream-revision: "7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd"
  adaptation: "Local Codex shared workflows, 2026-10-26"
---

# Full Stop

Read [shared boundaries](../full-send/references/boundaries.md). Full-stop authorizes the task's implementation, validation, review, and requested PR preparation subject to those boundaries; it never activates full-send's merge authority.

Follow steps 1–5 and the evidence requirements in [full-send](../full-send/SKILL.md), then use its merge gate only as a readiness assessment. New PRs default to draft. Report draft status as a handoff item; do not silently mark ready.

Never merge, enable auto-merge, enter a merge queue, push to the default branch, bypass protection, or delegate these actions. Before any push or operation that could advance a PR, inspect existing auto-merge/queue state. If it might merge automatically, stop mutation and report; do not disable or remove anything without authorization. An inability to verify this state is a blocker. Recheck before each push.

Hand off the PR URL, final head/base, validation results and limitations, Sol outcome and unresolved IDs, required approvals, and current open/draft/unmerged state. Distinguish ready for the user's review, waiting on required approval/checks, and blocked. Do not claim ready to merge while draft, required evidence is missing, or a hold remains. If someone else merges it, report the observed state without implying you performed it. Stop only the monitoring owned by this workflow; do not alter unrelated automation.
