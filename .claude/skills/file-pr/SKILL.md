---
name: file-pr
description: File a concise, problem-first pull request as a draft by default, after checking for an existing PR. Use when the user asks to file, open, or create a PR, or when full-send or full-stop reaches that step.
metadata:
  upstream: https://github.com/t3dotgg/tstack/blob/7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd/skills/file-pr/SKILL.md
  adapted: "2026-10-26: draft by default, existing-PR check, validation and limitations sections; see docs/PROJECT_SKILLS.md"
---

# File PR

## Before filing

1. **Check for an existing PR** for this branch:
   `gh pr list --head <branch> --state all --json number,url,state,isDraft,title`.
   If one is open, do not file a duplicate. Report it. Change its title or
   description only if the user asked you to update that PR. If one was closed
   or merged, say so and ask before filing a new one.
2. **Review the diff locally** against the base branch (usually
   `origin/main`), and confirm its contents match the goal. Leave out
   unrelated changes.
3. **Push only this branch**, and only because the user asked you to file the
   PR. Never push to the default branch.

## Title

PR titles usually become commit messages, so follow the repository's title
conventions. Look at recently merged PRs and Git history for examples. Prefer a
concise, human-readable title that says why the change matters:

BAD

> ❌ perf(server): negotiate permessage-deflate on the websocket

GOOD

> ✅ perf(server): cut websocket frame size by 70%+ with gzipping

## Description

Open with the problem, in plain words, based on the user's original request.
Then explain the solution briefly. Do not lead with an inventory of changes:

BAD

> ❌ Removed implicit workspace carry-over from every "new thread" entry point (cmd+n / cmd+shift+o, sidebar v1/v2 buttons, command palette). New threads inherit only the project from context; branch, worktree, and env mode always come from the configured defaults. Deleted buildContextualThreadOptions, startNewThreadInProjectFromContext, and the v1 sidebar's seed-context machinery.

GOOD

> ✅ My "new worktree" default was ignored when starting new threads on existing worktrees. Super unintuitive. Now your preferences always apply.

Then add two short sections:

- **Validation:** what you actually ran and observed, with the commands and
  results (tests, typecheck, lint, reproduction, screenshots). Put model
  review on its own line, for example `Reviewed with sol-loop: 2 rounds with
  claude-opus-5-5. Reviewer verdict: approved`. Never present a model review
  as a test. Say what was not run.
- **Known limitations:** what the change does not cover, deferred follow-ups,
  and remaining risks. Write `None known` only if that is true.

End with the attribution line the harness asks for, if it gives one.
Otherwise end with `Created with <model> in Claude Code.` Include subagent
models that wrote part of the change. Use the model name the harness reports.
If the model is not exposed, name only the harness.

Before submitting, check the title, description, quotes, and attachments for
secrets and private details.

## Filing

File a draft by default: `gh pr create --draft`. File a ready-for-review PR
only when the user asked for one, or when a full-send request for this task
reaches its ready step. Some review bots skip drafts. Mention that in the
report rather than filing as ready on your own.

If `gh pr create` fails because the GraphQL rate limit is used up, open the
PR through REST:
`gh api repos/<owner>/<repo>/pulls -f title=... -f head=... -f base=... -F draft=true -F body=@<file>`.

Report the PR URL GitHub returned, and whether it is a draft. If the user also
asked you to babysit it, continue with the `babysit-pr` skill.

Do not post a follow-up PR comment unless it serves the user's request. When a
comment is needed, use the `leaving-pr-comments` skill.
