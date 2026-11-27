---
name: babysit-pr
description: Watch a pull request through CI and review bots. Read-only by default (report events only). Fixes, pushes, and comment replies happen only in fix mode, when the user asks for fixes on that PR or full-send or full-stop covers it. Use when the user asks to monitor, watch, or babysit a PR.
metadata:
  upstream: https://github.com/t3dotgg/tstack/blob/7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd/skills/babysit-pr/SKILL.md
  adapted: "2026-10-26: read-only default mode, harness PR monitor first, T3 Code parts removed; see docs/PROJECT_SKILLS.md"
---

# Babysit PR

Many repos have AI review bots. They are helpful, even if they are not always
right.

## Modes

- **Watch (default):** for "monitor", "watch", "keep an eye on", or anything
  unclear. Read only: read checks, reviews, and comments, then report what
  needs action. Do not edit files, commit, push, rebase, comment, resolve
  threads, mark ready, or merge. Read-only monitoring never authorizes edits
  or pushes.
- **Fix:** only when the user asks you to fix or address findings on this
  specific PR, or a full-send or full-stop request for this task covers it.
  Fix mode lets you change and push this PR's own branch, and reply to and
  resolve its bot threads. Project approval rules and production safeguards
  still apply.

Merging is never part of babysitting. Merge only under a full-send request for
this task, and only through its merge gate.

## Waiting

Never write your own watcher, polling loop, or `sleep` loop. Use one watcher
per PR:

1. If the harness has its own PR monitor (for example, the Claude desktop
   app's PR status tools), use it, and follow its rules. Do not also run
   `pr-wait`.
2. Otherwise use `pr-wait`, which only reads from GitHub:

```bash
.claude/skills/babysit-pr/scripts/pr-wait <pr> [--repo owner/name] [--until ready|green|any-change]
```

It prints one line per real event. It exits 0 when the `--until` condition is
met or the PR merges, 1 when it needs you (a required check failed, conflicts,
unresolved threads, PR closed), and 2 on bad input.

- `ready` (default): required checks green, Greptile or Macroscope reviewed the
  head, and no unresolved threads.
- `green`: required checks only. Use it when the repo has no Greptile or
  Macroscope.
- `any-change`: exit on the first event.

In Claude Code, run it with the Monitor tool and a long timeout, so each line
wakes you. Without a monitor, run it as one long background command. It ends on
its own.

Start it again after you push, after you handle an exit 1, and after a resume.
It keeps state in `~/.local/state/pr-wait/`, so nothing that arrived in between
is lost. If it says another pid already watches the PR, do not start a second
one. Stop the old one only if its events do not reach you.

When an event needs no action, end your turn without a message. Never post or
say "still waiting".

## GitHub rate limits

`gh pr create`, `gh pr view`, and `gh pr checks` use GraphQL. When GraphQL is
used up, the REST limit is separate and usually still has room. Use
`gh api repos/<owner>/<repo>/pulls/<n>` to read a PR, and
`gh api repos/<owner>/<repo>/commits/<sha>/check-runs` for checks. Check with
`gh api rate_limit --jq .resources.graphql` before you watch again.

## Reviews

Use checks and new review statuses for the latest head; an older passing check
does not validate a new push. Also evaluate every unresolved existing finding
against the current code, even when it predates the latest push. Ignore a
finding only after verifying that it is stale or resolved, and record why.
Verify every bot finding against the source before changing code, or before
calling it real in watch mode. Tell repository failures apart from
infrastructure flakes.

In fix mode, fix real findings and CI failures, and get proof for each fix
before you push. If you believe a bot finding is not worth addressing, reply
with a written reason and resolve the thread. Use the `leaving-pr-comments`
skill for every comment posted on the user's behalf. Never dismiss or resolve
a human reviewer's request. Report it.

If the repo has `.macroscope/check-run-agents/*.md`, read those rules before
you answer a Macroscope finding. Its findings cite them.

CodeRabbit is advisory. Treat its findings like any other finding, but never
wait for it.

Screenshots and videos help as well, when you have a way to upload them.

Keep the PR at the size the user's goal needs. Review loops tend to grow a PR
one cheap-looking fix at a time. Fix real bugs in the intended case. Decline
the rest with a written reason, and list them as follow-ups: unneeded tests,
guards for edge cases that do not matter, extra integration or compatibility,
and small performance costs. Prefer the fix that deletes or narrows code.

## Base branch

Watch for changes to the base branch. `pr-wait` reports when new base commits
touch this PR's files, and when the PR becomes BEHIND or DIRTY. In watch mode,
report it. In fix mode, rebase this PR's branch and push with
`--force-with-lease`, then wait for green again.

If an overlapping PR makes this one obsolete, stop monitoring, report it to the
user, and ask before closing the PR.

Stop when `pr-wait` exits 0, or when the harness monitor reports the PR ready.
Report that the PR is ready, with its link, head sha, and draft state. Never
call a PR ready when it is BEHIND or DIRTY, or when base commits that landed
after the last green run touch this PR's files.
