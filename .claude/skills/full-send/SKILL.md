---
name: full-send
description: Opt-in autonomous workflow that takes one named change to a merged PR (prove, Opus review loop, file, babysit, merge). Run only when the user explicitly invokes /full-send or says "full send" for that specific task in their current request.
disable-model-invocation: true
metadata:
  upstream: https://github.com/t3dotgg/tstack/blob/7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd/skills/full-send/SKILL.md
  adapted: "2026-10-26: per-task opt-in, no overrides of project approvals, draft-first PRs; see docs/PROJECT_SKILLS.md"
---

# Full Send

Full send is opt-in for one task. It applies only when the user's current
request explicitly says "full send" (or invokes `/full-send`) for a specific
change. None of these is permission: having this skill installed, an earlier
full-send request, or a full-send request for a different task, PR, or
repository. If it is unclear, do not assume autonomy. Work like `full-stop`
(never merge) and ask.

The user is probably not watching. Your updates and your final message go
unread until long after you stop. You own this task from its current state to
a merged PR, within the limits below.

## What a full-send request grants, for this task only

- Create a branch, commit, and push this task's own branch.
- File this task's PR with `file-pr`. File it as a draft, then mark it ready
  for review (`gh pr ready`) once proof and the review loop pass. The
  full-send request is the user's request for a ready PR.
- Rebase this task's branch, and push it with `--force-with-lease`.
- Fix CI failures and real review findings on this PR, and reply to and
  resolve bot threads on it, as `babysit-pr` fix mode describes.
- Merge this PR once the merge gate passes.

## What it does not grant

Everything else keeps its normal rules. A full-send request does not override:

- Approval requirements in the system prompt, the harness, `CLAUDE.md`,
  `AGENTS.md`, or other project instructions. If one says to ask first, for
  example before computer use, a paid service, a migration, a data apply, or
  a production command, ask first.
- Harness permission prompts. Never work around them.
- Paid-service limits. Add no new paid services, credentials, API keys, or
  external integrations.
- Production safeguards. No deploys, production data writes, shared-environment
  migrations, or secret changes.
- Branch protection, required reviews, and merge queues. Never use `--admin`
  or other bypasses.
- Holds the user placed on a PR or branch.

If merging would itself deploy to production (for example, the default branch
auto-deploys), and this request did not say that deploy is fine, treat the
merge as touching production and ask first.

## Steps

1. **Finish the change.** Complete the goal from the user's request with the
   smallest change that works. Fix the case that happened, not every case that
   could. If you are on the default branch, create a branch first.
2. **Prove it.** Get proof for every change you made. See "Proof".
3. **Review it** with the `sol-loop` skill. If the Opus reviewer cannot run,
   there is no review. The merge gate cannot pass without one. Ask the user.
4. **File the PR** with the `file-pr` skill, as a draft. Rebase onto the latest
   default branch first. The description's validation section says how you
   proved the change.
5. **Babysit the PR** with the `babysit-pr` skill in fix mode. Mark it ready
   for review when proof and the review loop cover the current head. Fix real
   findings and CI failures. Get proof for each fix before you push it.
6. **Merge** when the merge gate passes.
7. **Report** in your final message: the PR link, the merge commit, your
   proof, the reviewer outcome, and each decision you made for the user.

Stay active from step 1 to step 7. If you end your turn while checks or bots
are pending, the work stops, because nobody will prompt you again. Wait as
`babysit-pr` describes, so something wakes you when the PR changes.

## Proof

Proof is evidence you observed yourself in this session: command output, a
reproduction, a screenshot. Use the most direct proof the change allows, with
methods the project's rules let you use. If the right method needs approval,
ask for it.

- Reproduce the original failure, apply the fix, then watch the same
  reproduction pass.
- Run the checks the repo's CI runs (typecheck, lint, tests).
- Add one focused test that fails without the fix, when the behavior has none
  and the repo has a test setup.
- For UI and runtime behavior, run the app and look at the change. Green
  mocked tests do not prove the user experience works. Attach screenshots to
  the PR when they help and you have a way to upload them.

Model review is not proof. Report it separately from the checks you ran.

When you cannot find a way to prove a change, you do not have full confidence.
Ask the user.

## Merge gate

Full confidence means all of these are true on the latest commit:

- Your proof covers every change in the diff.
- `sol-loop` ended with an Opus `APPROVE` on the current behavior diff and no
  open blocker or should, or the user accepted the open items in writing. A
  failed or skipped reviewer run does not pass.
- Required checks are green.
- Review bots have finished, and each finding is fixed or dismissed with a
  written reason.
- Required human approvals are present, and no human review requests changes.
  Never dismiss a human review. An automated "needs human review" result
  blocks the merge, so ask the user.
- The branch is up to date with the default branch, and GitHub reports it as
  mergeable.
- No project rule, production safeguard, or user hold blocks the merge.

Right before merging, run `git fetch` and confirm the live PR head is the
commit you proved. Merge with the method the repo uses. Check the allowed
methods and recent merged PRs. If the repo uses a merge queue or auto-merge,
stay until GitHub reports the PR as merged. Merge through branch protection as
configured.

## Asking the user

A question in a normal message goes unseen, and the thread looks done. To ask
the user something, use `AskUserQuestion`, so the thread shows that it is
waiting. Put all the context in the question: the PR link, what blocks you,
and the options with your recommendation first.

Ask when you cannot continue alone:

- You cannot prove the change.
- The merge gate cannot pass, and you cannot fix that yourself.
- The next step is outside the grant above, or a project rule says to ask:
  deleting data, touching production, changing things outside the repo,
  closing a PR, or force-pushing any other branch.
- The goal is ambiguous in a way that changes the result.
- Another PR makes this one obsolete.

Decide everything else yourself with sensible defaults, and list those
decisions in the report.

If no question tool is available, or it returns no answer, take the safe path:
leave the PR open and unmerged, and start your final message with the question.
