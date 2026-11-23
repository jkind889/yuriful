---
name: sol-loop
description: Review the current code change in a loop with a separate, read-only Claude Opus reviewer subagent (sol-loop-reviewer) until both agents agree or the round budget ends. Use when the user says "sol loop" or asks for an Opus review loop on a change; full-send and full-stop also use it.
metadata:
  upstream: https://github.com/t3dotgg/tstack/blob/7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd/skills/sol-loop/SKILL.md
  adapted: "2026-10-26: GPT Sol reviewer replaced with read-only Claude Opus subagent; see docs/PROJECT_SKILLS.md"
---

# sol-loop (Claude Opus reviewer)

This workflow makes a code change more correct before (or sometimes after)
filing a PR. Upstream, a GPT Sol model reviews in a loop. Here the reviewer is
the `sol-loop-reviewer` subagent (`.claude/agents/sol-loop-reviewer.md`):
pinned to `model: claude-opus-5-5`, with only `Read, Grep, Glob`. You are
the implementing agent. You own the fixes. The reviewer only reports.

Make the smallest changes that address real findings. Watch for scope creep,
and push back with evidence.

## Budget

- Default: 3 rounds. Round 1 is full. Later rounds check changed code and
  open findings.
- High-risk work gets 5 rounds: security, authentication or permissions,
  data loss, migrations or backfills, payments, concurrency or shared state,
  and production configuration. Decide this in step 1 and record why. The
  user can ask for more or fewer rounds.
- Stop early if a round returns only nits. Declined nits and comment, doc, or
  format-only fixes need no new round.
- One reviewer per round. Never start a second reviewer, and never swap in
  another model.
- Keep a ledger (step 4). Never guess its fields.

## 1. Scope

Run `git status --short`. Do not stash, discard, commit, or include unrelated
changes. Limit the review to the change's paths if they separate cleanly from
other work. Otherwise stop and ask.

Find the base after `git fetch origin`:

- PR: `gh pr view <n> --json baseRefName,headRefOid` (read only). Check out
  the branch only if the tree is clean. Confirm `HEAD` is the PR head, or
  ahead of it only by this change. Base:
  `git merge-base HEAD origin/<baseRefName>`.
- Local: `git merge-base HEAD origin/<default-branch>`. With no remote: a base
  the user names, or `HEAD` for uncommitted changes only.

State the intent and what is out of scope in 1-2 sentences. Run the checks
that cover the change (the project's tests, typecheck, and lint commands).
Record each exact command, its exit status, and a one-line result. Do not
send the reviewer code this change breaks. Note checks that are missing or
were already failing.

## 2. Build the review bundle

The reviewer reads the real diff from files, not your summary of it.

```bash
RUN="$(git rev-parse --absolute-git-dir)/sol-loop/$(date +%Y%m%d-%H%M%S)"
.claude/skills/sol-loop/scripts/review-bundle <base> "$RUN/round-1" [-- <paths>...]
```

The script snapshots base to working tree, including untracked files that are
not ignored, through a temporary index. Your index, stash, and working tree
stay untouched. It writes `diff.patch`, `context.patch` (whole-function
context), `diffstat.txt`, and `git.txt`, and prints `tree <sha>`. Save that
sha. The next round passes it as `--prev-tree <sha>`, which also writes
`delta.patch`. The bundle lives inside `.git`, so it is never committed.

Then write `$RUN/round-<n>/bundle.md` yourself:

```
Round: <n> of <budget> (risk: normal|high, because <reason>)
Repo: <absolute path>   Base: <sha>   Tree: <sha>   Paths: <paths or whole repo>
Intent: <1-2 sentences>
Out of scope: <items>
Checks run by the implementer (claims, not proof):
- `<command>` -> exit <n>: <result>
Missing or pre-failing checks: <list or none>
Ledger:
| id | severity (reviewer -> yours) | outcome | evidence |
```

The reviewer may have no Grep or Glob tools (the Claude desktop app runs
without them), so give it the searches too. Write `$RUN/round-<n>/search.txt`
with raw output, each block headed by its command:
`git grep -n -w -e <symbol> ...` for each changed function, type, export,
route, or config key, and `git grep -n -F -e '<string>'` for each string the
reviewer listed under SEARCHES last round. Paste the output unedited.

If `diff.patch` is over about 4000 lines, split the review by paths or ask the
user.

## 3. Run the reviewer

Delegate with the Agent tool: `subagent_type: "sol-loop-reviewer"`. Do not
pass a `model` parameter. A per-call model overrides the agent's pinned Opus.
The prompt is short: `Review round <n>. Bundle: <absolute path>. Follow your
instructions.` The facts live in the bundle.

Do not edit scoped files while the review runs. Wait for the completion
notice. Do not poll it, and do not start a second reviewer.

Check the reply before you use it:

- `MODEL:` names a Claude Opus model (`claude-opus-...`). Record it verbatim.
- `VERDICT:` is `APPROVE` or `CHANGES`.
- Every finding has an ID, severity, `file:line`, and evidence.

Otherwise the round failed. Failures include an error, a timeout, no reply,
`VERDICT: ERROR`, a missing, unknown, or non-Opus model, and an unparseable
reply. A failed round is never approval. Retry once with a fresh reviewer. If
it fails again, or the Agent tool does not know `sol-loop-reviewer` (for
example, the session started before the agent was installed), stop and use
the manual review handoff below.

## 4. Assess findings

Check each finding and its severity yourself against the code. Another path, a
rare case, or a small cost is a nit, whatever label it came with.

- Agree: make the smallest fix. Prefer deleting or narrowing code over a new
  lock, cache, helper, or option. Fix the case that happened. Add one focused
  test that fails without the fix, if the intent needs it.
- Disagree: say why, with evidence (`file:line`, a test, command output).
- Out of scope, or a nit: decline in one line, and list it as a follow-up.

Update the ledger: `fixed`, `disagree`, `declined`, or `open`, each with
evidence. Re-run the checks that cover the changed code, and record the
commands and results. If the review grew the diff, cut it back first. Never
agree just to end the loop.

## 5. Next round

Start one only if budget remains and any of these is true: a blocker or should
is open, behavior code changed since the last reviewed tree, or the approval
does not cover the current diff. Build `round-<n+1>` with
`--prev-tree <last tree>`, and write its `bundle.md` with the ledger.

Continue the same reviewer if you can (SendMessage to its agent ID), so it
keeps its context. Otherwise start a fresh one. The bundle carries everything
it needs. Tell it to check the open IDs and `delta.patch` first, and to judge
approval against the full `diff.patch`.

## 6. Stop

- **Agreed:** the latest successful round returned `APPROVE` for a tree that
  matches the current working tree. If unsure, rebuild the bundle and compare
  tree shas. No blocker or should is open, and you have no concern of your own.
- **Stuck:** an item is still disputed after two replies, or the budget ran
  out. Show both sides in 2-3 lines each, and let the user decide. Running out
  of budget is not approval.

Do not push during the loop. Push after agreement only if the user asked you
to push, ship, or update the PR, or a full-send or full-stop request for this
task covers it. If you are also authorized to edit that PR's description, add:

`Reviewed with sol-loop: <N> rounds with <MODEL line>. Reviewer verdict: <approved | not approved: open IDs>`

## Report

Keep these two sections apart. Never merge them:

- **Checks executed:** each command you ran, its exit status, its result, and
  the tree it ran on.
- **Model review (not a test):** the reviewer model as reported, rounds run
  and rounds failed, the final verdict, and the ledger (ID, severity,
  outcome, evidence). List unresolved findings by ID.

Also report the diff size before and after (diffstat), whether you pushed,
and the bundle path. Report usage only if the harness showed it. Otherwise
say it was not reported. Never call the review clean or approved unless the
latest successful round returned `APPROVE` for the current tree. Name every
failed round.

## Manual review handoff

Use this when the Opus reviewer cannot run:

1. Keep the latest bundle. Write `$RUN/MANUAL-REVIEW.md` with the reviewer
   instructions (the body of `.claude/agents/sol-loop-reviewer.md`), the
   bundle path, and the ledger.
2. Tell the user plainly: **no model review was performed**. List the checks
   you executed separately.
3. Offer these routes:
   - In a new Claude Code session in the repo, run `claude --agent
     sol-loop-reviewer` and say `Review the bundle at <path>.`
   - Paste `MANUAL-REVIEW.md` and `diff.patch` into any Claude Opus session.
   - Review the change personally.
4. Do not push or merge any step that depends on review until the user
   decides.
