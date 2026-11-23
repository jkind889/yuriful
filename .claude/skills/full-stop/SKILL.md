---
name: full-stop
description: Opt-in workflow that does full-send's prove, Opus review, file, and babysit work for one named change, then stops with the PR ready for the user to merge. Never merges. Run only when the user explicitly invokes /full-stop or says "full stop" for that specific task.
disable-model-invocation: true
metadata:
  upstream: https://github.com/t3dotgg/tstack/blob/7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd/skills/full-stop/SKILL.md
  adapted: "2026-10-26: no override of project approvals, draft-first PRs; see docs/PROJECT_SKILLS.md"
---

# Full Stop

Do the same work as `full-send`, but stop with the PR ready for the user to
merge. Never merge it.

Read [full-send](../full-send/SKILL.md) (`.claude/skills/full-send/SKILL.md`)
and follow its steps, proof rules, review, babysitting, and its "What it does
not grant" list. An explicit "full stop" request for this task authorizes that
work without a separate "full send" request: a branch, commits and pushes to
this task's branch, filing the PR, fixes, and a rebase with
`--force-with-lease` on this task's branch. It grants no merge permission. It
does not override approval requirements, project instructions, paid-service
limits, production safeguards, or holds the user placed. The rules below take
precedence over full-send.

## No merging

Never merge, enable auto-merge, enter a merge queue, push to the default
branch, bypass branch protection, or ask another agent or session to do any of
these.

Before any push or operation that could advance this task's PR, inspect its
auto-merge and merge-queue state. If either is active, stop mutation and report
the blocker; do not disable auto-merge or remove queue membership unless that
action is independently authorized. Unknown state is also a blocker. Check
again before each push, and ask for missing authorization rather than risking
an automatic merge.

## Draft status

A new PR from `file-pr` stays a draft. Mark it ready for review only if the
user's request asked for that. If checks or review bots need a non-draft PR,
ask with `AskUserQuestion`, or hand it off as a draft and say so. Leave an
existing non-draft PR as it is.

## Stop at the gate

Use full-send's merge gate as the readiness check, apart from draft status.
Replace its merge and final report steps with a handoff. Proof and review must
cover the final diff. Recheck behavior changes and meaningful conflict fixes
before the handoff.

Fetch the target branch, and check the live PR's head, base, draft state,
checks, reviews, and mergeability. Confirm it is open and not set to merge
without the user. If someone else merged it, report that instead.

- **Ready to merge:** the merge gate passes. Leave the PR open and unmerged.
- **Ready except draft:** everything passes, but the PR is still a draft
  because nobody asked to mark it ready.
- **Waiting for required approval:** only human approval remains. Confirm that
  this is the actual blocker.
- **Blocked:** explain what prevents readiness, what you tried, and what is
  needed. Follow full-send's rules for asking the user.

Report the PR link, the final head sha, draft state, the verdict, proof
(commands run and their results), the reviewer outcome (model, rounds,
unresolved IDs), and remaining risks. State whether the PR is still open and
unmerged.
